// Bottom taskbar: Start, Search, pinned + running apps, tray slot.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {WindowPreview} from './windowPreview.js';
import {makeMenu, openMenu, addPinItem} from './menu.js';
import * as U from './util.js';
import {ReorderItem, ReorderGroup} from './reorder.js';

const HEIGHT = 48;
// First installed one wins.
const SYSTEM_MONITORS = [
    'org.gnome.SystemMonitor.desktop', 'gnome-system-monitor.desktop',
    'io.missioncenter.MissionCenter.desktop', 'net.nokyan.Resources.desktop',
];
const TERMINALS = [
    'org.gnome.Ptyxis.desktop', 'org.gnome.Console.desktop', 'org.gnome.Terminal.desktop',
];

const firstApp = ids => ids.map(id => Shell.AppSystem.get_default().lookup_app(id)).find(Boolean);

const appWindows = app => app.get_windows().filter(w => !w.skip_taskbar);

export const Clock = GObject.registerClass(
class Clock extends St.Bin {
    _init(ext) {
        super._init({style_class: 'w11-clock', y_align: Clutter.ActorAlign.CENTER});
        this._ext = ext;
        this._label = new St.Label({style_class: 'w11-clock-line', x_align: Clutter.ActorAlign.END});
        this.set_child(this._label);
        const sync = () => this._sync();
        ext.wallClock.connectObject('notify::clock', sync, this);
        ext.iface.connectObject('changed::clock-format', sync, this);
        ext.settings.connectObject('changed::clock-style', sync, 'changed::clock-custom-format', sync, this);
        this._sync();
    }

    _sync() {
        const s = this._ext.settings;
        const h12 = this._ext.iface.get_string('clock-format') === '12h';
        const fmt = U.clockFormat(s.get_string('clock-style'), h12, s.get_string('clock-custom-format'));
        this._label.text = GLib.DateTime.new_now_local().format(fmt) ?? '';
    }
});

