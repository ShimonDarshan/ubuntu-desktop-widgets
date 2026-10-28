// Desktop Widgets: widgets that live on the desktop. For now, the music card
// (media/widget.js). The card sits on the desktop layer, above the wallpaper
// and the desktop icons (DING) but below every app window, or, with "always on
// top", above the windows like the top panel. The music icon in the top bar
// (panel/indicator.js) brings the card above the windows for a while: until
// the icon is clicked again or an app window gets the focus. The visualizer
// can leave the card for the bottom of every monitor, above all windows
// (media/screenVisualizer.js), or be hidden. It also puts
// Bluetooth headphones back in music mode when the login screen left them in
// call mode (media/bluetoothAudio.js).

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {BluetoothAudioFixer} from './media/bluetoothAudio.js';
import {hideCavaFromMicIndicator} from './media/micIndicator.js';
import {NowPlaying} from './media/nowPlaying.js';
import {OutputStreams} from './media/outputStreams.js';
import {ScreenVisualizer} from './media/screenVisualizer.js';
import {CavaFeed} from './media/visualizer.js';
import {MediaWidget} from './media/widget.js';
import {MediaIndicator} from './panel/indicator.js';

// Monitors can change a few times in a row while they are plugged in; the
// card moves once they have been still this long.
const MONITORS_SETTLE_MS = 300;

// DING draws the desktop icons in its own full-screen windows. On Wayland it
// names them "Desktop Icons <n>", or puts "@!x,y;<flags>" in the title with B
// for "keep at bottom" (see emulateX11WindowType.js in DING). Real X11
// desktop windows have the DESKTOP type.
function isDesktopWindow(actor) {
    const win = actor.meta_window;
    if (!win)
        return false;
    if (win.get_window_type() === Meta.WindowType.DESKTOP)
        return true;
    const title = win.get_title() ?? '';
    if (title.startsWith('Desktop Icons '))
        return true;
    const flags = title.match(/@!.*?;?([A-Za-z]*)\s*$/);
    return !!flags && flags[1].toUpperCase().includes('B');
}

