import { describe, expect, test } from 'bun:test';

// A Path2D that records what was drawn into it, so the shape a brush builds can
// be measured without a canvas.
interface Dab {
  x: number;
  y: number;
  r: number;
}

class RecordingPath2D {
  dabs: Dab[] = [];
  rects: { x: number; y: number; w: number; h: number }[] = [];
  ops: string[] = [];
  moveTo(): void {
    this.ops.push('moveTo');
  }
  quadraticCurveTo(): void {
    this.ops.push('quad');
  }
  closePath(): void {
    this.ops.push('close');
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.ops.push('rect');
    this.rects.push({ x, y, w, h });
  }
  addPath(): void {
    this.ops.push('addPath');
  }
  arc(x: number, y: number, r: number): void {
    this.ops.push('arc');
    this.dabs.push({ x, y, r });
  }
}

Object.assign(globalThis, { Path2D: RecordingPath2D });

const { buildPath, pathOf, strokeHit } = await import('./ink');
const { makeStroke } = await import('./points');

type Stroke = import('./types').Stroke;
type StrokePoint = import('./types').StrokePoint;

function line(x0: number, y0: number, x1: number, y1: number, count: number): StrokePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    x: x0 + ((x1 - x0) * i) / (count - 1),
    y: y0 + ((y1 - y0) * i) / (count - 1),
    p: 0.5,
  }));
}

function chalk(overrides: Partial<Stroke> & { points?: StrokePoint[] } = {}): Stroke {
  const { points = line(0, 0, 200, 0, 40), ...fields } = overrides;
  return makeStroke(
    {
      id: 'chalk-stroke',
      seq: 0,
      color: '#ffffff',
      size: 20,
      pen: false,
      brush: 'chalk',
      seed: 12345,
      layer: 'layer',
      frame: 'frame',
      ...fields,
    },
    points
  );
}

const dabsOf = (stroke: Stroke): Dab[] => (buildPath(stroke) as unknown as RecordingPath2D).dabs;

