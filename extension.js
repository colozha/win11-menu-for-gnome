import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GnomeDesktop from 'gi://GnomeDesktop';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Taskbar, Clock} from './taskbar.js';
import {StartMenu} from './startMenu.js';
import {TrayReorder} from './reorder.js';
import * as U from './util.js';

const STYLE_KEYS = [
    'theme', 'accent-color', 'auto-contrast',
    'taskbar-color', 'taskbar-text-color', 'taskbar-opacity',
    'start-color', 'start-text-color', 'start-opacity',
];
const START_KEYS = ['start-pinned', 'show-recommended', 'all-apps-view', 'pinned-expanded', 'known-apps'];
const DEFAULT_START_PINS = [
    'org.gnome.Nautilus.desktop', 'org.gnome.Settings.desktop', 'org.gnome.TextEditor.desktop',
    'org.gnome.Calculator.desktop', 'org.gnome.Ptyxis.desktop', 'org.gnome.Console.desktop',
];

/** Acrylic: blur what's behind a translucent surface, so opacity reads as frosted glass, not ghosting. */
function setBlur(actor, on) {
    const has = actor.get_effect('w11-blur');
    if (on && !has) {
        actor.add_effect_with_name('w11-blur', new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, radius: 60, brightness: 0.9}));
        actor._w11BlurEvt = actor.connect('captured-event', () => {
            kickRedraw(actor);
            return Clutter.EVENT_PROPAGATE;
        });
    } else if (!on && has) {
        actor.remove_effect(has);
        actor.disconnect(actor._w11BlurEvt);
        actor._w11BlurEvt = 0;
        actor._w11BlurTl?.stop();
    }
}

/**
 * Background blur samples the whole actor area, but a hover only triggers a clipped redraw of the
 * hovered child; the rest of the framebuffer still holds last frame's content (old hover box
 * included), which then gets blurred in as a ghost. Repaint the whole actor briefly after input.
 */
function kickRedraw(actor) {
    if (!actor._w11BlurTl) {
        actor._w11BlurTl = new Clutter.Timeline({actor, duration: 300});
        actor._w11BlurTl.connect('new-frame', () => actor.queue_redraw());
    }
    actor._w11BlurTl.rewind();
    actor._w11BlurTl.start();
}

