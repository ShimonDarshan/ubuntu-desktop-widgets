// The music icon in the top bar: a click brings the music card above the app
// windows, a second click sends it back to the desktop. Shown pressed while
// the card is in front.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

export const MediaIndicator = GObject.registerClass(
class MediaIndicator extends PanelMenu.Button {
    _init(onClick) {
        super._init(0.5, 'Music card', true);
        this._onClick = onClick;
        this.add_child(new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'system-status-icon',
        }));
    }

    setActive(active) {
        if (active)
            this.add_style_pseudo_class('checked');
        else
            this.remove_style_pseudo_class('checked');
    }

    // No menu: a left click or a tap toggles the card.
    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.TOUCH_BEGIN ||
            (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY)) {
            this._onClick();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});
