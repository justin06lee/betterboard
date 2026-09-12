import { describe, expect, test } from 'bun:test';
import { appendPoint, inkReach, makeStroke, movedStroke, packPoints, scaledStroke, sealPoints, unpackPoints } from './points';
import type { Stroke } from './types';
import { emptyBBox } from './types';

const fields = { id: 's', seq: 0, color: '#fff', size: 4, pen: true, brush: 'pen' as const, seed: 1, layer: 'l', frame: 'f' };

describe('packed points', () => {
  test('keep their precision however far out on the board they were drawn', () => {
    const far = 12_345_678.9012;
    const points = Array.from({ length: 50 }, (_, i) => ({ x: far + i * 0.37, y: -far - i * 0.11, p: 0.5 }));
    for (const [a, b] of unpackPoints(packPoints(points)).map((p, i) => [p, points[i]])) {
      expect(Math.abs(a.x - b.x)).toBeLessThan(1e-5);
      expect(Math.abs(a.y - b.y)).toBeLessThan(1e-5);
    }
  });

  test('are measured from the first point', () => {
    const packed = packPoints([
      { x: 10, y: 20, p: 0.5 },
      { x: 13, y: 24, p: 0.25 },
    ]);
    expect([packed.ox, packed.oy, packed.n]).toEqual([10, 20, 2]);
    expect([...packed.pts]).toEqual([0, 0, 0.5, 3, 4, 0.25]);
  });
});

describe('a stroke being drawn', () => {
  test('makes room as points arrive, and gives the spare back when it ends', () => {
    const s: Stroke = { ...fields, ox: 0, oy: 0, pts: new Float32Array(3), n: 0, bbox: emptyBBox() };
    for (let i = 0; i < 100; i++) appendPoint(s, 5 + i, 7, 0.5);
    expect(s.n).toBe(100);
    expect(s.pts.length).toBeGreaterThanOrEqual(300);
    expect([s.ox, s.oy]).toEqual([5, 7]);
    expect(unpackPoints(s)[99]).toEqual({ x: 104, y: 7, p: 0.5 });
    sealPoints(s);
    expect(s.pts.length).toBe(300);
  });

  test('grows its box to cover the ink, not just the centerline', () => {
    const s: Stroke = { ...fields, ox: 0, oy: 0, pts: new Float32Array(3), n: 0, bbox: emptyBBox() };
    appendPoint(s, 0, 0, 0.5);
    appendPoint(s, 100, 0, 0.5);
    const r = inkReach('pen', 4);
    expect(s.bbox).toEqual({ minX: -r, minY: -r, maxX: 100 + r, maxY: r });
  });
});

describe('copies', () => {
  const s = makeStroke(fields, [
    { x: 0, y: 0, p: 0.5 },
    { x: 10, y: 5, p: 0.5 },
  ]);

  test('a moved stroke shares its points and its outline', () => {
    const withPath = { ...s, path: {} as Path2D };
    const moved = movedStroke(withPath, 3, -2);
    expect(moved.pts).toBe(s.pts);
    expect(moved.path).toBe(withPath.path);
    expect([moved.ox, moved.oy]).toEqual([3, -2]);
    expect(moved.bbox.minX).toBeCloseTo(s.bbox.minX + 3);
    expect(moved.bbox.maxY).toBeCloseTo(s.bbox.maxY - 2);
  });

  test('a moved pixel stroke works its cells out again where it lands', () => {
    const pixel = { ...s, brush: 'pixel' as const, path: {} as Path2D };
    expect(movedStroke(pixel, 1, 1).path).toBeUndefined();
  });

  test('a scaled stroke scales around the origin, size and all', () => {
    const scaled = scaledStroke(s, 2);
    expect(scaled.size).toBe(8);
    expect(unpackPoints(scaled)).toEqual([
      { x: 0, y: 0, p: 0.5 },
      { x: 20, y: 10, p: 0.5 },
    ]);
    expect(scaled.pts).not.toBe(s.pts);
  });
});

describe('ink reach', () => {
  test('covers what each brush can put down beyond its centerline', () => {
    expect(inkReach('liner', 10)).toBeLessThan(inkReach('pen', 10));
    expect(inkReach('pen', 10)).toBeLessThan(inkReach('chalk', 10));
    // A pen pressed hard runs to 0.81 × its size either side.
    expect(inkReach('pen', 10)).toBeGreaterThanOrEqual(8.1);
    // A pixel's cell can sit a whole cell from the point that lit it.
    expect(inkReach('pixel', 6)).toBeGreaterThanOrEqual(6);
  });
});
