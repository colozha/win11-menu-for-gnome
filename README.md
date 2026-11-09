# Win11 Taskbar & Start

A Windows 11 style taskbar and Start menu for GNOME Shell 50.

## Features

- Taskbar on every monitor with pinned apps, running apps, and window previews.
- Start menu with app search, pinned apps, recent files, and power controls.
- Drag to reorder apps and tray items; right-click apps to pin or unpin them.
- System tray and clock on the primary monitor, plus a Show desktop button.
- Customizable themes, colors, opacity, icon size, alignment, and clock format.

The extension hides the GNOME top bar while enabled.

## Requirements

Requires **GNOME Shell 50**, `git`, `glib-compile-schemas`, and `gnome-extensions`. Disable conflicting extensions such as **Dash to Panel** and **ArcMenu** first.

## Install

Clone and install for your user:

```sh
git clone https://github.com/colozha/win11-menu-for-gnome.git
cd win11-menu-for-gnome
glib-compile-schemas schemas/
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/win11-menu@husain
```

If the symlink destination exists, check the existing installation first.

Log out and back in (required on Wayland), then enable:

```sh
gnome-extensions enable win11-menu@husain
```

## Use

- Click Start or press **Super** to open the menu.
- Right-click an app to pin it to Start or the taskbar. Drag pinned apps to reorder them.
- Hover a running app for window previews; click a preview to switch windows.
- Right-click an empty area of the taskbar for desktop actions and taskbar settings.

Customize appearance and behavior, including the Super key shortcut:

```sh
gnome-extensions prefs win11-menu@husain
```

Disable and restore the GNOME top bar:

```sh
gnome-extensions disable win11-menu@husain
```

## Test

From the repository directory (requires `gjs`):

```sh
gjs -m tests/util.test.js
glib-compile-schemas --strict --dry-run schemas/
```

For GNOME Shell logs:

```sh
journalctl -f -o cat /usr/bin/gnome-shell
```
