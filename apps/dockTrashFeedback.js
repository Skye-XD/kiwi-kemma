// SPDX-License-Identifier: GPL-3.0-or-later
// Dock trash feedback: when something is moved to the trash, the Dash-to-Dock
// comes up, the item flies from the pointer into the trash icon and the can
// gulps it down; when the trash is emptied the can squashes. Roughly what the
// macOS Dock does when a file is dragged to its trash.
//
// It watches the trash itself rather than any one way of putting things there,
// so a file deleted from Files, the desktop, the Delete key or a menu all get
// the same response.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { dockContainers } from './dockUtils.js';

const TRASH_URI = 'trash:///';
const ITEM_COUNT = 'trash::item-count';
const SOUND = '/usr/share/sounds/freedesktop/stereo/trash-empty.oga';
// One trash operation emits a burst of monitor events; read the count once.
const SETTLE_MS = 150;
// Give an autohidden dock time to slide in before aiming at its trash icon.
const REVEAL_MS = 240;
const FLIGHT_MS = 620;
const STAGGER_MS = 90;
const MAX_FLYERS = 3;
const FLYER_SIZE = 64;
// How long the dock stays up after the last animation has finished.
const LINGER_MS = 700;

let settings = null;
let trash = null;
let monitor = null;
let monitorId = 0;
let settleId = 0;
let cancellable = null;
let count = null;
let added = [];
let hideId = 0;
let timers = new Set();
let flyers = new Set();
let dndIds = [];
let dragging = false;
// dock -> Set of what is holding it up: 'trash' (reveal) and/or 'drag'.
let dockHolders = new Map();
let hoveredArt = null;
let drag = null;            // {uris, fromDing, reading, trashWhenRead}

const URI_LIST = 'text/uri-list';
// DING marks its own icon drags; it trashes those itself when they are let go
// over the dock trash.
const DING_ICON_LIST = 'x-special/ding-icon-list';

// A drag reveals an autohidden dock once it reaches the dock's screen edge,
// and lets go once it is clearly away from it.
const REVEAL_EDGE = 3;
const RELEASE_MARGIN = 48;

function later(ms, fn) {
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        timers.delete(id);
        fn();
        return GLib.SOURCE_REMOVE;
    });
    timers.add(id);
}

// The dock on the monitor the user is working on, or the first one.
function currentDock() {
    const docks = dockContainers();
    const monitorIndex = global.display.get_current_monitor();
    return docks.find(d => d.monitorIndex === monitorIndex) ?? docks[0] ?? null;
}

// The trash icon art inside a dock. Kiwi's minimized strip may have adopted
// the trash item, so look through the whole container.
function trashArtIn(dock) {
    let found = null;
    const walk = actor => {
        if (found)
            return;
        if (actor._delegate?.app?.isTrash && actor instanceof St.Widget) {
            found = actor.icon?.icon ?? actor;
            return;
        }
        actor.get_children().forEach(walk);
    };
    if (dock)
        walk(dock);
    return found;
}

/* The post-trash reveal and a drag at the dock edge both hold the dock up
 * through Dash-to-Dock's _onDragStart/_onDragEnd, which save one state per
 * dock: a second start overwrites it and the first end drops the dock even
 * while the other still wants it. So start on the first holder, end on the
 * last. */
function holdDock(dock, who) {
    const holders = dockHolders.get(dock);
    if (holders) {
        holders.add(who);
        return;
    }
    dock._onDragStart();
    dockHolders.set(dock, new Set([who]));
}

function releaseDock(dock, who) {
    const holders = dockHolders.get(dock);
    if (!holders?.delete(who) || holders.size)
        return;
    dockHolders.delete(dock);
    try {
        dock._onDragEnd();
    } catch (_e) {
        // The dock went away first.
    }
}

function releaseAll(who) {
    for (const dock of [...dockHolders.keys()])
        releaseDock(dock, who);
}

/* Bring the dock up the way Dash-to-Dock does for its own drags, and keep it
 * there until the animations are over. */
function reveal(dock, holdMs) {
    if (!dock || typeof dock._onDragStart !== 'function')
        return;
    holdDock(dock, 'trash');
    if (hideId)
        GLib.source_remove(hideId);
    hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, holdMs + LINGER_MS, () => {
        hideId = 0;
        releaseAll('trash');
        return GLib.SOURCE_REMOVE;
    });
}

