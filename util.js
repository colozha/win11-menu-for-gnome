// Pure helpers. No Shell/St imports, so tests/util.test.js can run them under plain gjs.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const THEME_COLORS = {
    dark: {taskbar: '#1c1c1c', start: '#202020'},
    light: {taskbar: '#f3f3f3', start: '#f9f9f9'},
};

/** Acrylic blur radius (Shell.BlurEffect), shared by the effect and the taskbar's blur layer. */
export const BLUR_RADIUS = 60;

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

/** Cut [start, start+len) into n integer [offset, size] spans that exactly cover it. */
function cuts(start, len, n) {
    const at = i => start + Math.round(i * len / n);
    return Array.from({length: n}, (_, i) => [at(i), at(i + 1) - at(i)]);
}

/**
 * Tile `area` ({x, y, width, height}) into n rects that exactly cover it.
 * layout: 'columns' | 'rows' | 'grid' | 'main' (first window left half, rest stacked right).
 */
export function splitRects(area, n, layout) {
    const {x, y, width, height} = area;
    const cols = (ys, yh, count) => cuts(x, width, count).map(([cx, cw]) => ({x: cx, y: ys, width: cw, height: yh}));
    if (n <= 1)
        return [{x, y, width, height}];
    switch (layout) {
    case 'rows':
        return cuts(y, height, n).map(([ry, rh]) => ({x, y: ry, width, height: rh}));
    case 'grid': {
        const perRow = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / perRow);
        return cuts(y, height, rows).flatMap(([ry, rh], r) =>
            cols(ry, rh, r < rows - 1 ? perRow : n - perRow * (rows - 1)));
    }
    case 'main': {
        const [[lx, lw], [rx, rw]] = cuts(x, width, 2);
        return [
            {x: lx, y, width: lw, height},
            ...cuts(y, height, n - 1).map(([ry, rh]) => ({x: rx, y: ry, width: rw, height: rh})),
        ];
    }
    default:
        return cols(y, height, n);
    }
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

// ---------- sticky notes ----------

/** Windows 11 Sticky Notes palette. `text` is the ink color on that body. */
export const NOTE_COLORS = [
    {id: 'yellow', name: 'Yellow', body: '#fff7d1', header: '#fff2ab', text: '#1a1a1a'},
    {id: 'green', name: 'Green', body: '#e4f9e0', header: '#cbf1c4', text: '#1a1a1a'},
    {id: 'pink', name: 'Pink', body: '#ffe4f1', header: '#ffcce5', text: '#1a1a1a'},
    {id: 'purple', name: 'Purple', body: '#f2e6ff', header: '#e7cfff', text: '#1a1a1a'},
    {id: 'blue', name: 'Blue', body: '#e2f1ff', header: '#cde9ff', text: '#1a1a1a'},
    {id: 'gray', name: 'Gray', body: '#f3f2f1', header: '#e1dfdd', text: '#1a1a1a'},
    {id: 'charcoal', name: 'Charcoal', body: '#454545', header: '#3b3b3b', text: '#ffffff'},
];
export const NOTE_MIN = {w: 200, h: 160};

export function noteColor(id) {
    return NOTE_COLORS.find(c => c.id === id) ?? NOTE_COLORS[0];
}

/** Parse the notes file; null when the JSON itself is broken (caller must not overwrite it). */
export function parseNotes(json) {
    let data;
    try {
        data = JSON.parse(json);
    } catch {
        return null;
    }
    const list = Array.isArray(data?.notes) ? data.notes : [];
    const num = (v, d) => (Number.isFinite(v) ? Math.round(v) : d);
    return list.filter(n => n && typeof n.id === 'string' && n.id).map(n => ({
        id: n.id,
        text: typeof n.text === 'string' ? n.text : '',
        color: noteColor(n.color).id,
        x: num(n.x, 0),
        y: num(n.y, 0),
        w: Math.max(NOTE_MIN.w, num(n.w, 300)),
        h: Math.max(NOTE_MIN.h, num(n.h, 300)),
        hidden: n.hidden === true,
        onTop: n.onTop === true,
        modified: num(n.modified, 0),
    }));
}

/** Fit {x,y,w,h} into the area it overlaps most (else the first), shrinking if too big. */
export function clampRect(r, areas) {
    if (!areas.length)
        return r;
    const overlap = a => Math.max(0, Math.min(r.x + r.w, a.x + a.width) - Math.max(r.x, a.x)) *
        Math.max(0, Math.min(r.y + r.h, a.y + a.height) - Math.max(r.y, a.y));
    const area = areas.reduce((best, a) => (overlap(a) > overlap(best) ? a : best), areas[0]);
    const w = Math.min(r.w, area.width);
    const h = Math.min(r.h, area.height);
    const x = Math.max(area.x, Math.min(r.x, area.x + area.width - w));
    const y = Math.max(area.y, Math.min(r.y, area.y + area.height - h));
    return {x, y, w, h};
}

/** List label: first non-empty line, truncated. */
export function noteTitle(text) {
    const line = (text ?? '').split('\n').map(l => l.trim()).find(l => l) ?? '';
    if (!line)
        return 'Empty note';
    return line.length > 40 ? `${line.slice(0, 40).trimEnd()}…` : line;
}
