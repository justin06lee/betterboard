import { describe, expect, test } from 'bun:test';
import { isDockSide, nearestSide } from './dock';

describe('nearestSide', () => {
  test('picks the edge the pointer is closest to', () => {
    expect(nearestSide(10, 400, 1000, 800)).toBe('left');
    expect(nearestSide(990, 400, 1000, 800)).toBe('right');
    expect(nearestSide(500, 10, 1000, 800)).toBe('top');
    expect(nearestSide(500, 790, 1000, 800)).toBe('bottom');
  });

  test('measures in fractions of the window, so a wide one keeps its sides reachable', () => {
    // 100px from the left of a 2000px window is a tenth of the way in; 150px
    // from the top of a 600px one is a quarter. The left edge wins on distance
    // in pixels, and should also win here.
    expect(nearestSide(100, 150, 2000, 600)).toBe('left');
    // Nudge the pointer down and the top is no longer the nearer edge either.
    expect(nearestSide(400, 60, 2000, 600)).toBe('top');
  });
});

describe('isDockSide', () => {
  test('guards a stored preference against anything else', () => {
    expect(isDockSide('bottom')).toBe(true);
    expect(isDockSide('middle')).toBe(false);
    expect(isDockSide(3)).toBe(false);
  });
});
