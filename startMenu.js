// Start menu: search, Pinned, Recommended, All apps, user + power footer.
import AccountsService from 'gi://AccountsService';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {Avatar} from 'resource:///org/gnome/shell/ui/userWidget.js';
import {makeMenu, openMenu, addPinItem} from './menu.js';
import {ReorderItem, ReorderGroup} from './reorder.js';
import * as U from './util.js';

const COLUMNS = 6;
const COLLAPSED_ROWS = 3;
const MAX_HEIGHT = 820;
const MARGIN = 12;

const vbox = (style_class, props = {}) =>
    new St.BoxLayout({style_class, orientation: Clutter.Orientation.VERTICAL, ...props});

function chunk(list, n) {
    const out = [];
    for (let i = 0; i < list.length; i += n)
        out.push(list.slice(i, i + n));
    return out;
}

function fileIcon(mime) {
    const type = Gio.content_type_from_mime_type(mime ?? '') ?? 'text/plain';
    return Gio.content_type_get_icon(type);
}

export class StartMenu {
    constructor(ext) {
        this._ext = ext;
        this._grab = null;
        this._dirty = true;
        this._taskbar = null;
        this._appSys = Shell.AppSystem.get_default();
        this._canHibernate = false;
        this._queryHibernate();

        // Fullscreen catcher: a click outside the menu closes it.
        this._backdrop = new St.Widget({reactive: true, visible: false});
        this._backdrop.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        Main.uiGroup.add_child(this._backdrop);
        this._backdrop.connect('button-press-event', (_a, event) => this._onOutsidePress(event));
        this._backdrop.connect('touch-event', (_a, event) => this._onOutsidePress(event));
        this._backdrop.connect('key-press-event', (_a, event) => this._onKeyPress(event));
        this._backdrop.connect('key-release-event', (_a, event) => this._onKeyRelease(event));
        this._superDown = false;
        this._ignoreOverlayUntil = 0;

        this.actor = vbox('w11-start', {reactive: true});
        this._fg = '';
        ext.themeActor(this.actor, 'start');
        this._backdrop.add_child(this.actor);
        global.focus_manager.add_group(this.actor);
        this.menuManager = new PopupMenu.PopupMenuManager(this.actor);

        // Search
        const searchWrap = new St.Bin({style_class: 'w11-search-wrap', x_expand: true});
        this._search = new St.Entry({
            style_class: 'w11-search',
            hint_text: 'Search for apps, settings, and documents',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'system-search-symbolic'}),
        });
        searchWrap.set_child(this._search);
        this.actor.add_child(searchWrap);
        this._search.clutter_text.connect('text-changed', () => this._render());
        this._search.clutter_text.connect('activate', () => this._firstAction?.());
        this._search.clutter_text.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Down) {
                this._body.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._search.clutter_text.connect('key-focus-in', () => this.syncAccent());
        this._search.clutter_text.connect('key-focus-out', () => this.syncAccent());

        // Scrolling body
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            y_expand: true,
        });
        this._body = vbox('w11-body');
        this._scroll.set_child(this._body);
        this.actor.add_child(this._scroll);

        this.actor.add_child(this._buildFooter());
    }

    get isOpen() {
        return this._grab !== null;
    }

    markDirty() {
        this._dirty = true;
        // Deferred: a pin action runs inside the menu of a tile that _render destroys.
        if (this.isOpen && !this._renderId) {
            this._renderId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._renderId = 0;
                if (this.isOpen)
                    this._render();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /** `fg` is a custom text color, or '' for the theme's. */
    setColors(bg, fg) {
        this._fg = fg;
        this.actor.set_style(`background-color: ${bg};${fg ? ` color: ${fg};` : ''}`);
        this.syncAccent();
    }

    syncAccent() {
        const accent = this._ext.accent;
        let style = '';
        if (accent && this._search.clutter_text.has_key_focus())
            style += `border-color: ${accent};`;
        // The search box sets its own text color in CSS, so a custom one has to be repeated here.
        if (this._fg)
            style += ` color: ${this._fg};`;
        this._search.set_style(style || null);
    }

    /** Mutter's overlay-key (Super released alone). Skipped if our own key handler just closed us. */
    onOverlayKey(taskbar) {
        if (GLib.get_monotonic_time() < this._ignoreOverlayUntil)
            return;
        this.toggle(taskbar);
    }

    toggle(taskbar, focusSearch = false) {
        if (this.isOpen)
            this.close();
        else
            this.open(taskbar, focusSearch);
    }

    open(taskbar, _focusSearch) {
        if (this.isOpen || !taskbar)
            return;
        this._taskbar = taskbar;
        this._superDown = false;
        taskbar.preview.close();

        this._search.text = '';
        this._dirty = true;
        this._render();
        this._scroll.vadjustment.value = 0;

        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const mon = taskbar.monitor;
        const height = Math.min(MAX_HEIGHT * sf, mon.height - taskbar.height - 2 * MARGIN * sf);
        this.actor.height = height;
        const [, width] = this.actor.get_preferred_width(height);
        const center = this._ext.settings.get_string('taskbar-alignment') === 'center';
        const x = center ? mon.x + Math.round((mon.width - width) / 2) : mon.x + MARGIN * sf;
        this.actor.set_position(x, taskbar.y - height - MARGIN * sf);

        Main.uiGroup.set_child_above_sibling(this._backdrop, null);
        this._backdrop.show();
        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        // Search box always holds focus on open, like Windows; typing searches.
        this._search.grab_key_focus();

        this.actor.remove_all_transitions();
        this.actor.set({opacity: 0, translation_y: 40 * sf});
        this.actor.ease({
            opacity: 255,
            translation_y: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    close() {
        if (!this.isOpen)
            return;
        Main.popModal(this._grab);
        this._grab = null;
        this.menuManager.activeMenu?.close();
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.actor.ease({
            opacity: 0,
            translation_y: 24 * sf,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => this._backdrop.hide(),
        });
    }

    destroy() {
        if (this._renderId)
            GLib.source_remove(this._renderId);
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._user?.disconnectObject(this);
        this._backdrop.destroy();
    }

    _onOutsidePress(event) {
        const target = global.stage.get_event_actor(event);
        if (target && this.actor.contains(target))
            return Clutter.EVENT_PROPAGATE;
        if (event.type() === Clutter.EventType.BUTTON_PRESS || event.type() === Clutter.EventType.TOUCH_BEGIN)
            this.close();
        return Clutter.EVENT_STOP;
    }

    _onKeyPress(event) {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            if (this._search.text)
                this._search.text = '';
            else
                this.close();
            return Clutter.EVENT_STOP;
        }
        // Close on Super *release*: closing on press let the release's overlay-key reopen the menu.
        const isSuper = sym === Clutter.KEY_Super_L || sym === Clutter.KEY_Super_R;
        this._superDown = isSuper;
        if (isSuper)
            return Clutter.EVENT_STOP;
        // Typing while a tile has focus goes to search.
        const ch = event.get_key_unicode();
        if (ch && ch.trim() && !this._search.clutter_text.has_key_focus()) {
            this._search.grab_key_focus();
            this._search.clutter_text.insert_text(ch, -1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onKeyRelease(event) {
        const sym = event.get_key_symbol();
        if ((sym !== Clutter.KEY_Super_L && sym !== Clutter.KEY_Super_R) || !this._superDown)
            return Clutter.EVENT_PROPAGATE;
        this._superDown = false;
        this._ignoreOverlayUntil = GLib.get_monotonic_time() + 500 * 1000;
        this.close();
        return Clutter.EVENT_STOP;
    }

    // ---------- content ----------

    _render() {
        const query = this._search.text.trim();
        this._body.destroy_all_children();
        this._firstAction = null;
        if (query)
            this._renderSearch(query);
        else
            this._renderHome();
        this._dirty = false;
    }

    _installedApps() {
        if (!this._dirty && this._apps)
            return this._apps;
        this._apps = this._appSys.get_installed()
            .filter(info => info.should_show())
            .map(info => this._appSys.lookup_app(info.get_id()))
            .filter(Boolean)
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));
        return this._apps;
    }

    _renderHome() {
        const s = this._ext.settings;
        const now = Math.floor(Date.now() / 1000);
        const known = this._ext.known ?? {};

        // Pinned
        const pinned = s.get_strv('start-pinned').map(id => this._appSys.lookup_app(id)).filter(Boolean);
        const expanded = s.get_boolean('pinned-expanded');
        const canToggle = pinned.length > COLUMNS * COLLAPSED_ROWS;
        const toggle = canToggle
            ? this._pill(expanded ? 'Show less' : 'Show all', expanded ? 'pan-up-symbolic' : 'pan-down-symbolic',
                () => s.set_boolean('pinned-expanded', !expanded))
            : null;
        const pinnedSection = this._section('Pinned', toggle);
        const shown = expanded || !canToggle ? pinned : pinned.slice(0, COLUMNS * COLLAPSED_ROWS);
        const tiles = [];
        this._pinGroup = new ReorderGroup({
            container: pinnedSection,
            items: () => tiles,
            onDrop: (src, dst) => {
                s.set_strv('start-pinned', U.moveItem(s.get_strv('start-pinned'), src, dst));
                // Rebuild now, not on the next idle, so the tiles don't flash back before moving.
                this._render();
            },
        });
        for (const app of shown)
            tiles.push({actor: this._appTile(app, {pinned: true}), key: app.get_id()});
        if (shown.length)
            this._grid(pinnedSection, tiles.map(t => t.actor));
        else
            pinnedSection.add_child(new St.Label({style_class: 'w11-empty', text: 'Right-click an app below and choose Pin to Start.'}));

        // Recommended
        if (s.get_boolean('show-recommended')) {
            const fresh = this._installedApps()
                .filter(app => U.isRecentlyAdded(known, app.get_id(), now))
                .sort((a, b) => known[b.get_id()] - known[a.get_id()])
                .map(app => this._row({
                    icon: app.create_icon_texture(32),
                    title: app.get_name(),
                    subtitle: 'Recently added',
                    onActivate: () => this._launch(app),
                    onMenu: btn => this._appMenu(btn, app),
                }));
            const files = U.recentFiles(6).map(f => this._row({
                icon: new St.Icon({gicon: fileIcon(f.mime), icon_size: 32}),
                title: f.name,
                subtitle: U.relativeTime(f.modified, now),
                onActivate: () => this._openUri(f.uri),
            }));
            const items = [...fresh, ...files].slice(0, 6);
            const rec = this._section('Recommended');
            if (items.length) {
                for (const pair of chunk(items, 2)) {
                    const line = new St.BoxLayout({x_expand: true});
                    line.layout_manager.homogeneous = true;
                    pair.forEach(r => line.add_child(r));
                    rec.add_child(line);
                }
            } else {
                rec.add_child(new St.Label({style_class: 'w11-empty', text: 'Files you open and apps you install will show up here.'}));
            }
        }

        // All
        const view = s.get_string('all-apps-view');
        const viewPill = this._pill(`View: ${view === 'list' ? 'List' : 'Grid'}`, 'pan-down-symbolic',
            btn => this._viewMenu(btn));
        const all = this._section('All', viewPill);
        let letter = null;
        let group = [];
        const flush = () => {
            if (!group.length)
                return;
            all.add_child(new St.Label({style_class: 'w11-letter', text: letter}));
            if (view === 'list') {
                group.forEach(app => all.add_child(this._row({
                    icon: app.create_icon_texture(24),
                    title: app.get_name(),
                    subtitle: U.isRecentlyAdded(known, app.get_id(), now) ? 'New' : null,
                    onActivate: () => this._launch(app),
                    onMenu: btn => this._appMenu(btn, app),
                })));
            } else {
                this._grid(all, group.map(app =>
                    this._appTile(app, {isNew: U.isRecentlyAdded(known, app.get_id(), now)})));
            }
            group = [];
        };
        for (const app of this._installedApps()) {
            const l = U.letterOf(app.get_name());
            if (l !== letter) {
                flush();
                letter = l;
            }
            group.push(app);
        }
        flush();
    }

    _renderSearch(query) {
        const ids = Shell.AppSystem.search(query).flat();
        const apps = [...new Set(ids)].map(id => this._appSys.lookup_app(id)).filter(Boolean);
        const q = query.toLowerCase();
        const files = U.recentFiles(200).filter(f => f.name.toLowerCase().includes(q)).slice(0, 8);
        const kind = app => app.get_app_info()?.get_categories()?.split(';').includes('Settings') ? 'Settings' : 'App';

        if (!apps.length && !files.length) {
            this._body.add_child(new St.Label({style_class: 'w11-empty', text: `No results for “${query}”`}));
            return;
        }

        const best = this._section('Best match');
        if (apps.length) {
            const [top] = apps;
            best.add_child(this._row({
                icon: top.create_icon_texture(48),
                title: top.get_name(),
                subtitle: kind(top),
                onActivate: () => this._launch(top),
                onMenu: btn => this._appMenu(btn, top),
                style: 'w11-best',
            }));
            this._firstAction = () => this._launch(top);
        } else {
            const [f] = files;
            best.add_child(this._row({
                icon: new St.Icon({gicon: fileIcon(f.mime), icon_size: 48}),
                title: f.name,
                subtitle: 'Document',
                onActivate: () => this._openUri(f.uri),
                style: 'w11-best',
            }));
            this._firstAction = () => this._openUri(f.uri);
        }

        const rest = apps.slice(1, 9);
        if (rest.length) {
            const sec = this._section('Apps');
            rest.forEach(app => sec.add_child(this._row({
                icon: app.create_icon_texture(24),
                title: app.get_name(),
                subtitle: kind(app),
                onActivate: () => this._launch(app),
                onMenu: btn => this._appMenu(btn, app),
            })));
        }
        const docs = apps.length ? files : files.slice(1);
        if (docs.length) {
            const sec = this._section('Documents');
            docs.forEach(f => sec.add_child(this._row({
                icon: new St.Icon({gicon: fileIcon(f.mime), icon_size: 24}),
                title: f.name,
                subtitle: GLib.path_get_dirname(Gio.File.new_for_uri(f.uri).get_path() ?? ''),
                onActivate: () => this._openUri(f.uri),
            })));
        }
    }

    // ---------- building blocks ----------

    _section(title, action = null) {
        const sec = vbox('w11-section');
        const header = new St.BoxLayout({style_class: 'w11-section-header'});
        header.add_child(new St.Label({
            style_class: 'w11-section-title',
            text: title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (action)
            header.add_child(action);
        sec.add_child(header);
        this._body.add_child(sec);
        return sec;
    }

    _pill(text, iconName, onClick) {
        const box = new St.BoxLayout({style_class: 'w11-pill-box', y_align: Clutter.ActorAlign.CENTER});
        const label = new St.Label({text, y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(label);
        box.add_child(new St.Icon({icon_name: iconName, y_align: Clutter.ActorAlign.CENTER}));
        const b = new St.Button({
            style_class: 'w11-pill',
            child: box,
            can_focus: true,
            x_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        b.connect('clicked', () => onClick(b));
        return b;
    }

    _grid(parent, tiles) {
        for (const row of chunk(tiles, COLUMNS)) {
            const line = new St.BoxLayout();
            row.forEach(t => line.add_child(t));
            parent.add_child(line);
        }
    }

    _focusable(btn) {
        btn.connect('key-focus-in', () => ensureActorVisibleInScrollView(this._scroll, btn));
        return btn;
    }

    _appTile(app, {isNew = false, pinned = false} = {}) {
        const btn = new St.Button({
            style_class: 'w11-tile',
            can_focus: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            accessible_name: app.get_name(),
            clip_to_allocation: true,
        });
        const box = vbox('w11-tile-box', {x_expand: true, y_align: Clutter.ActorAlign.START});
        const icon = app.create_icon_texture(32);
        icon.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);
        const label = new St.Label({style_class: 'w11-tile-label', text: app.get_name(), x_align: Clutter.ActorAlign.CENTER});
        const ct = label.clutter_text;
        ct.line_alignment = Pango.Alignment.CENTER;
        if (isNew) {
            ct.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(label);
            const tag = new St.Label({style_class: 'w11-new', text: 'New', x_align: Clutter.ActorAlign.CENTER});
            if (this._ext.accent)
                tag.set_style(`color: ${this._ext.accent};`);
            box.add_child(tag);
        } else {
            // Pango ellipsizes wrapped text to one line, so wrap fully and clip at two lines (CSS height).
            ct.line_wrap = true;
            ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            ct.ellipsize = Pango.EllipsizeMode.NONE;
            label.clip_to_allocation = true;
            box.add_child(label);
        }
        btn.set_child(box);
        btn.connect('clicked', (_b, button) => {
            if (button === Clutter.BUTTON_SECONDARY)
                this._appMenu(btn, app);
            else
                this._launch(app);
        });
        if (pinned) {
            new ReorderItem(btn, {
                group: this._pinGroup,
                key: app.get_id(),
                onBegin: () => this.menuManager.activeMenu?.close(),
            });
        }
        return this._focusable(btn);
    }

    _row({icon, title, subtitle, onActivate, onMenu = null, style = null}) {
        const btn = new St.Button({
            style_class: 'w11-row',
            can_focus: true,
            x_expand: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            accessible_name: title,
        });
        if (style)
            btn.add_style_class_name(style);
        const box = new St.BoxLayout({style_class: 'w11-row-box', x_expand: true});
        icon.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);
        const text = vbox(null, {y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        const t = new St.Label({text: title});
        t.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(t);
        if (subtitle) {
            const sub = new St.Label({style_class: 'w11-sub', text: subtitle});
            sub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(sub);
        }
        box.add_child(text);
        btn.set_child(box);
        btn.connect('clicked', (_b, button) => {
            if (button === Clutter.BUTTON_SECONDARY)
                onMenu?.(btn);
            else
                onActivate();
        });
        return this._focusable(btn);
    }

    // ---------- menus ----------

    _menuFor(btn) {
        btn._w11Menu ??= makeMenu(this._ext, btn, this.menuManager);
        btn._w11Menu.removeAll();
        return btn._w11Menu;
    }

    _appMenu(btn, app) {
        const s = this._ext.settings;
        const id = app.get_id();
        const menu = this._menuFor(btn);
        addPinItem(menu, s, 'start-pinned', id, 'Pin to Start', 'Unpin from Start');
        if (s.get_strv('start-pinned').includes(id) && s.get_strv('start-pinned')[0] !== id)
            menu.addAction('Move to front', () => s.set_strv('start-pinned', U.moveToFront(s.get_strv('start-pinned'), id)));
        addPinItem(menu, s, 'taskbar-pinned', id, 'Pin to taskbar', 'Unpin from taskbar');
        openMenu(menu);
    }

    _viewMenu(btn) {
        const s = this._ext.settings;
        const menu = this._menuFor(btn);
        for (const [value, label] of [['grid', 'Grid'], ['list', 'List']]) {
            const item = menu.addAction(label, () => s.set_string('all-apps-view', value));
            item.setOrnament(s.get_string('all-apps-view') === value ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        openMenu(menu);
    }

    // ---------- footer ----------

    _buildFooter() {
        const footer = new St.BoxLayout({style_class: 'w11-footer'});

        const userBox = new St.BoxLayout({style_class: 'w11-user-box'});
        this._user = AccountsService.UserManager.get_default().get_user(GLib.get_user_name());
        const avatar = new Avatar(this._user, {iconSize: 32, styleClass: 'w11-avatar'});
        const updateAvatar = () => avatar.update();
        this._user.connectObject('notify::is-loaded', updateAvatar, 'changed', updateAvatar, this);
        updateAvatar();
        userBox.add_child(avatar);
        userBox.add_child(new St.Label({text: GLib.get_real_name() || GLib.get_user_name(), y_align: Clutter.ActorAlign.CENTER}));
        const userBtn = new St.Button({style_class: 'w11-user', child: userBox, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        userBtn.connect('clicked', () => this._userMenu(userBtn));
        footer.add_child(userBtn);
        footer.add_child(new St.Widget({x_expand: true}));

        const icons = new St.BoxLayout({style_class: 'w11-footer-icons', y_align: Clutter.ActorAlign.CENTER});
        const dir = d => () => this._openUri(GLib.filename_to_uri(GLib.get_user_special_dir(d) ?? GLib.get_home_dir(), null));
        icons.add_child(this._iconButton('x-office-document-symbolic', 'Documents', dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS)));
        icons.add_child(this._iconButton('image-x-generic-symbolic', 'Pictures', dir(GLib.UserDirectory.DIRECTORY_PICTURES)));
        icons.add_child(this._iconButton('emblem-system-symbolic', 'Settings', () => {
            this._appSys.lookup_app('org.gnome.Settings.desktop')?.activate();
            this.close();
        }));
        const power = this._iconButton('system-shutdown-symbolic', 'Power', () => this._powerMenu(power));
        icons.add_child(power);
        footer.add_child(icons);
        return footer;
    }

    _iconButton(iconName, name, onClick) {
        const b = new St.Button({
            style_class: 'w11-icon-button',
            child: new St.Icon({icon_name: iconName}),
            can_focus: true,
            accessible_name: name,
        });
        b.connect('clicked', onClick);
        return b;
    }

    _userMenu(btn) {
        const sys = SystemActions.getDefault();
        const menu = this._menuFor(btn);
        menu.addAction('Change account settings', () => this._spawn(['gnome-control-center', 'system', 'users']),
            'avatar-default-symbolic');
        menu.addAction('Lock', () => this._run(() => sys.activateLockScreen()), 'system-lock-screen-symbolic');
        menu.addAction('Sign out', () => this._run(() => sys.activateLogout()), 'system-log-out-symbolic');
        openMenu(menu);
    }

    _powerMenu(btn) {
        const sys = SystemActions.getDefault();
        const menu = this._menuFor(btn);
        menu.addAction('Lock', () => this._run(() => sys.activateLockScreen()), 'system-lock-screen-symbolic');
        menu.addAction('Sleep', () => this._run(() => sys.activateSuspend()), 'weather-clear-night-symbolic');
        if (this._canHibernate)
            menu.addAction('Hibernate', () => this._run(() => this._logind('Hibernate')), 'document-open-recent-symbolic');
        // Immediate, like Windows; gnome-session still stops for apps with unsaved work.
        menu.addAction('Shut down', () => this._spawn(['gnome-session-quit', '--power-off', '--no-prompt']), 'system-shutdown-symbolic');
        menu.addAction('Restart', () => this._spawn(['gnome-session-quit', '--reboot', '--no-prompt']), 'system-reboot-symbolic');
        openMenu(menu);
    }

    _queryHibernate() {
        Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager', 'CanHibernate', null, new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    this._canHibernate = conn.call_finish(res).deepUnpack()[0] === 'yes';
                } catch {
                    this._canHibernate = false;
                }
            });
    }

    _logind(method) {
        Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager', method, new GLib.Variant('(b)', [true]), null,
            Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    Main.notifyError(`${method} failed`, e.message);
                }
            });
    }

    // ---------- actions ----------

    _run(fn) {
        this.close();
        fn();
    }

    _spawn(argv) {
        this.close();
        Util.spawn(argv);
    }

    _launch(app) {
        this.close();
        if (app.get_n_windows() > 0 && app.can_open_new_window())
            app.open_new_window(-1);
        else
            app.activate();
    }

    _openUri(uri) {
        this.close();
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError('Could not open file', e.message);
        }
    }
}
