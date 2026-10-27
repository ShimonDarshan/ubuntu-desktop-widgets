// Music visualizer: rounded pill bars on one baseline, colored after where the
// music comes from: reds for YouTube, greens for Spotify, white for the
// laptop's own players. Each palette shifts a little from left to right and
// changes shade toward the top of tall bars. Before any player shows up the
// bars keep the rainbow (orange -> purple). Bar heights come from cava, which only
// listens to what the speakers play; it never changes the sound. cava runs
// only while the visualizer is active (music playing, widget shown).

import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const STYLES = ['rainbow', 'mirror', 'wave'];

const FRAMERATE = 30;
const RESTART_DELAY_S = 5;
// cava prints each bar as 0..ASCII_MAX.
const ASCII_MAX = 1000;
// cava asks PipeWire for 512-sample buffers, which lowers the quantum of the
// whole output (crackles on Bluetooth headphones). Ask for PipeWire's default
// quantum instead; still ~47 updates a second, plenty for 30 fps bars.
const CAVA_LATENCY = '1024/48000';
// When the music stops, the bars sink to dots over about half a second.
const SINK_FACTOR = 0.78;
const SINK_MS = 33;

function cavaConfig(bars) {
    return `[general]
bars = ${bars}
framerate = ${FRAMERATE}

[input]
method = pipewire
source = auto

[output]
method = raw
raw_target = /dev/stdout
data_format = ascii
ascii_max_range = ${ASCII_MAX}
bar_delimiter = 59
frame_delimiter = 10
channels = mono
mono_option = average
`;
}

// HSL (h in degrees, s/l in 0..1) to [r, g, b] in 0..1.
function hsl(h, s, l) {
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)];
}

// x is the bar's place from 0 (left) to 1 (right).
function baseColor(x) {
    return hsl(45 + 225 * x, 0.85, 0.52);
}

function topColor(x) {
    return hsl(Math.max(0, (45 + 225 * x) * 0.35 - 5), 0.9, 0.52);
}

function midColor(x) {
    const hue = 45 + 225 * x;
    return hsl((hue + Math.max(0, hue * 0.35 - 5)) / 2, 0.9, 0.52);
}

// Per source: base, mid and top colors, like the rainbow's, with x the bar's
// place from 0 (left) to 1 (right).
const PALETTES = {
    rainbow: {base: baseColor, mid: midColor, top: topColor},
    youtube: {
        base: x => hsl(345 + 15 * x, 0.85, 0.42),
        mid: x => hsl(352 + 10 * x, 0.9, 0.5),
        top: x => hsl(2 + 6 * x, 0.95, 0.6),
    },
    spotify: {
        base: x => hsl(150 - 10 * x, 0.75, 0.36),
        mid: x => hsl(143 - 6 * x, 0.73, 0.44),
        top: x => hsl(135 - 5 * x, 0.75, 0.6),
    },
    local: {
        base: x => hsl(0, 0, 0.62 + 0.06 * x),
        mid: x => hsl(0, 0, 0.8 + 0.04 * x),
        top: () => hsl(0, 0, 1),
    },
};

function findCava() {
    return GLib.find_program_in_path('cava') ??
        (GLib.file_test('/usr/local/bin/cava', GLib.FileTest.IS_EXECUTABLE)
            ? '/usr/local/bin/cava' : null);
}

