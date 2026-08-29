import { describe, expect, test } from 'bun:test';
import { eraseStrokePoints } from './erase';
import type { StrokePoint } from './types';

const line = (from: number, to: number, p0 = 0.25, p1 = 0.75): StrokePoint[] => [
  { x: from, y: 0, p: p0 },
  { x: to, y: 0, p: p1 },
];

describe('eraseStrokePoints', () => {
  test('splits a stroke and retains the portions outside the eraser circle', () => {
    const result = eraseStrokePoints(line(0, 100), [{ x: 50, y: 0 }], 10);

    expect(result.changed).toBe(true);
    expect(result.fragments).toHaveLength(2);
    expect(result.fragments[0][0].x).toBe(0);
    expect(result.fragments[0].at(-1)!.x).toBeCloseTo(40, 3);
    expect(result.fragments[1][0].x).toBeCloseTo(60, 3);
    expect(result.fragments[1].at(-1)!.x).toBe(100);
  });

  test('uses the whole swept path instead of leaving gaps between events', () => {
    const result = eraseStrokePoints(line(0, 100), [{ x: 40, y: 0 }, { x: 60, y: 0 }], 5);

    expect(result.fragments).toHaveLength(2);
    expect(result.fragments[0].at(-1)!.x).toBeCloseTo(35, 3);
    expect(result.fragments[1][0].x).toBeCloseTo(65, 3);
  });

  test('interpolates pressure at newly cut ends', () => {
    const result = eraseStrokePoints(line(0, 100, 0, 1), [{ x: 50, y: 0 }], 10);

    expect(result.fragments[0].at(-1)!.p).toBeCloseTo(0.4, 3);
    expect(result.fragments[1][0].p).toBeCloseTo(0.6, 3);
  });

  test('returns the original points when the eraser misses', () => {
    const points = line(0, 100);
    const result = eraseStrokePoints(points, [{ x: 50, y: 40 }], 10);

    expect(result.changed).toBe(false);
    expect(result.fragments).toEqual([points]);
  });

  test('removes a dot only when the circle reaches it', () => {
    const dot = [{ x: 5, y: 5, p: 0.5 }];
    expect(eraseStrokePoints(dot, [{ x: 5, y: 5 }], 2).fragments).toEqual([]);
    expect(eraseStrokePoints(dot, [{ x: 20, y: 20 }], 2).changed).toBe(false);
  });

  test('only subdivides the part of a very long sparse stroke near the eraser', () => {
    const result = eraseStrokePoints(line(-5000, 5000), [{ x: 0, y: 0 }], 1);
    expect(result.changed).toBe(true);
    expect(result.fragments.flat().length).toBeLessThan(100);
  });
});
