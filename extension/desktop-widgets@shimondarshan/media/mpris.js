// Tracks the MPRIS media players on the session bus: Spotify, and browser
// tabs playing YouTube, Spotify Web and the like (Firefox and Chrome publish
// one player each). Emits 'changed' whenever a player appears, goes away or
// changes track / playback state.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const PREFIX = 'org.mpris.MediaPlayer2.';
const PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const MprisProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`);

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="${PLAYER_IFACE}">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
  </interface>
</node>`);

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function hostOf(url) {
    if (!url)
        return '';
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host()?.toLowerCase() ?? '';
    } catch {
        return '';
    }
}

class Player extends Signals.EventEmitter {
    constructor(busName) {
        super();
        this.busName = busName;
        this.title = '';
        this.artists = [];
        this.artUrl = '';
        this.url = '';
        this.lengthUs = 0;
        this.status = 'Stopped';
        this.canPlay = false;
        this.canGoNext = false;
        this.canGoPrevious = false;
        this.app = null;
        this.identity = '';

        this._cancellable = new Gio.Cancellable();
        this._mpris = new MprisProxy(Gio.DBus.session, busName, PATH, (_p, error) => {
            if (error)
                return;
            this._readIdentity();
            this.emit('changed');
        }, this._cancellable);
        this._player = new PlayerProxy(Gio.DBus.session, busName, PATH, (_p, error) => {
            if (error) {
                if (!isCancelled(error))
                    console.error(`desktop-widgets: ${busName}: ${error.message}`);
                return;
            }
            this._player.connectObject('g-properties-changed', () => this._update(), this);
            this._update();
        }, this._cancellable);
    }

    get playing() {
        return this.status === 'Playing';
    }

    // The app name to show under the title: "Spotify", "Firefox", ...
    get appName() {
        return this.app?.get_name() ?? this.identity;
    }

    // Where the music comes from, for the visualizer colors: 'youtube' or
    // 'spotify' for those sites (browsers send the tab's address as
    // xesam:url) and the Spotify app, 'local' for everything else.
    get source() {
        const host = hostOf(this.url);
        if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host))
            return 'youtube';
        if (/(^|\.)spotify\.com$/.test(host) || this.busName.toLowerCase().includes('spotify'))
            return 'spotify';
        return 'local';
    }

    playPause() {
        this._player.PlayPauseAsync().catch(e => this._logError(e));
    }

    next() {
        this._player.NextAsync().catch(e => this._logError(e));
    }

    previous() {
        this._player.PreviousAsync().catch(e => this._logError(e));
    }

    // Resolves with the playback position in microseconds, or -1 when the
    // player doesn't report one. Position never emits PropertiesChanged, so
    // it has to be asked for.
    getPosition() {
        return new Promise(resolve => {
            Gio.DBus.session.call(this.busName, PATH,
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
                null, Gio.DBusCallFlags.NONE, 1000, this._cancellable,
                (conn, res) => {
                    try {
                        resolve(Number(conn.call_finish(res).recursiveUnpack()[0]));
                    } catch {
                        resolve(-1);
                    }
                });
        });
    }

    destroy() {
        this._cancellable.cancel();
        this._player?.disconnectObject(this);
        this._player = null;
        this._mpris = null;
    }

    _readIdentity() {
        this.identity = this._mpris.Identity ?? '';
        const entry = this._mpris.DesktopEntry;
        this.app = entry
            ? Shell.AppSystem.get_default().lookup_app(`${entry}.desktop`)
            : null;
    }

    _update() {
        const metadata = {};
        for (const [key, value] of Object.entries(this._player.Metadata ?? {}))
            metadata[key] = value.recursiveUnpack();

        // Some players send malformed metadata; keep only what matches the spec.
        const artists = metadata['xesam:artist'];
        this.artists = Array.isArray(artists) && artists.every(a => typeof a === 'string')
            ? artists : [];
        this.title = typeof metadata['xesam:title'] === 'string' ? metadata['xesam:title'] : '';
        this.artUrl = typeof metadata['mpris:artUrl'] === 'string' ? metadata['mpris:artUrl'] : '';
        this.url = typeof metadata['xesam:url'] === 'string' ? metadata['xesam:url'] : '';
        this.lengthUs = Number(metadata['mpris:length']) || 0;
        this.status = this._player.PlaybackStatus ?? 'Stopped';
        this.canPlay = !!this._player.CanPlay;
        this.canGoNext = !!this._player.CanGoNext;
        this.canGoPrevious = !!this._player.CanGoPrevious;
        this.emit('changed');
    }

    _logError(e) {
        if (!isCancelled(e))
            console.error(`desktop-widgets: ${this.busName}: ${e.message}`);
    }
}

export class Players extends Signals.EventEmitter {
    constructor() {
        super();
        this._players = new Map();
        this._cancellable = new Gio.Cancellable();

        this._ownerChangedId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(PREFIX))
                    return;
                if (newOwner && !oldOwner)
                    this._add(name);
                else if (!newOwner)
                    this._remove(name);
            });

        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(PREFIX)).forEach(n => this._add(n));
                } catch (e) {
                    if (!isCancelled(e))
                        console.error(`desktop-widgets: listing players: ${e.message}`);
                }
            });
    }

    // Players that can actually play something, in the order they appeared.
    get list() {
        return [...this._players.values()].filter(p => p.canPlay);
    }

    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._ownerChangedId);
        this._cancellable.cancel();
        for (const player of this._players.values())
            player.destroy();
        this._players.clear();
    }

    _add(busName) {
        if (this._players.has(busName))
            return;
        const player = new Player(busName);
        player.connect('changed', () => this.emit('changed', player));
        this._players.set(busName, player);
    }

    _remove(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;
        player.destroy();
        this._players.delete(busName);
        this.emit('changed', null);
    }
}
