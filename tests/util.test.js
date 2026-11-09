// Run: gjs -m tests/util.test.js
import GLib from 'gi://GLib';
import * as U from '../util.js';

const eq = (a, b, msg) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

eq(U.rgba('#202020', 95), 'rgba(32, 32, 32, 0.95)', 'rgba');
eq(U.rgba('ff0000', 150), 'rgba(255, 0, 0, 1)', 'rgba clamps');
eq(U.rgba('nope', 50), 'rgba(0, 0, 0, 0.5)', 'rgba bad input');

eq(U.resolveTheme('system', 'prefer-dark'), 'dark', 'theme system dark');
eq(U.resolveTheme('system', 'default'), 'light', 'theme system default');
eq(U.resolveTheme('light', 'prefer-dark'), 'light', 'theme forced');

eq(U.togglePin(['a', 'b'], 'b'), ['a'], 'unpin');
eq(U.togglePin(['a'], 'b'), ['a', 'b'], 'pin');
eq(U.moveItem(['a', 'b', 'c', 'd'], 'a', 'c'), ['b', 'c', 'a', 'd'], 'move forward');
eq(U.moveItem(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c'], 'move back');
eq(U.moveItem(['a', 'b'], 'x', 'b'), ['a', 'b'], 'move unknown is a no-op');
eq(U.moveToFront(['a', 'b', 'c'], 'c'), ['c', 'a', 'b'], 'move to front');

const first = U.updateKnownApps({}, ['a', 'b'], 1000);
eq(first, {a: 0, b: 0}, 'first run seeds without "new"');
const second = U.updateKnownApps(first, ['a', 'c'], 2000);
eq(second, {a: 0, c: 2000}, 'new app stamped, removed app dropped');
eq(U.isRecentlyAdded(second, 'c', 2000 + 3600), true, 'recent');
eq(U.isRecentlyAdded(second, 'c', 2000 + 8 * 86400), false, 'expired');
eq(U.isRecentlyAdded(second, 'a', 2000), false, 'seeded is not new');

eq(U.parseKnown('garbage'), {}, 'parseKnown bad json');
eq(U.letterOf('firefox'), 'F', 'letter');
eq(U.letterOf('1Password'), '#', 'letter digit');
eq(U.relativeTime(1000, 1000 + 17 * 60), '17m ago', 'relative minutes');

// recentFiles: write a tiny xbel pointing at a real file
const dir = GLib.dir_make_tmp('w11XXXXXX');
const target = GLib.build_filenamev([dir, 'note.txt']);
GLib.file_set_contents(target, 'x');
const bf = new GLib.BookmarkFile();
const uri = GLib.filename_to_uri(target, null);
bf.set_mime_type(uri, 'text/plain');
bf.add_application(uri, 'test', 'true');
bf.set_modified_date_time(uri, GLib.DateTime.new_now_utc());
bf.set_mime_type('file:///does/not/exist.txt', 'text/plain');
bf.add_application('file:///does/not/exist.txt', 'test', 'true');
const xbel = GLib.build_filenamev([dir, 'r.xbel']);
bf.to_file(xbel);
const files = U.recentFiles(5, xbel);
eq(files.map(f => f.name), ['note.txt'], 'recentFiles skips missing');
eq(U.recentFiles(5, '/nonexistent.xbel'), [], 'recentFiles missing file');

eq(U.clockFormat('time-date', false), '%H:%M%n%d-%b-%y', 'clock default');
eq(U.clockFormat('time', true), '%I:%M %p', 'clock time 12h');
eq(U.clockFormat('custom', false, '  '), '%H:%M%n%d-%b-%y', 'clock empty custom falls back');
eq(U.clockFormat('custom', false, '%H'), '%H', 'clock custom');
const dt = GLib.DateTime.new_local(2026, 11, 9, 14, 5, 0);
eq(dt.format(U.clockFormat('time-weekday', false)).split('\n')[0], '14:05', '%n splits lines');

eq(U.contrastTheme('#000000'), 'dark', 'contrast black');
eq(U.contrastTheme('#ffffff'), 'light', 'contrast white');
eq(U.contrastTheme('#1c1c1c'), 'dark', 'contrast taskbar dark');
eq(U.contrastTheme('#f3f3f3'), 'light', 'contrast taskbar light');
eq(U.contrastTheme('#0078d4'), 'dark', 'contrast windows blue');
eq(U.contrastTheme('#ffd700'), 'light', 'contrast gold');
eq(U.contrastTheme(''), 'dark', 'contrast bad input');

eq(U.moveInGroups(['a', 'b', 'c'], ['x', 'y'], 'a', 'c'), {pins: ['b', 'c', 'a'], running: ['x', 'y']}, 'groups pinned move');
eq(U.moveInGroups(['a', 'b'], ['x', 'y', 'z'], 'z', 'x'), {pins: ['a', 'b'], running: ['z', 'x', 'y']}, 'groups running move');
eq(U.moveInGroups(['a', 'b'], ['x', 'y'], 'a', 'y'), {pins: ['b', 'a'], running: ['x', 'y']}, 'pinned dropped on running → end of pins');
eq(U.moveInGroups(['a', 'b'], ['x', 'y'], 'y', 'a'), {pins: ['a', 'b'], running: ['y', 'x']}, 'running dropped on pinned → front of running');

const tray = ['r:a', 'r:b', 'c:d'];
eq(U.moveTrayEntry(tray, 0, 1), ['r:b', 'r:a', 'c:d'], 'tray swap in box');
eq(U.moveTrayEntry(tray, 2, -1), ['r:a', 'r:d', 'r:b'], 'tray up across boundary joins right box');
eq(U.moveTrayEntry(tray, 1, 1), ['r:a', 'c:d', 'c:b'], 'tray down across boundary joins center box');
eq(U.moveTrayEntry(tray, 0, -1), tray, 'tray move past start is a no-op');
eq(U.moveTrayEntry(tray, 2, 1), tray, 'tray move past end is a no-op');

print('util.test.js: all passed');
