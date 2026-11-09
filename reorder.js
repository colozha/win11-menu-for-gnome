// Drag-to-reorder: taskbar buttons and Start pins (shell DND), and tray items (own drag, see TrayReorder).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {moveItem} from './util.js';

const SHIFT_MS = 150;

/**
 * One reorderable list (taskbar apps, Start pins). While an item is dragged over the list the
 * others slide to where they would end up, and slide back when the pointer leaves or the drag is
 * cancelled. Slots are snapshotted at drag start in stage coordinates, so this works across grid
 * rows and the hit test never chases actors that are moving.
 *
 *   items(): [{actor, key}] in on-screen order
 *   order(keys, src, dst): keys after dropping src on dst (default: take dst's slot)
 *   onDrop(src, dst)
 */
export class ReorderGroup {
    constructor({container, items, order = moveItem, onDrop}) {
        this._container = container;
        this._items = items;
        this._order = order;
        this._onDrop = onDrop;
        this._slots = null;
        this._dropping = false;
        this._containerDead = false;
        container.connect('destroy', () => {
            this._containerDead = true;
        });
    }

    begin(source) {
        this._source = source;
        this._target = null;
        this._slots = this._items().map(({actor, key}) => {
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            const slot = {actor, key, x, y, w, h, dead: false};
            slot.id = actor.connect('destroy', () => {
                slot.dead = true;
            });
            return slot;
        });
        this._keys = this._slots.map(sl => sl.key);
        // Pointer anywhere near the row (gaps, a few px above or below) still counts as over the list.
        const pad = Math.min(...this._slots.map(sl => sl.h)) / 2;
        this._bounds = {
            x1: Math.min(...this._slots.map(sl => sl.x)) - pad,
            y1: Math.min(...this._slots.map(sl => sl.y)) - pad,
            x2: Math.max(...this._slots.map(sl => sl.x + sl.w)) + pad,
            y2: Math.max(...this._slots.map(sl => sl.y + sl.h)) + pad,
        };
        this._container._delegate = this;
        this._monitor = {dragMotion: e => this._onMotion(e.x, e.y)};
        DND.addDragMonitor(this._monitor);
    }

    _onMotion(x, y) {
        if (this._slots) {
            const b = this._bounds;
            if (x < b.x1 || x > b.x2 || y < b.y1 || y > b.y2) {
                this._preview(null);
            } else {
                const hit = this._slots.find(sl => x >= sl.x && x < sl.x + sl.w && y >= sl.y && y < sl.y + sl.h);
                if (hit)
                    this._preview(hit.key);
            }
        }
        return DND.DragMotionResult.CONTINUE;
    }

