// Themed popup menus shared by the taskbar and the Start menu.
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import {togglePin} from './util.js';

export function makeMenu(ext, source, manager, alignment = 0.5) {
    const menu = new PopupMenu.PopupMenu(source, alignment, St.Side.BOTTOM);
    menu.actor.add_style_class_name('w11-menu');
    ext.themeActor(menu.actor);
    Main.uiGroup.add_child(menu.actor);
    menu.actor.hide();
    manager.addMenu(menu);
    // The Start menu backdrop is raised on open; keep our menus above it.
    menu.connect('open-state-changed', (_m, open) => {
        if (open)
            Main.uiGroup.set_child_above_sibling(menu.actor, null);
    });
    source.connect('destroy', () => menu.destroy());
    return menu;
}

export function openMenu(menu) {
    menu.open(BoxPointer.PopupAnimation.FULL);
}

export function addPinItem(menu, settings, key, appId, pinLabel, unpinLabel) {
    const pinned = settings.get_strv(key).includes(appId);
    menu.addAction(pinned ? unpinLabel : pinLabel,
        () => settings.set_strv(key, togglePin(settings.get_strv(key), appId)),
        'view-pin-symbolic');
}
