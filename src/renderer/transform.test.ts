import { describe, expect, test } from 'bun:test';
import { makeStroke, pointAt, unpackPoints } from './points';
import type { Stroke } from './types';
import {
  OPPOSITE,
  boxAffine,
  boxGrips,
  gripMode,
  mapPoint,
  resizeCursor,
  resizeRect,
  transformRect,
  transformStroke,
} from './transform';

// buildPath draws into a Path2D; tests only need it to exist.
class TestPath2D {
  moveTo(): void {}
  lineTo(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
  arc(): void {}
  rect(): void {}
  addPath(): void {}
}

Object.assign(globalThis, { Path2D: TestPath2D });

const box = { x: 100, y: 100, width: 200, height: 100 };
const grips = boxGrips(box);

describe('grips', () => {
  test('corners scale and edges stretch the axis they face', () => {
    expect([0, 1, 2, 3].map(gripMode)).toEqual(['corner', 'corner', 'corner', 'corner']);
    expect(gripMode(4)).toBe('y'); // top
    expect(gripMode(5)).toBe('x'); // right
    expect(gripMode(6)).toBe('y'); // bottom
    expect(gripMode(7)).toBe('x'); // left
  });

  test('every grip is anchored by the one straight across the box', () => {
    grips.forEach((p, i) => {
      const q = grips[OPPOSITE[i]];
      expect((p.x + q.x) / 2).toBe(200);
      expect((p.y + q.y) / 2).toBe(150);
    });
  });
});

describe('resizeRect', () => {
  const left = grips[OPPOSITE[5]]; // what holds still while the right edge moves

  test('an edge grip stretches one axis about the opposite edge', () => {
    expect(resizeRect(box, left, { x: 400, y: 170 }, 'x')).toEqual({ x: 100, y: 100, width: 300, height: 100 });
    const top = grips[OPPOSITE[6]];
    expect(resizeRect(box, top, { x: 0, y: 150 }, 'y')).toEqual({ x: 100, y: 100, width: 200, height: 50 });
  });

  test('an edge dragged just past its anchor leaves the anchored edge where it was', () => {
    const r = resizeRect(box, left, { x: 97, y: 150 }, 'x', { min: 8 });
    expect(r.width).toBe(8);
    expect(r.x + r.width).toBe(left.x);
  });

  test('a corner keeps the proportions unless it is freed', () => {
    const topLeft = grips[0];
    expect(resizeRect(box, topLeft, { x: 500, y: 150 }, 'corner')).toEqual({ x: 100, y: 100, width: 400, height: 200 });
    expect(resizeRect(box, topLeft, { x: 500, y: 150 }, 'corner', { free: true })).toEqual({
      x: 100,
      y: 100,
      width: 400,
      height: 50,
    });
  });

  test('a corner dragged across its anchor carries the box to the other side', () => {
    expect(resizeRect(box, grips[0], { x: 0, y: 50 }, 'corner', { free: true })).toEqual({ x: 0, y: 50, width: 100, height: 50 });
  });

  test('a centred resize grows both sides at once', () => {
    const centre = { x: 200, y: 150 };
    expect(resizeRect(box, centre, { x: 400, y: 250 }, 'corner', { centered: true })).toEqual({
      x: 0,
      y: 50,
      width: 400,
      height: 200,
    });
    expect(resizeRect(box, centre, { x: 250, y: 0 }, 'x', { centered: true })).toEqual({ x: 150, y: 100, width: 100, height: 100 });
  });

  test('the floor holds a proportional resize to its proportions', () => {
    const r = resizeRect(box, grips[0], { x: 101, y: 101 }, 'corner', { min: 10 });
    expect(r.width).toBeCloseTo(20);
    expect(r.height).toBeCloseTo(10);
  });
});

describe('reshaping', () => {
  const stretched = { x: 100, y: 100, width: 400, height: 100 }; // twice as wide

  function stroke(): Stroke {
    return makeStroke(
      { id: 's', seq: 3, color: '#000000', size: 4, pen: true, brush: 'pen', seed: 7, layer: 'l', frame: 'f' },
      [
        { x: 100, y: 100, p: 0.3 },
        { x: 300, y: 200, p: 0.8 },
      ]
    );
  }

  test('a stroke is carried through the map and keeps what makes it itself', () => {
    const before = stroke();
    const after = transformStroke(before, box, stretched);
    const points = unpackPoints(after);
    expect(points.map((p) => [p.x, p.y])).toEqual([
      [100, 100],
      [500, 200],
    ]);
    expect(points[0].p).toBeCloseTo(0.3, 6);
    expect(points[1].p).toBeCloseTo(0.8, 6);
    expect(after).toMatchObject({ id: 's', seq: 3, seed: 7, brush: 'pen', layer: 'l', frame: 'f' });
    expect(after.path).toBeUndefined(); // drawn again along its new path, the first time it is painted
    expect(pointAt(before, 1).x).toBe(300); // the original is left alone for undo
  });

  test('a stretch widens the line by the geometric mean; an even scale by exactly the scale', () => {
    expect(transformStroke(stroke(), box, stretched).size).toBeCloseTo(4 * Math.SQRT2);
    expect(transformStroke(stroke(), box, { x: 100, y: 100, width: 100, height: 50 }).size).toBeCloseTo(2);
  });

  test('the reshaped bounds still wrap the ink', () => {
    const after = transformStroke(stroke(), box, stretched);
    for (const pt of unpackPoints(after)) {
      expect(pt.x - after.size / 2).toBeGreaterThanOrEqual(after.bbox.minX);
      expect(pt.x + after.size / 2).toBeLessThanOrEqual(after.bbox.maxX);
      expect(pt.y - after.size / 2).toBeGreaterThanOrEqual(after.bbox.minY);
      expect(pt.y + after.size / 2).toBeLessThanOrEqual(after.bbox.maxY);
    }
  });

  test('pictures, points and the canvas map all agree', () => {
    const moved = transformRect({ x: 150, y: 120, width: 50, height: 40 }, box, stretched);
    expect({ x: moved.x, y: moved.y }).toEqual(mapPoint({ x: 150, y: 120 }, box, stretched));
    expect({ x: moved.x + moved.width, y: moved.y + moved.height }).toEqual(mapPoint({ x: 200, y: 160 }, box, stretched));
    const m = boxAffine(box, stretched);
    const corner = mapPoint({ x: 300, y: 200 }, box, stretched);
    expect(corner).toEqual({ x: 300 * m.sx + m.dx, y: 200 * m.sy + m.dy });
    expect(corner).toEqual({ x: 500, y: 200 });
  });
});

describe('resizeCursor', () => {
  test('points the way the grip faces on screen', () => {
    expect(resizeCursor(1, 0)).toBe('ew-resize');
    expect(resizeCursor(-1, 0)).toBe('ew-resize');
    expect(resizeCursor(0, 1)).toBe('ns-resize');
    expect(resizeCursor(1, 1)).toBe('nwse-resize');
    expect(resizeCursor(-1, -1)).toBe('nwse-resize');
    expect(resizeCursor(1, -1)).toBe('nesw-resize');
    expect(resizeCursor(-1, 1)).toBe('nesw-resize');
  });
});
