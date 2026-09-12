import { getStroke } from 'perfect-freehand';
import type { BrushId, Stroke } from './types';

// Every brush turns a centerline into one filled Path2D, so rendering stays a
// single fill per stroke whatever was used to draw it. The path is built in
// the stroke's own coordinates — measured from (ox, oy), like its points — and
// drawn under a translation to there: a float path far out on an infinite
// board would lose its precision, and one that does not know where it sits
// survives being moved.
export function buildPath(stroke: Stroke, live = false): Path2D {
  switch (stroke.brush) {
    case 'pixel':
      return pixelPath(stroke);
    case 'marker':
      return markerPath(stroke, live);
    case 'paint':
      return paintPath(stroke, live);
    case 'chalk':
      return chalkPath(stroke);
    case 'liner':
      return linerPath(stroke, live);
    default:
      return penPath(stroke, live);
  }
}

// ---- the outline cache ----------------------------------------------------

// An outline costs far more memory than the points it comes from, and a board
// of a million strokes cannot keep one for every stroke. They are built the
// first time a stroke is drawn and dropped oldest-first past a budget: the
// renderer paints into cached tiles, so an outline is mostly needed once, when
// the tiles around it are painted, and rebuilding the odd one costs little.
const PATH_BUDGET = 6_000_000; // in rough outline vertices
const COST: Record<BrushId, number> = { pen: 2, marker: 2, liner: 2, pixel: 2, paint: 14, chalk: 12 };
const kept = new Map<Stroke, number>();
let spent = 0;

export function pathOf(s: Stroke): Path2D {
  let path = s.path;
  if (path) {
    // A copy (a moved stroke, a duplicated frame) inherits its original's
    // outline without having been counted yet.
    if (!kept.has(s)) keep(s);
    return path;
  }
  path = buildPath(s);
  s.path = path;
  keep(s);
  return path;
}

function keep(s: Stroke): void {
  const cost = s.n * (COST[s.brush] ?? 2) + 8;
  kept.set(s, cost);
  spent += cost;
  if (spent <= PATH_BUDGET) return;
  for (const [old, c] of kept) {
    if (spent <= PATH_BUDGET * 0.8) break;
    kept.delete(old);
    spent -= c;
    if (old !== s) old.path = undefined;
  }
}

export function pathCacheStats(): { paths: number; cost: number } {
  return { paths: kept.size, cost: spent };
}

// perfect-freehand's input, [x, y, pressure] per point in stroke coordinates.
function input(stroke: Stroke, pressure?: number): number[][] {
  const { pts, n } = stroke;
  const out = new Array<number[]>(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) out[i] = [pts[j], pts[j + 1], pressure ?? pts[j + 2]];
  return out;
}

function appendOutline(path: Path2D, outline: number[][]): void {
  if (outline.length < 3) return;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i - 1];
    const [x1, y1] = outline[i];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
}

function dot(path: Path2D, stroke: Stroke, radius: number): Path2D {
  if (stroke.n > 0) path.arc(stroke.pts[0], stroke.pts[1], radius, 0, Math.PI * 2);
  return path;
}

// The original: pressure-weighted taper. simulatePressure kicks in for mouse
// strokes, where hardware pressure is a constant 0.5.
function penPath(stroke: Stroke, live: boolean): Path2D {
  const outline = getStroke(input(stroke), {
    size: stroke.size,
    thinning: 0.62,
    smoothing: 0.5,
    streamline: live ? 0.32 : 0.42,
    simulatePressure: !stroke.pen,
    last: !live,
  });
  const path = new Path2D();
  if (outline.length < 3) return dot(path, stroke, stroke.size / 2);
  appendOutline(path, outline);
  return path;
}

// Flat chisel tip: near-uniform width and squared-off ends. Filled at less than
// full opacity (see BRUSHES), so crossing strokes build up like a real marker
// while a single stroke stays even, because it is one fill.
function markerPath(stroke: Stroke, live: boolean): Path2D {
  const outline = getStroke(input(stroke), {
    size: stroke.size,
    thinning: 0.08,
    smoothing: 0.65,
    streamline: live ? 0.4 : 0.5,
    simulatePressure: false,
    last: !live,
    start: { cap: false, taper: 0 },
    end: { cap: false, taper: 0 },
  });
  const path = new Path2D();
  if (outline.length < 3) return dot(path, stroke, stroke.size / 2);
  appendOutline(path, outline);
  return path;
}

