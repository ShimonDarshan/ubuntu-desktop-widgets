// Desktop Widgets: widgets that live on the desktop. For now, the music card
// (media/widget.js). The card sits on the desktop layer, above the wallpaper
// and the desktop icons (DING) but below every app window, or, with "always on
// top", above the windows like the top panel.

import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {hideCavaFromMicIndicator} from './media/micIndicator.js';
import {MediaWidget} from './media/widget.js';

// DING draws the desktop icons in its own full-screen windows. On Wayland it
// names them "Desktop Icons <n>", or puts "@!x,y;<flags>" in the title with B
// for "keep at bottom" (see emulateX11WindowType.js in DING). Real X11
// desktop windows have the DESKTOP type.
function isDesktopWindow(actor) {
    const win = actor.meta_window;
    if (!win)
        return false;
    if (win.get_window_type() === Meta.WindowType.DESKTOP)
        return true;
    const title = win.get_title() ?? '';
    if (title.startsWith('Desktop Icons '))
        return true;
    const flags = title.match(/@!.*?;?([A-Za-z]*)\s*$/);
    return !!flags && flags[1].toUpperCase().includes('B');
}

export default class DesktopWidgetsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settings.connectObject(
            'changed::media-visible', () => this._syncMedia(),
            'changed::media-on-top', () => this._place(), this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._media?.restorePosition(), this);
        global.display.connectObject('restacked', () => this._restack(), this);
        this._restoreMicIndicator = hideCavaFromMicIndicator();
        this._syncMedia();
    }

    disable() {
        this._restoreMicIndicator?.();
        this._restoreMicIndicator = null;
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._destroyMedia();
        this._settings = null;
    }

    _syncMedia() {
        if (!this._settings.get_boolean('media-visible')) {
            this._destroyMedia();
            return;
        }
        if (this._media)
            return;
        this._media = new MediaWidget(this._settings, () => this.openPreferences());
        this._place();
        this._media.restorePosition();
    }

    _destroyMedia() {
        if (!this._media)
            return;
        this._unparent();
        this._media.destroy();
        this._media = null;
    }

    _place() {
        const widget = this._media;
        if (!widget)
            return;
        const onTop = this._settings.get_boolean('media-on-top');
        if (widget.get_parent()) {
            if (onTop === this._onTop)
                return;
            this._unparent();
        }
        this._onTop = onTop;
        if (onTop) {
            Main.layoutManager.addChrome(widget, {trackFullscreen: true});
        } else {
            global.window_group.add_child(widget);
            this._restack();
        }
    }

    _unparent() {
        const widget = this._media;
        if (this._onTop)
            Main.layoutManager.removeChrome(widget);
        else
            widget.get_parent()?.remove_child(widget);
    }

    // Window actors are reordered whenever windows restack; put the card back
    // just above the topmost desktop window (or the wallpaper when there is
    // none), so app windows still cover it. The children of the window group
    // are read directly because DING hides its windows from
    // global.get_window_actors().
    _restack() {
        const widget = this._media;
        if (!widget || this._onTop || widget.get_parent() !== global.window_group)
            return;
        const desktop = global.window_group.get_children()
            .filter(a => a instanceof Meta.WindowActor && isDesktopWindow(a)).at(-1);
        global.window_group.set_child_above_sibling(widget,
            desktop ?? Main.layoutManager._backgroundGroup);
    }
}
