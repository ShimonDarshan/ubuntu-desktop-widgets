// The music card: cover art, title and app, the rainbow visualizer, a
// progress line, play controls and the main volume. Drag it anywhere with the
// left button (the spot is saved); right-click for lock, always on top,
// visualizer style, settings and hide.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {Players} from './mpris.js';
import {Output} from './volume.js';
import {STYLES, Visualizer} from './visualizer.js';

const STYLE_LABELS = {rainbow: 'Rainbow bars', mirror: 'Mirror', wave: 'Wave'};
const POSITION_POLL_S = 1;
// Background color and edge of the card (stylesheet.css); the opacity setting
// scales both. Below SHADOW_BELOW percent the text gets a shadow to stay
// readable on bright wallpapers.
const BACKGROUND_RGB = '18, 18, 18';
const EDGE_ALPHA_AT_DEFAULT = 0.14;
const DEFAULT_OPACITY = 72;
const SHADOW_BELOW = 30;
// Default distance from the top-right corner of the primary monitor.
const MARGIN = 40;

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

export const MediaWidget = GObject.registerClass(
class MediaWidget extends St.BoxLayout {
    _init(settings, openPreferences) {
        super._init({style_class: 'dw-media', vertical: true, reactive: true});
        this._settings = settings;
        this._active = null;
        this._artKey = null;

        this._buildHeader();
        this._visualizer = new Visualizer();
        this.add_child(this._visualizer);
        this._progress = new BarLevel({style_class: 'dw-media-progress', x_expand: true});
        this.add_child(this._progress);
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
            'changed::media-position', () => this.restorePosition(), this);
        this.connect('notify::mapped', () => this._syncVisualizer());
        this.connect('destroy', () => this._onDestroy());

        this._syncSettings();
        this._sync();
        this._syncVolume();
    }

    // Puts the card at its saved spot, or the top-right corner the first
    // time, kept fully on a monitor. Call once it is on the stage.
    restorePosition() {
        const [w, h] = this._naturalSize();
        let [x, y] = this._settings.get_value('media-position').deepUnpack();
        if (x < 0 || y < 0) {
            const monitor = Main.layoutManager.primaryMonitor;
            x = monitor.x + monitor.width - w - MARGIN;
            y = monitor.y + Main.panel.height + MARGIN;
        }
        this.set_position(...this._clamp(x, y, w, h));
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
        this._settings.set_value('media-position', new GLib.Variant('(ii)', [x, y]));
        return Clutter.EVENT_STOP;
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'dw-media-header'});
        this._art = new St.Icon({style_class: 'dw-media-art', y_align: Clutter.ActorAlign.CENTER});
        const labels = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({style_class: 'dw-media-title'});
        this._subtitle = new St.Label({style_class: 'dw-media-subtitle'});
        for (const label of [this._title, this._subtitle]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            labels.add_child(label);
        }
        header.add_child(this._art);
        header.add_child(labels);
        this.add_child(header);
    }

    _buildControls() {
        const row = new St.BoxLayout({style_class: 'dw-media-controls'});

        this._prevButton = iconButton('media-skip-backward-symbolic', 'Previous');
        this._prevButton.connect('clicked', () => this._active?.previous());
        this._playButton = iconButton('media-playback-start-symbolic', 'Play', 'dw-media-play');
        this._playButton.connect('clicked', () => this._active?.playPause());
        this._nextButton = iconButton('media-skip-forward-symbolic', 'Next');
        this._nextButton.connect('clicked', () => this._active?.next());

        this._muteButton = iconButton('audio-volume-high-symbolic', 'Mute', 'dw-media-button dw-media-mute');
        this._muteButton.connect('clicked', () => this._output.toggleMute());
        this._slider = new Slider(0);
        this._slider.add_style_class_name('dw-media-slider');
        this._slider.set({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._slider.accessible_name = 'Volume';
        this._sliderId = this._slider.connect('notify::value',
            () => this._output.setLevel(this._slider.value));
        this._percent = new St.Label({style_class: 'dw-media-percent', y_align: Clutter.ActorAlign.CENTER});

        for (const child of [this._prevButton, this._playButton, this._nextButton,
            this._muteButton, this._slider, this._percent])
            row.add_child(child);
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
        this._menu.addAction('Hide', () => this._settings.set_boolean('media-visible', false));
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

        this._progress.visible = (player?.lengthUs ?? 0) > 0;
        this._syncDots(players);
        this._syncPositionPoll();
        this._syncVisualizer();
    }

    _syncArt(player) {
        const key = player ? player.artUrl || `app:${player.busName}` : null;
        if (key === this._artKey)
            return;
        this._artKey = key;
        if (player?.artUrl)
            this._art.gicon = new Gio.FileIcon({file: Gio.File.new_for_uri(player.artUrl)});
        else
            this._art.gicon = player?.app?.get_icon() ?? new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
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
        if (player === this._active && position >= 0)
            this._progress.value = Math.min(1, position / player.lengthUs);
    }

    _syncVisualizer() {
        this._visualizer.setActive(this.mapped && this._players.list.some(p => p.playing));
    }

    _syncVolume() {
        const {level, muted, available} = this._output;
        this._muteButton.child.icon_name = volumeIcon(level, muted);
        this._muteButton.accessible_name = muted ? 'Unmute' : 'Mute';
        this._slider.block_signal_handler(this._sliderId);
        this._slider.value = muted ? 0 : level;
        this._slider.unblock_signal_handler(this._sliderId);
        this._percent.text = muted ? 'Muted' : `${Math.round(level * 100)}%`;
        for (const actor of [this._muteButton, this._slider, this._percent])
            actor.visible = available;
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
        this.set_style(`background-color: rgba(${BACKGROUND_RGB}, ${alpha}); ` +
            `border-color: rgba(255, 255, 255, ${edge.toFixed(3)});`);
        if (opacity < SHADOW_BELOW)
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

    // Keeps a w x h box at (x, y) fully on the monitor holding its center, or
    // on the primary monitor when its center is on none.
    _clamp(x, y, w, h) {
        const cx = x + w / 2;
        const cy = y + h / 2;
        const monitor = Main.layoutManager.monitors.find(m =>
            cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height) ??
            Main.layoutManager.primaryMonitor;
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
        this._endDrag();
        if (this._positionId) {
            GLib.source_remove(this._positionId);
            this._positionId = 0;
        }
        this._settings.disconnectObject(this);
        this._menu.destroy();
        this._players.destroy();
        this._output.destroy();
    }
});
