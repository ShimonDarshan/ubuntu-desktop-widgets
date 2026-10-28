// What the music card and the screen visualizer show: the players, the one
// shown (the card's dots pick it), its cover and the cover's colors. Lives
// as long as the extension, so the screen visualizer keeps its colors while
// the card is hidden. Emits 'changed' when a player or its state changes and
// 'art-changed' when the cover (or its colors) changes.

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {Artwork, neutralColors} from './artwork.js';
import {Players} from './mpris.js';

export class NowPlaying extends Signals.EventEmitter {
    constructor() {
        super();
        this.active = null;
        // {path, colors} of the active player's cover, or null for none.
        this.cover = null;
        this._artKey = null;
        this._artwork = new Artwork();
        this._players = new Players();
        this._players.connect('changed', (_o, player) => {
            // A player that starts playing takes over, unless the one shown
            // is playing too.
            if (player?.playing && !this.active?.playing)
                this.active = player;
            this._sync();
        });
    }

    get players() {
        return this._players.list;
    }

    get playing() {
        return this.players.some(p => p.playing);
    }

    // The cover's colors, white and silver while there is no cover, or null
    // (the rainbow) with no player at all.
    get colors() {
        return this.cover?.colors ?? (this.active ? neutralColors() : null);
    }

    select(player) {
        this.active = player;
        this._sync();
    }

    destroy() {
        this._artKey = null;
        this._players.destroy();
        this._artwork.destroy();
    }

    _sync() {
        const players = this.players;
        if (!players.includes(this.active))
            this.active = players.find(p => p.playing) ?? players[0] ?? null;
        this._syncArt(this.active);
        this.emit('changed');
    }

    _syncArt(player) {
        const key = player ? player.artUrl || `app:${player.busName}` : null;
        if (key === this._artKey)
            return;
        this._artKey = key;
        if (!player?.artUrl) {
            this.cover = null;
            this.emit('art-changed');
            return;
        }
        // The previous cover stays until the new one is ready.
        this._artwork.load(player.artUrl).then(result => {
            if (key !== this._artKey)
                return;
            this.cover = result;
            this.emit('art-changed');
        });
    }
}
