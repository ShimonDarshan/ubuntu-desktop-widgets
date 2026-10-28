// Whether any app is sending sound to the speakers right now. MPRIS alone
// isn't enough: Firefox shows one player for all its tabs, so when an X
// video takes it over and pauses, Spotify Web can go on playing in another
// tab while the player says Paused. `pactl subscribe` tells when a stream
// changes; `pactl list sink-inputs` then says which ones are corked
// (paused). Gvc doesn't report that. Event sounds (notifications) don't
// count. `running`: any stream plays; `musicRunning`: a Spotify or YouTube
// one does (musicSources.js). Emits 'changed' when either changes. Without
// pactl both stay false and the visualizer follows the players only.
//
// The plain-text list is parsed, not `-f json`: pactl 16 writes (null) for
// JSON strings with non-ASCII characters, like the en dash in Spotify's tab
// titles. C.UTF-8 keeps the labels in English and the titles intact.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {isMusicStream} from './musicSources.js';

const RESTART_DELAY_S = 5;
// A track change sends a burst of events; list the streams once it's over.
const SETTLE_MS = 150;

// [{corked, properties}] from `pactl list sink-inputs`.
export function parseSinkInputs(text) {
    const streams = [];
    for (const line of text.split('\n')) {
        if (line.startsWith('Sink Input #')) {
            streams.push({corked: false, properties: {}});
            continue;
        }
        const stream = streams.at(-1);
        if (!stream)
            continue;
        const corked = line.match(/^\s+Corked: (\w+)/);
        if (corked) {
            stream.corked = corked[1] === 'yes';
            continue;
        }
        const property = line.match(/^\s+([\w.-]+) = "(.*)"$/);
        if (property)
            stream.properties[property[1]] = property[2];
    }
    return streams;
}

export class OutputStreams extends Signals.EventEmitter {
    constructor() {
        super();
        this.running = false;
        this.musicRunning = false;
        this._pactl = GLib.find_program_in_path('pactl');
        if (!this._pactl) {
            console.warn('desktop-widgets: pactl not found; the visualizer follows the players only');
            return;
        }
        this._subscribe();
        this._list();
    }

    destroy() {
        this._destroyed = true;
        for (const id of ['_restartId', '_settleId']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
        this._cancellable?.cancel();
        this._proc?.force_exit();
        this._proc = null;
    }

    _subscribe() {
        this._restartId = 0;
        try {
            this._proc = Gio.Subprocess.new([this._pactl, 'subscribe'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.error(`desktop-widgets: cannot start pactl: ${e.message}`);
            this._scheduleRestart();
            return;
        }
        this._cancellable = new Gio.Cancellable();
        const stdout = new Gio.DataInputStream({
            base_stream: this._proc.get_stdout_pipe(),
            close_base_stream: true,
        });
        this._readLine(stdout, this._cancellable);
    }

    _readLine(stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (_s, res) => {
            if (cancellable.is_cancelled())
                return;
            let line = null;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch (e) {
                console.error(`desktop-widgets: pactl: ${e.message}`);
            }
            if (line === null) {
                // pactl exited (PipeWire restarted?); start it again.
                this._proc = null;
                this._scheduleRestart();
                return;
            }
            if (line.includes('sink-input'))
                this._queueList();
            this._readLine(stream, cancellable);
        });
    }

    _scheduleRestart() {
        if (this._destroyed)
            return;
        this._restartId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RESTART_DELAY_S, () => {
            this._subscribe();
            this._list();
            return GLib.SOURCE_REMOVE;
        });
    }

    _queueList() {
        if (this._settleId)
            return;
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._settleId = 0;
            this._list();
            return GLib.SOURCE_REMOVE;
        });
    }

    _list() {
        let proc;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            launcher.setenv('LC_ALL', 'C.UTF-8', true);
            proc = launcher.spawnv([this._pactl, 'list', 'sink-inputs']);
        } catch (e) {
            console.error(`desktop-widgets: cannot start pactl: ${e.message}`);
            return;
        }
        proc.communicate_utf8_async(null, this._cancellable, (_p, res) => {
            let playing;
            try {
                const [, stdout] = proc.communicate_utf8_finish(res);
                playing = parseSinkInputs(stdout).filter(s =>
                    !s.corked && s.properties['media.role'] !== 'event');
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`desktop-widgets: pactl list: ${e.message}`);
                return;
            }
            const running = playing.length > 0;
            const musicRunning = playing.some(s =>
                isMusicStream(s.properties['application.name'] ?? '', s.properties['media.name'] ?? ''));
            if (this._destroyed || (running === this.running && musicRunning === this.musicRunning))
                return;
            this.running = running;
            this.musicRunning = musicRunning;
            this.emit('changed');
        });
    }
}