describe('chalk brush', () => {
  test('lays down grain rather than one filled outline', () => {
    const dabs = dabsOf(chalk());
    expect(dabs.length).toBeGreaterThan(200);
    // Every dab opens its own subpath; arc() would otherwise string the grain
    // together with connecting lines.
    const ops = (buildPath(chalk()) as unknown as RecordingPath2D).ops;
    expect(ops.filter((op) => op === 'arc')).toHaveLength(dabs.length);
    expect(ops.filter((op) => op === 'moveTo')).toHaveLength(dabs.length);
    for (let i = 0; i < ops.length; i += 2) {
      expect(ops[i]).toBe('moveTo');
      expect(ops[i + 1]).toBe('arc');
    }
  });

  test('rebuilds identically from the same seed', () => {
    expect(dabsOf(chalk())).toEqual(dabsOf(chalk()));
  });

  test('a different seed grinds differently', () => {
    expect(dabsOf(chalk({ seed: 999 }))).not.toEqual(dabsOf(chalk()));
  });

  test('grain already drawn does not crawl as the stroke grows', () => {
    const short = dabsOf(chalk({ points: line(0, 0, 200, 0, 40) }));
    const long = dabsOf(chalk({ points: line(0, 0, 400, 0, 79) }));
    // Both sample the same centerline at the same spacing, so the shorter one
    // has to be a dab-for-dab prefix of the longer — otherwise the grain would
    // visibly reshuffle under the pen on every pointer move.
    expect(long.slice(0, short.length)).toEqual(short);
    expect(long.length).toBeGreaterThan(short.length);
  });

  test('stays within reach of the centerline, dust included', () => {
    const stroke = chalk();
    // Half-width, times the widest a row wobbles, times the dust throw, plus a
    // grain's own radius — nothing may land further out than that.
    const reach = (stroke.size / 2) * 1.15 * 1.4 + stroke.size * 0.1;
    for (const dab of dabsOf(stroke)) {
      expect(Math.abs(dab.y)).toBeLessThanOrEqual(reach);
      expect(dab.x).toBeGreaterThanOrEqual(-reach);
      expect(dab.x).toBeLessThanOrEqual(200 + reach);
    }
  });

  test('never lands outside the box the board culls it by', () => {
    const stroke = chalk();
    const b = stroke.bbox;
    for (const dab of dabsOf(stroke)) {
      expect(stroke.ox + dab.x - dab.r).toBeGreaterThanOrEqual(b.minX);
      expect(stroke.ox + dab.x + dab.r).toBeLessThanOrEqual(b.maxX);
      expect(stroke.oy + dab.y - dab.r).toBeGreaterThanOrEqual(b.minY);
      expect(stroke.oy + dab.y + dab.r).toBeLessThanOrEqual(b.maxY);
    }
  });

  test('spreads across the width instead of hugging the centerline', () => {
    const dabs = dabsOf(chalk());
    const spread = Math.max(...dabs.map((d) => Math.abs(d.y)));
    expect(spread).toBeGreaterThan(3); // it is a band, not a hairline
  });

  test('a fatter stick lays coarser grain, not more of it', () => {
    const thin = dabsOf(chalk({ size: 8 })).length;
    const fat = dabsOf(chalk({ size: 40 })).length;
    // Rows spread out with the size, so the same line costs less to grind at a
    // bigger size — never more, which is what would make fat chalk crawl.
    expect(fat).toBeLessThan(thin);
    expect(fat).toBeGreaterThan(thin / 8);
  });

  test('caps the grain on a runaway stroke rather than building forever', () => {
    const dabs = dabsOf(chalk({ points: line(0, 0, 500_000, 0, 200) }));
    expect(dabs.length).toBe(16000);
  });

  test('a single point still leaves a mark', () => {
    expect(dabsOf(chalk({ points: [{ x: 5, y: 7, p: 0.5 }] }))).toHaveLength(1);
  });

  test('grinds the same grain wherever on the board it is drawn', () => {
    // Outlines are built relative to the stroke's own origin, so the far end
    // of an infinite board gets exactly the grain the middle does.
    const here = dabsOf(chalk());
    const far = dabsOf(chalk({ points: line(4_000_000, -9_000_000, 4_000_200, -9_000_000, 40) }));
    expect(far).toEqual(here);
  });
});

describe('outlines', () => {
  test('a pixel stroke snaps to the world grid, written relative to itself', () => {
    const s = makeStroke(
      { id: 'px', seq: 0, color: '#fff', size: 4, pen: false, brush: 'pixel', seed: 1, layer: 'l', frame: 'f' },
      [{ x: 13, y: 21, p: 0.5 }]
    );
    // The world cell is (12, 20)–(16, 24); the stroke starts at (13, 21).
    expect((buildPath(s) as unknown as RecordingPath2D).rects).toEqual([{ x: -1, y: -1, w: 4, h: 4 }]);
  });

  test('are built once and kept', () => {
    const s = chalk();
    expect(s.path).toBeUndefined();
    const path = pathOf(s);
    expect(pathOf(s)).toBe(path);
    expect(s.path).toBe(path);
  });
});

describe('strokeHit', () => {
  const far = 9_000_000;
  const pen = makeStroke(
    { id: 'far', seq: 0, color: '#fff', size: 4, pen: false, brush: 'pen', seed: 1, layer: 'l', frame: 'f' },
    line(far, far, far + 100, far, 20)
  );

  test('finds a stroke drawn far from the origin', () => {
    expect(strokeHit(pen, far + 50, far + 1, 1)).toBe(true);
    expect(strokeHit(pen, far + 50, far + 20, 1)).toBe(false);
  });

  test('reaches the width of the ink, not just its centerline', () => {
    expect(strokeHit(pen, far + 50, far + 2.9, 1)).toBe(true);
    expect(strokeHit(pen, far + 50, far + 3.2, 1)).toBe(false);
  });
});
