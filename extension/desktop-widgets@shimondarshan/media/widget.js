// The music card: cover art, title, artist and app, the visualizer, a
// timeline you can drag to seek, play controls and a speaker button for the
// main volume. The card's top is tinted with the cover's color. Drag it
// anywhere with the left button (the spot is saved for the monitor it's on
// and the set of plugged-in monitors); right-click for lock,
// always on top, visualizer style, settings and hide. The X that shows on
// hover hides the card too; the music keeps playing and the music icon in the
// top bar brings the card back.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {Artwork, neutralColors} from './artwork.js';
import {css, mix} from './color.js';
import {describeMonitors} from './monitors.js';
import {Players} from './mpris.js';
import {Output} from './volume.js';
import {STYLES, Visualizer} from './visualizer.js';

const STYLE_LABELS = {halo: 'Halo bars', rainbow: 'Rainbow bars', mirror: 'Mirror', wave: 'Wave'};
const POSITION_POLL_S = 1;
// Scrolling or the arrow keys on the timeline seek once they pause this long.
const SEEK_DELAY_MS = 300;
// Scrolling on the speaker button changes the volume by this much.
const VOLUME_STEP = 0.05;
// Background color and edge of the card (stylesheet.css); the opacity setting
// scales both. The top of the card mixes in TINT of the accent color. Below
// SHADOW_BELOW percent there is no tint and the text gets a shadow to stay
// readable on bright wallpapers.
const BACKGROUND = [23 / 255, 21 / 255, 26 / 255];
const TINT = 0.2;
const EDGE_ALPHA_AT_DEFAULT = 0.12;
const DEFAULT_OPACITY = 72;
const SHADOW_BELOW = 30;
// Default distance from the top-right corner of the primary monitor.
const MARGIN = 40;
// The X fades in and out this fast when the pointer enters or leaves.
const CLOSE_FADE_MS = 150;

