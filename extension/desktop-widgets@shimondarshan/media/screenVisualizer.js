// The visualizer at the bottom of the screen: one strip of bars along the
// bottom edge of each monitor, above every window (and the dock), with no
// background. Clicks, scrolling and the pointer go through it to whatever is
// underneath. A monitor showing a fullscreen window hides its strip. The
// strips fade out once the music stops and the bars have sunk, and come back
// when it plays again.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Visualizer} from './visualizer.js';

// Height of the strips, in logical pixels.
const HEIGHT = 72;
const FADE_IN_MS = 200;
// Waits for the bars to sink (visualizer.js) before fading out.
const FADE_OUT_DELAY_MS = 600;
const FADE_OUT_MS = 400;

export class ScreenVisualizer {
    constructor(feed) {
        this._feed = feed;
        this._strips = [];
        this._style = 'halo';
        this._colors = null;
        this._playing = false;
        this.rebuild();
    }

    // One strip per monitor; call again when monitors change.
    rebuild() {
        this._destroyStrips();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const height = HEIGHT * scale;
        for (const monitor of Main.layoutManager.monitors) {
            const strip = new Visualizer(this._feed, {
                style_class: 'dw-screen-visualizer',
                reactive: false,
                x_expand: false,
                opacity: this._playing ? 255 : 0,
            });
            strip.set_position(monitor.x, monitor.y + monitor.height - height);
            strip.set_size(monitor.width, height);
            strip.setStyle(this._style);
            strip.setColors(this._colors);
            Main.layoutManager.addChrome(strip, {
                affectsInputRegion: false,
                affectsStruts: false,
                trackFullscreen: true,
            });
            this._strips.push(strip);
        }
    }

    setStyle(style) {
        this._style = style;
        this._strips.forEach(s => s.setStyle(style));
    }

    setColors(colors) {
        this._colors = colors;
        this._strips.forEach(s => s.setColors(colors));
    }

    // The strips stay mapped while faded out, so the feed still sees them
    // and starts cava as soon as music plays.
    setPlaying(playing) {
        if (playing === this._playing)
            return;
        this._playing = playing;
        for (const strip of this._strips) {
            strip.remove_all_transitions();
            strip.ease({
                opacity: playing ? 255 : 0,
                delay: playing ? 0 : FADE_OUT_DELAY_MS,
                duration: playing ? FADE_IN_MS : FADE_OUT_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    destroy() {
        this._destroyStrips();
        this._feed = null;
    }

    _destroyStrips() {
        for (const strip of this._strips) {
            Main.layoutManager.removeChrome(strip);
            strip.destroy();
        }
        this._strips = [];
    }
}
