import { describe, expect, test } from 'bun:test';
import { backgroundSelect, dilate, floodSelect, maskBounds, maskTouchesBorder, similarSelect } from './pixels';

// Builds an RGBA buffer from a character grid and a palette, so a test image
// reads like a picture of itself.
function raster(rows: string[], palette: Record<string, [number, number, number, number]>) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = palette[row[x]];
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  });
  return { data, width, height };
}

function picture(mask: Uint8Array, width: number, height: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) row += mask[y * width + x] ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

const INK: Record<string, [number, number, number, number]> = {
  w: [255, 255, 255, 255],
  r: [200, 30, 30, 255],
  b: [30, 30, 200, 255],
  t: [0, 0, 0, 0], // transparent
  k: [0, 0, 0, 255], // opaque black
};

describe('floodSelect', () => {
  test('selects the contiguous region of the seed color only', () => {
    const { data, width, height } = raster(['wwrww', 'wwrww', 'rrrrr', 'wwrww'], INK);
    const mask = floodSelect(data, width, height, 0, 0, 10);
    expect(picture(mask, width, height)).toEqual(['##...', '##...', '.....', '.....']);
  });

  test('does not leak across diagonal contact', () => {
    const { data, width, height } = raster(['wr', 'rw'], INK);
    const mask = floodSelect(data, width, height, 0, 0, 10);
    expect(picture(mask, width, height)).toEqual(['#.', '..']);
  });

  test('tolerance widens what counts as the same color', () => {
    const palette: Record<string, [number, number, number, number]> = {
      a: [100, 100, 100, 255],
      b: [130, 100, 100, 255], // 30 away on one channel
      c: [250, 100, 100, 255],
    };
    const { data, width, height } = raster(['abc'], palette);
    expect(picture(floodSelect(data, width, height, 0, 0, 5), width, height)).toEqual(['#..']);
    expect(picture(floodSelect(data, width, height, 0, 0, 20), width, height)).toEqual(['##.']);
  });

  test('transparent pixels never match opaque ones of the same RGB', () => {
    const { data, width, height } = raster(['tk'], INK);
    const mask = floodSelect(data, width, height, 0, 0, 40);
    expect(picture(mask, width, height)).toEqual(['#.']);
  });

  test('a seed outside the image selects nothing', () => {
    const { data, width, height } = raster(['ww'], INK);
    expect(maskBounds(floodSelect(data, width, height, 5, 0, 10), width, height)).toBeNull();
  });
});

describe('backgroundSelect', () => {
  test('selects the border-connected backdrop, not enclosed holes of the same color', () => {
    const { data, width, height } = raster(
      ['wwwwww', 'wrrrrw', 'wrwwrw', 'wrrrrw', 'wwwwww'],
      INK
    );
    const mask = backgroundSelect(data, width, height, 10);
    expect(picture(mask, width, height)).toEqual([
      '######',
      '#....#',
      '#....#',
      '#....#',
      '######',
    ]);
  });

  test('keeps a subject that touches the edge', () => {
    const { data, width, height } = raster(['wwrr', 'wwrr', 'wwww'], INK);
    const mask = backgroundSelect(data, width, height, 10);
    expect(picture(mask, width, height)).toEqual(['##..', '##..', '####']);
  });

  test('follows the dominant border color when a corner disagrees', () => {
    const { data, width, height } = raster(['bwww', 'wwww', 'wwrw', 'wwww'], INK);
    const mask = backgroundSelect(data, width, height, 10);
    expect(picture(mask, width, height)).toEqual(['.###', '####', '##.#', '####']);
  });
});

describe('dilate', () => {
  test('grows the mask by one 4-connected ring', () => {
    const mask = new Uint8Array(5 * 5);
    mask[2 * 5 + 2] = 1;
    expect(picture(dilate(mask, 5, 5), 5, 5)).toEqual([
      '.....',
      '..#..',
      '.###.',
      '..#..',
      '.....',
    ]);
  });
});

describe('maskBounds', () => {
  test('finds the tight box around the selected pixels', () => {
    const mask = new Uint8Array(4 * 3);
    mask[1 * 4 + 1] = 1;
    mask[2 * 4 + 3] = 1;
    expect(maskBounds(mask, 4, 3)).toEqual({ minX: 1, minY: 1, maxX: 3, maxY: 2 });
  });

  test('is null for an empty mask', () => {
    expect(maskBounds(new Uint8Array(6), 3, 2)).toBeNull();
  });
});

describe('similarSelect', () => {
  test('takes every matching pixel, connected or not', () => {
    const { data, width, height } = raster(['rwr', 'www', 'rwr'], INK);
    const mask = similarSelect(data, width, height, 0, 0, 10);
    expect(picture(mask, width, height)).toEqual(['#.#', '...', '#.#']);
  });

  test('still respects tolerance', () => {
    const { data, width, height } = raster(['rb', 'br'], INK);
    expect(picture(similarSelect(data, width, height, 0, 0, 10), width, height)).toEqual(['#.', '.#']);
    expect(picture(similarSelect(data, width, height, 0, 0, 255), width, height)).toEqual(['##', '##']);
  });

  test('a click outside the picture selects nothing', () => {
    const { data, width, height } = raster(['rr', 'rr'], INK);
    expect(similarSelect(data, width, height, 5, 0, 40).some((v) => v === 1)).toBe(false);
  });
});

describe('maskTouchesBorder', () => {
  test('tells an enclosed region from one that ran off the edge', () => {
    const { data, width, height } = raster(['www', 'wrw', 'www'], INK);
    const inside = floodSelect(data, width, height, 1, 1, 10);
    const outside = floodSelect(data, width, height, 0, 0, 10);
    expect(maskTouchesBorder(inside, width, height)).toBe(false);
    expect(maskTouchesBorder(outside, width, height)).toBe(true);
  });

  test('an empty mask has not touched anything', () => {
    expect(maskTouchesBorder(new Uint8Array(9), 3, 3)).toBe(false);
  });
});
