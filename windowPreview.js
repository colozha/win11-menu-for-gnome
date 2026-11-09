// Hover thumbnails above a taskbar button, one card per window.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const OPEN_DELAY = 400;
const CLOSE_DELAY = 300;
const THUMB_W = 220;
const THUMB_H = 130;
const PEEK_DELAY = 400;
const PEEK_FADE = 150;

export class WindowPreview {
    constructor(ext, taskbar) {
        this._ext = ext;
        this._taskbar = taskbar;
        this._button = null;
        this._timeout = 0;
        this._peekTimeout = 0;
        this._peeked = null;
        this._peekLayer = null;
        this._faded = new Set();

        this.actor = new St.BoxLayout({
            style_class: 'w11-preview',
            reactive: true,
            track_hover: true,
            visible: false,
        });
        ext.themeActor(this.actor);
        Main.layoutManager.addTopChrome(this.actor);
        this.actor.connect('notify::hover', () => {
            if (this.actor.hover)
                this._cancel();
            else
                this.scheduleClose();
        });
    }

    get isOpen() {
        return this.actor.visible;
    }

    scheduleOpen(button) {
        this._cancel();
        if (!button.windows().length)
            return;
        if (this.isOpen) {
            this.open(button);
            return;
        }
        this._timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OPEN_DELAY, () => {
            this._timeout = 0;
            this.open(button);
            return GLib.SOURCE_REMOVE;
        });
    }

    scheduleClose() {
        this._cancel();
        this._timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOSE_DELAY, () => {
            this._timeout = 0;
            this.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancel() {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = 0;
    }

    open(button) {
        this._cancel();
        const wins = button.windows();
        if (!wins.length) {
            this.close();
            return;
        }

        if (this._button !== button) {
            this._button?.app.disconnectObject(this);
            this._button = button;
            // Re-render on the next idle so a closing window's actor is gone.
            button.app.connectObject('windows-changed', () => {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this._button === button && this.isOpen)
                        this.open(button);
                    return GLib.SOURCE_REMOVE;
                });
            }, this);
        }

        if (this._peeked && !wins.includes(this._peeked))
            this._unpeek();
        this.actor.destroy_all_children();
        for (const win of wins)
            this.actor.add_child(this._card(win, button.app));

        const [bx] = button.get_transformed_position();
        const [bw] = button.get_transformed_size();
        const [, natW] = this.actor.get_preferred_width(-1);
        const [, natH] = this.actor.get_preferred_height(natW);
        const mon = this._taskbar.monitor;
        const gap = 8 * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const x = Math.max(mon.x + gap,
            Math.min(Math.round(bx + bw / 2 - natW / 2), mon.x + mon.width - natW - gap));
        this.actor.set_position(x, this._taskbar.y - natH - gap);

        if (!this.isOpen) {
            Main.layoutManager.uiGroup.set_child_above_sibling(this.actor, null);
            this.actor.set({visible: true, opacity: 0, translation_y: gap});
            this.actor.ease({
                opacity: 255,
                translation_y: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    close() {
        this._cancel();
        this._unpeek();
        this._button?.app.disconnectObject(this);
        this._button = null;
        if (!this.isOpen)
            return;
        this.actor.ease({
            opacity: 0,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this.actor.hide();
                this.actor.destroy_all_children();
            },
        });
    }

    _card(win, app) {
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const card = new St.Button({style_class: 'w11-card', can_focus: true, track_hover: true});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        card.set_child(box);

        const header = new St.BoxLayout({style_class: 'w11-card-header'});
        header.add_child(app.create_icon_texture(16));
        const title = new St.Label({
            text: win.get_title() || app.get_name(),
            style_class: 'w11-card-title',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add_child(title);
        const close = new St.Button({
            style_class: 'w11-card-close',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
            opacity: 0,
            accessible_name: 'Close window',
        });
        close.connect('clicked', () => win.delete(global.get_current_time()));
        header.add_child(close);
        box.add_child(header);

        const thumb = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: THUMB_W * sf,
            height: THUMB_H * sf,
        });
        const wa = win.get_compositor_private();
        if (wa?.width && wa?.height) {
            const s = Math.min(THUMB_W * sf / wa.width, THUMB_H * sf / wa.height, 1);
            thumb.add_child(new Clutter.Clone({
                source: wa,
                width: Math.round(wa.width * s),
                height: Math.round(wa.height * s),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        box.add_child(thumb);

        card.connect('notify::hover', () => {
            close.opacity = card.hover ? 255 : 0;
            this._schedulePeek(card.hover ? win : null);
        });
        card.connect('clicked', () => {
            Main.activateWindow(win);
            this.close();
        });
        return card;
    }

    // ---------- peek: hovering a card shows that window, other windows fade out ----------

    _schedulePeek(win) {
        this._cancelPeek();
        // Already peeking: switch instantly between cards, like Windows.
        if (win && this._peeked) {
            this._peek(win);
            return;
        }
        this._peekTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, win ? PEEK_DELAY : 100, () => {
            this._peekTimeout = 0;
            if (win)
                this._peek(win);
            else
                this._unpeek();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPeek() {
        if (this._peekTimeout)
            GLib.source_remove(this._peekTimeout);
        this._peekTimeout = 0;
    }

    _peek(win) {
        const target = win.get_compositor_private();
        if (!target)
            return;
        this._peeked = win;
        for (const a of global.get_window_actors()) {
            if (this._faded.has(a) || a.meta_window.get_window_type() === Meta.WindowType.DESKTOP)
                continue;
            this._faded.add(a);
            a.ease({opacity: 0, duration: PEEK_FADE, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        // A clone works for minimized windows and other workspaces too; clones ignore the source's opacity.
        this._peekLayer?.destroy();
        this._peekLayer = new Clutter.Clone({source: target, x: target.x, y: target.y, opacity: 0});
        Main.layoutManager.uiGroup.insert_child_above(this._peekLayer, global.window_group);
        this._peekLayer.ease({opacity: 255, duration: PEEK_FADE, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _unpeek() {
        this._cancelPeek();
        this._peekLayer?.destroy();
        this._peekLayer = null;
        this._peeked = null;
        const alive = new Set(global.get_window_actors());
        for (const a of this._faded) {
            if (alive.has(a))
                a.ease({opacity: 255, duration: PEEK_FADE, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._faded.clear();
    }

    destroy() {
        this._cancel();
        this._unpeek();
        this._button?.app.disconnectObject(this);
        this.actor.destroy();
    }
}