function bounce(art, peak, outMode, outMs) {
    art.set_pivot_point(0.5, 1.0);
    art.remove_transition('scale-x');
    art.remove_transition('scale-y');
    art.ease({
        scale_x: peak, scale_y: peak,
        duration: 120,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => art.ease({
            scale_x: 1, scale_y: 1,
            duration: outMs,
            mode: outMode,
        }),
    });
}

function gulp(art) {
    bounce(art, 1.22, Clutter.AnimationMode.EASE_OUT_BACK, 320);
}

function playSound() {
    if (!settings?.get_boolean('dock-trash-sound'))
        return;
    try {
        Gio.Subprocess.new(['pw-play', SOUND], Gio.SubprocessFlags.NONE);
    } catch (e) {
        console.error(`[kiwi] dock trash sound: ${e.message}`);
    }
}

// What a trashed item looks like: its thumbnail when it has one, else its icon.
function iconFor(file) {
    return new Promise(resolve => {
        file.query_info_async('standard::icon,thumbnail::path',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable,
            (f, res) => {
                try {
                    const info = f.query_info_finish(res);
                    const thumb = info.get_attribute_byte_string('thumbnail::path');
                    resolve(thumb
                        ? new Gio.FileIcon({ file: Gio.File.new_for_path(thumb) })
                        : info.get_icon());
                } catch (_e) {
                    resolve(null);
                }
            });
    });
}

/* Toss an icon from (x, y) into the trash art: x eases across while y takes
 * EASE_IN_BACK, which first lifts the icon and then drops it, so the path is
 * an arc rather than a straight line. */
