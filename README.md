# ubuntu-desktop-setup

Desktop widgets for Ubuntu 24.04 (GNOME Shell 46, Wayland), as a GNOME Shell
extension: `desktop-widgets@shimondarshan`.

## Music card

A card on the desktop for whatever is playing: Spotify, or a YouTube / Spotify
Web tab in Firefox or Chrome.

- Cover art, title, artist and app; previous / play-pause / next
- A timeline with elapsed and remaining time; drag it (or scroll on it) to
  jump in the song. A bubble shows where it will land; it jumps on release.
- Colors from the cover: the top of the card and the visualizer
  take the cover's two strongest colors. Black-and-white or faded covers give
  light and mid grays in the cover's tint; without a cover they are white and
  silver.
- A speaker button for the main volume (the same output as the top-right
  system menu): click to mute, scroll on it to change the volume
- A visualizer that follows the music, in four styles: halo bars, rainbow
  bars, mirror and wave. It only listens to the sound and never changes it.
- The visualizer can sit on the card, along the bottom of the screen, or be
  hidden (right-click → Show visualizer, or Settings). At the bottom of the
  screen it spans every monitor above all windows (and the dock), with no
  background; clicks and scrolling go through it to whatever is underneath.
  It steps aside for fullscreen windows, fades out when the music stops, and
  stays even when the card is hidden.
- With several players, dots under the card switch between them; a player that
  starts playing takes over
- Drag it anywhere with the left button; the spot is kept across logins
- Right-click: lock position, always on top, transparent background,
  visualizer style and placement, settings, hide
- An X in the top-right corner (shown while the pointer is on the card) hides
  the card; the music keeps playing
- Background opacity from 0% (only the art, text, bars and buttons on the
  wallpaper) to 100%, in Settings

By default the card sits on the desktop: above the wallpaper and desktop icons,
below app windows. "Always on top" keeps it above the windows instead.

When windows cover the card, click the music icon in the top bar: the card
comes above them (the icon shows pressed) and works as usual. Click the icon
again, or click any app window, to send it back to the desktop. If the card was
hidden (with the X or the menu), the icon brings it back, and it stays until
it is hidden again. The icon can be turned off in Settings.

### How the visualizer works

The bar heights come from [cava](https://github.com/karlstav/cava). The
extension starts it with its own config (`~/.cache/desktop-widgets/cava.conf`:
PipeWire input, raw output, mono) only while something is playing and the bars
are on screen (on the shown card, or at the bottom of the screen), and stops it
on pause. One cava feeds the card and every monitor's strip.

"Playing" means a player says so, or any app is sending sound to the speakers
(`pactl`, event sounds left out). Firefox shows one player for all its tabs:
when an X video takes it over and pauses, Spotify Web can go on playing in
another tab, and the bars keep following it. The card can only control the tab
Firefox's player points at.

By default ("Only for Spotify and YouTube" in Settings) only the Spotify app,
Spotify Web and YouTube (and YouTube Music) wake the bars: a player is known by
its page address, a browser's sound stream by its tab title ("… - YouTube",
"Spotify – …", "Song • Artist"). X, other sites, games and calls don't. cava
hears all the sound together, so while music plays an X video alongside it
still moves the bars. Without cava the card still works, with still
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
  extension.js          places the card on the desktop layer, on top or in front for a while;
                        places the visualizer
  media/mpris.js        media players on the session bus (MPRIS)
  media/volume.js       main output volume and its name
  media/artwork.js      caches covers, picks their colors
  media/nowPlaying.js   the player shown, its cover and colors (card and strips)
  media/outputStreams.js  whether any app is playing sound (pactl)
  media/musicSources.js   which players and streams count as Spotify / YouTube
  media/color.js        color helpers
  media/visualizer.js   runs cava, draws the bars
  media/screenVisualizer.js  the bars along the bottom of every monitor
  media/widget.js       the card, dragging, right-click menu
  panel/indicator.js    music icon in the top bar that brings the card in front
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
