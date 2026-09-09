// Colour maths for the in-app picker. The board only ever stores opaque
// `#rrggbb` strings, so everything here funnels back to that — but the picker
// needs HSV to give people a square to aim at, and RGB to type into.

export interface RGB {
  r: number; // 0..255
  g: number;
  b: number;
}

export interface HSV {
  h: number; // 0..360
  s: number; // 0..1
  v: number; // 0..1
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function hex2(v: number): string {
  return clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
}

export function rgbToHex({ r, g, b }: RGB): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

// Accepts `#abc` and `#aabbcc`, with or without the hash.
export function hexToRgb(hex: string): RGB | null {
  const s = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) {
    return {
      r: parseInt(s[0] + s[0], 16),
      g: parseInt(s[1] + s[1], 16),
      b: parseInt(s[2] + s[2], 16),
    };
  }
  if (/^[0-9a-f]{6}$/i.test(s)) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }
  return null;
}

// Anything a person might reasonably paste into the hex field: a hex string, an
// `rgb(...)` triple, or three bare numbers.
export function parseColor(text: string): string | null {
  const s = text.trim();
  if (!s) return null;
  const hex = hexToRgb(s);
  if (hex) return rgbToHex(hex);
  const nums = s.match(/-?\d+(\.\d+)?/g);
  if (nums && nums.length >= 3) {
    const [r, g, b] = nums.slice(0, 3).map(Number);
    if ([r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) {
      return rgbToHex({ r, g, b });
    }
  }
  return null;
}

export function rgbToHsv({ r, g, b }: RGB): HSV {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: HSV): RGB {
  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  const seg = Math.floor(hh / 60) % 6;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

// Relative luminance, for deciding whether a label sitting on a swatch should
// be black or white.
export function luminance({ r, g, b }: RGB): number {
  const channel = (v: number) => {
    const n = v / 255;
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function readableInk(hex: string): string {
  const rgb = hexToRgb(hex);
  return !rgb || luminance(rgb) > 0.42 ? '#101116' : '#ffffff';
}

// Recent colours are a most-recently-used list with no duplicates: picking a
// colour you already used moves it to the front rather than growing the row.
export const MAX_RECENT = 14;

export function pushRecent(list: string[], color: string, max = MAX_RECENT): string[] {
  const c = color.toLowerCase();
  return [c, ...list.filter((item) => item.toLowerCase() !== c)].slice(0, max);
}
