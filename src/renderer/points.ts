import type { BBox, BrushId, Stroke, StrokePoint } from './types';
import { emptyBBox, growBBox } from './types';

// A stroke's centerline is packed rather than held as one object per point:
// a Float32Array of (x - ox, y - oy, pressure) triples, measured from the
// stroke's own origin. On a board of a million strokes that is the difference
// between fifty million little objects for the garbage collector to walk and
// a few hundred megabytes it never looks at — and measuring from the stroke's
// own origin keeps float32 exact however far out on the board it was drawn.
//
// Committed points are never written to again, so they are shared freely: a
// moved stroke, a pasted copy and a clip all point at the same array.

export interface Packed {
  ox: number;
  oy: number;
  pts: Float32Array;
  n: number;
}

export function packPoints(points: readonly StrokePoint[]): Packed {
  const n = points.length;
  const ox = n > 0 ? points[0].x : 0;
  const oy = n > 0 ? points[0].y : 0;
  const pts = new Float32Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const pt = points[i];
    pts[j] = pt.x - ox;
    pts[j + 1] = pt.y - oy;
    pts[j + 2] = pt.p;
  }
  return { ox, oy, pts, n };
}

export function unpackPoints(s: Packed): StrokePoint[] {
  const out = new Array<StrokePoint>(s.n);
  for (let i = 0, j = 0; i < s.n; i++, j += 3) {
    out[i] = { x: s.ox + s.pts[j], y: s.oy + s.pts[j + 1], p: s.pts[j + 2] };
  }
  return out;
}

export function pointAt(s: Packed, i: number): StrokePoint {
  const j = i * 3;
  return { x: s.ox + s.pts[j], y: s.oy + s.pts[j + 1], p: s.pts[j + 2] };
}

// How far from its centerline a brush's ink can land, in world units. A
// stroke's bbox has to cover all of it: the board is painted in tiles, and ink
// outside the box would be cut off at the edge of whichever tile it strayed
// into. Pressure pushes a pen well past half its size — perfect-freehand's
// radius runs to 0.81 × size at a full press — chalk throws dust nearly a
// whole size out, and a pixel's cell can sit a cell away from the point that
// lit it.
const REACH: Record<BrushId, number> = {
  pen: 0.82,
  pixel: 1,
  marker: 0.55,
  paint: 0.7,
  chalk: 0.95,
  liner: 0.5,
};

export function inkReach(brush: BrushId, size: number): number {
  if (brush === 'pixel') return Math.max(1, Math.round(size)) + 1;
  return (REACH[brush] ?? 1) * size + 1;
}

export function packedBBox(p: Packed, brush: BrushId, size: number): BBox {
  const { pts, n } = p;
  if (n === 0) return emptyBBox();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let j = 0, end = n * 3; j < end; j += 3) {
    const x = pts[j];
    const y = pts[j + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const r = inkReach(brush, size);
  return { minX: p.ox + minX - r, minY: p.oy + minY - r, maxX: p.ox + maxX + r, maxY: p.oy + maxY + r };
}

export function strokeBBox(s: Stroke): BBox {
  return packedBBox(s, s.brush, s.size);
}

// Everything that makes a stroke itself, apart from where its points are.
export type StrokeFields = Pick<Stroke, 'id' | 'seq' | 'color' | 'size' | 'pen' | 'brush' | 'seed' | 'layer' | 'frame'>;

export function fromPacked(f: StrokeFields, p: Packed): Stroke {
  return {
    id: f.id,
    seq: f.seq,
    color: f.color,
    size: f.size,
    pen: f.pen,
    brush: f.brush,
    seed: f.seed,
    layer: f.layer,
    frame: f.frame,
    ox: p.ox,
    oy: p.oy,
    pts: p.pts,
    n: p.n,
    bbox: packedBBox(p, f.brush, f.size),
  };
}

// Builds a stroke from loose points — the form a model drawing or an eraser
// fragment arrives in.
export function makeStroke(f: StrokeFields, points: readonly StrokePoint[]): Stroke {
  return fromPacked(f, packPoints(points));
}

// ---- a stroke still being drawn -------------------------------------------

// Points arrive one at a time while the pen is down, so the array keeps spare
// room and doubles when it runs out rather than reallocating per point.
export function appendPoint(s: Stroke, x: number, y: number, p: number): void {
  if (s.n === 0) {
    s.ox = x;
    s.oy = y;
  }
  const j = s.n * 3;
  if (j + 3 > s.pts.length) {
    const grown = new Float32Array(Math.max(96, s.pts.length * 2));
    grown.set(s.pts.subarray(0, j));
    s.pts = grown;
  }
  s.pts[j] = x - s.ox;
  s.pts[j + 1] = y - s.oy;
  s.pts[j + 2] = p;
  s.n++;
  growBBox(s.bbox, x, y, inkReach(s.brush, s.size));
}

// The pen is up: trim the spare room, since the points are now frozen.
export function sealPoints(s: Stroke): void {
  if (s.pts.length !== s.n * 3) s.pts = s.pts.slice(0, s.n * 3);
}

// ---- copies ---------------------------------------------------------------

// A stroke shifted across the board. Points are relative, so they are shared
// and the outline is too — except a pixel stroke's, which is snapped to the
// world grid and has to be worked out again wherever it lands.
export function movedStroke(s: Stroke, dx: number, dy: number): Stroke {
  const b = s.bbox;
  return {
    ...s,
    ox: s.ox + dx,
    oy: s.oy + dy,
    bbox: { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy },
    path: s.brush === 'pixel' ? undefined : s.path,
    mark: undefined,
  };
}

// A stroke with the whole world scaled around the origin, size included.
export function scaledStroke(s: Stroke, f: number): Stroke {
  const pts = new Float32Array(s.n * 3);
  for (let j = 0, end = s.n * 3; j < end; j += 3) {
    pts[j] = s.pts[j] * f;
    pts[j + 1] = s.pts[j + 1] * f;
    pts[j + 2] = s.pts[j + 2];
  }
  const out: Stroke = { ...s, ox: s.ox * f, oy: s.oy * f, size: s.size * f, pts, path: undefined, mark: undefined };
  out.bbox = strokeBBox(out);
  return out;
}
