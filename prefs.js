import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {moveTrayEntry} from './util.js';

const THEME_COLORS = {taskbar: '#1c1c1c', start: '#202020'};

const toHex = rgba => `#${[rgba.red, rgba.green, rgba.blue]
    .map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;

function comboRow(s, key, title, choices) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(choices.map(c => c[1]))});
    row.selected = Math.max(0, choices.findIndex(c => c[0] === s.get_string(key)));
    row.connect('notify::selected', () => s.set_string(key, choices[row.selected][0]));
    return row;
}

function switchRow(s, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    s.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** Switch "custom" + color button; the key holds '' (theme/system default) or '#rrggbb'. */
function colorRow(s, key, title, subtitle, fallback) {
    const row = new Adw.ActionRow({title, subtitle});
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        valign: Gtk.Align.CENTER,
    });
    const rgba = new Gdk.RGBA();
    rgba.parse(s.get_string(key) || fallback);
    button.rgba = rgba;
    const sw = new Gtk.Switch({valign: Gtk.Align.CENTER, active: s.get_string(key) !== ''});
    button.sensitive = sw.active;
    sw.connect('notify::active', () => {
        button.sensitive = sw.active;
        s.set_string(key, sw.active ? toHex(button.rgba) : '');
    });
    button.connect('notify::rgba', () => {
        if (sw.active)
            s.set_string(key, toHex(button.rgba));
    });
    row.add_suffix(button);
    row.add_suffix(sw);
    return row;
}

function opacityRow(s, key, title) {
    const row = new Adw.ActionRow({title});
    const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 1);
    scale.set({hexpand: true, width_request: 220, draw_value: true, value_pos: Gtk.PositionType.LEFT, valign: Gtk.Align.CENTER});
    scale.set_format_value_func((_s, v) => `${Math.round(v)}%`);
    scale.set_value(s.get_int(key));
    scale.connect('value-changed', () => s.set_int(key, Math.round(scale.get_value())));
    row.add_suffix(scale);
    return row;
}

function spinRow(s, key, title, subtitle, min, max, step) {
    const row = Adw.SpinRow.new_with_range(min, max, step);
    row.set({title, subtitle});
    row.value = s.get_int(key);
    row.connect('notify::value', () => s.set_int(key, Math.round(row.value)));
    return row;
}

/** Clock style + a custom format entry that is only editable for the Custom style. */
function clockRows(s) {
    const style = comboRow(s, 'clock-style', 'Date and time style', [
        ['time-date', '14:05 / 09-Nov-26'],
        ['time-date-locale', '14:05 / locale date'],
        ['time-weekday', '14:05 / Mon, 09 Nov'],
        ['single-line', 'Mon 09 Nov  14:05'],
        ['time', 'Time only'],
        ['custom', 'Custom'],
    ]);
    const custom = new Adw.EntryRow({title: 'Custom format (%H:%M, %a, %d, %b, %Y; %n = new line)', show_apply_button: true});
    custom.text = s.get_string('clock-custom-format');
    custom.connect('apply', () => s.set_string('clock-custom-format', custom.text));
    const sync = () => {
        custom.sensitive = s.get_string('clock-style') === 'custom';
    };
    const id = s.connect('changed::clock-style', sync);
    custom.connect('destroy', () => s.disconnect(id));
    sync();
    return [style, custom];
}

const TRAY_NAMES = {
    quickSettings: 'Quick Settings (network, sound, battery)',
    dateMenu: 'Clock and notifications',
    keyboard: 'Keyboard layout',
    a11y: 'Accessibility',
    dwellClick: 'Dwell click',
    screenRecording: 'Screen recording',
    screenSharing: 'Screen sharing',
};

/** One row per tray item, top = leftmost, with arrows. The extension keeps 'tray-order' complete. */
function trayOrderGroup(s) {
    const g = new Adw.PreferencesGroup({
        title: 'Tray order',
        description: 'Top is leftmost. You can also drag items in the tray. Some only show while active.',
    });
    const reset = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER, css_classes: ['flat']});
    reset.connect('clicked', () => s.reset('tray-order'));
    g.set_header_suffix(reset);

    let rows = [];
    const build = () => {
        rows.forEach(r => g.remove(r));
        const list = s.get_strv('tray-order');
        rows = list.map((entry, i) => {
            const role = entry.slice(2);
            const row = new Adw.ActionRow({title: TRAY_NAMES[role] ?? role});
            for (const [icon, delta, tip] of [['go-up-symbolic', -1, 'Move left'], ['go-down-symbolic', 1, 'Move right']]) {
                const b = new Gtk.Button({
                    icon_name: icon,
                    tooltip_text: tip,
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    sensitive: i + delta >= 0 && i + delta < list.length,
                });
                b.connect('clicked', () => s.set_strv('tray-order', moveTrayEntry(s.get_strv('tray-order'), i, delta)));
                row.add_suffix(b);
            }
            return row;
        });
        if (!rows.length)
            rows = [new Adw.ActionRow({title: 'Turn the extension on to list tray items'})];
        rows.forEach(r => g.add(r));
    };
    const id = s.connect('changed::tray-order', build);
    g.connect('destroy', () => s.disconnect(id));
    build();
    return g;
}

function group(title, rows, description = '') {
    const g = new Adw.PreferencesGroup({title, description});
    rows.forEach(r => g.add(r));
    return g;
}

export default class Win11Prefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window._settings = s;
        window.set_default_size(640, 720);

        const look = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'applications-graphics-symbolic'});
        look.add(group('Theme', [
            comboRow(s, 'theme', 'Theme', [['system', 'Follow system'], ['dark', 'Dark'], ['light', 'Light']]),
            colorRow(s, 'accent-color', 'Custom accent color', 'Off uses the GNOME accent color', '#4cc2ff'),
            switchRow(s, 'auto-contrast', 'Auto contrast text',
                'With a custom background, use light text on dark colors and dark text on light ones'),
        ]));
        look.add(group('Taskbar', [
            colorRow(s, 'taskbar-color', 'Custom background', 'Off uses the theme color', THEME_COLORS.taskbar),
            colorRow(s, 'taskbar-text-color', 'Custom text color', 'Clock, tray labels and icons; off uses the theme or auto contrast', '#ffffff'),
            opacityRow(s, 'taskbar-opacity', 'Opacity'),
            spinRow(s, 'taskbar-icon-size', 'Icon size', 'In pixels; the taskbar grows for large icons', 16, 48, 2),
            ...clockRows(s),
        ]));
        look.add(group('Start menu', [
            colorRow(s, 'start-color', 'Custom background', 'Off uses the theme color', THEME_COLORS.start),
            colorRow(s, 'start-text-color', 'Custom text color', 'Off uses the theme or auto contrast', '#ffffff'),
            opacityRow(s, 'start-opacity', 'Opacity'),
        ]));
        window.add(look);

        const behavior = new Adw.PreferencesPage({title: 'Behavior', icon_name: 'preferences-system-symbolic'});
        behavior.add(group('Taskbar', [
            comboRow(s, 'taskbar-alignment', 'Alignment', [['left', 'Left'], ['center', 'Center']]),
            switchRow(s, 'show-search-button', 'Search button'),
            comboRow(s, 'show-desktop-button', 'Show desktop button', [['right', 'Right edge'], ['left', 'Left edge'], ['none', 'Hidden']]),
        ]));

        const reset = new Adw.ActionRow({title: 'Reset pinned apps', subtitle: 'Restores the default pins on Start and the taskbar'});
        const resetButton = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
        resetButton.connect('clicked', () => {
            s.reset('start-pinned');
            s.reset('taskbar-pinned');
            s.set_boolean('pins-seeded', false);
        });
        reset.add_suffix(resetButton);

        behavior.add(group('Start menu', [
            switchRow(s, 'super-opens-start', 'Super key opens Start', 'Off keeps the GNOME overview on Super'),
            switchRow(s, 'show-recommended', 'Show Recommended', 'Recently added apps and recent files'),
            comboRow(s, 'all-apps-view', 'All apps view', [['grid', 'Grid'], ['list', 'List']]),
            reset,
        ]));
        behavior.add(trayOrderGroup(s));
        window.add(behavior);
    }
}
