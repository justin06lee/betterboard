import { describe, expect, test } from 'bun:test';
import type { Camera } from './types';
import { anchorCamera, mirrorView, toScreen, toWorld, toWorldDelta } from './types';

const views: Camera[] = [
  { x: 10, y: -20, scale: 1.5, rotation: 0 },
  { x: -40, y: 5, scale: 0.75, rotation: 0.6 },
  { x: 3, y: 9, scale: 2, rotation: -2.2, flip: true },
];

const spots = [
  { x: 0, y: 0 },
  { x: 120, y: -35 },
  { x: -60, y: 210 },
];

function close(a: { x: number; y: number }, b: { x: number; y: number }): void {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
}

describe('the camera', () => {
  test('screen and world round-trip, mirrored or not', () => {
    for (const camera of views) {
      for (const w of spots) {
        const s = toScreen(camera, w.x, w.y);
        close(toWorld(camera, s.x, s.y), w);
      }
    }
  });

  test('a delta follows the same map as a point', () => {
    for (const camera of views) {
      const a = toWorld(camera, 30, 40);
      const b = toWorld(camera, 75, -10);
      close(toWorldDelta(camera, 45, -50), { x: b.x - a.x, y: b.y - a.y });
    }
  });

  test('anchoring pins a world point under a screen point, mirrored too', () => {
    for (const base of views) {
      const camera = { ...base };
      anchorCamera(camera, { x: 12, y: 34 }, 200, 150);
      close(toScreen(camera, 12, 34), { x: 200, y: 150 });
    }
  });

  test('flipping mirrors every point across the middle of the screen', () => {
    const cx = 400;
    const cy = 300;
    for (const base of views) {
      for (const axis of ['h', 'v'] as const) {
        const camera = { ...base };
        const before = spots.map((w) => toScreen(camera, w.x, w.y));
        mirrorView(camera, cx, cy, axis);
        spots.forEach((w, i) => {
          const s = before[i];
          close(toScreen(camera, w.x, w.y), axis === 'h' ? { x: 2 * cx - s.x, y: s.y } : { x: s.x, y: 2 * cy - s.y });
        });
      }
    }
  });

  test('flipping the same way twice puts the view back', () => {
    for (const base of views) {
      for (const axis of ['h', 'v'] as const) {
        const camera = { ...base };
        mirrorView(camera, 400, 300, axis);
        expect(camera.flip).toBe(!base.flip);
        mirrorView(camera, 400, 300, axis);
        expect(Boolean(camera.flip)).toBe(Boolean(base.flip));
        for (const w of spots) close(toScreen(camera, w.x, w.y), toScreen(base, w.x, w.y));
      }
    }
  });
});