export default class DesktopWidgetsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // Shared by the card and the screen visualizer: one set of players
        // and covers, one cava.
        this._nowPlaying = new NowPlaying();
        this._feed = new CavaFeed();
        this._outputStreams = new OutputStreams();
        this._outputStreams.connectObject('changed', () => this._syncPlaying(), this);
        this._nowPlaying.connectObject(
            'changed', () => this._syncPlaying(),
            'art-changed', () => this._screenVisualizer?.setColors(this._nowPlaying.colors), this);
        this._settings.connectObject(
            'changed::media-visible', () => this._syncMedia(),
            'changed::visualizer-placement', () => this._syncVisualizer(),
            'changed::visualizer-bars', () => this._syncVisualizer(),
            'changed::visualizer-bottom-bars', () => this._syncVisualizer(),
            'changed::visualizer-music-only', () => this._syncPlaying(),
            'changed::visualizer-style', () => this._screenVisualizer?.setStyle(
                this._settings.get_string('visualizer-style')),
            'changed::media-on-top', () => this._place(),
            'changed::panel-icon-visible', () => this._syncIndicator(),
            'changed::bluetooth-audio-fix', () => this._syncBluetoothAudio(), this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._onMonitorsChanged(), this);
        global.display.connectObject(
            'restacked', () => this._restack(),
            'notify::focus-window', () => this._onFocusChanged(), this);
        this._restoreMicIndicator = hideCavaFromMicIndicator();
        this._peek = false;
        this._syncMedia();
        this._syncVisualizer();
        this._syncPlaying();
        this._syncIndicator();
        this._syncBluetoothAudio();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._bluetoothAudio?.destroy();
        this._bluetoothAudio = null;
        this._restoreMicIndicator?.();
        this._restoreMicIndicator = null;
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._settings.disconnectObject(this);
        if (this._monitorsId) {
            GLib.source_remove(this._monitorsId);
            this._monitorsId = 0;
        }
        this._destroyMedia();
        this._screenVisualizer?.destroy();
        this._screenVisualizer = null;
        this._nowPlaying.disconnectObject(this);
        this._outputStreams.disconnectObject(this);
        this._outputStreams.destroy();
        this._outputStreams = null;
        this._feed.destroy();
        this._feed = null;
        this._nowPlaying.destroy();
        this._nowPlaying = null;
        this._settings = null;
    }

    // The bars on the card, at the bottom of every monitor, or nowhere. The
    // card hides its own bars (widget.js); cava follows whichever are shown.
    _syncVisualizer() {
        const placement = this._settings.get_string('visualizer-placement');
        this._feed.setBarCount(this._settings.get_int(
            placement === 'bottom' ? 'visualizer-bottom-bars' : 'visualizer-bars'));
        if (placement !== 'bottom') {
            this._screenVisualizer?.destroy();
            this._screenVisualizer = null;
            return;
        }
        if (this._screenVisualizer)
            return;
        this._screenVisualizer = new ScreenVisualizer(this._feed);
        this._screenVisualizer.setStyle(this._settings.get_string('visualizer-style'));
        this._screenVisualizer.setColors(this._nowPlaying.colors);
        this._screenVisualizer.setPlaying(this._nowPlaying.playing);
    }

    // The bars move while a player plays or any app sends sound to the
    // speakers (a Firefox tab can play while its player says Paused); with
    // "only for Spotify and YouTube", only while one of those does.
    _syncPlaying() {
        const playing = this._settings.get_boolean('visualizer-music-only')
            ? this._nowPlaying.musicPlaying || this._outputStreams.musicRunning
            : this._nowPlaying.playing || this._outputStreams.running;
        this._feed.setPlaying(playing);
        this._screenVisualizer?.setPlaying(playing);
    }

    _onMonitorsChanged() {
        if (this._monitorsId)
            GLib.source_remove(this._monitorsId);
        this._monitorsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MONITORS_SETTLE_MS, () => {
            this._monitorsId = 0;
            this._media?.restorePosition();
            this._screenVisualizer?.rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncBluetoothAudio() {
        if (!this._settings.get_boolean('bluetooth-audio-fix')) {
            this._bluetoothAudio?.destroy();
            this._bluetoothAudio = null;
        } else {
            this._bluetoothAudio ??= new BluetoothAudioFixer(this._settings);
        }
    }

    _syncIndicator() {
        if (!this._settings.get_boolean('panel-icon-visible')) {
            this._indicator?.destroy();
            this._indicator = null;
            if (this._peek)
                this._endPeek();
            return;
        }
        if (this._indicator)
            return;
        this._indicator = new MediaIndicator(() => this._togglePeek());
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._syncIndicatorState();
    }

    _syncIndicatorState() {
        this._indicator?.setActive(!!this._media?.get_parent() && this._onTop);
    }

    // The icon was clicked: bring the card in front (showing it if it was
    // hidden), or send it back to the desktop.
    _togglePeek() {
        if (this._peek) {
            const win = this._peekFocus;
            this._endPeek();
            if (win && global.display.list_all_windows().includes(win))
                win.activate(global.get_current_time());
            return;
        }
        if (!this._settings.get_boolean('media-on-top')) {
            this._peek = true;
            // With no window focused, a click on any window, even the one
            // that covered the card, changes the focus and ends the peek.
            this._peekFocus = global.display.focus_window;
            global.display.unset_input_focus(global.get_current_time());
        }
        if (this._settings.get_boolean('media-visible'))
            this._place();
        else
            this._settings.set_boolean('media-visible', true);
    }

    _endPeek() {
        this._peek = false;
        this._peekFocus = null;
        this._place();
    }

    // Clicks on the card stay in the shell and leave the window focus alone,
    // so a focused window means the user went back to an app.
    _onFocusChanged() {
        if (this._peek && global.display.focus_window)
            this._endPeek();
    }

    _syncMedia() {
        if (!this._settings.get_boolean('media-visible')) {
            this._destroyMedia();
            return;
        }
        if (this._media)
            return;
        this._media = new MediaWidget(this._settings, this._nowPlaying, this._feed,
            () => this.openPreferences());
        this._place();
        this._media.restorePosition();
    }

    _destroyMedia() {
        this._peek = false;
        this._peekFocus = null;
        if (!this._media)
            return;
        this._unparent();
        this._media.destroy();
        this._media = null;
        this._syncIndicatorState();
    }

    _place() {
        const widget = this._media;
        if (!widget)
            return;
        const onTop = this._settings.get_boolean('media-on-top') || this._peek;
        if (widget.get_parent()) {
            if (onTop === this._onTop) {
                this._syncIndicatorState();
                return;
            }
            this._unparent();
        }
        this._onTop = onTop;
        if (onTop) {
            Main.layoutManager.addChrome(widget, {trackFullscreen: true});
        } else {
            global.window_group.add_child(widget);
            this._restack();
        }
        this._syncIndicatorState();
    }

    _unparent() {
        const widget = this._media;
        if (this._onTop)
            Main.layoutManager.removeChrome(widget);
        else
            widget.get_parent()?.remove_child(widget);
    }

    // Window actors are reordered whenever windows restack; put the card back
    // just above the topmost desktop window (or the wallpaper when there is
    // none), so app windows still cover it. The children of the window group
    // are read directly because DING hides its windows from
    // global.get_window_actors().
    _restack() {
        const widget = this._media;
        if (!widget || this._onTop || widget.get_parent() !== global.window_group)
            return;
        const desktop = global.window_group.get_children()
            .filter(a => a instanceof Meta.WindowActor && isDesktopWindow(a)).at(-1);
        global.window_group.set_child_above_sibling(widget,
            desktop ?? Main.layoutManager._backgroundGroup);
    }
}
