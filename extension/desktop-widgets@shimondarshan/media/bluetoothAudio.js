// Puts Bluetooth headphones back in music mode after a login or unlock.
// While you log out and in, the login screen briefly takes connected
// headphones, can't get their music channel (A2DP: "Stream End Point in Use")
// and leaves them in the headset/call profile (HFP, mono 16 kHz), so music
// sounds bad. Instead of changing the login screen's config, this remembers
// the last profile each headphone had during the session and, for a short
// while after the extension starts, switches back the ones last in music
// mode, reconnecting once when music mode isn't offered. Headphones last used
// for calls, or whose microphone is recording, are left alone; outside that
// short while it only remembers. Uses pactl, and BlueZ for the reconnect.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// The login screen lets go of the headphones a few seconds after login.
const SETTLE_MS = 5000;
// After this long it only remembers profiles; profile changes before it may
// be the login screen's doing.
const WINDOW_MS = 30000;
// Card events come in bursts; act once they pause this long.
const EVENT_DELAY_MS = 1000;
const RECONNECT_PAUSE_MS = 3000;
const RESUBSCRIBE_DELAY_MS = 5000;
const BLUEZ_TIMEOUT_MS = 20000;

const isMusic = profile => profile.startsWith('a2dp');
const isCall = profile => profile.startsWith('headset-head-unit');

function log(message) {
    console.log(`desktop-widgets: bluetooth: ${message}`);
}

// Resolves with pactl's output, or null when it fails.
function pactl(args, cancellable) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(['pactl', ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            resolve(null);
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, out] = p.communicate_utf8_finish(res);
                resolve(p.get_successful() ? out : null);
            } catch {
                resolve(null);
            }
        });
    });
}

async function pactlList(what, cancellable) {
    try {
        return JSON.parse(await pactl(['-f', 'json', 'list', what], cancellable) ?? '[]');
    } catch {
        return [];
    }
}

// The headphones' Bluetooth address, or null for other cards.
function cardAddress(card) {
    return card.properties?.['device.api'] === 'bluez5'
        ? card.properties['api.bluez5.address'] ?? null : null;
}

// True when something records from the microphone of the headphones at mac.
function micInUse(mac, sources, outputs) {
    const mics = new Set(sources
        .filter(s => s.properties?.['api.bluez5.address'] === mac &&
            s.properties['media.class'] === 'Audio/Source')
        .map(s => s.index));
    return outputs.some(o => mics.has(o.source));
}

// The music profile to switch to: the remembered one when it's on offer,
// else the best one on offer, else null.
function musicProfile(card, remembered) {
    const offered = Object.entries(card.profiles ?? {})
        .filter(([name, p]) => isMusic(name) && p.available);
    if (offered.some(([name]) => name === remembered))
        return remembered;
    offered.sort(([, a], [, b]) => b.priority - a.priority);
    return offered[0]?.[0] ?? null;
}

export class BluetoothAudioFixer {
    constructor(settings) {
        this._settings = settings;
        this._cancellable = new Gio.Cancellable();
        this._timeouts = new Set();
        this._eventId = 0;
        this._settled = false;
        this._windowOver = false;
        // Headphones being reconnected now, and those reconnected already:
        // once per start is enough.
        this._reconnecting = new Set();
        this._reconnected = new Set();
        this._subscribe();
        this._after(SETTLE_MS, () => {
            this._settled = true;
            this._check();
        });
        this._after(WINDOW_MS, () => {
            this._windowOver = true;
            this._remember();
        });
    }

    destroy() {
        this._cancellable.cancel();
        this._proc?.force_exit();
        this._proc = null;
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
    }

    _after(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
        return id;
    }

    _sleep(ms) {
        return new Promise(resolve => this._after(ms, resolve));
    }

