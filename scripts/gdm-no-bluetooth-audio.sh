#!/usr/bin/env bash
# Stops the GDM login screen from taking Bluetooth headphones.
#
# After logout, the login screen (user gdm) starts its own PipeWire and
# WirePlumber. Those grab connected Bluetooth headphones, fail to open the
# music channel (A2DP: "Stream End Point in Use") and fall back to the
# headset/call profile (HFP, mono 16 kHz). The next login then finds the
# headphones stuck in that profile and music sounds bad until they are
# reconnected. With Bluetooth audio off for gdm only, the user session is the
# only one that ever connects them.
#
# For WirePlumber 0.4 (Ubuntu 24.04). Undo: sudo rm "$CONF"
set -euo pipefail

GDM_HOME=$(getent passwd gdm | cut -d: -f6)
DIR="$GDM_HOME/.config/wireplumber/bluetooth.lua.d"
# Loaded after the system's 50-bluez-config.lua, which sets it to true.
CONF="$DIR/51-disable-bluetooth.lua"

sudo install -d -o gdm -g gdm "$GDM_HOME/.config" "$GDM_HOME/.config/wireplumber" "$DIR"
echo '-- Written by ubuntu-desktop-setup/scripts/gdm-no-bluetooth-audio.sh
-- The login screen must not take Bluetooth headphones (see that script).
bluez_monitor.enabled = false' | sudo tee "$CONF" >/dev/null
sudo chown gdm:gdm "$CONF"
echo "Wrote $CONF"
