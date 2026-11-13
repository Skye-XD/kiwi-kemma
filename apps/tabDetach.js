// SPDX-License-Identifier: GPL-3.0-or-later
// Drag a tab out of a libadwaita app (Ptyxis, Files, Text Editor, Web) and let
// go over another app's window: it opens in a window of its own, as on macOS.
//
// libadwaita detaches a tab only when the "root window" reads the
// application/x-rootwindow-drop it offers, and Mutter plays the root window
// only where no client surface is under the pointer
// (meta-wayland-data-device.c: drag_focus == NULL -> fake acceptance + fake
// read). Over another app's window that app gets the drop, refuses the type,
// and the tab stays put. Shell chrome under the pointer is "no surface" to
// Mutter -- the same thing that makes a drop on the dock reach no client -- so
// while such a drag is over a window of a different app, an invisible reactive
// actor covers the stage. The dragging app's own windows are left uncovered,
// so dropping onto one of them still moves the tab into that window.
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ROOTWINDOW_DROP = 'application/x-rootwindow-drop';
const DING_ICON_LIST = 'x-special/ding-icon-list';

let dndIds = [];
let shield = null;
let sourceApp = null;      // the app the tab is dragged out of; null: not a tab drag

function appOf(win) {
    return win ? Shell.WindowTracker.get_default().get_window_app(win) : null;
}

// The topmost visible window at a stage point, as the pointer sees it.
function windowAt(x, y) {
    const workspace = global.workspace_manager.get_active_workspace();
    const actors = global.get_window_actors();
    for (let i = actors.length - 1; i >= 0; i--) {
        const actor = actors[i];
        const win = actor.meta_window;
        if (!actor.visible || !win || win.minimized ||
            !(win.is_on_all_workspaces() || win.get_workspace() === workspace))
            continue;
        const r = win.get_frame_rect();
        if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
            return win;
    }
    return null;
}

function onEnter() {
    const types = global.display.get_selection().get_mimetypes(Meta.SelectionType.SELECTION_DND);
    // DING's own icons carry a root-window type too; the desktop handles those.
    sourceApp = types.includes(ROOTWINDOW_DROP) && !types.includes(DING_ICON_LIST)
        ? appOf(global.display.focus_window) ?? null
        : null;
}

function onMotion(x, y) {
    if (!sourceApp)
        return;
    const win = windowAt(x, y);
    const cover = !!win && appOf(win) !== sourceApp;
    if (cover && !shield) {
        shield = new Clutter.Actor({ reactive: true });
        shield.add_constraint(new Clutter.BindConstraint({
            source: global.stage, coordinate: Clutter.BindCoordinate.ALL,
        }));
        // Above the windows and below the panel, dock and the drag icon.
        Main.layoutManager.uiGroup.insert_child_above(shield, global.window_group);
    }
    shield?.set_reactive(cover);
}

function onLeave() {
    sourceApp = null;
    shield?.destroy();
    shield = null;
}

export function enable() {
    if (dndIds.length)
        return;
    const dnd = global.backend.get_dnd();
    dndIds = [
        dnd.connect('dnd-enter', () => onEnter()),
        dnd.connect('dnd-position-change', (_d, x, y) => onMotion(x, y)),
        dnd.connect('dnd-leave', () => onLeave()),
    ];
}

export function disable() {
    onLeave();
    const dnd = global.backend.get_dnd();
    dndIds.forEach(id => dnd.disconnect(id));
    dndIds = [];
}
