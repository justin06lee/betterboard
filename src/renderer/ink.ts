import { getStroke } from 'perfect-freehand';
import type { Stroke } from './types';

// Builds the filled outline for a stroke from its (pressure-weighted) centerline.
// simulatePressure kicks in for mouse strokes, where hardware pressure is a constant 0.5.
export function buildPath(stroke: Stroke, live = false): Path2D {
  const outline = getStroke(
    stroke.points.map((pt) => [pt.x, pt.y, pt.p]),
    {
      size: stroke.size,
      thinning: 0.62,
      smoothing: 0.5,
      streamline: live ? 0.32 : 0.42,
      simulatePressure: !stroke.pen,
      last: !live,
    }
  );

  const path = new Path2D();
  if (outline.length < 3) {
    const p0 = stroke.points[0];
    if (p0) path.arc(p0.x, p0.y, stroke.size / 2, 0, Math.PI * 2);
    return path;
  }

  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i - 1];
    const [x1, y1] = outline[i];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
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
  const pts = stroke.points;
  if (pts.length === 1) {
    const dx = pts[0].x - x;
    const dy = pts[0].y - y;
    return dx * dx + dy * dy <= reachSq;
  }
  for (let i = 1; i < pts.length; i++) {
    if (segmentDistSq(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= reachSq) {
      return true;
    }
  }
  return false;
}