// Constant width, round ends, and pressure ignored on purpose: thinning is off
// and simulatePressure is off, so a stylus leaning hard and a mouse click draw
// exactly the same line. Streamlined a little harder than the pen, because
// with no taper to hide it every wobble of the hand stays at full width.
function linerPath(stroke: Stroke, live: boolean): Path2D {
  const outline = getStroke(input(stroke, 0.5), {
    size: stroke.size,
    thinning: 0,
    smoothing: 0.55,
    streamline: live ? 0.4 : 0.5,
    simulatePressure: false,
    last: !live,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
  });
  const path = new Path2D();
  if (outline.length < 3) return dot(path, stroke, stroke.size / 2);
  appendOutline(path, outline);
  return path;
}

// Several thin hairs riding parallel to the centerline. The gaps between them
// are what reads as dry brush; because they land in one path they merge instead
// of darkening where they overlap.
const BRISTLES = 7;

function paintPath(stroke: Stroke, live: boolean): Path2D {
  const path = new Path2D();
  if (stroke.n < 2) return dot(path, stroke, stroke.size / 3);

  // Seeded from the stroke's own seed so a rebuild — on load, on normalize, on
  // duplicating a frame — produces exactly the same bristles.
  const rand = mulberry32(stroke.seed >>> 0);
  const spread = stroke.size * 0.42;
  for (let i = 0; i < BRISTLES; i++) {
    const t = (i / (BRISTLES - 1)) * 2 - 1; // -1..1 across the width
    const offset = t * spread + (rand() - 0.5) * stroke.size * 0.1;
    // Hairs run thick down the middle and thin at the edges, so the stroke has
    // a solid body that frays — a loaded brush, rather than a rake of liners.
    const body = 0.7 + 0.6 * (1 - Math.abs(t));
    const width = stroke.size * (0.1 + rand() * 0.1) * body;
    const outline = getStroke(offsetLine(stroke, offset), {
      size: width,
      thinning: 0.55,
      smoothing: 0.6,
      streamline: live ? 0.35 : 0.45,
      simulatePressure: !stroke.pen,
      last: !live,
    });
    appendOutline(path, outline);
  }
  return path;
}

// Dry powder dragged across a board's tooth: a broad body that never quite
// fills in, grain right through the middle, and edges that fray into loose
// dust rather than stopping on a line. It is one path of many small dabs, and
// the gaps between them are what reads as chalk — so unlike the other brushes
// the shape carries the texture, not the fill.
//
// Grain goes down in rows along the centerline. Row spacing and grain radius
// both scale with the stroke size while the count per row barely moves, which
// is what holds the coverage — the fraction of the band actually filled — near
// constant across sizes. Scaling the row count instead lets a fat stick pack
// its rows tight enough to fill in solid, which stops looking like chalk and
// starts looking like a marker.
const CHALK_MAX_DABS = 16000; // a runaway guard for a very long stroke

function chalkPath(stroke: Stroke): Path2D {
  const path = new Path2D();
  const { pts, n } = stroke;
  const half = stroke.size / 2;
  if (n < 2) return dot(path, stroke, half * 0.7);

  // Seeded from the stroke's own seed, and consumed in centerline order, so a
  // rebuild lands every grain exactly where it was — and so the grain already
  // on screen does not crawl as the rest of the stroke is still being drawn.
  const rand = mulberry32(stroke.seed >>> 0);
  // Tuned for how much of the band ends up actually covered, which is not the
  // same as how much is thrown at it — grains land at random and overlap, so
  // the covered fraction is 1 - e^-density. Aiming straight at a coverage
  // number without that lands about half as dense as intended, and chalk turns
  // into spray paint.
  const step = Math.max(0.8, stroke.size * 0.15);
  const perRow = Math.max(7, Math.round(8 + stroke.size * 0.16));
  const grain = Math.max(0.5, stroke.size * 0.09);

  let dabs = 0;
  let carry = 0;
  for (let i = 1; i < n; i++) {
    const ax = pts[(i - 1) * 3];
    const ay = pts[(i - 1) * 3 + 1];
    const ap = pts[(i - 1) * 3 + 2];
    const dx = pts[i * 3] - ax;
    const dy = pts[i * 3 + 1] - ay;
    const bp = pts[i * 3 + 2];
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const tx = dx / len;
    const ty = dy / len;

    let d = carry;
    for (; d < len; d += step) {
      const t = d / len;
      const cx = ax + dx * t;
      const cy = ay + dy * t;
      // A mouse reports a flat 0.5, which would make every row identical, so
      // it gets a fixed middling press instead of a simulated one — chalk has
      // no taper to simulate, only more or less dust.
      const press = stroke.pen ? ap + (bp - ap) * t : 0.62;
      // Held lightly, chalk narrows and only catches the high points of the
      // tooth; leaned on, it broadens and fills. The per-row wobble is what
      // keeps the edge of the band from running straight.
      const width = half * (0.55 + 0.45 * press) * (0.85 + rand() * 0.3);
      const skip = 0.34 - 0.2 * press;

      for (let g = 0; g < perRow; g++) {
        if (rand() < skip) continue;
        // Near-even across the band, pulled in a little at random: enough of a
        // body to read as a stroke, not so centre-heavy that the holes — which
        // are the grain — get filled in where the mark is most visible. The
        // occasional wider throw is the dust that lands off the mark.
        const across = (rand() * 2 - 1) * (0.7 + rand() * 0.3) * width * (rand() < 0.07 ? 1.4 : 1);
        const along = (rand() - 0.5) * step * 1.6;
        const r = grain * (0.5 + rand() * 0.8);
        const x = cx - ty * across + tx * along;
        const y = cy + tx * across + ty * along;
        // arc() draws a line from wherever the path already is, so every dab
        // has to start its own subpath or the grain gets strung together.
        path.moveTo(x + r, y);
        path.arc(x, y, r, 0, Math.PI * 2);
        if (++dabs >= CHALK_MAX_DABS) return path;
      }
    }
    carry = d - len;
  }
  return path;
}

