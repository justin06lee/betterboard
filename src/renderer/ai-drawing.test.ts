import { describe, expect, test } from 'bun:test';
import { drawingToLines } from './ai-drawing';

const quad = [
  { x: 10, y: 20 },
  { x: 110, y: 20 },
  { x: 110, y: 220 },
  { x: 10, y: 220 },
];

describe('drawingToLines', () => {
  test('maps normalized model coordinates into the selected world region', () => {
    const lines = drawingToLines({
      commands: [{ type: 'line', x1: 0, y1: 0, x2: 1000, y2: 1000, color: '#ff0000', size: 4 }],
    }, quad, 0.5, { color: '#000000', size: 6 });

    expect(lines).toHaveLength(1);
    expect(lines[0].points.map(({ x, y }) => [x, y])).toEqual([[10, 20], [110, 220]]);
    expect(lines[0].size).toBe(2);
    expect(lines[0].color).toBe('#ff0000');
  });

  test('turns an arrow into a shaft and two wings', () => {
    const lines = drawingToLines({ commands: [{ type: 'arrow', x1: 100, y1: 500, x2: 900, y2: 500 }] }, quad, 1, { color: '#000000', size: 6 });
    expect(lines).toHaveLength(3);
  });

  test('rejects executable-looking or malformed output', () => {
    expect(drawingToLines({ commands: [{ type: 'script', code: 'alert(1)' }] }, quad, 1, { color: '#000000', size: 6 })).toEqual([]);
    expect(drawingToLines({ commands: 'not-an-array' }, quad, 1, { color: '#000000', size: 6 })).toEqual([]);
  });
});
