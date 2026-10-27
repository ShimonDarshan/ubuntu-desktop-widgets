# ubuntu-desktop-setup

Desktop widgets for Ubuntu 24.04 (GNOME Shell 46, Wayland), as a GNOME Shell
extension: `desktop-widgets@shimondarshan`.

## Music card

A card on the desktop for whatever is playing: Spotify, or a YouTube / Spotify
Web tab in Firefox or Chrome.

- Cover art, title, artist and app; previous / play-pause / next; a progress line
- Main volume slider and mute (the same output as the top-right system menu)
- A visualizer that follows the music (red for YouTube, green for Spotify,
  white for local players), in three styles: rainbow bars,
  mirror and wave. It only listens to the sound and never changes it.
- With several players, dots under the card switch between them; a player that
  starts playing takes over
- Drag it anywhere with the left button; the spot is kept across logins
- Right-click: lock position, always on top, transparent background,
  visualizer style, settings, hide
- Background opacity from 0% (only the art, text, bars and buttons on the
  wallpaper) to 100%, in Settings

By default the card sits on the desktop: above the wallpaper and desktop icons,
below app windows. "Always on top" keeps it above the windows instead.

### How the visualizer works

The bar heights come from [cava](https://github.com/karlstav/cava). The
extension starts it with its own config (`~/.cache/desktop-widgets/cava.conf`:
PipeWire input, raw output, mono) only while something is playing and the card
is shown, and stops it on pause. Without cava the card still works, with still
bars.

cava is started with `PIPEWIRE_LATENCY=1024/48000` so it never lowers the audio
buffer size of the output (its own 512-sample request caused crackles on
Bluetooth headphones). GNOME shows the microphone icon for any recording
stream; the extension leaves cava's (it only listens to the speakers) out of
that check, so the icon still appears for real microphone use.

## Install

```bash
scripts/install-cava.sh   # builds the latest cava release into /usr/local (needs sudo)
./install.sh              # links the extension, compiles its settings, enables it
```

Then log out and back in: on Wayland, GNOME Shell only loads new extension code
at login. Run `./install.sh` again after pulling changes, then log in again.

Settings: right-click the card → Settings…, or the Extensions app.

## Layout

```
extension/desktop-widgets@shimondarshan/
  extension.js          places the card on the desktop layer or on top
  media/mpris.js        media players on the session bus (MPRIS)
  media/volume.js       main output volume
  media/visualizer.js   runs cava, draws the bars
  media/widget.js       the card, dragging, right-click menu
  prefs.js              settings window
  schemas/              settings schema
  stylesheet.css
install.sh
scripts/install-cava.sh
```

## Debugging

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i desktop-widgets
```
