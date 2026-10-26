// GNOME shows the microphone icon in the top bar whenever anything records
// audio. The visualizer's cava stream only listens to what the speakers play,
// so leave it out of that check; any other recording still shows the icon.
// Same logic as InputStreamSlider._maybeShowInput in ui/status/volume.js
// (GNOME 46; the top-bar icon follows that slider's visibility), plus the
// cava filter.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// media.name of cava's PipeWire stream; Gvc reports it as the description
// (get_name() is null for recording streams).
const CAVA_STREAM_NAME = 'cava';
const SKIPPED_APPS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];
// A new stream gets its description a moment after 'stream-added'.
const RECHECK_MS = 300;
// At login, extensions are enabled before the quick settings finish building
// their indicators (asynchronously); wait for the microphone one this long.
const WAIT_MS = 250;
const WAIT_TRIES = 120;

function findSlider() {
    const slider = Main.panel.statusArea.quickSettings?._volumeInput?._input;
    return typeof slider?._maybeShowInput === 'function' ? slider : null;
}

function override(slider) {
    let recheckId = 0;
    slider._maybeShowInput = function () {
        const outputs = this._control.get_source_outputs();
        this._showInput = !!this._stream && outputs.some(output =>
            !SKIPPED_APPS.includes(output.get_application_id()) &&
            output.get_description() !== CAVA_STREAM_NAME);
        this._sync();

        if (!recheckId && outputs.some(output => !output.get_description())) {
            recheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RECHECK_MS, () => {
                recheckId = 0;
                this._maybeShowInput();
                return GLib.SOURCE_REMOVE;
            });
        }
    };
    const changedId = slider._control.connect('stream-changed', () => slider._maybeShowInput());
    slider._maybeShowInput();

    return () => {
        slider._control.disconnect(changedId);
        if (recheckId)
            GLib.source_remove(recheckId);
        // Drop the override so the prototype's method is used again.
        delete slider._maybeShowInput;
        slider._maybeShowInput();
    };
}

// Returns a function that puts the original logic back (or stops waiting).
export function hideCavaFromMicIndicator() {
    const slider = findSlider();
    if (slider)
        return override(slider);

    let restore = null;
    let tries = 0;
    let waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WAIT_MS, () => {
        const found = findSlider();
        if (found) {
            restore = override(found);
        } else if (++tries < WAIT_TRIES) {
            return GLib.SOURCE_CONTINUE;
        } else {
            console.warn('desktop-widgets: microphone indicator not found; cava will show it');
        }
        waitId = 0;
        return GLib.SOURCE_REMOVE;
    });

    return () => {
        if (waitId)
            GLib.source_remove(waitId);
        restore?.();
    };
}