export default class Win11Extension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.wallClock = new GnomeDesktop.WallClock();
        this._themed = new Map(); // actor → surface ('taskbar' | 'start' | null)
        this._taskbars = [];
        this._resolveStyle();

        this._seedPins();
        this._updateKnown();

        this.startMenu = new StartMenu(this);
        this._hideTopBar();
        this._buildTaskbars();

        Shell.AppSystem.get_default().connectObject('installed-changed', () => this._updateKnown(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._buildTaskbars(), this);
        this.settings.connectObject('changed', (_s, key) => this._onSetting(key), this);
        this.iface.connectObject(
            'changed::color-scheme', () => this._applyStyle(),
            'changed::accent-color', () => this._applyStyle(),
            this);
        this._syncOverlayKey();
    }

    disable() {
        this._unblockOverlayKey();
        if (this._syncId)
            GLib.source_remove(this._syncId);
        this._syncId = 0;
        Shell.AppSystem.get_default().disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this.settings.disconnectObject(this);
        this.iface.disconnectObject(this);
        this._destroyTaskbars();
        this._showTopBar();
        this.startMenu.destroy();
        this.startMenu = null;
        this._themed = null;
        this._desktopShown = null;
        this.wallClock = null;
        this.iface = null;
        this.settings = null;
    }

    get primaryTaskbar() {
        return this._taskbars[Main.layoutManager.primaryIndex] ?? this._taskbars[0];
    }

    /**
     * Register a root actor so it gets .w11-dark / .w11-light now and on every theme change.
     * A `surface` ('taskbar' | 'start') with a custom background may get the other theme (auto contrast).
     */
    themeActor(actor, surface = null) {
        this._themed.set(actor, surface);
        actor.add_style_class_name(`w11-${this.themeFor(surface)}`);
        actor.connect('destroy', () => this._themed?.delete(actor));
    }

    /** Theme class for a surface: auto contrast against its custom background, else the global theme. */
    themeFor(surface) {
        const bg = surface ? this.settings.get_string(`${surface}-color`) : '';
        if (bg && this.settings.get_boolean('auto-contrast'))
            return U.contrastTheme(bg);
        return this.theme;
    }

    _onSetting(key) {
        if (STYLE_KEYS.includes(key)) {
            this._applyStyle();
        } else if (['taskbar-alignment', 'show-search-button', 'show-desktop-button'].includes(key)) {
            this._taskbars.forEach(t => t.syncLayout());
        } else if (key === 'taskbar-icon-size') {
            this._buildTaskbars();
        } else if (key === 'taskbar-pinned') {
            // Deferred: unpinning from a button's own menu destroys that button.
            this._syncId ||= GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._syncId = 0;
                this._taskbars.forEach(t => t.sync());
                return GLib.SOURCE_REMOVE;
            });
        } else if (key === 'super-opens-start') {
            this._syncOverlayKey();
        } else if (key === 'pins-seeded') {
            this._seedPins();
        }
        if (START_KEYS.includes(key))
            this.startMenu.markDirty();
    }

    // ---------- style ----------

    _resolveStyle() {
        this.theme = U.resolveTheme(this.settings.get_string('theme'), this.iface.get_string('color-scheme'));
        this.accent = this.settings.get_string('accent-color');
    }

    _applyStyle() {
        this._resolveStyle();
        for (const [a, surface] of this._themed) {
            a.remove_style_class_name('w11-dark');
            a.remove_style_class_name('w11-light');
            a.add_style_class_name(`w11-${this.themeFor(surface)}`);
        }
        const s = this.settings;
        const defaults = U.THEME_COLORS[this.theme];
        const taskbarBg = U.rgba(s.get_string('taskbar-color') || defaults.taskbar, s.get_int('taskbar-opacity'));
        const taskbarFg = s.get_string('taskbar-text-color');
        const taskbarBlur = s.get_int('taskbar-opacity') < 100;
        for (const t of this._taskbars) {
            t.set_style(`background-color: ${taskbarBg};${taskbarFg ? ` color: ${taskbarFg};` : ''}`);
            setBlur(t, taskbarBlur);
            t.syncAccent();
        }
        this.startMenu.setColors(U.rgba(s.get_string('start-color') || defaults.start, s.get_int('start-opacity')),
            s.get_string('start-text-color'));
        setBlur(this.startMenu.actor, s.get_int('start-opacity') < 100);
        this.startMenu.syncAccent();
        this.startMenu.markDirty();
    }

    // ---------- taskbars + tray ----------

    _buildTaskbars() {
        this.startMenu.close();
        this._destroyTaskbars();
        const primary = Main.layoutManager.primaryIndex;
        this._taskbars = Main.layoutManager.monitors.map((m, i) => new Taskbar(this, m, i === primary));
        if (this.primaryTaskbar)
            this._moveTray(this.primaryTaskbar);
        this._applyStyle();
    }

    _destroyTaskbars() {
        this._restoreTray();
        this._taskbars.forEach(t => t.destroy());
        this._taskbars = [];
    }

    _hideTopBar() {
        // Untracked, because trackFullscreen would show it again after any fullscreen window.
        const box = Main.layoutManager.panelBox;
        Main.layoutManager.untrackChrome(box);
        box.hide();
    }

    _showTopBar() {
        const box = Main.layoutManager.panelBox;
        box.show();
        Main.layoutManager.trackChrome(box, {affectsStruts: true, trackFullscreen: true});
    }

    _moveTray(taskbar) {
        // shortcut: the hidden Panel still owns these boxes in its allocate(); safe while panelBox stays hidden.
        this._trayMoves = [];
        for (const box of [Main.panel._rightBox, Main.panel._centerBox]) {
            const parent = box.get_parent();
            const index = parent.get_children().indexOf(box);
            parent.remove_child(box);
            taskbar.tray.add_child(box);
            this._trayMoves.push({box, parent, index});
            box.connectObject('child-added', () => this._setArrows(St.Side.BOTTOM), this);
        }
        this._setArrows(St.Side.BOTTOM);

        const dm = Main.panel.statusArea.dateMenu;
        if (dm?._clockDisplay) {
            dm._clockDisplay.hide();
            this._clock = new Clock(this);
            dm._clockDisplay.get_parent().insert_child_above(this._clock, dm._clockDisplay);
        }
        this._trayReorder = new TrayReorder(this.settings, taskbar.tray,
            {r: Main.panel._rightBox, c: Main.panel._centerBox});
    }

    _restoreTray() {
        if (!this._trayMoves)
            return;
        this._trayReorder?.destroy();
        this._trayReorder = null;
        this._clock?.destroy();
        this._clock = null;
        Main.panel.statusArea.dateMenu?._clockDisplay?.show();
        for (const {box, parent, index} of this._trayMoves.reverse()) {
            box.disconnectObject(this);
            box.get_parent()?.remove_child(box);
            parent.insert_child_at_index(box, index);
        }
        this._trayMoves = null;
        this._setArrows(St.Side.TOP);
    }

    _setArrows(side) {
        for (const item of Object.values(Main.panel.statusArea)) {
            const bp = item?.menu?._boxPointer;
            if (bp) {
                bp._arrowSide = side;
                bp._userArrowSide = side;
            }
        }
    }

    // ---------- show desktop ----------

    /** Minimize every visible window on this workspace; a second call brings them back. */
    toggleDesktop() {
        this.startMenu.close();
        const ws = global.workspace_manager.get_active_workspace();
        const wins = ws.list_windows();
        const visible = global.display.sort_windows_by_stacking(wins).filter(w =>
            !w.minimized && !w.skip_taskbar && w.can_minimize() &&
            w.get_window_type() !== Meta.WindowType.DESKTOP);
        if (visible.length) {
            this._desktopShown = {ws, wins: visible};
            visible.forEach(w => w.minimize());
            return;
        }
        if (this._desktopShown?.ws !== ws)
            return;
        const restore = this._desktopShown.wins.filter(w => wins.includes(w));
        this._desktopShown = null;
        restore.forEach(w => w.unminimize());
        if (restore.length)
            Main.activateWindow(restore.at(-1));
    }

    // ---------- Super key ----------

    _syncOverlayKey() {
        const want = this.settings.get_boolean('super-opens-start');
        if (want && !this._overlayHandler) {
            const handler = GObject.signal_handler_find(global.display, {signalId: 'overlay-key'});
            if (handler) {
                GObject.signal_handler_block(global.display, handler);
                this._overlayHandler = handler;
            }
            global.display.connectObject('overlay-key', () => this.startMenu.onOverlayKey(this.primaryTaskbar), this);
            // Start menu is modal in POPUP mode, where the shell filters overlay-key; allow it so Super can close the menu.
            Main.wm.allowKeybinding('overlay-key', Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);
        } else if (!want) {
            this._unblockOverlayKey();
        }
    }

    _unblockOverlayKey() {
        global.display.disconnectObject(this);
        Main.wm.allowKeybinding('overlay-key', Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        if (this._overlayHandler)
            GObject.signal_handler_unblock(global.display, this._overlayHandler);
        this._overlayHandler = 0;
    }

    // ---------- data ----------

    _seedPins() {
        const s = this.settings;
        if (s.get_boolean('pins-seeded'))
            return;
        const appSys = Shell.AppSystem.get_default();
        const exists = id => appSys.lookup_app(id);
        const favs = global.settings.get_strv('favorite-apps').filter(exists);
        s.set_strv('taskbar-pinned', ['org.gnome.Nautilus.desktop', ...favs]
            .filter((id, i, a) => exists(id) && a.indexOf(id) === i));
        s.set_strv('start-pinned', [...DEFAULT_START_PINS, ...favs]
            .filter((id, i, a) => exists(id) && a.indexOf(id) === i));
        s.set_boolean('pins-seeded', true);
    }

    _updateKnown() {
        const ids = Shell.AppSystem.get_default().get_installed()
            .filter(a => a.should_show())
            .map(a => a.get_id());
        const prev = this.settings.get_string('known-apps');
        this.known = U.updateKnownApps(U.parseKnown(prev), ids, Math.floor(Date.now() / 1000));
        const json = JSON.stringify(this.known);
        if (json !== prev)
            this.settings.set_string('known-apps', json);
    }
}