const AppButton = GObject.registerClass(
class AppButton extends St.Button {
    _init(taskbar, app) {
        super._init({
            style_class: 'w11-tb-button',
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: app.get_name(),
            style: taskbar.buttonStyle,
        });
        this.app = app;
        this._taskbar = taskbar;
        this._ext = taskbar.ext;

        const box = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        const icon = app.create_icon_texture(taskbar.iconSize);
        icon.set({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(icon);
        this._indicator = new St.Widget({
            style_class: 'w11-indicator',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            // BinLayout only honors END alignment on expanding children.
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this._indicator);
        this.set_child(box);

        app.connectObject('windows-changed', () => {
            this.sync();
            taskbar.queueIconGeometry();
        }, this);
        new ReorderItem(this, {
            group: taskbar.reorder,
            key: app.get_id(),
            onBegin: () => {
                taskbar.dragging = true;
                taskbar.preview.close();
            },
            onEnd: () => {
                taskbar.dragging = false;
            },
        });
        this.connect('notify::hover', () => {
            if (this.hover && !taskbar.dragging)
                taskbar.preview.scheduleOpen(this);
            else
                taskbar.preview.scheduleClose();
        });
        this.connect('clicked', (_b, button) => this._onClicked(button));
        this.sync();
    }

    windows() {
        return appWindows(this.app).sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
    }

    sync() {
        const wins = this.windows();
        const focusWin = global.display.focus_window;
        const focused = wins.some(w => w === focusWin || w === focusWin?.get_transient_for());
        this._indicator.visible = wins.length > 0;
        for (const a of [this, this._indicator]) {
            if (focused)
                a.add_style_class_name('w11-focused');
            else
                a.remove_style_class_name('w11-focused');
        }
        if (wins.some(w => w.demands_attention || w.urgent) && !focused)
            this.add_style_class_name('w11-attention');
        else
            this.remove_style_class_name('w11-attention');
        const accent = this._ext.accent;
        this._indicator.set_style(focused && accent ? `background-color: ${accent};` : null);
    }

    /** Tell mutter where this button is, so minimize animates into it instead of the top-left corner. */
    updateIconGeometry() {
        if (!this.mapped)
            return;
        const [x, y] = this.get_transformed_position();
        const [width, height] = this.get_transformed_size();
        const rect = new Mtk.Rectangle({
            x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height),
        });
        // Every monitor has its own taskbar; each one claims only the windows on its monitor.
        const monitor = this._taskbar.monitor.index;
        for (const w of this.windows()) {
            if (w.get_monitor() === monitor)
                w.set_icon_geometry(rect);
        }
    }

    _onClicked(button) {
        const preview = this._taskbar.preview;
        if (button === Clutter.BUTTON_SECONDARY) {
            preview.close();
            this._openMenu();
            return;
        }
        if (button === Clutter.BUTTON_MIDDLE) {
            preview.close();
            this.app.open_new_window(-1);
            return;
        }
        const wins = this.windows();
        if (wins.length === 0) {
            this.app.activate();
        } else if (wins.length === 1) {
            preview.close();
            const [w] = wins;
            if (w.has_focus() && !w.minimized)
                w.minimize();
            else
                Main.activateWindow(w);
        } else {
            preview.open(this);
        }
    }

    _openMenu() {
        this._menu ??= makeMenu(this._ext, this, this._taskbar.menuManager);
        const menu = this._menu;
        menu.removeAll();
        menu.addAction(this.app.get_name(), () => this.app.open_new_window(-1), this.app.get_icon());
        if (this.windows().length && this.app.can_open_new_window())
            menu.addAction('New window', () => this.app.open_new_window(-1), 'window-new-symbolic');
        if (this.app.get_app_info()) {
            addPinItem(menu, this._ext.settings, 'taskbar-pinned', this.app.get_id(),
                'Pin to taskbar', 'Unpin from taskbar');
        }
        const wins = this.windows();
        if (wins.length) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction(wins.length > 1 ? 'Close all windows' : 'Close window',
                () => wins.forEach(w => w.delete(global.get_current_time())),
                'window-close-symbolic');
        }
        openMenu(menu);
    }
});

export const Taskbar = GObject.registerClass(
class Taskbar extends St.Widget {
    _init(ext, monitor, isPrimary) {
        // [show desktop] [content: apps over tray] [show desktop]
        super._init({
            style_class: 'w11-taskbar',
            reactive: true,
            layout_manager: new Clutter.BoxLayout(),
        });
        this.ext = ext;
        this.monitor = monitor;
        ext.themeActor(this, 'taskbar');
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.preview = new WindowPreview(ext, this);
        this._order = [];
        this._buttons = new Map();

        this.iconSize = ext.settings.get_int('taskbar-icon-size');
        const buttonSize = this.iconSize + 16;
        this.buttonStyle = `width: ${buttonSize}px; height: ${buttonSize}px;`;

        this._deskLeft = this._desktopButton('w11-show-desktop-left');
        this.add_child(this._deskLeft);
        const content = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this.add_child(content);
        this._deskRight = this._desktopButton('w11-show-desktop-right');
        this.add_child(this._deskRight);

        // Fills the full height so Start (and the other buttons) can take edge clicks.
        this._appsBox = new St.BoxLayout({style_class: 'w11-apps', x_expand: true, y_expand: true});
        content.add_child(this._appsBox);

        this._startIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${ext.path}/icons/start-symbolic.svg`),
            icon_size: this.iconSize,
            style_class: 'w11-start-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Hit area = full taskbar height, plus the left gutter when left-aligned (Fitts: slam the corner).
        this._startButton = new St.Button({
            style_class: 'w11-start-hit',
            can_focus: true,
            y_expand: true,
            accessible_name: 'Start',
            child: new St.Bin({
                style_class: 'w11-tb-button w11-start-inner',
                style: this.buttonStyle,
                y_align: Clutter.ActorAlign.CENTER,
                child: this._startIcon,
            }),
        });
        this._startButton.connect('clicked', () => ext.startMenu.toggle(this));
        this._appsBox.add_child(this._startButton);

        this._searchButton = this._iconButton(
            new St.Icon({
                icon_name: 'system-search-symbolic',
                icon_size: Math.round(this.iconSize * 5 / 6),
                style_class: 'w11-search-icon',
            }),
            'Search', () => ext.startMenu.toggle(this, true));
        this._appsBox.add_child(this._searchButton);
        this._appList = new St.BoxLayout({style_class: 'w11-apps', y_align: Clutter.ActorAlign.CENTER});
        this._appsBox.add_child(this._appList);
        this.reorder = new ReorderGroup({
            container: this._appList,
            items: () => this._appList.get_children().map(actor => ({actor, key: actor.app.get_id()})),
            order: (keys, src, dst) => this.previewOrder(keys, src, dst),
            onDrop: (src, dst) => this.moveApp(src, dst),
        });

        // shortcut: apps and tray can overlap when a narrow monitor has many apps; add overflow if it bites.
        this.tray = new St.BoxLayout({
            style_class: 'w11-tray',
            // Clutter only emits captured-event on reactive actors; TrayReorder listens here.
            reactive: true,
            x_align: Clutter.ActorAlign.END,
            y_expand: true,
            x_expand: true,
        });
        content.add_child(this.tray);
        if (!isPrimary)
            this.tray.add_child(new Clock(ext));

        // Context menus anchor here, at the pointer.
        this._menuAnchor = new St.Widget({width: 1, height: 1});
        Main.uiGroup.add_child(this._menuAnchor);
        this.connect('button-press-event', (_a, event) => this._onButtonPress(event));

        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const h = Math.max(HEIGHT, buttonSize + 8) * sf;
        this.set_position(monitor.x, monitor.y + monitor.height - h);
        this.set_size(monitor.width, h);
        Main.layoutManager.addChrome(this, {affectsStruts: true, trackFullscreen: true});

        Shell.AppSystem.get_default().connectObject('app-state-changed', () => this.sync(), this);
        global.display.connectObject(
            'notify::focus-window', () => this._syncStates(),
            'window-demands-attention', () => this._syncStates(),
            'window-marked-urgent', () => this._syncStates(),
            'window-entered-monitor', () => this.queueIconGeometry(),
            this);
        this._appList.connect('notify::allocation', () => this.queueIconGeometry());
        this.connect('notify::mapped', () => this.queueIconGeometry());
        this.connect('destroy', () => {
            if (this._iconGeometryLater)
                global.compositor.get_laters().remove(this._iconGeometryLater);
            this.preview.destroy();
            this._menuAnchor.destroy();
        });

        this.syncLayout();
        this.sync();
    }

    _iconButton(icon, name, onClick) {
        const b = new St.Button({
            style_class: 'w11-tb-button',
            style: this.buttonStyle,
            child: icon,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: name,
        });
        b.connect('clicked', onClick);
        return b;
    }

    _desktopButton(side) {
        const b = new St.Button({
            style_class: `w11-show-desktop ${side}`,
            can_focus: true,
            y_expand: true,
            accessible_name: 'Show desktop',
        });
        b.connect('clicked', () => this.ext.toggleDesktop());
        return b;
    }

    _onButtonPress(event) {
        if (event.get_button() !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;
        // Buttons (apps, Start, Search, show desktop) and tray items handle their own right-click
        // and let the press bubble; opening our menu here would grab input and swallow their release.
        const target = global.stage.get_event_actor(event);
        if (target !== this.tray && this.tray.contains(target))
            return Clutter.EVENT_PROPAGATE;
        for (let a = target; a && a !== this; a = a.get_parent()) {
            if (a instanceof St.Button)
                return Clutter.EVENT_PROPAGATE;
        }
        const [x] = event.get_coords();
        this._openContextMenu(x);
        return Clutter.EVENT_STOP;
    }

    _openContextMenu(x) {
        this.preview.close();
        this._contextMenu ??= makeMenu(this.ext, this._menuAnchor, this.menuManager);
        const menu = this._contextMenu;
        menu.removeAll();

        const monitorApp = firstApp(SYSTEM_MONITORS);
        if (monitorApp)
            menu.addAction('Task Manager', () => monitorApp.activate(), 'utilities-system-monitor-symbolic');
        const terminal = firstApp(TERMINALS);
        if (terminal)
            menu.addAction('Terminal', () => terminal.open_new_window(-1), 'utilities-terminal-symbolic');
        menu.addAction('Show desktop', () => this.ext.toggleDesktop(), 'user-desktop-symbolic');
        menu.addAction('Activities overview', () => Main.overview.toggle(), 'view-app-grid-symbolic');

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settings = firstApp(['org.gnome.Settings.desktop']);
        if (settings)
            menu.addAction('Settings', () => settings.activate(), 'emblem-system-symbolic');
        menu.addAction('Taskbar settings', () => this.ext.openPreferences(), 'preferences-system-symbolic');

        this._menuAnchor.set_position(Math.round(x), this.y);
        openMenu(menu);
    }

    syncLayout() {
        const s = this.ext.settings;
        const center = s.get_string('taskbar-alignment') === 'center';
        this._appsBox.x_align = center ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START;
        if (center)
            this._startButton.remove_style_class_name('w11-edge');
        else
            this._startButton.add_style_class_name('w11-edge');
        this._searchButton.visible = s.get_boolean('show-search-button');
        const desk = s.get_string('show-desktop-button');
        this._deskLeft.visible = desk === 'left';
        this._deskRight.visible = desk === 'right';
        this.syncAccent();
    }

    syncAccent() {
        const accent = this.ext.accent;
        this._startIcon.set_style(accent ? `color: ${accent};` : null);
        this._syncStates();
    }

    sync() {
        const appSys = Shell.AppSystem.get_default();
        const running = appSys.get_running().filter(a => appWindows(a).length).map(a => a.get_id());
        this._order = this._order.filter(id => running.includes(id));
        for (const id of running) {
            if (!this._order.includes(id))
                this._order.push(id);
        }
        const pinned = this.ext.settings.get_strv('taskbar-pinned').filter(id => appSys.lookup_app(id));
        const ids = [...pinned, ...this._order.filter(id => !pinned.includes(id))];

        for (const [id, btn] of this._buttons) {
            if (!ids.includes(id)) {
                btn.destroy();
                this._buttons.delete(id);
            }
        }
        ids.forEach((id, i) => {
            let btn = this._buttons.get(id);
            if (!btn) {
                const app = appSys.lookup_app(id) ?? appSys.get_running().find(a => a.get_id() === id);
                if (!app)
                    return;
                btn = new AppButton(this, app);
                this._buttons.set(id, btn);
                this._appList.add_child(btn);
            }
            this._appList.set_child_at_index(btn, i);
        });
    }

    /**
     * Drop `src` onto `dst`. Pinned apps reorder the pin list, running ones the session order;
     * a drop across the two groups lands at the edge of the dragged app's own group.
     */
    moveApp(src, dst) {
        const s = this.ext.settings;
        const pins = s.get_strv('taskbar-pinned');
        const next = U.moveInGroups(pins, this._order, src, dst);
        if (next.pins !== pins)
            s.set_strv('taskbar-pinned', next.pins);
        this._order = next.running;
        this.sync();
    }

    /** The shown order (`keys`) after dropping `src` on `dst`: what moveApp would produce. */
    previewOrder(keys, src, dst) {
        const pins = keys.filter(id => this._isPinned(id));
        const next = U.moveInGroups(pins, keys.filter(id => !pins.includes(id)), src, dst);
        return [...next.pins, ...next.running];
    }

    _isPinned(id) {
        return this.ext.settings.get_strv('taskbar-pinned').includes(id);
    }

    /** Batch icon-geometry updates to once per frame, after layout has settled. */
    queueIconGeometry() {
        this._iconGeometryLater ??= global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._iconGeometryLater = null;
            for (const btn of this._buttons.values())
                btn.updateIconGeometry();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncStates() {
        for (const btn of this._buttons.values())
            btn.sync();
    }
});
