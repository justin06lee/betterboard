import { describe, expect, test } from 'bun:test';
import { exportLayout } from './render';
import type { BBox } from './types';

const box = (minX: number, minY: number, maxX: number, maxY: number): BBox => ({ minX, minY, maxX, maxY });

// The world point a layout maps to a given pixel, so a test can check framing
// without a canvas.
function place(layout: ReturnType<typeof exportLayout>, x: number, y: number): { x: number; y: number } {
  const [a, , , d, e, f] = layout.transform;
  return { x: a * x + e, y: d * y + f };
}

describe('exportLayout', () => {
  test('surrounds the content with the padding on every side', () => {
    const layout = exportLayout(box(100, 50, 300, 250), { pad: 20, maxScale: 1, maxDim: 4096 });
    expect(layout.width).toBe(240);
    expect(layout.height).toBe(240);
    expect(place(layout, 100, 50)).toEqual({ x: 20, y: 20 });
    expect(place(layout, 300, 250)).toEqual({ x: 220, y: 220 });
  });

  test('scales down to the longest-side cap and keeps the aspect ratio', () => {
    const layout = exportLayout(box(0, 0, 1000, 500), { pad: 0, maxDim: 500 });
    expect(layout.width).toBe(500);
    expect(layout.height).toBe(250);
  });

  test('never magnifies past maxScale, however small the drawing', () => {
    const layout = exportLayout(box(0, 0, 10, 10), { pad: 0, maxDim: 4096, maxScale: 2 });
    expect(layout.width).toBe(20);
    expect(layout.height).toBe(20);
  });

  test('rounds both sides up to the quantum video encoders need', () => {
    const layout = exportLayout(box(0, 0, 101, 33), { pad: 0, maxScale: 1, quantize: 2 });
    expect(layout.width % 2).toBe(0);
    expect(layout.height % 2).toBe(0);
    expect(layout.width).toBe(102);
    expect(layout.height).toBe(34);
  });

  test('rounds up rather than down, so content is never clipped', () => {
    const layout = exportLayout(box(0, 0, 100.4, 100.4), { pad: 0, maxScale: 1 });
    expect(layout.width).toBe(101);
    expect(layout.height).toBe(101);
  });

  test('gives an empty board a canvas of at least one quantum', () => {
    const layout = exportLayout(box(0, 0, 0, 0), { pad: 0, quantize: 2 });
    expect(layout.width).toBe(2);
    expect(layout.height).toBe(2);
  });
});
