#!/usr/bin/env bash
# Keeps Bluetooth headphones connected and in music quality across logout and
# login, run by bt-audio-guard.service (systemd --user):
#
#   save     at logout: remember which Bluetooth audio devices are connected
#   restore  at login: reconnect the remembered ones that dropped, and put any
#            that came up in the headset/call profile (HFP, mono 16 kHz) back
#            into A2DP, reconnecting once if A2DP isn't offered. A device whose
#            microphone is being recorded (a call) is left alone.
set -u

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/bt-audio-guard"
STATE="$STATE_DIR/devices"
A2DP_SINK_UUID=0000110b-0000-1000-8000-00805f9b34fb

log() { echo "bt-audio-guard: $*"; }

# MACs of paired devices that can play music (A2DP sink).
audio_devices() {
    bluetoothctl devices Paired | awk '{print $2}' | while read -r mac; do
        bluetoothctl info "$mac" | grep -qi "$A2DP_SINK_UUID" && echo "$mac"
    done
}

is_connected() { bluetoothctl info "$1" | grep -q "Connected: yes"; }

card() { echo "bluez_card.${1//:/_}"; }

# Prints the card's profiles section, active profile included.
card_info() {
    pactl list cards | awk -v c="$(card "$1")" '$1 == "Name:" {n = $2} n == c'
}

active_profile() { card_info "$1" | awk '/Active Profile:/ {print $3}'; }

has_a2dp() { card_info "$1" | grep -q '^\s*a2dp-sink'; }

# True when something records from this device's microphone.
mic_in_use() {
    local source
    source=$(pactl list sources short | awk -v s="bluez_input.${1//:/_}" 'index($2, s) == 1 {print $1}')
    [ -n "$source" ] && pactl list source-outputs short | awk '{print $2}' | grep -qx "$source"
}

wait_for() { # SECONDS COMMAND...
    local deadline=$((SECONDS + $1)); shift
    until "$@"; do
        [ $SECONDS -ge $deadline ] && return 1
        sleep 1
    done
}

connect() {
    log "connecting $1"
    bluetoothctl connect "$1" >/dev/null
    wait_for 15 is_connected "$1" && wait_for 10 card_exists "$1"
}

card_exists() { [ -n "$(card_info "$1")" ]; }

fix_profile() {
    local mac=$1 profile
    profile=$(active_profile "$mac")
    case "$profile" in
        a2dp*|"") return ;;
    esac
    if mic_in_use "$mac"; then
        log "$mac is in $profile with its microphone in use; leaving it"
        return
    fi
    if ! has_a2dp "$mac"; then
        log "$mac is in $profile without A2DP on offer; reconnecting"
        bluetoothctl disconnect "$mac" >/dev/null
        sleep 3
        connect "$mac" || return
    fi
    if has_a2dp "$mac"; then
        pactl set-card-profile "$(card "$mac")" a2dp-sink && log "$mac switched to a2dp-sink"
    else
        log "$mac still has no A2DP profile"
    fi
}

save() {
    local connected
    connected=$(audio_devices | while read -r mac; do is_connected "$mac" && echo "$mac"; done)
    # Keep the last list when nothing is connected at logout: the devices may
    # already have dropped by now.
    [ -z "$connected" ] && return
    mkdir -p "$STATE_DIR"
    echo "$connected" > "$STATE"
    log "saved: $(echo $connected)"
}

restore() {
    wait_for 30 pactl info >/dev/null 2>&1 || { log "PipeWire not up"; return; }
    local remembered=""
    [ -f "$STATE" ] && remembered=$(cat "$STATE")
    for mac in $(audio_devices); do
        if ! is_connected "$mac"; then
            echo "$remembered" | grep -qx "$mac" || continue
            connect "$mac" || { log "$mac did not connect (off or out of range?)"; continue; }
        fi
        wait_for 10 card_exists "$mac" || continue
        # Give WirePlumber a moment to settle on a profile first.
        sleep 2
        fix_profile "$mac"
    done
}

case "${1:-}" in
    save) save ;;
    restore) restore ;;
    *) echo "usage: $0 save|restore" >&2; exit 2 ;;
esac