function iconButton(iconName, label, styleClass = 'dw-media-button') {
    return new St.Button({
        style_class: styleClass,
        child: new St.Icon({icon_name: iconName}),
        can_focus: true,
        accessible_name: label,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function volumeIcon(level, muted) {
    if (muted || level <= 0)
        return 'audio-volume-muted-symbolic';
    if (level < 0.34)
        return 'audio-volume-low-symbolic';
    if (level < 0.67)
        return 'audio-volume-medium-symbolic';
    return 'audio-volume-high-symbolic';
}

// Microseconds as 3:07, or 1:02:07 past an hour.
function formatTime(us) {
    const total = Math.max(0, Math.floor(us / 1e6));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const seconds = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function ellipsized(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

export const MediaWidget = GObject.registerClass(
class MediaWidget extends St.BoxLayout {
    _init(settings, openPreferences) {
        super._init({style_class: 'dw-media', vertical: true, reactive: true, track_hover: true});
        this._settings = settings;
        this._active = null;
        this._artKey = null;
        this._colors = null;
        this._accent = null;
        this._positionUs = 0;
        this._seeking = false;
        this._artwork = new Artwork();
        this._cancellable = new Gio.Cancellable();
        this._monitors = null;
        this._restoreSerial = 0;

        this._buildHeader();
        this._visualizer = new Visualizer();
        this.add_child(this._visualizer);
        this._buildTimeline();
        this._buildControls();
        this._dots = new St.BoxLayout({style_class: 'dw-media-dots', x_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._dots);
        this._buildMenu(openPreferences);

        this._players = new Players();
        this._players.connect('changed', (_o, player) => {
            // A player that starts playing takes over, unless the one shown
            // is playing too.
            if (player?.playing && !this._active?.playing)
                this._active = player;
            this._sync();
        });
        this._output = new Output();
        this._output.connect('changed', () => this._syncVolume());

        this._settings.connectObject(
            'changed::visualizer-style', () => this._syncSettings(),
            'changed::visualizer-bars', () => this._syncSettings(),
            'changed::media-locked', () => this._syncSettings(),
            'changed::media-on-top', () => this._syncSettings(),
            'changed::media-background-opacity', () => this._syncSettings(),
            'changed::media-positions', () => this.restorePosition(), this);
        this.connect('notify::mapped', () => this._syncVisualizer());
        this.connect('notify::hover', () => this._syncClose());
        this.connect('destroy', () => this._onDestroy());
        // Hidden until restorePosition() knows where it goes.
        this.hide();

        this._syncSettings();
        this._sync();
        this._syncVolume();
    }

    // Puts the card on the monitor and at the spot saved for the plugged-in
    // monitors, or the top-right corner when there is none, kept fully on a
    // monitor. Call once it is on the stage, and again when monitors change.
    async restorePosition() {
        const serial = ++this._restoreSerial;
        const monitors = await describeMonitors(this._cancellable);
        if (serial !== this._restoreSerial || this._cancellable.is_cancelled() || this._grab)
            return;
        this._monitors = monitors;
        this._migratePosition();
        const [w, h] = this._naturalSize();
        const [name, dx, dy] = (monitors &&
            this._settings.get_value('media-positions').deepUnpack()[monitors.setup]) ?? [];
        const monitor = monitors?.monitors.find(m => m.name === name);
        let x, y;
        if (monitor) {
            [x, y] = [monitor.x + dx, monitor.y + dy];
        } else {
            const primary = Main.layoutManager.primaryMonitor;
            x = primary.x + primary.width - w - MARGIN;
            y = primary.y + Main.panel.height + MARGIN;
        }
        this.set_position(...this._clamp(x, y, w, h));
        this.show();
    }

    // Saves (x, y) as an offset from the corner of the monitor holding the
    // card, for the plugged-in monitors only. Dropped when the monitors
    // changed and restorePosition() hasn't caught up yet.
    _savePosition(x, y, w = this.width, h = this.height) {
        const {x: mx, y: my} = this._monitorAt(x, y, w, h);
        const monitor = this._monitors?.monitors.find(m => m.x === mx && m.y === my);
        if (!monitor)
            return;
        const positions = this._settings.get_value('media-positions').deepUnpack();
        positions[this._monitors.setup] = [monitor.name, x - mx, y - my];
        this._settings.set_value('media-positions', new GLib.Variant('a{s(sii)}', positions));
    }

    // Moves a spot saved by older versions, in screen coordinates, to the
    // monitors plugged in now.
    _migratePosition() {
        const [x, y] = this._settings.get_value('media-position').deepUnpack();
        if (x < 0 || y < 0 || !this._monitors)
            return;
        this._settings.reset('media-position');
        const [w, h] = this._naturalSize();
        this._savePosition(...this._clamp(x, y, w, h), w, h);
    }

    vfunc_button_press_event(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this._menu.toggle();
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY || this._settings.get_boolean('media-locked'))
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._dragOffset = [x - this.x, y - this.y];
        this._grab = global.stage.grab(this);
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this.set_position(Math.round(x - this._dragOffset[0]), Math.round(y - this._dragOffset[1]));
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event() {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag();
        const [x, y] = this._clamp(this.x, this.y, this.width, this.height);
        this.set_position(x, y);
        this._savePosition(x, y);
        return Clutter.EVENT_STOP;
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'dw-media-header'});
        // The cover is the Bin's background image (round corners); without
        // one the Bin shows the app's icon instead.
        this._art = new St.Bin({style_class: 'dw-media-art', y_align: Clutter.ActorAlign.CENTER});
        this._artIcon = new St.Icon({
            style_class: 'dw-media-art-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._art.set_child(this._artIcon);
        const labels = new St.BoxLayout({
            style_class: 'dw-media-labels',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = ellipsized(new St.Label({style_class: 'dw-media-title'}));
        this._subtitle = ellipsized(new St.Label({style_class: 'dw-media-subtitle'}));
        for (const label of [this._title, this._subtitle])
            labels.add_child(label);
        // Kept in the layout while invisible so the title doesn't jump.
        this._closeButton = iconButton('window-close-symbolic', 'Hide', 'dw-media-button dw-media-close');
        this._closeButton.y_align = Clutter.ActorAlign.START;
        this._closeButton.opacity = 0;
        this._closeButton.connect('clicked', () => this._hide());
        this._closeButton.connect('key-focus-in', () => this._syncClose());
        this._closeButton.connect('key-focus-out', () => this._syncClose());
        header.add_child(this._art);
        header.add_child(labels);
        header.add_child(this._closeButton);
        this.add_child(header);
    }

    // Elapsed time, the track line with a handle to seek, and time left, on
    // one row. While dragging, a bubble above the handle shows where the song
    // will jump to; it jumps on release.
    _buildTimeline() {
        this._timeline = new St.BoxLayout({style_class: 'dw-media-timeline'});
        const track = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._seek = new Slider(0);
        this._seek.add_style_class_name('dw-media-seek');
        this._seek.set({x_expand: true, track_hover: true});
        this._seek.accessible_name = 'Position';
        this._tip = new St.Label({
            style_class: 'dw-media-seek-tip',
            visible: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        track.add_child(this._seek);
        track.add_child(this._tip);

        this._elapsed = new St.Label({style_class: 'dw-media-time', y_align: Clutter.ActorAlign.CENTER});
        this._remaining = new St.Label({
            style_class: 'dw-media-time dw-media-time-left',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timeline.add_child(this._elapsed);
        this._timeline.add_child(track);
        this._timeline.add_child(this._remaining);
        this.add_child(this._timeline);

        this._seek.connect('drag-begin', () => {
            this._seeking = true;
            this._syncTimes();
        });
        this._seek.connect('drag-end', () => {
            this._seeking = false;
            this._tip.hide();
            this._seekTo(this._seek.value);
        });
        this._seekId = this._seek.connect('notify::value', () => {
            this._syncTimes();
            if (!this._seeking)
                this._queueSeek();
        });
    }

    // Previous / play / next in the middle; the speaker button on the right
    // (click to mute, scroll to change the volume) is balanced by an empty
    // spot of the same width on the left.
    _buildControls() {
        const row = new St.BoxLayout({style_class: 'dw-media-controls'});
        const buttons = new St.BoxLayout({
            style_class: 'dw-media-transport',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._prevButton = iconButton('media-skip-backward-symbolic', 'Previous', 'dw-media-button dw-media-skip');
        this._prevButton.connect('clicked', () => this._active?.previous());
        this._playButton = iconButton('media-playback-start-symbolic', 'Play', 'dw-media-play');
        this._playButton.connect('clicked', () => this._active?.playPause());
        this._nextButton = iconButton('media-skip-forward-symbolic', 'Next', 'dw-media-button dw-media-skip');
        this._nextButton.connect('clicked', () => this._active?.next());
        for (const child of [this._prevButton, this._playButton, this._nextButton])
            buttons.add_child(child);

        this._muteButton = iconButton('audio-volume-high-symbolic', 'Mute', 'dw-media-button dw-media-mute');
        this._muteButton.connect('clicked', () => this._output.toggleMute());
        this._muteButton.connect('scroll-event', (_b, event) => {
            const direction = event.get_scroll_direction();
            let step = 0;
            if (direction === Clutter.ScrollDirection.UP)
                step = VOLUME_STEP;
            else if (direction === Clutter.ScrollDirection.DOWN)
                step = -VOLUME_STEP;
            else if (direction === Clutter.ScrollDirection.SMOOTH)
                step = -event.get_scroll_delta()[1] * VOLUME_STEP;
            if (step)
                this._output.setLevel(Math.max(0, Math.min(1, this._output.level + step)));
            return Clutter.EVENT_STOP;
        });

        row.add_child(new St.Widget({style_class: 'dw-media-mute-spacer'}));
        row.add_child(buttons);
        row.add_child(this._muteButton);
        this.add_child(row);
    }

    _buildMenu(openPreferences) {
        this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP);
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menuManager.addMenu(this._menu);

        this._lockItem = new PopupMenu.PopupSwitchMenuItem('Lock position', false);
        this._lockItem.connect('toggled', (_i, state) => this._settings.set_boolean('media-locked', state));
        this._onTopItem = new PopupMenu.PopupSwitchMenuItem('Always on top', false);
        this._onTopItem.connect('toggled', (_i, state) => this._settings.set_boolean('media-on-top', state));
        // Off brings back the opacity used before it was turned on.
        this._transparentItem = new PopupMenu.PopupSwitchMenuItem('Transparent background', false);
        this._transparentItem.connect('toggled', (_i, state) =>
            this._settings.set_int('media-background-opacity', state ? 0 : this._lastOpacity ?? DEFAULT_OPACITY));
        this._menu.addMenuItem(this._lockItem);
        this._menu.addMenuItem(this._onTopItem);
        this._menu.addMenuItem(this._transparentItem);

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Visualizer'));
        this._styleItems = new Map();
        for (const style of STYLES) {
            const item = this._menu.addAction(STYLE_LABELS[style],
                () => this._settings.set_string('visualizer-style', style));
            this._styleItems.set(style, item);
        }

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction('Settings…', () => openPreferences());
        this._menu.addAction('Hide', () => this._hide());
    }

    // Only the card goes away: the players don't hear about it.
    _hide() {
        this._settings.set_boolean('media-visible', false);
    }

    _syncClose() {
        this._closeButton.ease({
            opacity: this.hover || this._closeButton.has_key_focus() ? 255 : 0,
            duration: CLOSE_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _sync() {
        const players = this._players.list;
        if (!players.includes(this._active))
            this._active = players.find(p => p.playing) ?? players[0] ?? null;
        const player = this._active;

        if (player) {
            this._title.text = player.title || player.appName || 'Unknown title';
            this._subtitle.text = [player.artists.join(', '), player.appName]
                .filter(Boolean).join(' · ');
        } else {
            this._title.text = 'Nothing playing';
            this._subtitle.text = 'Play music in Spotify or a browser';
        }
        this._syncArt(player);

        const playing = !!player?.playing;
        this._playButton.child.icon_name = playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playButton.accessible_name = playing ? 'Pause' : 'Play';
        this._playButton.reactive = !!player;
        this._prevButton.reactive = !!player?.canGoPrevious;
        this._nextButton.reactive = !!player?.canGoNext;

        this._timeline.visible = (player?.lengthUs ?? 0) > 0;
        const canSeek = !!player?.canSeek;
        this._seek.reactive = canSeek;
        this._seek.can_focus = canSeek;
        if (canSeek)
            this._seek.remove_style_class_name('dw-media-seek-off');
        else
            this._seek.add_style_class_name('dw-media-seek-off');
        this._syncDots(players);
        this._syncPositionPoll();
        this._syncColors();
        this._syncVisualizer();
    }

    _syncArt(player) {
        const key = player ? player.artUrl || `app:${player.busName}` : null;
        if (key === this._artKey)
            return;
        this._artKey = key;
        if (!player?.artUrl) {
            this._showIcon(player);
            return;
        }
        // The previous cover stays until the new one is ready.
        this._artwork.load(player.artUrl).then(result => {
            if (key !== this._artKey)
                return;
            if (result) {
                this._art.set_style(`background-image: url("${GLib.filename_to_uri(result.path, null)}");`);
                this._art.add_style_class_name('dw-media-art-cover');
                this._artIcon.hide();
                this._colors = result.colors;
            } else {
                this._showIcon(this._active);
            }
            this._syncColors();
        });
    }

    _showIcon(player) {
        this._art.set_style(null);
        this._art.remove_style_class_name('dw-media-art-cover');
        this._artIcon.gicon = player?.app?.get_icon() ?? new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
        this._artIcon.show();
        this._colors = null;
        this._syncColors();
    }

    // The cover's colors, or white and silver while there is none: the card's
    // tint and the visualizer. With no player the bars keep the rainbow.
    _syncColors() {
        const colors = this._colors ?? (this._active ? neutralColors() : null);
        this._visualizer.setColors(colors);
        this._accent = colors?.[0] ?? null;
        this._syncBackground();
    }

    // One dot per player when there is more than one; click to show it.
    _syncDots(players) {
        this._dots.destroy_all_children();
        this._dots.visible = players.length > 1;
        if (!this._dots.visible)
            return;
        for (const player of players) {
            const dot = new St.Button({
                style_class: 'dw-media-dot',
                can_focus: true,
                accessible_name: `Show ${player.appName}`,
                checked: player === this._active,
            });
            dot.connect('clicked', () => {
                this._active = player;
                this._sync();
            });
            this._dots.add_child(dot);
        }
    }

    _syncPositionPoll() {
        const wanted = !!this._active?.playing && this._active.lengthUs > 0;
        if (wanted && !this._positionId) {
            this._positionId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POSITION_POLL_S, () => {
                this._updatePosition();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wanted && this._positionId) {
            GLib.source_remove(this._positionId);
            this._positionId = 0;
        }
        this._updatePosition();
    }

    async _updatePosition() {
        const player = this._active;
        if (!player || player.lengthUs <= 0)
            return;
        const position = await player.getPosition();
        // Leave the handle alone while the user moves it.
        if (player !== this._active || position < 0 || this._seeking || this._seekDelayId)
            return;
        this._positionUs = position;
        this._seek.block_signal_handler(this._seekId);
        this._seek.value = Math.min(1, position / player.lengthUs);
        this._seek.unblock_signal_handler(this._seekId);
        this._syncTimes();
    }

    // While seeking the times follow the handle, otherwise the player.
    _syncTimes() {
        const length = this._active?.lengthUs ?? 0;
        const moving = this._seeking || !!this._seekDelayId;
        const position = moving ? this._seek.value * length : Math.min(this._positionUs, length);
        this._elapsed.text = formatTime(position);
        this._remaining.text = `−${formatTime(length - position)}`;
        if (!this._seeking)
            return;
        this._tip.text = formatTime(position);
        this._tip.show();
        const radius = this._seek.get_theme_node().get_length('-slider-handle-radius');
        const handleX = radius + (this._seek.width - 2 * radius) * this._seek.value;
        const [, tipWidth] = this._tip.get_preferred_width(-1);
        const [, tipHeight] = this._tip.get_preferred_height(tipWidth);
        this._tip.translation_x = Math.round(handleX - tipWidth / 2);
        this._tip.translation_y = -tipHeight - 6;
    }

    // Scroll and arrow keys change the value in small steps; seek once they stop.
    _queueSeek() {
        if (this._seekDelayId)
            GLib.source_remove(this._seekDelayId);
        this._seekDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEEK_DELAY_MS, () => {
            this._seekDelayId = 0;
            this._seekTo(this._seek.value);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _seekTo(fraction) {
        const player = this._active;
        if (!player?.canSeek || player.lengthUs <= 0)
            return;
        this._positionUs = fraction * player.lengthUs;
        this._syncTimes();
        await player.setPosition(this._positionUs);
        this._updatePosition();
    }

    _syncVisualizer() {
        this._visualizer.setActive(this.mapped && this._players.list.some(p => p.playing));
    }

    _syncVolume() {
        const {level, muted, available} = this._output;
        this._muteButton.child.icon_name = volumeIcon(level, muted);
        this._muteButton.accessible_name = muted
            ? 'Unmute' : `Mute (volume ${Math.round(level * 100)}%)`;
        this._muteButton.visible = available;
    }

    _syncSettings() {
        const style = this._settings.get_string('visualizer-style');
        this._visualizer.setStyle(style);
        this._visualizer.setBarCount(this._settings.get_int('visualizer-bars'));
        for (const [key, item] of this._styleItems)
            item.setOrnament(key === style ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        this._lockItem.setToggleState(this._settings.get_boolean('media-locked'));
        this._onTopItem.setToggleState(this._settings.get_boolean('media-on-top'));
        this._syncBackground();
    }

    _syncBackground() {
        const opacity = this._settings.get_int('media-background-opacity');
        if (opacity > 0)
            this._lastOpacity = opacity;
        const alpha = opacity / 100;
        const edge = Math.min(1, EDGE_ALPHA_AT_DEFAULT * opacity / DEFAULT_OPACITY);
        const transparent = opacity < SHADOW_BELOW;
        const background = this._accent && !transparent
            ? 'background-gradient-direction: vertical; ' +
              `background-gradient-start: ${css(mix(BACKGROUND, this._accent, TINT), alpha)}; ` +
              `background-gradient-end: ${css(BACKGROUND, alpha)};`
            : `background-color: ${css(BACKGROUND, alpha)};`;
        this.set_style(`${background} border-color: rgba(255, 255, 255, ${edge.toFixed(3)});`);
        if (transparent)
            this.add_style_class_name('dw-media-transparent');
        else
            this.remove_style_class_name('dw-media-transparent');
        this._transparentItem.setToggleState(opacity === 0);
    }

    _naturalSize() {
        const [, w] = this.get_preferred_width(-1);
        const [, h] = this.get_preferred_height(w);
        return [w, h];
    }

    // The monitor holding the center of a w x h box at (x, y), or the
    // primary monitor when its center is on none.
    _monitorAt(x, y, w, h) {
        const cx = x + w / 2;
        const cy = y + h / 2;
        return Main.layoutManager.monitors.find(m =>
            cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height) ??
            Main.layoutManager.primaryMonitor;
    }

    // Keeps a w x h box at (x, y) fully on _monitorAt().
    _clamp(x, y, w, h) {
        const monitor = this._monitorAt(x, y, w, h);
        return [
            Math.round(Math.max(monitor.x, Math.min(x, monitor.x + monitor.width - w))),
            Math.round(Math.max(monitor.y, Math.min(y, monitor.y + monitor.height - h))),
        ];
    }

    _endDrag() {
        this._grab?.dismiss();
        this._grab = null;
    }

    _onDestroy() {
        this._cancellable.cancel();
        this._endDrag();
        for (const id of ['_positionId', '_seekDelayId']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
        this._settings.disconnectObject(this);
        this._menu.destroy();
        this._players.destroy();
        this._output.destroy();
        this._artwork.destroy();
    }
});