    /** Slide every item to its slot in the order that dropping on `target` would give. */
    _preview(target) {
        if (target === this._target)
            return;
        this._target = target;
        const src = this._source.key;
        const order = target && target !== src ? this._order(this._keys, src, target) : this._keys;
        for (const sl of this._slots) {
            const to = this._slots[order.indexOf(sl.key)] ?? sl;
            if (!sl.dead) {
                sl.actor.ease({
                    translation_x: to.x - sl.x,
                    translation_y: to.y - sl.y,
                    duration: SHIFT_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        }
    }

    handleDragOver(source) {
        return source?.group === this ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.NO_DROP;
    }

    acceptDrop(source) {
        if (source?.group !== this || !this._slots)
            return false;
        const src = source.key;
        const dst = this._target;
        this._dropping = true;
        // Deferred: the drop usually rebuilds the list that holds both actors.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._dropping = false;
            // The items already sit in their new slots; reorder first, then drop the offsets.
            if (dst && dst !== src)
                this._onDrop(src, dst);
            this._finish(false);
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    /** Escape or a drop elsewhere: the source jumps home now, so DND's snap-back lands on it. */
    cancel() {
        const sl = this._slots?.find(s => s.actor === this._source.actor);
        if (sl && !sl.dead) {
            sl.actor.remove_all_transitions();
            sl.actor.set({translation_x: 0, translation_y: 0});
        }
    }

    end() {
        if (this._monitor)
            DND.removeDragMonitor(this._monitor);
        this._monitor = null;
        if (!this._containerDead && this._container._delegate === this)
            this._container._delegate = null;
        if (!this._dropping)
            this._finish(true);
    }

    _finish(animate) {
        for (const sl of this._slots ?? []) {
            if (sl.dead)
                continue;
            sl.actor.disconnect(sl.id);
            sl.actor.remove_all_transitions();
            if (animate)
                sl.actor.ease({translation_x: 0, translation_y: 0, duration: SHIFT_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                sl.actor.set({translation_x: 0, translation_y: 0});
        }
        this._slots = null;
        this._target = null;
    }
}

/** Makes `actor` a drag source in `group`; dropping it calls group.onDrop(key, targetKey). */
export class ReorderItem {
    constructor(actor, {group, key, onBegin = null, onEnd = null}) {
        this.actor = actor;
        this.group = group;
        this.key = key;
        actor._delegate = this;
        let alive = true;
        actor.connect('destroy', () => {
            alive = false;
        });
        const draggable = DND.makeDraggable(actor);
        draggable.connect('drag-begin', () => {
            actor.opacity = 90;
            group.begin(this);
            onBegin?.();
        });
        draggable.connect('drag-cancelled', () => group.cancel());
        draggable.connect('drag-end', () => {
            if (alive)
                actor.opacity = 255;
            group.end();
            onEnd?.();
        });
    }

    getDragActor() {
        // The clone ignores the source's opacity, so the dragged copy stays solid while the slot dims.
        const [w, h] = this.actor.get_size();
        return new Clutter.Clone({source: this.actor, width: w, height: h});
    }

    getDragActorSource() {
        return this.actor;
    }

    handleDragOver(source) {
        return this.group.handleDragOver(source);
    }

    acceptDrop(source) {
        return this.group.acceptDrop(source);
    }
}

/**
 * Tray items are GNOME panel buttons whose ClickGesture opens the menu on *press* and grabs input,
 * so a drag can never start. While the tray is ours that gesture is switched off and we own the
 * click: press takes a grab on the tray; moving past the drag threshold drags the item live,
 * releasing without moving toggles its menu (on click, like Windows).
 * The order lives in 'tray-order' (also editable in prefs); the original layout comes back on destroy().
 */
export class TrayReorder {
    constructor(settings, tray, boxes) {
        this._settings = settings;
        this._tray = tray;
        this._boxes = boxes; // {r: rightBox, c: centerBox}
        this._press = null;
        this._drag = null;
        this._applyId = 0;
        this._applying = false;
        this._gestures = new Map(); // button → its ClickGesture we disabled

        this._dead = new WeakSet();
        this._snapshot = [];
        for (const box of Object.values(boxes)) {
            for (const child of box.get_children()) {
                this._snapshot.push({child, box});
                child.connectObject('destroy', () => this._dead.add(child), this);
            }
        }

        tray.connectObject('captured-event', (_a, e) => this._onEvent(e), this);
        for (const box of Object.values(boxes))
            box.connectObject('child-added', () => this._queueApply(), this);
        // Edited in prefs: re-apply. Our own writes come back here too, but re-applying is a no-op.
        settings.connectObject('changed::tray-order', () => this._queueApply(), this);
        this._apply();
        this._save();
        this._takeClicks();
    }

    destroy() {
        this._endDrag(false);
        this._endPress();
        if (this._applyId)
            GLib.source_remove(this._applyId);
        for (const [button, gesture] of this._gestures) {
            button.disconnectObject(this);
            gesture.set_enabled(true);
        }
        this._gestures.clear();
        this._settings.disconnectObject(this);
        this._tray.disconnectObject(this);
        for (const box of Object.values(this._boxes))
            box.disconnectObject(this);
        this._restoreSnapshot();
        for (const {child} of this._snapshot) {
            if (!this._dead.has(child))
                child.disconnectObject(this);
        }
    }

    /** Put the items back the way GNOME had them. */
    _restoreSnapshot() {
        for (const box of Object.values(this._boxes)) {
            const kids = this._snapshot.filter(s => s.box === box && !this._dead.has(s.child)).map(s => s.child);
            kids.forEach((c, i) => {
                if (c.get_parent() !== box) {
                    c.get_parent()?.remove_child(c);
                    box.insert_child_at_index(c, i);
                } else {
                    box.set_child_at_index(c, i);
                }
            });
        }
    }

    // ---------- order ----------

    _containers() {
        const out = new Map();
        for (const [role, ind] of Object.entries(Main.panel.statusArea)) {
            if (ind?.container)
                out.set(ind.container, role);
        }
        return out;
    }

    /** Visible items in on-screen order. */
    _items() {
        const boxes = Object.values(this._boxes);
        return this._tray.get_children()
            .filter(b => boxes.includes(b))
            .flatMap(b => b.get_children().filter(c => c.visible));
    }

    /** Status-area buttons by their container. */
    _buttons() {
        const out = new Map();
        for (const ind of Object.values(Main.panel.statusArea)) {
            if (ind?.container)
                out.set(ind.container, ind);
        }
        return out;
    }

    /** Switch off each panel button's open-on-press gesture; _onEvent opens its menu on click instead. */
    _takeClicks() {
        const boxes = Object.values(this._boxes);
        for (const [container, button] of this._buttons()) {
            if (!boxes.includes(container.get_parent()))
                continue;
            const g = button._clickGesture;
            if (!g || this._gestures.has(button) || !g.enabled || !button.menu?.toggle)
                continue;
            g.set_enabled(false);
            this._gestures.set(button, g);
            button.connectObject('destroy', () => this._gestures.delete(button), this);
        }
    }

    _save() {
        const roles = this._containers();
        const keyOf = box => Object.keys(this._boxes).find(k => this._boxes[k] === box);
        const order = [];
        for (const box of Object.values(this._boxes)) {
            for (const c of box.get_children()) {
                if (roles.has(c))
                    order.push(`${keyOf(box)}:${roles.get(c)}`);
            }
        }
        if (order.join() !== this._settings.get_strv('tray-order').join())
            this._settings.set_strv('tray-order', order);
    }

    _queueApply() {
        if (this._applying || this._drag || this._applyId)
            return;
        this._applyId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._applyId = 0;
            this._apply();
            // Record every current item, so prefs can list them and departed ones drop out.
            this._save();
            this._takeClicks();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Saved items go after unsaved ones, so a newly added indicator shows up on the left. */
    _apply() {
        const saved = this._settings.get_strv('tray-order');
        if (!saved.length) {
            // Reset from prefs: back to GNOME's order (_save then records it).
            this._restoreSnapshot();
            return;
        }
        const byRole = new Map([...this._containers()].map(([c, r]) => [r, c]));
        const ours = c => Object.values(this._boxes).includes(c.get_parent());
        this._applying = true;
        for (const [key, box] of Object.entries(this._boxes)) {
            const wanted = saved
                .filter(e => e.startsWith(`${key}:`))
                .map(e => byRole.get(e.slice(2)))
                .filter(c => c && ours(c));
            for (const c of wanted) {
                if (c.get_parent() !== box) {
                    c.get_parent().remove_child(c);
                    box.add_child(c);
                }
            }
            const rest = box.get_children().filter(c => !wanted.includes(c));
            [...rest, ...wanted].forEach((c, i) => box.set_child_at_index(c, i));
        }
        this._applying = false;
    }

    // ---------- press → drag ----------

    _containerAt(actor) {
        const boxes = Object.values(this._boxes);
        for (let a = actor; a; a = a.get_parent()) {
            if (boxes.includes(a.get_parent()))
                return a;
        }
        return null;
    }

    _onEvent(event) {
        const type = event.type();
        if (!this._press) {
            const press = type === Clutter.EventType.TOUCH_BEGIN ||
                (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY);
            if (press) {
                const c = this._containerAt(global.stage.get_event_actor(event));
                const button = c && this._buttons().get(c);
                // Only items whose click we own; others keep their own handling (no drag for them).
                if (button && this._gestures.has(button)) {
                    const [x, y] = event.get_coords();
                    const wasOpen = button.menu.isOpen;
                    this._press = {c, button, wasOpen, x, y, grab: global.stage.grab(this._tray)};
                }
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
            const [x, y] = event.get_coords();
            const threshold = St.Settings.get().drag_threshold;
            if (Math.abs(x - this._press.x) > threshold || Math.abs(y - this._press.y) > threshold) {
                this._startDrag(x);
                return Clutter.EVENT_STOP;
            }
        } else if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END) {
            const {button, wasOpen} = this._press;
            this._endPress();
            // Skip if the item's own press handler already toggled it (some extensions do).
            if (button.menu?.isOpen === wasOpen)
                button.menu.toggle();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _endPress() {
        this._press?.grab.dismiss();
        this._press = null;
    }

    _startDrag(x) {
        const {c} = this._press;
        this._endPress();
        Main.panel.menuManager.activeMenu?.close(BoxPointer.PopupAnimation.NONE);

        const [cx, cy] = c.get_transformed_position();
        const [w, h] = c.get_size();
        const clone = new Clutter.Clone({source: c, width: w, height: h, x: cx, y: cy, reactive: true, opacity: 230});
        Main.uiGroup.add_child(clone);
        Main.uiGroup.set_child_above_sibling(clone, null);
        c.opacity = 60;
        this._drag = {c, clone, dx: cx - x, grab: global.stage.grab(clone), alive: true};
        const drag = this._drag;
        const id = c.connect('destroy', () => {
            drag.alive = false;
            this._endDrag(false);
        });
        drag.disconnect = () => drag.alive && c.disconnect(id);
        clone.connect('event', (_a, e) => this._onDragEvent(e));
    }

    _onDragEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
            const [x] = event.get_coords();
            this._drag.clone.x = x + this._drag.dx;
            this._moveTo(x);
        } else if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END) {
            this._endDrag(true);
        } else if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            // Cancelled: put everything back where the saved order has it.
            this._endDrag(false);
            this._apply();
        }
        return Clutter.EVENT_STOP;
    }

    /** Insert the dragged item before the first item whose center is right of the pointer. */
    _moveTo(x) {
        const {c} = this._drag;
        const items = this._items().filter(i => i !== c);
        const before = items.find(i => x < i.get_transformed_position()[0] + i.width / 2);
        const parent = (before ?? items.at(-1))?.get_parent();
        if (!parent)
            return;
        if (c.get_parent() === parent) {
            const kids = parent.get_children();
            const cur = kids.indexOf(c);
            const idx = before ? kids.indexOf(before) : kids.length;
            const target = cur < idx ? idx - 1 : idx;
            if (target !== cur)
                parent.set_child_at_index(c, target);
        } else {
            c.get_parent().remove_child(c);
            if (before)
                parent.insert_child_at_index(c, parent.get_children().indexOf(before));
            else
                parent.add_child(c);
        }
    }

    _endDrag(save) {
        if (!this._drag)
            return;
        const {c, clone, grab, alive} = this._drag;
        this._drag.disconnect();
        this._drag = null;
        grab.dismiss();
        clone.destroy();
        if (alive)
            c.opacity = 255;
        if (save)
            this._save();
    }
}
