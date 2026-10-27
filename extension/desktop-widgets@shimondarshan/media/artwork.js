// Cover art for the music card. Remote covers (Spotify sends https://
// addresses) are copied to ~/.cache/desktop-widgets/art, since St draws a
// background image with round corners only from a file. Each cover also gives
// two colors: the card's tint and the visualizer run from one to the other.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {hsl, toHsl} from './color.js';

// Covers kept on disk, newest first; older ones are deleted at startup.
const KEEP_FILES = 100;
// Results kept in memory.
const KEEP_RESULTS = 50;
// The cover is shrunk to SAMPLE x SAMPLE pixels to pick its colors.
const SAMPLE = 32;
// Hue buckets of 30 degrees; the second color must be at least MIN_APART
// buckets away from the first.
const BUCKETS = 12;
const MIN_APART = 2;

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

// Vivid, mid-light versions that read well on the dark card.
function tame(rgb) {
    const [h, s, l] = toHsl(rgb);
    return hsl(h, clamp(s, 0.45, 0.85), clamp(l, 0.6, 0.72));
}

// The two strongest colors of the cover, or null for a gray one. Each pixel
// counts by how vivid it is; near-black, near-white and gray pixels don't
// count.
function pickColors(pixbuf) {
    const channels = pixbuf.get_n_channels();
    const stride = pixbuf.get_rowstride();
    const pixels = pixbuf.get_pixels();
    const buckets = Array.from({length: BUCKETS}, () => ({weight: 0, rgb: [0, 0, 0]}));

    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const i = y * stride + x * channels;
            if (channels === 4 && pixels[i + 3] < 128)
                continue;
            const rgb = [pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255];
            const [h, s, l] = toHsl(rgb);
            if (s < 0.2 || l < 0.12 || l > 0.9)
                continue;
            const weight = s * (1 - Math.abs(l - 0.5) * 1.4);
            const bucket = buckets[Math.floor(h / 30) % BUCKETS];
            bucket.weight += weight;
            rgb.forEach((c, k) => (bucket.rgb[k] += c * weight));
        }
    }

    const ranked = buckets.map((b, index) => ({...b, index}))
        .filter(b => b.weight > 0)
        .sort((a, b) => b.weight - a.weight);
    const first = ranked[0];
    if (!first || first.weight < SAMPLE * SAMPLE * 0.02)
        return null;
    const average = b => b.rgb.map(c => c / b.weight);
    const primary = tame(average(first));

    const apart = b => {
        const d = Math.abs(b.index - first.index);
        return Math.min(d, BUCKETS - d) >= MIN_APART;
    };
    const second = ranked.find(b => apart(b) && b.weight >= first.weight * 0.15);
    if (second)
        return [primary, tame(average(second))];
    const [h, s, l] = toHsl(primary);
    return [primary, hsl((h + 40) % 360, s, clamp(l + 0.06, 0.6, 0.72))];
}

export class Artwork {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'desktop-widgets', 'art']);
        this._results = new Map();
        this._cancellable = new Gio.Cancellable();
        try {
            GLib.mkdir_with_parents(this._dir, 0o755);
            this._prune();
        } catch (e) {
            console.error(`desktop-widgets: art cache: ${e.message}`);
        }
    }

    // Resolves with {path, colors} for the cover at uri, colors being
    // [primary, secondary] or null, or with null when it can't be read.
    load(uri) {
        let result = this._results.get(uri);
        if (!result) {
            result = this._load(uri);
            this._results.set(uri, result);
            if (this._results.size > KEEP_RESULTS)
                this._results.delete(this._results.keys().next().value);
        }
        return result;
    }

    destroy() {
        this._cancellable.cancel();
        this._results.clear();
    }

    async _load(uri) {
        try {
            const path = await this._localPath(uri);
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, SAMPLE, SAMPLE, false);
            return {path, colors: pickColors(pixbuf)};
        } catch (e) {
            if (!isCancelled(e))
                console.warn(`desktop-widgets: cover ${uri}: ${e.message}`);
            this._results.delete(uri);
            return null;
        }
    }

    // Local covers are used where they are; remote ones are downloaded once.
    async _localPath(uri) {
        const file = Gio.File.new_for_uri(uri);
        if (file.is_native())
            return file.get_path();
        const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, uri, -1);
        const path = GLib.build_filenamev([this._dir, name]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
        const bytes = await new Promise((resolve, reject) => {
            file.load_bytes_async(this._cancellable, (_f, res) => {
                try {
                    resolve(file.load_bytes_finish(res)[0]);
                } catch (e) {
                    reject(e);
                }
            });
        });
        GLib.file_set_contents(path, bytes.toArray());
        return path;
    }

    _prune() {
        const dir = Gio.File.new_for_path(this._dir);
        const enumerator = dir.enumerate_children('standard::name,time::modified',
            Gio.FileQueryInfoFlags.NONE, null);
        const files = [];
        let info;
        while ((info = enumerator.next_file(null)))
            files.push([info.get_name(), info.get_attribute_uint64('time::modified')]);
        enumerator.close(null);
        files.sort((a, b) => b[1] - a[1]);
        for (const [name] of files.slice(KEEP_FILES))
            dir.get_child(name).delete(null);
    }
}
