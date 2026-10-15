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
let revealed = new Set();
let hideId = 0;
let timers = new Set();
let flyers = new Set();

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

/* Bring the dock up the way Dash-to-Dock does for its own drags, and keep it
 * there until the animations are over. */
function reveal(dock, holdMs) {
    if (!dock || typeof dock._onDragStart !== 'function')
        return;
    if (!revealed.has(dock)) {
        revealed.add(dock);
        dock._onDragStart();
    }
    if (hideId)
        GLib.source_remove(hideId);
    hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, holdMs + LINGER_MS, () => {
        hideId = 0;
        for (const d of revealed) {
            try {
                d._onDragEnd();
            } catch (e) {
                console.error(e);
            }
        }
        revealed.clear();
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
}

export function disable() {
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
    for (const d of revealed) {
        try {
            d._onDragEnd();
        } catch (_e) {
            // The dock went away first.
        }
    }
    revealed.clear();
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
