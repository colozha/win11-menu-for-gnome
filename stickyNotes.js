// Sticky notes drawn by the shell itself, so they keep their place across logins
// (Wayland apps cannot restore their own window positions).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import {makeMenu, openMenu} from './menu.js';
import * as U from './util.js';

const DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'win11-menu']);
const FILE = GLib.build_filenamev([DIR, 'sticky-notes.json']);
const SAVE_DELAY = 500;
const CASCADE = 24;

export class StickyNotes {
    constructor(ext) {
        this._ext = ext;
        this._notes = this._load();
        this._actors = new Map(); // id → Note, only for visible notes
        this.menuManager = new PopupMenu.PopupMenuManager(Main.layoutManager.uiGroup);

        // Desktop layer: inside the background group, because mutter restacks every other
        // window_group child above the windows; background actors are kept at its bottom.
        this._bg = Main.layoutManager._backgroundGroup;
        this._desktop = new Clutter.Actor();
        this._bg.add_child(this._desktop);
        this._bg.connectObject('child-added', () => this._bg.set_child_above_sibling(this._desktop, null), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._actors.forEach(n => n.place()), this);

        this._notes.filter(n => !n.hidden).forEach(n => this._mount(n));
    }

    destroy() {
        this._flush();
        this._bg.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._actors.forEach(n => n.unmount());
        this._actors.clear();
        this._desktop.destroy();
    }

    // ---------- API for the taskbar ----------

    list() {
        return this._notes;
    }

    create(near = null) {
        const areas = workAreas();
        const prim = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const w = 300, h = 300;
        let x, y;
        if (near) {
            x = near.x + near.w + 12;
            y = near.y;
        } else {
            const step = (this._notes.length % 8) * CASCADE;
            x = prim.x + Math.round((prim.width - w) / 2) + step;
            y = prim.y + Math.round((prim.height - h) / 2) + step;
        }
        const note = {
            id: GLib.uuid_string_random(), text: '', color: near?.color ?? 'yellow',
            ...U.clampRect({x, y, w, h}, areas),
            hidden: false, onTop: false, modified: Date.now(),
        };
        this._notes.push(note);
        this.save();
        this._mount(note).focus();
    }

    show(id) {
        const note = this._notes.find(n => n.id === id);
        if (!note)
            return;
        if (note.hidden) {
            note.hidden = false;
            this.save();
        }
        const actor = this._actors.get(id) ?? this._mount(note);
        actor.raise();
        actor.focus();
    }

    setAllHidden(hidden) {
        for (const n of this._notes) {
            if (n.hidden !== hidden)
                hidden ? this.hide(n.id, false) : this.show(n.id);
        }
        this.save();
    }

    hide(id, save = true) {
        const note = this._notes.find(n => n.id === id);
        if (!note)
            return;
        note.hidden = true;
        this._actors.get(id)?.unmount();
        this._actors.delete(id);
        if (save)
            this.save();
    }

    delete(id) {
        this._actors.get(id)?.unmount();
        this._actors.delete(id);
        this._notes = this._notes.filter(n => n.id !== id);
        this.save();
    }

    setOnTop(id, onTop) {
        const note = this._notes.find(n => n.id === id);
        note.onTop = onTop;
        this.save();
        this._actors.get(id).unmount();
        this._mount(note).focus();
    }

    // ---------- layers ----------

    /** Parent a note on its layer. Pinned notes sit above windows but below the overview. */
    attach(actor, onTop) {
        if (onTop) {
            Main.layoutManager.addChrome(actor, {trackFullscreen: true});
            Main.layoutManager.uiGroup.set_child_below_sibling(actor, Main.layoutManager.overviewGroup);
        } else {
            this._desktop.add_child(actor);
        }
    }

    detach(actor, onTop) {
        if (onTop)
            Main.layoutManager.removeChrome(actor);
        else
            this._desktop.remove_child(actor);
    }

    raise(actor, onTop) {
        if (onTop)
            Main.layoutManager.uiGroup.set_child_below_sibling(actor, Main.layoutManager.overviewGroup);
        else
            this._desktop.set_child_above_sibling(actor, null);
    }

    _mount(note) {
        const actor = new Note(this, note);
        this._actors.set(note.id, actor);
        return actor;
    }

    // ---------- storage ----------

    _load() {
        let json;
        try {
            const [, bytes] = GLib.file_get_contents(FILE);
            json = new TextDecoder().decode(bytes);
        } catch {
            return []; // first run
        }
        const notes = U.parseNotes(json);
        if (notes === null) {
            // Never overwrite a file we could not read; keep it for recovery.
            const bak = `${FILE}.${Date.now()}.bak`;
            GLib.rename(FILE, bak);
            console.warn(`win11-menu: unreadable ${FILE}, moved to ${bak}`);
            return [];
        }
        return notes;
    }

