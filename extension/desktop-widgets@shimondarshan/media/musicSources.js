// Which players and sound streams count as music for the visualizer when it
// is set to follow Spotify and YouTube only: the Spotify app, and Spotify Web
// or YouTube in a browser. A player is known by its page address
// (xesam:url); a browser's sound stream only by its tab title:
//   YouTube        "(3) Song - YouTube", "Song - YouTube Music"
//   Spotify Web    "Spotify – Liked Songs" (paused), "Song • Artist" (playing)

import GLib from 'gi://GLib';

const MUSIC_HOSTS = ['open.spotify.com', 'youtube.com', 'music.youtube.com'];
const SPOTIFY_APP = 'org.mpris.MediaPlayer2.spotify';
const YOUTUBE_TITLE = /- YouTube( Music)?$/;
const SPOTIFY_TITLE = /^Spotify\b/;
const TRACK_TITLE = / • /;

function parse(url) {
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE);
    } catch {
        return null;
    }
}

function hostOf(url) {
    return parse(url)?.get_host()?.replace(/^(www|m)\./, '') ?? '';
}

export function isMusicPlayer(player) {
    return player.busName === SPOTIFY_APP || player.busName.startsWith(`${SPOTIFY_APP}.`) ||
        MUSIC_HOSTS.includes(hostOf(player.url));
}

// A YouTube page that isn't a video (home, search, a channel...), where
// hovering a thumbnail plays a muted preview. Firefox has one player for all
// its tabs, so the preview would take it over from the music playing.
export function isPreviewPage(url) {
    const uri = parse(url);
    return hostOf(url) === 'youtube.com' &&
        !/^\/(watch|shorts|live|embed)\b/.test(uri.get_path());
}

// app is the stream's application.name, title its media.name.
export function isMusicStream(app, title) {
    return /^spotify$/i.test(app) ||
        YOUTUBE_TITLE.test(title) || SPOTIFY_TITLE.test(title) || TRACK_TITLE.test(title);
}
