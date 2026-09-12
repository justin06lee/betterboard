import { buildPath } from './ink';
import type { Rect } from './store';
import type { BBox, Point, Stroke } from './types';
import { emptyBBox, growBBox } from './types';

// A selection's box, the grips on it, and what dragging one does to whatever
// the box holds. Kept apart from the renderer so the arithmetic can be tested
// without a window.

// Corners scale, keeping the proportions unless told otherwise; an edge
// stretches the one axis it faces.
export type GripMode = 'corner' | 'x' | 'y';

// The eight grips of a box: four corners clockwise from the top left, then
// the four edge midpoints clockwise from the top.
export function boxGrips(r: Rect): Point[] {
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return [
    { x: r.x, y: r.y },
    { x: right, y: r.y },
    { x: right, y: bottom },
    { x: r.x, y: bottom },
    { x: cx, y: r.y },
    { x: right, y: cy },
    { x: cx, y: bottom },
    { x: r.x, y: cy },
  ];
}

// The grip across the box from each of the above: what holds still while that
// one is dragged.
export const OPPOSITE = [2, 3, 0, 1, 6, 7, 4, 5];

export function gripMode(i: number): GripMode {
  return i < 4 ? 'corner' : i % 2 === 1 ? 'x' : 'y';
}

export interface ResizeOpts {
  free?: boolean; // a corner lets go of the proportions (Shift)
  centered?: boolean; // grow about the middle rather than the far side (Option)
  min?: number; // no side may shrink below this
}

// Where a box goes when one grip is dragged to `to` while `anchor` holds still
// (for a centred resize, the anchor is the middle of the box). Dragging past
// the anchor carries the box over to the other side of it — the anchored edge
// stays exactly where it was, however far short of the floor that leaves the
// pointer.
export function resizeRect(from: Rect, anchor: Point, to: Point, mode: GripMode, opts: ResizeOpts = {}): Rect {
  const { free = false, centered = false, min = 0 } = opts;
  // Centred, the pointer only ever sets half the box.
  const reach = centered ? 2 : 1;
  const dx = to.x - anchor.x;
  const dy = to.y - anchor.y;
  let width = from.width;
  let height = from.height;
  if (mode === 'x') {
    width = Math.max(min, Math.abs(dx) * reach);
  } else if (mode === 'y') {
    height = Math.max(min, Math.abs(dy) * reach);
  } else if (free) {
    width = Math.max(min, Math.abs(dx) * reach);
    height = Math.max(min, Math.abs(dy) * reach);
  } else {
    // The larger pull wins, and the floor bounds the ratio rather than each
    // side, so running into it never bends the proportions.
    const k = Math.max(
      (Math.abs(dx) * reach) / from.width,
      (Math.abs(dy) * reach) / from.height,
      min / from.width,
      min / from.height
    );
    width = from.width * k;
    height = from.height * k;
  }
  const place = (a: number, d: number, size: number) => (centered ? a - size / 2 : d < 0 ? a - size : a);
  return {
    x: mode === 'y' ? from.x : place(anchor.x, dx, width),
    y: mode === 'x' ? from.y : place(anchor.y, dy, height),
    width,
    height,
  };
}

// The straight-line map carrying one box onto another, as (x·sx + dx, y·sy + dy):
// whatever sat a third of the way across the old box sits a third of the way
// across the new one.
export function boxAffine(from: Rect, to: Rect): { sx: number; sy: number; dx: number; dy: number } {
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return { sx, sy, dx: to.x - from.x * sx, dy: to.y - from.y * sy };
}

export function mapPoint(p: Point, from: Rect, to: Rect): Point {
  const m = boxAffine(from, to);
  return { x: p.x * m.sx + m.dx, y: p.y * m.sy + m.dy };
}

export function transformRect(r: Rect, from: Rect, to: Rect): Rect {
  const m = boxAffine(from, to);
  return { x: r.x * m.sx + m.dx, y: r.y * m.sy + m.dy, width: r.width * m.sx, height: r.height * m.sy };
}

// A reshaped copy of a stroke. The centerline goes through the map; the width
// can only be one number, so it scales by the geometric mean of the two axes —
// the rule vector editors use — which is exact for an even scale and splits a
// stretch between its axes instead of letting one decide. The line is then
// drawn again along its new path, so a stretched stroke is still a clean
// stroke rather than a smeared one. Everything that makes it this stroke (id,
// seq, seed, brush) is kept, so a selection holding it still holds it.
export function transformStroke(s: Stroke, from: Rect, to: Rect): Stroke {
  const m = boxAffine(from, to);
  const size = s.size * Math.sqrt(m.sx * m.sy);
  const points = s.points.map((pt) => ({ x: pt.x * m.sx + m.dx, y: pt.y * m.sy + m.dy, p: pt.p }));
  // The same margin a freshly drawn stroke gets.
  const bbox = emptyBBox();
  for (const pt of points) growBBox(bbox, pt.x, pt.y, size + 2);
  const out: Stroke = { ...s, size, points, bbox };
  out.path = buildPath(out);
  return out;
}

export function bboxRect(b: BBox): Rect {
  return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
}

// The resize cursor for a grip, picked from the way it points on screen away
// from the middle of the box — so it still reads right with the board turned
// or mirrored.
export function resizeCursor(dx: number, dy: number): string {
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180;
  if (deg < 22.5 || deg >= 157.5) return 'ew-resize';
  if (deg < 67.5) return 'nwse-resize';
  if (deg < 112.5) return 'ns-resize';
  return 'nesw-resize';
}
