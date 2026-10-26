// Settings window (Extensions app → Desktop Widgets → Settings, or the
// card's right-click menu → Settings…).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const STYLES = [['rainbow', 'Rainbow bars'], ['mirror', 'Mirror'], ['wave', 'Wave']];

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class DesktopWidgetsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Music', icon_name: 'audio-x-generic-symbolic'});

        const card = new Adw.PreferencesGroup({title: 'Music card'});
        card.add(switchRow(settings, 'media-visible', 'Show music card'));
        card.add(switchRow(settings, 'media-on-top', 'Always on top',
            'When off, the card sits on the desktop and windows cover it'));
        card.add(switchRow(settings, 'media-locked', 'Lock position'));
        const reset = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        reset.connect('clicked', () => settings.reset('media-position'));
        const resetRow = new Adw.ActionRow({
            title: 'Position',
            subtitle: 'Drag the card to move it; reset puts it back in the top-right corner',
        });
        resetRow.add_suffix(reset);
        card.add(resetRow);
        page.add(card);

        const visualizer = new Adw.PreferencesGroup({title: 'Visualizer'});
        const style = new Adw.ComboRow({
            title: 'Style',
            model: Gtk.StringList.new(STYLES.map(([, label]) => label)),
        });
        const syncStyle = () => {
            const index = STYLES.findIndex(([key]) => key === settings.get_string('visualizer-style'));
            style.selected = Math.max(0, index);
        };
        syncStyle();
        settings.connect('changed::visualizer-style', syncStyle);
        style.connect('notify::selected',
            () => settings.set_string('visualizer-style', STYLES[style.selected][0]));
        visualizer.add(style);

        const bars = Adw.SpinRow.new_with_range(12, 64, 1);
        bars.title = 'Bars';
        settings.bind('visualizer-bars', bars, 'value', Gio.SettingsBindFlags.DEFAULT);
        visualizer.add(bars);

        const cava = GLib.find_program_in_path('cava') ??
            (GLib.file_test('/usr/local/bin/cava', GLib.FileTest.IS_EXECUTABLE) ? '/usr/local/bin/cava' : null);
        visualizer.add(new Adw.ActionRow({
            title: 'cava',
            subtitle: cava
                ? `Found at ${cava}; the bars follow the music`
                : 'Not installed; run scripts/install-cava.sh so the bars follow the music',
        }));
        page.add(visualizer);

        window.add(page);
    }
}