export const Visualizer = GObject.registerClass(
class Visualizer extends St.DrawingArea {
    _init(params) {
        super._init({style_class: 'dw-media-visualizer', x_expand: true, ...params});
        this._style = 'rainbow';
        this._palette = PALETTES.rainbow;
        this._bars = 28;
        this._values = new Array(this._bars).fill(0);
        this._active = false;
        this._cava = findCava();
        if (!this._cava)
            console.warn('desktop-widgets: cava not found; the visualizer stays still');
        this.connect('destroy', () => this._onDestroy());
    }

    setStyle(style) {
        this._style = STYLES.includes(style) ? style : 'rainbow';
        this.queue_repaint();
    }

    // 'youtube', 'spotify' or 'local' (see Player.source); null keeps the rainbow.
    setSource(source) {
        const palette = PALETTES[source] ?? PALETTES.rainbow;
        if (palette === this._palette)
            return;
        this._palette = palette;
        this.queue_repaint();
    }

    setBarCount(bars) {
        if (bars === this._bars)
            return;
        this._bars = bars;
        this._values = new Array(bars).fill(0);
        if (this._active) {
            this._stop();
            this._spawn();
        }
        this.queue_repaint();
    }

    // Active: run cava and follow the music. Inactive: stop cava and let the
    // bars sink to a row of dots.
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        if (active) {
            this._stopSinking();
            this._spawn();
        } else {
            this._stop();
            this._startSinking();
        }
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        if (this._style === 'wave')
            this._drawWave(cr, width, height);
        else
            this._drawPills(cr, width, height, this._style === 'mirror');
        cr.$dispose();
    }

    _drawPills(cr, width, height, mirror) {
        const n = this._values.length;
        const slot = width / n;
        const barWidth = Math.max(2, slot * 0.6);
        const radius = barWidth / 2;
        for (let i = 0; i < n; i++) {
            const x = n > 1 ? i / (n - 1) : 0;
            const barHeight = Math.max(barWidth, this._values[i] * height);
            const left = i * slot + (slot - barWidth) / 2;
            const top = mirror ? (height - barHeight) / 2 : height - barHeight;

            // The gradient spans the whole height, so a short bar shows only
            // its base color and a tall one reaches the warm top color.
            const gradient = mirror
                ? new Cairo.LinearGradient(0, 0, 0, height)
                : new Cairo.LinearGradient(0, height, 0, 0);
            const {base, mid, top: topColor} = this._palette;
            if (mirror) {
                gradient.addColorStopRGB(0, ...topColor(x));
                gradient.addColorStopRGB(0.5, ...base(x));
                gradient.addColorStopRGB(1, ...topColor(x));
            } else {
                gradient.addColorStopRGB(0, ...base(x));
                gradient.addColorStopRGB(0.5, ...mid(x));
                gradient.addColorStopRGB(1, ...topColor(x));
            }

            cr.newSubPath();
            cr.arc(left + radius, top + radius, radius, Math.PI, 0);
            cr.arc(left + radius, top + barHeight - radius, radius, 0, Math.PI);
            cr.closePath();
            cr.setSource(gradient);
            cr.fill();
        }
    }

    _drawWave(cr, width, height) {
        const n = this._values.length;
        const lineWidth = 3;
        const span = height - 2 * lineWidth;
        const points = this._values.map((v, i) =>
            [(i + 0.5) * width / n, height - lineWidth - v * span]);

        const gradient = new Cairo.LinearGradient(0, 0, width, 0);
        const fill = new Cairo.LinearGradient(0, 0, width, 0);
        for (let s = 0; s <= 6; s++) {
            gradient.addColorStopRGB(s / 6, ...this._palette.base(s / 6));
            fill.addColorStopRGBA(s / 6, ...this._palette.base(s / 6), 0.25);
        }

        const tracePath = () => {
            cr.moveTo(0, points[0][1]);
            for (let i = 0; i < n - 1; i++) {
                const [x, y] = points[i];
                const [nx, ny] = points[i + 1];
                cr.curveTo(x, y, x, y, (x + nx) / 2, (y + ny) / 2);
            }
            cr.lineTo(width, points[n - 1][1]);
        };

        // Soft fill under the line, then the line itself.
        tracePath();
        cr.lineTo(width, height);
        cr.lineTo(0, height);
        cr.closePath();
        cr.setSource(fill);
        cr.fill();

        tracePath();
        cr.setSource(gradient);
        cr.setLineWidth(lineWidth);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.stroke();
    }

    _spawn() {
        this._restartId = 0;
        if (!this._cava || !this._active)
            return;

        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'desktop-widgets']);
        const config = GLib.build_filenamev([dir, 'cava.conf']);
        try {
            GLib.mkdir_with_parents(dir, 0o755);
            GLib.file_set_contents(config, cavaConfig(this._bars));
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            launcher.setenv('PIPEWIRE_LATENCY', CAVA_LATENCY, true);
            this._proc = launcher.spawnv([this._cava, '-p', config]);
        } catch (e) {
            console.error(`desktop-widgets: cannot start cava: ${e.message}`);
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
                console.error(`desktop-widgets: cava: ${e.message}`);
            }
            if (line === null) {
                // cava exited or its output broke; start it again.
                this._stop();
                this._scheduleRestart();
                return;
            }
            const values = line.split(';').filter(v => v !== '').map(v => Number(v) / ASCII_MAX);
            if (values.length === this._bars) {
                this._values = values;
                this.queue_repaint();
            }
            this._readLine(stream, cancellable);
        });
    }

    _stop() {
        if (this._restartId) {
            GLib.source_remove(this._restartId);
            this._restartId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._proc?.force_exit();
        this._proc = null;
    }

    _scheduleRestart() {
        if (!this._active)
            return;
        this._restartId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RESTART_DELAY_S, () => {
            this._spawn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _startSinking() {
        if (this._sinkId)
            return;
        this._sinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SINK_MS, () => {
            this._values = this._values.map(v => v * SINK_FACTOR);
            this.queue_repaint();
            if (this._values.every(v => v < 0.01)) {
                this._sinkId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopSinking() {
        if (this._sinkId) {
            GLib.source_remove(this._sinkId);
            this._sinkId = 0;
        }
    }

    _onDestroy() {
        this._active = false;
        this._stopSinking();
        this._stop();
    }
});
