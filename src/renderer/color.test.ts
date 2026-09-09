import { describe, expect, test } from 'bun:test';
import { hexToRgb, hsvToRgb, luminance, parseColor, pushRecent, readableInk, rgbToHex, rgbToHsv } from './color';

describe('hex', () => {
  test('reads long, short, and unprefixed forms', () => {
    expect(hexToRgb('#4cc9f0')).toEqual({ r: 76, g: 201, b: 240 });
    expect(hexToRgb('4cc9f0')).toEqual({ r: 76, g: 201, b: 240 });
    expect(hexToRgb('#f0a')).toEqual({ r: 255, g: 0, b: 170 });
  });

  test('rejects anything that is not a colour', () => {
    expect(hexToRgb('#12345')).toBeNull();
    expect(hexToRgb('rebeccapurple')).toBeNull();
    expect(hexToRgb('')).toBeNull();
  });

  test('writes back what it read', () => {
    expect(rgbToHex({ r: 76, g: 201, b: 240 })).toBe('#4cc9f0');
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
  });

  test('clamps and rounds out-of-range channels rather than emitting garbage', () => {
    expect(rgbToHex({ r: -5, g: 300, b: 127.6 })).toBe('#00ff80');
  });
});

describe('parseColor', () => {
  test('takes hex, rgb() and bare triples', () => {
    expect(parseColor('  #4CC9F0 ')).toBe('#4cc9f0');
    expect(parseColor('rgb(76, 201, 240)')).toBe('#4cc9f0');
    expect(parseColor('76 201 240')).toBe('#4cc9f0');
  });

  test('refuses out-of-range numbers and nonsense', () => {
    expect(parseColor('300, 0, 0')).toBeNull();
    expect(parseColor('hello')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});

describe('hsv', () => {
  test('round-trips the primaries', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#4cc9f0']) {
      const rgb = hexToRgb(hex)!;
      expect(rgbToHex(hsvToRgb(rgbToHsv(rgb)))).toBe(hex);
    }
  });

  test('greys have no hue and full value is white', () => {
    expect(rgbToHsv({ r: 128, g: 128, b: 128 }).s).toBe(0);
    expect(rgbToHex(hsvToRgb({ h: 210, s: 0, v: 1 }))).toBe('#ffffff');
  });

  test('hue wraps rather than clipping', () => {
    expect(rgbToHex(hsvToRgb({ h: 360, s: 1, v: 1 }))).toBe('#ff0000');
    expect(rgbToHex(hsvToRgb({ h: -120, s: 1, v: 1 }))).toBe('#0000ff');
  });
});

describe('readableInk', () => {
  test('picks the ink that will actually be legible', () => {
    expect(readableInk('#ffffff')).toBe('#101116');
    expect(readableInk('#000000')).toBe('#ffffff');
    expect(luminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
  });
});

describe('pushRecent', () => {
  test('moves a repeat to the front instead of duplicating it', () => {
    const list = pushRecent(pushRecent(['#111111'], '#222222'), '#111111');
    expect(list).toEqual(['#111111', '#222222']);
  });

  test('matches case-insensitively, and keeps what was just typed', () => {
    expect(pushRecent(['#aabbcc'], '#AABBCC')).toEqual(['#aabbcc']);
  });

  test('drops the oldest past the cap', () => {
    let list: string[] = [];
    for (let i = 0; i < 8; i++) list = pushRecent(list, `#00000${i}`, 3);
    expect(list).toEqual(['#000007', '#000006', '#000005']);
  });
});