// The centerline shifted sideways by `distance`, perpendicular to its local
// heading, as perfect-freehand input.
function offsetLine(stroke: Stroke, distance: number): number[][] {
  const { pts, n } = stroke;
  const out = new Array<number[]>(n);
  for (let i = 0; i < n; i++) {
    const prev = Math.max(0, i - 1) * 3;
    const next = Math.min(n - 1, i + 1) * 3;
    const dx = pts[next] - pts[prev];
    const dy = pts[next + 1] - pts[prev + 1];
    const len = Math.hypot(dx, dy);
    const j = i * 3;
    if (len === 0) {
      out[i] = [pts[j], pts[j + 1], pts[j + 2]];
      continue;
    }
    out[i] = [pts[j] - (dy / len) * distance, pts[j + 1] + (dx / len) * distance, pts[j + 2]];
  }
  return out;
}

// Square cells on a world-space grid anchored at the origin, so separate
// strokes — and separate sessions — land on the same lattice and line up.
// Pressure is ignored: a pixel is on or it is not. The grid is the world's,
// not the stroke's, so cells are found in world coordinates and only then
// written relative to the stroke.
const MAX_CELLS = 20000; // a runaway guard for a stroke drawn at a tiny cell size

function pixelPath(stroke: Stroke): Path2D {
  const cell = Math.max(1, Math.round(stroke.size));
  const path = new Path2D();
  const { ox, oy, pts, n } = stroke;
  if (n === 0) return path;
  const seen = new Set<number>();
  let count = 0;

  const put = (cx: number, cy: number): boolean => {
    // Cantor-ish pairing keeps the dedupe key a number rather than a string.
    const key = (cx & 0xffff) * 0x10000 + (cy & 0xffff);
    if (seen.has(key)) return true;
    if (count >= MAX_CELLS) return false;
    seen.add(key);
    count++;
    path.rect(cx * cell - ox, cy * cell - oy, cell, cell);
    return true;
  };

  const cellX = (i: number) => Math.floor((ox + pts[i * 3]) / cell);
  const cellY = (i: number) => Math.floor((oy + pts[i * 3 + 1]) / cell);

  let x0 = cellX(0);
  let y0 = cellY(0);
  put(x0, y0);
  for (let i = 1; i < n; i++) {
    const x1 = cellX(i);
    const y1 = cellY(i);
    if (!bresenham(x0, y0, x1, y1, put)) break; // hit the cap
    x0 = x1;
    y0 = y1;
  }
  return path;
}

// Walks the cells between two grid points so a fast stroke leaves no gaps.
function bresenham(x0: number, y0: number, x1: number, y1: number, put: (x: number, y: number) => boolean): boolean {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (!put(x0, y0)) return false;
    if (x0 === x1 && y0 === y1) return true;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

export function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function segmentDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

// True if a circle (world coords) touches the stroke's centerline, padded by its width.
export function strokeHit(stroke: Stroke, x: number, y: number, radius: number): boolean {
  const b = stroke.bbox;
  if (x < b.minX - radius || x > b.maxX + radius || y < b.minY - radius || y > b.maxY + radius) {
    return false;
  }
  const reach = radius + stroke.size / 2;
  const reachSq = reach * reach;
  const { pts, n } = stroke;
  const px = x - stroke.ox;
  const py = y - stroke.oy;
  if (n === 1) {
    const dx = pts[0] - px;
    const dy = pts[1] - py;
    return dx * dx + dy * dy <= reachSq;
  }
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * 3;
    const b2 = i * 3;
    if (segmentDistSq(px, py, pts[a], pts[a + 1], pts[b2], pts[b2 + 1]) <= reachSq) return true;
  }
  return false;
}
