// Pure helpers. No Shell/St imports, so tests/util.test.js can run them under plain gjs.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const THEME_COLORS = {
    dark: {taskbar: '#1c1c1c', start: '#202020'},
    light: {taskbar: '#f3f3f3', start: '#f9f9f9'},
};

const RECENT_DAYS = 7;

/** '#rrggbb' + 0..100 → 'rgba(r, g, b, a)'. Falls back to black on bad input. */
export function rgba(hex, opacityPercent) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? '');
    const [r, g, b] = m ? m.slice(1).map(h => parseInt(h, 16)) : [0, 0, 0];
    const a = Math.max(0, Math.min(100, opacityPercent)) / 100;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Theme ('dark' | 'light') whose text reads best on `hex`: light (dark text) when the
 * perceived (YIQ) brightness is at least half. Unlike WCAG luminance this keeps white text
 * on saturated mid blues like Windows' #0078d4, which is how people read them.
 */
export function contrastTheme(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? '');
    if (!m)
        return 'dark';
    const [r, g, b] = m.slice(1).map(h => parseInt(h, 16));
    return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? 'light' : 'dark';
}

/** GLib.DateTime format string for a taskbar clock style; %n starts a second line. */
export function clockFormat(style, h12, custom = '') {
    const t = h12 ? '%I:%M %p' : '%H:%M';
    switch (style) {
    case 'time': return t;
    case 'time-date-locale': return `${t}%n%x`;
    case 'time-weekday': return `${t}%n%a, %d %b`;
    case 'single-line': return `%a %d %b  ${t}`;
    case 'custom': return custom.trim() || `${t}%n%d-%b-%y`;
    default: return `${t}%n%d-%b-%y`;
    }
}

/** Resolve 'system' | 'dark' | 'light' to 'dark' | 'light'. */
export function resolveTheme(theme, colorScheme) {
    if (theme === 'dark' || theme === 'light')
        return theme;
    return colorScheme === 'prefer-dark' ? 'dark' : 'light';
}

/** Pin list ops: return new arrays, never mutate the settings value. */
export function togglePin(list, id) {
    return list.includes(id) ? list.filter(x => x !== id) : [...list, id];
}

/** Move `id` into the slot `target` holds; items in between shift. */
export function moveItem(list, id, target) {
    const to = list.indexOf(target);
    if (to < 0 || id === target || !list.includes(id))
        return list;
    const out = list.filter(x => x !== id);
    out.splice(to, 0, id);
    return out;
}

/**
 * Taskbar drop: pinned apps reorder among pins, running ones among running; a drop across the
 * two groups lands at the edge of the dragged app's own group. Returns {pins, running}.
 */
export function moveInGroups(pins, running, src, dst) {
    const srcPinned = pins.includes(src);
    if (srcPinned !== pins.includes(dst)) {
        return srcPinned
            ? {pins: [...pins.filter(id => id !== src), src], running}
            : {pins, running: moveToFront(running, src)};
    }
    return srcPinned
        ? {pins: moveItem(pins, src, dst), running}
        : {pins, running: moveItem(running, src, dst)};
}

/**
 * Tray order entries are 'r:role' (right box) then 'c:role' (center box), in screen order.
 * Swap entry `index` with its neighbor; crossing the r/c boundary takes the neighbor's box.
 */
export function moveTrayEntry(list, index, delta) {
    const to = index + delta;
    if (index < 0 || index >= list.length || to < 0 || to >= list.length)
        return list;
    const out = [...list];
    const moved = out[index];
    out[index] = out[to];
    out[to] = out[index].slice(0, 2) + moved.slice(2);
    return out;
}

export function moveToFront(list, id) {
    return [id, ...list.filter(x => x !== id)];
}

/**
 * Merge currently installed app IDs into the known map.
 * On first run every app is stamped 0 so nothing shows as "new".
 */
export function updateKnownApps(known, installedIds, now) {
    const firstRun = Object.keys(known).length === 0;
    const next = {};
    for (const id of installedIds)
        next[id] = id in known ? known[id] : firstRun ? 0 : now;
    return next;
}

export function isRecentlyAdded(known, id, now) {
    const t = known[id];
    return t > 0 && now - t < RECENT_DAYS * 86400;
}

export function parseKnown(json) {
    try {
        const v = JSON.parse(json || '{}');
        return v && typeof v === 'object' ? v : {};
    } catch {
        return {};
    }
}

/** '17m ago', '3h ago', 'Yesterday', '09-Nov' */
export function relativeTime(unix, now) {
    const d = now - unix;
    if (d < 60)
        return 'Just now';
    if (d < 3600)
        return `${Math.floor(d / 60)}m ago`;
    if (d < 86400)
        return `${Math.floor(d / 3600)}h ago`;
    if (d < 172800)
        return 'Yesterday';
    return GLib.DateTime.new_from_unix_local(unix).format('%d-%b');
}

/** Section letter for the All list: A–Z, otherwise '#'. */
export function letterOf(name) {
    const c = (name ?? '').trim().charAt(0).toUpperCase();
    return c >= 'A' && c <= 'Z' ? c : '#';
}

/**
 * Most recent local files from the GTK recent list.
 * Returns [{uri, name, mime, modified}] newest first.
 */
export function recentFiles(limit, path = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel'])) {
    const bf = new GLib.BookmarkFile();
    try {
        bf.load_from_file(path);
    } catch {
        return [];
    }
    const items = [];
    for (const uri of bf.get_uris()) {
        try {
            if (!uri.startsWith('file://'))
                continue;
            const file = Gio.File.new_for_uri(uri);
            if (!file.query_exists(null))
                continue;
            items.push({
                uri,
                name: file.get_basename(),
                mime: bf.get_mime_type(uri),
                modified: bf.get_modified_date_time(uri).to_unix(),
            });
        } catch {
            // one broken entry must not hide the rest
        }
    }
    items.sort((a, b) => b.modified - a.modified);
    return items.slice(0, limit);
}
