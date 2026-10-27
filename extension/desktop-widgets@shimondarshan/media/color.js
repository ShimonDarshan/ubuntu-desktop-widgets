// Small color helpers shared by the card, the visualizer and the cover
// colors. Colors are [r, g, b] arrays in 0..1.

// HSL (h in degrees, s/l in 0..1) to [r, g, b].
export function hsl(h, s, l) {
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)];
}

// [r, g, b] to [h, s, l], h in degrees.
export function toHsl([r, g, b]) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0)
        return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === r)
        h = ((g - b) / d) % 6;
    else if (max === g)
        h = (b - r) / d + 2;
    else
        h = (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
}

// a at t = 0, b at t = 1.
export function mix(a, b, t) {
    return a.map((c, i) => c + (b[i] - c) * t);
}

export function css(rgb, alpha = 1) {
    const [r, g, b] = rgb.map(c => Math.round(Math.max(0, Math.min(1, c)) * 255));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