function fly(gicon, from, art, onLanded) {
    const half = FLYER_SIZE / 2;
    const flyer = new St.Icon({
        gicon: gicon ?? Gio.ThemedIcon.new('text-x-generic'),
        icon_size: FLYER_SIZE,
        x: from.x - half, y: from.y - half,
        opacity: 0,
    });
    flyer.set_pivot_point(0.5, 0.5);
    Main.uiGroup.add_child(flyer);
    Main.uiGroup.set_child_above_sibling(flyer, null);
    flyers.add(flyer);

    const [tx, ty] = art.get_transformed_position();
    const [tw, th] = art.get_transformed_size();
    const to = { x: tx + tw / 2 - half, y: ty + th / 2 - half };

    flyer.ease({ opacity: 255, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    flyer.ease({ x: to.x, duration: FLIGHT_MS, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE });
    flyer.ease({ scale_x: 0.32, scale_y: 0.32, duration: FLIGHT_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD });
    flyer.ease({
        y: to.y, duration: FLIGHT_MS, mode: Clutter.AnimationMode.EASE_IN_BACK,
        onComplete: () => {
            flyers.delete(flyer);
            flyer.destroy();
            onLanded();
        },
    });
}

/* Darken and lift the trash while something is dragged over it, as the macOS
 * Dock does. The Shell sees a client drag only as positions (Mutter's dnd-*
 * signals), which is enough for this. The dock is reactive chrome, so a drop
 * on it reaches no client at all (the source sees it cancelled, hence
 * hideDragIcon()); the files are read from SELECTION_DND and trashed here. */
function hover(art) {
    if (art === hoveredArt)
        return;
    unhover();
    if (!art)
        return;
    hoveredArt = art;
    art.set_pivot_point(0.5, 1.0);
    if (!art.get_effect('kiwi-trash-hover'))
        art.add_effect_with_name('kiwi-trash-hover', new Clutter.BrightnessContrastEffect());
    art.get_effect('kiwi-trash-hover').set_brightness(-0.25);
    art.ease({ scale_x: 1.12, scale_y: 1.12, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
}

function unhover() {
    const art = hoveredArt;
    hoveredArt = null;
    if (!art)
        return;
    try {
        art.remove_effect_by_name('kiwi-trash-hover');
        art.ease({ scale_x: 1, scale_y: 1, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    } catch (_e) {
        // The dock rebuilt its icons meanwhile.
    }
}

function syncDragReveal(dock, x, y) {
    const monitor = Main.layoutManager.monitors[dock.monitorIndex];
    if (!monitor || typeof dock._onDragStart !== 'function')
        return;
    let distance;
    switch (dock._position) {
    case St.Side.TOP: distance = y - monitor.y; break;
    case St.Side.LEFT: distance = x - monitor.x; break;
    case St.Side.RIGHT: distance = monitor.x + monitor.width - 1 - x; break;
    default: distance = monitor.y + monitor.height - 1 - y;
    }
    const onMonitor = x >= monitor.x && x < monitor.x + monitor.width &&
        y >= monitor.y && y < monitor.y + monitor.height;

    if (!dockHolders.get(dock)?.has('drag')) {
        if (onMonitor && distance <= REVEAL_EDGE)
            holdDock(dock, 'drag');
    } else if (!onMonitor || distance > (dock._box?.height ?? 0) + RELEASE_MARGIN) {
        releaseDock(dock, 'drag');
    }
}

/* What is being dragged. Mutter keeps a client drag's offer as the DND
 * selection, so the Shell can read the file list itself -- no window of its
 * own has to receive the drop. Read once per drag, on first reaching the
 * trash, while the source is still offering it. */
function readDraggedFiles() {
    if (!drag || drag.reading || drag.uris || drag.fromDing)
        return;
    const selection = global.display.get_selection();
    const types = selection.get_mimetypes(Meta.SelectionType.SELECTION_DND);
    if (types.includes(DING_ICON_LIST)) {
        drag.fromDing = true;
        return;
    }
    if (!types.includes(URI_LIST))
        return;

    const current = drag;
    current.reading = true;
    const stream = Gio.MemoryOutputStream.new_resizable();
    selection.transfer_async(Meta.SelectionType.SELECTION_DND, URI_LIST, -1,
        stream, cancellable, (sel, res) => {
            current.reading = false;
            try {
                sel.transfer_finish(res);
                stream.close(null);
                const text = new TextDecoder().decode(stream.steal_as_bytes().toArray());
                // text/uri-list lines end in CRLF. A last piece with no line
                // ending means the source stopped mid-list: it may be a cut-off
                // path (a parent folder, a name prefix), so never trash it.
                const lines = text.split(/\r?\n/);
                lines.pop();
                current.uris = lines
                    .map(l => l.trim())
                    .filter(l => l.startsWith('file://'));
            } catch (e) {
                console.error(`[kiwi] reading the dragged files: ${e.message}`);
                return;
            }
            if (current.trashWhenRead)
                trashUris(current.uris);
        });
}

/* The drop had no target as far as the source knows, so Mutter slides the
 * drag icon back to where it came from. The file is going into the trash, not
 * home: hide the icon on release. Mutter destroys it once its own slide
 * finishes; anything still there afterwards gets its opacity back. */
function hideDragIcon() {
    const group = global.compositor.get_feedback_group();
    const icons = group.get_children();
    icons.forEach(a => (a.opacity = 0));
    later(1000, () => icons.forEach(a => {
        try {
            if (a.get_parent() === group)
                a.opacity = 255;
        } catch (_e) {
            // Already destroyed, as expected.
        }
    }));
}

// Through Files, so the move shows up in its undo history.
function trashUris(uris) {
    if (!uris?.length)
        return;
    Gio.DBus.session.call('org.gnome.Nautilus', '/org/gnome/Nautilus/FileOperations2',
        'org.gnome.Nautilus.FileOperations2', 'TrashURIs',
        new GLib.Variant('(asa{sv})', [uris, {}]), null,
        Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
            try {
                conn.call_finish(res);
            } catch (e) {
                console.error(`[kiwi] trashing dropped files: ${e.message}`);
            }
        });
}

function onDragMotion(x, y) {
    if (!dragging)
        return;
    let over = null;
    for (const dock of dockContainers()) {
        syncDragReveal(dock, x, y);
        const art = trashArtIn(dock);
        if (!art?.mapped)
            continue;
        const [ax, ay] = art.get_transformed_position();
        const [aw, ah] = art.get_transformed_size();
        if (x >= ax && x < ax + aw && y >= ay && y < ay + ah)
            over = art;
    }
    hover(over);
    if (over)
        readDraggedFiles();
}

function onDragEnd() {
    if (!dragging)
        return;
    dragging = false;

    // Let go over the trash: trash what was dragged. A drag cancelled with
    // Esc ends with the button still held, and is left alone, and so is one
    // that carries no files (text, a tab): its icon must still slide home.
    const [, , mods] = global.get_pointer();
    const released = !(mods & Clutter.ModifierType.BUTTON1_MASK);
    const hasFiles = drag && (drag.uris?.length || drag.reading);
    if (hoveredArt && released && hasFiles && !drag.fromDing) {
        hideDragIcon();
        if (drag.uris)
            trashUris(drag.uris);
        else
            drag.trashWhenRead = true;
    }
    drag = null;
    unhover();
    releaseAll('drag');
}

async function onAdded(files) {
    const dock = currentDock();
    const shown = files.slice(0, MAX_FLYERS);
    reveal(dock, REVEAL_MS + FLIGHT_MS + STAGGER_MS * shown.length + 320);

    const [px, py] = global.get_pointer();
    const icons = await Promise.all(shown.map(iconFor));
    if (!settings)
        return;

    later(REVEAL_MS, () => {
        const art = trashArtIn(dock);
        if (!art?.mapped)
            return;
        // Dropped on the trash itself: there is nowhere to fly from.
        const [ax, ay] = art.get_transformed_position();
        const [aw, ah] = art.get_transformed_size();
        const onTrash = px >= ax - aw / 2 && px <= ax + aw * 1.5 &&
            py >= ay - ah / 2 && py <= ay + ah * 1.5;
        if (!icons.length || onTrash) {
            gulp(art);
            playSound();
            return;
        }
        icons.forEach((gicon, i) => later(i * STAGGER_MS, () => {
            fly(gicon, { x: px, y: py }, art, () => {
                gulp(art);
                if (i === 0)
                    playSound();
            });
        }));
    });
}

function onEmptied() {
    const dock = currentDock();
    reveal(dock, REVEAL_MS + 640);
    later(REVEAL_MS, () => {
        const art = trashArtIn(dock);
        if (art?.mapped)
            bounce(art, 0.86, Clutter.AnimationMode.EASE_OUT_ELASTIC, 520);
        playSound();
    });
}

function onCount(newCount) {
    const old = count;
    const files = added;
    added = [];
    count = newCount;
    if (old === null || newCount === old)
        return;

    if (newCount > old)
        onAdded(files).catch(e => console.error(e));
    else if (newCount === 0)
        onEmptied();
}

function readCount() {
    trash.query_info_async(ITEM_COUNT, Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT, cancellable, (file, res) => {
            try {
                onCount(file.query_info_finish(res).get_attribute_uint32(ITEM_COUNT));
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error(`[kiwi] dock trash count: ${e.message}`);
            }
        });
}

export function enable(extSettings) {
    settings = extSettings;
    if (monitor)
        return;

    cancellable = new Gio.Cancellable();
    trash = Gio.File.new_for_uri(TRASH_URI);
    try {
        monitor = trash.monitor_directory(Gio.FileMonitorFlags.NONE, cancellable);
    } catch (e) {
        console.error(`[kiwi] cannot watch the trash: ${e.message}`);
        monitor = null;
        return;
    }
    monitorId = monitor.connect('changed', (_m, file, _other, event) => {
        if (event === Gio.FileMonitorEvent.CREATED || event === Gio.FileMonitorEvent.MOVED_IN)
            added.push(file);
        if (settleId)
            GLib.source_remove(settleId);
        settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            settleId = 0;
            readCount();
            return GLib.SOURCE_REMOVE;
        });
    });
    // The starting count, so the first change has something to compare with.
    readCount();

    const dnd = global.backend.get_dnd();
    dndIds = [
        dnd.connect('dnd-enter', () => {
            dragging = true;
            drag = { uris: null, fromDing: false, reading: false, trashWhenRead: false };
        }),
        dnd.connect('dnd-position-change', (_d, x, y) => onDragMotion(x, y)),
        dnd.connect('dnd-leave', () => onDragEnd()),
    ];
}

export function disable() {
    onDragEnd();
    const dnd = global.backend.get_dnd();
    dndIds.forEach(id => dnd.disconnect(id));
    dndIds = [];
    if (settleId) {
        GLib.source_remove(settleId);
        settleId = 0;
    }
    timers.forEach(id => GLib.source_remove(id));
    timers.clear();
    flyers.forEach(f => f.destroy());
    flyers.clear();
    if (hideId) {
        GLib.source_remove(hideId);
        hideId = 0;
    }
    releaseAll('trash');
    releaseAll('drag');
    cancellable?.cancel();
    cancellable = null;
    if (monitor) {
        monitor.disconnect(monitorId);
        monitor.cancel();
    }
    monitor = null;
    monitorId = 0;
    trash = null;
    count = null;
    added = [];
    settings = null;
}
