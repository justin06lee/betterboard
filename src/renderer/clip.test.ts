import { describe, expect, test } from 'bun:test';
import { clipFromJSON, clipToJSON, isSticker, makeClip, placeClip, stickerName } from './clip';
import { makeStroke, pointAt, unpackPoints } from './points';
import type { BoardImage, Stroke } from './types';

function stroke(id: string, seq: number, at: number): Stroke {
  return {
    ...makeStroke({ id, seq, color: '#ff0000', size: 4, pen: true, brush: 'pen', seed: 7, layer: 'L1', frame: 'F1' }, [
      { x: at, y: at, p: 0.4 },
      { x: at + 10, y: at + 4, p: 0.8 },
    ]),
    // A fixed box, so the arithmetic below reads plainly.
    bbox: { minX: at - 2, minY: at - 2, maxX: at + 12, maxY: at + 6 },
  };
}

function image(id: string, seq: number, x: number, y: number): BoardImage {
  return { id, seq, src: 'data:image/png;base64,x', x, y, width: 20, height: 10, layer: 'L1', frame: 'F1' };
}

const place = { layer: 'L2', frame: 'F2', takeSeq: seqCounter() };

function seqCounter(): () => number {
  let n = 100;
  return () => n++;
}

describe('makeClip', () => {
  test('moves everything so the clip starts at its own origin', () => {
    // Bounds run from the image's corner (40, 30) to the stroke's padded
    // bbox (62, 56), so the whole clip shifts by exactly that corner.
    const clip = makeClip([stroke('a', 1, 50)], [image('b', 2, 40, 30)])!;
    expect(clip.width).toBe(22);
    expect(clip.height).toBe(26);
    expect(clip.images[0]).toMatchObject({ x: 0, y: 0 });
    expect(pointAt(clip.strokes[0], 0)).toMatchObject({ x: 10, y: 20 });
  });

  test('shares the stroke\'s points rather than copying them', () => {
    const s = stroke('a', 1, 0);
    expect(makeClip([s], [])!.strokes[0].pts).toBe(s.pts);
  });

  test('records how ink and pictures interleave, not just their two lists', () => {
    const clip = makeClip([stroke('ink', 5, 0)], [image('pic', 2, 0, 0)])!;
    expect(clip.order).toEqual(['image', 'stroke']);
  });

  test('is nothing when nothing was selected', () => {
    expect(makeClip([], [])).toBeNull();
  });

  test('written down as JSON, it comes back as the same clip', () => {
    const s = stroke('a', 1, 0);
    s.path = {} as Path2D;
    const clip = makeClip([s], [image('b', 2, 3, 4)])!;
    const json = clipToJSON(clip);
    const back = clipFromJSON(JSON.parse(JSON.stringify(json)));
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(unpackPoints(back.strokes[0])).toEqual(unpackPoints(clip.strokes[0]).map((p) => ({
      x: Math.round(p.x * 1e4) / 1e4,
      y: Math.round(p.y * 1e4) / 1e4,
      p: expect.closeTo(p.p, 3),
    })));
    expect(back.images).toEqual(clip.images);
    expect(back.order).toEqual(clip.order);
  });
});

describe('placeClip', () => {
  test('lands at the point it was given, with fresh ids on the active cell', () => {
    const clip = makeClip([stroke('a', 1, 50)], [])!;
    const { strokes } = placeClip(clip, { x: 200, y: 300 }, { ...place, takeSeq: seqCounter() });
    expect(strokes[0].id).not.toBe('a');
    expect(strokes[0].layer).toBe('L2');
    expect(strokes[0].frame).toBe('F2');
    // The clip's origin is the padded bbox corner, so the first point sits
    // just inside the point it was dropped at.
    expect(pointAt(strokes[0], 0)).toMatchObject({ x: 202, y: 302 });
    expect(strokes[0].bbox.minX).toBeLessThan(200);
  });

  test('hands out sequence numbers in the order the clip was made in', () => {
    const clip = makeClip([stroke('ink', 5, 0)], [image('pic', 2, 0, 0)])!;
    const out = placeClip(clip, { x: 0, y: 0 }, { ...place, takeSeq: seqCounter() });
    expect(out.images[0].seq).toBeLessThan(out.strokes[0].seq);
  });

  test('keeps the seed, so a paint stroke comes back with the same bristles', () => {
    const clip = makeClip([stroke('a', 1, 0)], [])!;
    const out = placeClip(clip, { x: 0, y: 0 }, { ...place, takeSeq: seqCounter() });
    expect(out.strokes[0].seed).toBe(7);
  });

  test('scales the whole clip, sizes included, when asked to', () => {
    const clip = makeClip([stroke('a', 1, 0)], [image('b', 2, 0, 0)])!;
    const out = placeClip(clip, { x: 0, y: 0 }, { ...place, takeSeq: seqCounter(), scale: 2 });
    expect(out.strokes[0].size).toBe(8);
    expect(out.images[0].width).toBe(40);
    expect(pointAt(out.strokes[0], 1).x - pointAt(out.strokes[0], 0).x).toBe(20);
  });

  test('leaves outlines unbuilt, for the renderer to build when first painted', () => {
    const clip = makeClip([stroke('a', 1, 0)], [])!;
    const out = placeClip(clip, { x: 0, y: 0 }, { ...place, takeSeq: seqCounter() });
    expect(out.strokes[0].path).toBeUndefined();
  });
});

describe('stickers', () => {
  test('names skip whatever is already taken', () => {
    expect(stickerName([{ name: 'Sticker 1' }, { name: 'Sticker 3' }])).toBe('Sticker 2');
  });

  test('rejects anything that is not a sticker, so a corrupt file cannot crash the tray', () => {
    expect(isSticker(null)).toBe(false);
    expect(isSticker({ id: 'x', name: 'x', thumb: '', clip: { strokes: [], images: [] } })).toBe(false);
    expect(
      isSticker({ id: 'x', name: 'x', thumb: '', clip: clipToJSON(makeClip([stroke('a', 1, 0)], [])!) })
    ).toBe(true);
  });
});
