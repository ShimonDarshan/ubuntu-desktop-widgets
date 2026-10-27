// Names the plugged-in monitors, so the card's spot can be saved per monitor
// and per set of monitors. Screen coordinates alone don't do: a monitor's
// coordinates change as others are plugged in or out around it.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DISPLAY_CONFIG = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_CONFIG_PATH = '/org/gnome/Mutter/DisplayConfig';
// Serials of monitors that don't report one, like most laptop panels.
const NO_SERIAL = ['', '0x00000000', 'unknown'];

// Vendor, product and serial stay the same on any port or dock; the
// connector only tells apart monitors without a serial.
function monitorName([connector, vendor, product, serial]) {
    return NO_SERIAL.includes(serial)
        ? `${vendor} ${product} on ${connector}`
        : `${vendor} ${product} ${serial}`;
}

// Resolves with {setup, monitors}, or null when mutter doesn't answer.
// setup names the set of plugged-in monitors; monitors has the name and
// screen corner of each of Main.layoutManager.monitors (a mirrored monitor's
// name joins its outputs' names).
export function describeMonitors(cancellable) {
    return new Promise(resolve => {
        Gio.DBus.session.call(DISPLAY_CONFIG, DISPLAY_CONFIG_PATH,
            DISPLAY_CONFIG, 'GetCurrentState', null, null,
            Gio.DBusCallFlags.NONE, -1, cancellable, (conn, res) => {
                let logical;
                try {
                    [, , logical] = conn.call_finish(res).deepUnpack();
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`desktop-widgets: monitors: ${e.message}`);
                    resolve(null);
                    return;
                }
                const monitors = Main.layoutManager.monitors.map(({x, y}) => {
                    const outputs = logical.find(([lx, ly]) => lx === x && ly === y)?.[5];
                    return {name: outputs?.map(monitorName).sort().join(' + ') ?? null, x, y};
                });
                if (monitors.some(m => !m.name)) {
                    resolve(null);
                    return;
                }
                resolve({setup: monitors.map(m => m.name).sort().join(', '), monitors});
            });
    });
}