    // Follows card changes (profile switches, headphones coming and going)
    // through `pactl subscribe`, started again if PipeWire restarts.
    _subscribe() {
        try {
            this._proc = Gio.Subprocess.new(['pactl', 'subscribe'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            log(`cannot run pactl: ${e.message}`);
            return;
        }
        const stdout = new Gio.DataInputStream({
            base_stream: this._proc.get_stdout_pipe(),
            close_base_stream: true,
        });
        this._readLine(stdout);
    }

    _readLine(stream) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (_s, res) => {
            if (this._cancellable.is_cancelled())
                return;
            let line = null;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch {}
            if (line === null) {
                this._proc = null;
                this._after(RESUBSCRIBE_DELAY_MS, () => this._subscribe());
                return;
            }
            if (line.includes(' on card '))
                this._onCardEvent();
            this._readLine(stream);
        });
    }

    _onCardEvent() {
        if (this._eventId)
            GLib.source_remove(this._eventId);
        this._timeouts.delete(this._eventId);
        this._eventId = this._after(EVENT_DELAY_MS, () => {
            this._eventId = 0;
            if (this._windowOver)
                this._remember();
            else if (this._settled)
                this._check();
        });
    }

    // Saves the profile of each connected headphone that is in music or
    // call mode.
    async _remember() {
        const cards = await pactlList('cards', this._cancellable);
        if (this._cancellable.is_cancelled())
            return;
        const saved = this._settings.get_value('bluetooth-audio-profiles').deepUnpack();
        let changed = false;
        for (const card of cards) {
            const mac = cardAddress(card);
            const profile = card.active_profile ?? '';
            if (!mac || !(isMusic(profile) || isCall(profile)) || saved[mac] === profile)
                continue;
            saved[mac] = profile;
            changed = true;
        }
        if (changed)
            this._settings.set_value('bluetooth-audio-profiles', new GLib.Variant('a{ss}', saved));
    }

    // Switches back headphones last in music mode that came up in call mode.
    async _check() {
        const [cards, sources, outputs] = await Promise.all(['cards', 'sources', 'source-outputs']
            .map(what => pactlList(what, this._cancellable)));
        if (this._cancellable.is_cancelled())
            return;
        const saved = this._settings.get_value('bluetooth-audio-profiles').deepUnpack();
        for (const card of cards) {
            const mac = cardAddress(card);
            const remembered = saved[mac];
            if (!mac || !remembered || !isMusic(remembered) ||
                !isCall(card.active_profile ?? '') || this._reconnecting.has(mac))
                continue;
            if (micInUse(mac, sources, outputs)) {
                log(`${mac} is in ${card.active_profile} with its microphone in use; leaving it`);
                continue;
            }
            this._fix(card, mac, remembered);
        }
    }

    async _fix(card, mac, remembered) {
        const music = musicProfile(card, remembered);
        if (music) {
            if (await pactl(['set-card-profile', card.name, music], this._cancellable) !== null)
                log(`${mac} came up in ${card.active_profile}; switched to ${music}`);
            return;
        }
        const path = card.properties['api.bluez5.path'];
        if (!path || this._reconnected.has(mac))
            return;
        log(`${mac} came up in ${card.active_profile} without music mode on offer; reconnecting`);
        this._reconnected.add(mac);
        this._reconnecting.add(mac);
        try {
            await this._bluez(path, 'Disconnect');
            await this._sleep(RECONNECT_PAUSE_MS);
            await this._bluez(path, 'Connect');
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                log(`${mac}: ${e.message}`);
        }
        this._reconnecting.delete(mac);
        // The headphones come back as a new card; its events check it again.
        if (!this._cancellable.is_cancelled())
            this._onCardEvent();
    }

    _bluez(path, method) {
        return new Promise((resolve, reject) => {
            Gio.DBus.system.call('org.bluez', path, 'org.bluez.Device1', method,
                null, null, Gio.DBusCallFlags.NONE, BLUEZ_TIMEOUT_MS, this._cancellable,
                (conn, res) => {
                    try {
                        conn.call_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }
}