    /** Debounced write; `now` skips the delay. */
    save(now = true) {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = 0;
        if (now) {
            this._write();
            return;
        }
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY, () => {
            this._saveId = 0;
            this._write();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flush() {
        if (this._saveId)
            this.save(true);
    }

    _write() {
        try {
            GLib.mkdir_with_parents(DIR, 0o700);
            const json = JSON.stringify({v: 1, notes: this._notes}, null, 1);
            GLib.file_set_contents(FILE, new TextEncoder().encode(json));
        } catch (e) {
            console.error(`win11-menu: could not save sticky notes: ${e.message}`);
        }
    }
}

function workAreas() {
    return Main.layoutManager.monitors.map((_m, i) => Main.layoutManager.getWorkAreaForMonitor(i));
}

const Note = GObject.registerClass(
class Note extends St.Widget {
    _init(manager, data) {
        // Bin: the content column, with the resize grip overlaid on its bottom-right corner.
        super._init({style_class: 'w11-note', layout_manager: new Clutter.BinLayout(), reactive: true});
        const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true});
        this.add_child(column);
        this._mgr = manager;
        this._data = data;

        // Header: drag handle with the note's actions.
        this._header = new St.BoxLayout({style_class: 'w11-note-header', reactive: true});
        this._header.add_child(this._button('list-add-symbolic', 'New note', () => this._mgr.create(this._data)));
        this._header.add_child(new St.Widget({x_expand: true}));
        this._pin = this._button('view-pin-symbolic', data.onTop ? 'Unpin from top' : 'Pin on top',
            () => this._mgr.setOnTop(data.id, !data.onTop));
        this._pin.toggle_mode = true;
        this._pin.checked = data.onTop;
        this._header.add_child(this._pin);
        this._more = this._button('view-more-symbolic', 'More options', () => this._openMenu());
        this._header.add_child(this._more);
        this._header.add_child(this._button('window-close-symbolic', 'Hide note', () => this._mgr.hide(data.id)));
        column.add_child(this._header);

        // Body: wrapping multi-line plain text that scrolls when it outgrows the note.
        this._entry = new St.Entry({style_class: 'w11-note-entry', hint_text: 'Take a note…', can_focus: true});
        const ct = this._entry.clutter_text;
        ct.set({single_line_mode: false, line_wrap: true, activatable: false});
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR; // long paths and URLs still wrap
        ct.text = data.text;
        ct.connect('text-changed', () => {
            data.text = ct.text;
            data.modified = Date.now();
            this._mgr.save(false);
        });
        ct.connect('cursor-changed', () => this._revealCursor());
        ct.connect('key-press-event', (_a, e) => {
            const key = e.get_key_symbol();
            if (key === Clutter.KEY_Escape) {
                global.stage.set_key_focus(null);
                return Clutter.EVENT_STOP;
            }
            // ClutterText only inserts a newline when the key event carries '\r' as its unicode.
            if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter].includes(key)) {
                ct.delete_selection();
                ct.insert_unichar('\n');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, reactive: true});
        content.add_child(this._entry);
        this._scroll = new St.ScrollView({
            style_class: 'w11-note-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            y_expand: true,
            child: content,
        });
        column.add_child(this._scroll);

        this._grip = new St.Widget({
            style_class: 'w11-note-grip', reactive: true, track_hover: true,
            x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.END,
        });
        this._grip.set_cursor_type(Clutter.CursorType.SE_RESIZE);
        this.add_child(this._grip);

        this._header.connect('event', (_a, e) => this._onDragEvent(e, 'move'));
        this._grip.connect('event', (_a, e) => this._onDragEvent(e, 'resize'));
        // Any press brings the note to the front of its layer; clicks in the body edit.
        this.connect('button-press-event', () => {
            this.raise();
            return Clutter.EVENT_PROPAGATE;
        });
        // The entry is only as tall as its text (St centers taller entries); a click on the
        // empty space below it continues the note at the end.
        this._scroll.connect('button-press-event', (_a, e) => {
            if (!this._entry.contains(global.stage.get_event_actor(e))) {
                this.focus();
                this._entry.clutter_text.cursor_position = -1;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._applyColor();
        this.place();
        this._mgr.attach(this, data.onTop);
    }

    _button(icon, name, cb) {
        const b = new St.Button({
            style_class: 'w11-note-btn', can_focus: true, accessible_name: name,
            child: new St.Icon({icon_name: icon, icon_size: 16}),
        });
        b.connect('clicked', cb);
        return b;
    }

    // ---------- geometry ----------

    /** Position from saved data, clamped to the current monitors (saved data untouched). */
    place() {
        const d = this._data;
        const r = U.clampRect({x: d.x, y: d.y, w: d.w, h: d.h}, workAreas());
        this.set_position(r.x, r.y);
        this.set_size(r.w, r.h);
    }

    raise() {
        this._mgr.raise(this, this._data.onTop);
    }

    /** Deferred: a closing popup menu restores its previous key focus after our callback. */
    focus() {
        this._focusId ||= GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusId = 0;
            this._entry.clutter_text.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    unmount() {
        if (this._focusId)
            GLib.source_remove(this._focusId);
        this._focusId = 0;
        this._endDrag();
        this._mgr.detach(this, this._data.onTop);
        this.destroy();
    }

    _onDragEvent(event, mode) {
        const type = event.type();
        if (!this._drag) {
            if (type !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            // Header buttons handle their own clicks.
            if (mode === 'move' && global.stage.get_event_actor(event) !== this._header)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            const handle = mode === 'move' ? this._header : this._grip;
            this.raise();
            this._drag = {mode, x, y, x0: this.x, y0: this.y, w0: this.width, h0: this.height,
                grab: global.stage.grab(handle)};
            return Clutter.EVENT_STOP;
        }
        if (this._drag.mode !== mode)
            return Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.MOTION) {
            const [x, y] = event.get_coords();
            const {x0, y0, w0, h0} = this._drag;
            const dx = Math.round(x - this._drag.x), dy = Math.round(y - this._drag.y);
            const r = mode === 'move'
                ? {x: x0 + dx, y: y0 + dy, w: w0, h: h0}
                : {x: x0, y: y0, w: Math.max(U.NOTE_MIN.w, w0 + dx), h: Math.max(U.NOTE_MIN.h, h0 + dy)};
            const c = U.clampRect(r, workAreas());
            this.set_position(c.x, c.y);
            this.set_size(c.w, c.h);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._endDrag();
            Object.assign(this._data, {x: this.x, y: this.y, w: this.width, h: this.height});
            this._mgr.save();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            this._endDrag();
            this.place(); // cancelled: back to the saved spot
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        this._drag?.grab.dismiss();
        this._drag = null;
    }

    _revealCursor() {
        const ct = this._entry.clutter_text;
        const [ok, , cy, lineH] = ct.position_to_coords(ct.cursor_position);
        if (!ok)
            return;
        const [, top] = ct.get_transformed_position();
        const [, viewTop] = this._scroll.get_transformed_position();
        const adj = this._scroll.vadjustment;
        const y = top - viewTop + adj.value + cy; // cursor y in content coordinates
        const view = adj.page_size;
        if (y < adj.value)
            adj.value = y;
        else if (y + lineH > adj.value + view)
            adj.value = y + lineH - view;
    }

    // ---------- color + menu ----------

    _applyColor() {
        const c = U.noteColor(this._data.color);
        this.set_style(`background-color: ${c.body}; color: ${c.text};`);
        this._header.set_style(`background-color: ${c.header};`);
        this._entry.set_style(`color: ${c.text}; caret-color: ${c.text}; selected-color: ${c.text};`);
        this.remove_style_class_name('w11-note-dark');
        if (c.id === 'charcoal')
            this.add_style_class_name('w11-note-dark');
    }

    _setColor(id) {
        this._data.color = id;
        this._data.modified = Date.now();
        this._applyColor();
        this._mgr.save();
    }

    _openMenu() {
        this._menu ??= makeMenu(this._mgr._ext, this._more, this._mgr.menuManager);
        const menu = this._menu;
        menu.removeAll();

        const swatches = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const row = new St.BoxLayout({style_class: 'w11-note-swatches', x_expand: true});
        for (const c of U.NOTE_COLORS) {
            const active = c.id === this._data.color;
            const b = new St.Button({
                style_class: `w11-note-swatch${active ? ' w11-active' : ''}`,
                style: `background-color: ${c.body};`,
                can_focus: true,
                accessible_name: c.name,
                child: active ? new St.Icon({icon_name: 'object-select-symbolic', icon_size: 12, style: `color: ${c.text};`}) : null,
            });
            b.connect('clicked', () => {
                this._setColor(c.id);
                menu.close();
            });
            row.add_child(b);
        }
        swatches.add_child(row);
        menu.addMenuItem(swatches);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(this._data.onTop ? 'Unpin from top' : 'Pin on top',
            () => this._mgr.setOnTop(this._data.id, !this._data.onTop), 'view-pin-symbolic');
        menu.addAction('Hide note', () => this._mgr.hide(this._data.id), 'window-close-symbolic');
        menu.addAction('Delete note', () => this._confirmDelete(), 'user-trash-symbolic');
        openMenu(menu);
    }

    _confirmDelete() {
        const id = this._data.id;
        if (!this._data.text.trim()) {
            this._mgr.delete(id);
            return;
        }
        const dialog = new ModalDialog.ModalDialog();
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: 'Delete this note?',
            description: `“${U.noteTitle(this._data.text)}” will be permanently deleted.`,
        }));
        dialog.setButtons([
            {label: 'Cancel', action: () => dialog.close(), key: Clutter.KEY_Escape},
            {label: 'Delete', action: () => {
                dialog.close();
                this._mgr.delete(id);
            }},
        ]);
        dialog.open();
    }
});
