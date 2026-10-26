// The main output volume, through the same mixer the top-right system menu
// uses. Follows the default output when it changes (speakers -> headphones).

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

export class Output extends Signals.EventEmitter {
    constructor() {
        super();
        this._control = Volume.getMixerControl();
        this._control.connectObject(
            'default-sink-changed', () => this._setStream(),
            'state-changed', () => this._setStream(), this);
        this._setStream();
    }

    get available() {
        return !!this._stream;
    }

    get muted() {
        return !!this._stream?.is_muted;
    }

    // 0..1 of the normal maximum (100%).
    get level() {
        if (!this._stream)
            return 0;
        return Math.min(1, this._stream.volume / this._control.get_vol_max_norm());
    }

    setLevel(value) {
        const stream = this._stream;
        if (!stream)
            return;
        stream.volume = value * this._control.get_vol_max_norm();
        if (stream.is_muted && value > 0)
            stream.change_is_muted(false);
        stream.push_volume();
    }

    toggleMute() {
        this._stream?.change_is_muted(!this._stream.is_muted);
    }

    destroy() {
        this._stream?.disconnectObject(this);
        this._stream = null;
        this._control.disconnectObject(this);
    }

    _setStream() {
        const stream = this._control.get_default_sink();
        if (stream !== this._stream) {
            this._stream?.disconnectObject(this);
            this._stream = stream;
            this._stream?.connectObject(
                'notify::volume', () => this.emit('changed'),
                'notify::is-muted', () => this.emit('changed'), this);
        }
        this.emit('changed');
    }
}
