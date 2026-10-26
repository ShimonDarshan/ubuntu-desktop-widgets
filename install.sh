#!/usr/bin/env bash
# Links the Desktop Widgets extension into ~/.local/share/gnome-shell/extensions
# (so edits in this repo are picked up), compiles its settings schema and adds
# it to the enabled extensions. Safe to run again after pulling changes.
# On Wayland, log out and back in once so GNOME Shell loads the new code.
set -euo pipefail

UUID=desktop-widgets@shimondarshan
SRC="$(cd "$(dirname "$0")" && pwd)/extension/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

glib-compile-schemas "$SRC/schemas"

mkdir -p "$(dirname "$DEST")"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
    echo "$DEST exists and is not a link; move it away first" >&2
    exit 1
fi
ln -sfn "$SRC" "$DEST"
echo "Linked $DEST -> $SRC"

# gnome-extensions enable only knows extensions the running shell has loaded,
# so add the UUID to the setting directly; the shell picks it up on next login.
current=$(gsettings get org.gnome.shell enabled-extensions)
if [[ $current != *"'$UUID'"* ]]; then
    if [[ $current == "@as []" ]]; then
        gsettings set org.gnome.shell enabled-extensions "['$UUID']"
    else
        gsettings set org.gnome.shell enabled-extensions "${current%]}, '$UUID']"
    fi
    echo "Enabled $UUID"
fi

# Bluetooth headphones: reconnect and back to A2DP after logout/login.
REPO="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user"
ln -sfn "$REPO/scripts/bt-audio-guard.sh" "$HOME/.local/bin/bt-audio-guard"
ln -sfn "$REPO/systemd/bt-audio-guard.service" "$HOME/.config/systemd/user/bt-audio-guard.service"
systemctl --user daemon-reload
systemctl --user enable bt-audio-guard.service >/dev/null 2>&1
echo "Enabled bt-audio-guard.service"

command -v cava >/dev/null ||
    echo "Note: cava not found; run scripts/install-cava.sh so the visualizer follows the music"
echo "Log out and back in to load the latest code."
