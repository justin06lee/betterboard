import type { Point, StrokePoint } from './types';

export interface EraseResult {
  changed: boolean;
  fragments: StrokePoint[][];
}

function distanceToSegmentSq(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  const x = a.x + t * dx - point.x;
  const y = a.y + t * dy - point.y;
  return x * x + y * y;
}

function pointInEraser(point: Point, path: Point[], radiusSq: number): boolean {
  if (path.length === 1) {
    const dx = point.x - path[0].x;
    const dy = point.y - path[0].y;
    return dx * dx + dy * dy <= radiusSq;
  }
  for (let i = 1; i < path.length; i++) {
    if (distanceToSegmentSq(point, path[i - 1], path[i]) <= radiusSq) return true;
  }
  return false;
}

function interpolate(a: StrokePoint, b: StrokePoint, t: number): StrokePoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    p: a.p + (b.p - a.p) * t,
  };
}

// Finds the edge of an erased interval. `aInside` and `bInside` must differ.
function boundary(
  a: StrokePoint,
  b: StrokePoint,
  aInside: boolean,
  path: Point[],
  radiusSq: number
): StrokePoint {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2;
    if (pointInEraser(interpolate(a, b, mid), path, radiusSq) === aInside) low = mid;
    else high = mid;
  }
  return interpolate(a, b, (low + high) / 2);
}

function samePoint(a: StrokePoint, b: StrokePoint): boolean {
  return a.x === b.x && a.y === b.y && a.p === b.p;
}

interface ClipBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Returns the portion of a segment that lies in an axis-aligned box. This
// keeps subdivision local to the eraser instead of resampling an entire long,
// sparse stroke just because its bounding box happens to cross the gesture.
function clipInterval(a: Point, b: Point, box: ClipBox): [number, number] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let low = 0;
  let high = 1;
  for (const [p, q] of [
    [-dx, a.x - box.minX],
    [dx, box.maxX - a.x],
    [-dy, a.y - box.minY],
    [dy, box.maxY - a.y],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) low = Math.max(low, t);
    else high = Math.min(high, t);
    if (low > high) return null;
  }
  return [low, high];
}

// Clips a pressure-sensitive centerline against the capsule swept out by an
// eraser gesture. The caller expands `radius` by half the rendered stroke
// width, which ensures the visible ink—not merely its centerline—is removed.
export function eraseStrokePoints(points: StrokePoint[], path: Point[], radius: number): EraseResult {
  if (points.length === 0 || path.length === 0 || !Number.isFinite(radius) || radius <= 0) {
    return { changed: false, fragments: [points] };
  }

  const radiusSq = radius * radius;
  if (points.length === 1) {
    return pointInEraser(points[0], path, radiusSq)
      ? { changed: true, fragments: [] }
      : { changed: false, fragments: [points] };
  }

  // Pointer samples and stored stroke points are normally much closer than
  // this already. Subdivision matters for old/synthetic sparse strokes: it
  // prevents a long segment from jumping across the eraser between endpoints.
  const maxStep = Math.max(0.05, radius / 4);
  const box: ClipBox = {
    minX: Math.min(...path.map((point) => point.x)) - radius,
    minY: Math.min(...path.map((point) => point.y)) - radius,
    maxX: Math.max(...path.map((point) => point.x)) + radius,
    maxY: Math.max(...path.map((point) => point.y)) + radius,
  };
  const samples: StrokePoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const clipped = clipInterval(a, b, box);
    if (!clipped) {
      if (!samePoint(samples[samples.length - 1], b)) samples.push(b);
      continue;
    }
    const [start, end] = clipped;
    if (start > 0) {
      const entry = interpolate(a, b, start);
      if (!samePoint(samples[samples.length - 1], entry)) samples.push(entry);
    }
    const clippedLength = Math.hypot(b.x - a.x, b.y - a.y) * (end - start);
    const count = Math.max(1, Math.ceil(clippedLength / maxStep));
    for (let step = 1; step <= count; step++) {
      const point = interpolate(a, b, start + (end - start) * step / count);
      if (!samePoint(samples[samples.length - 1], point)) samples.push(point);
    }
    if (end < 1 && !samePoint(samples[samples.length - 1], b)) samples.push(b);
  }

  const fragments: StrokePoint[][] = [];
  let current: StrokePoint[] | null = null;
  let previous = samples[0];
  let previousInside = pointInEraser(previous, path, radiusSq);
  if (!previousInside) current = [previous];
  let changed = previousInside;

  for (let i = 1; i < samples.length; i++) {
    const point = samples[i];
    const inside = pointInEraser(point, path, radiusSq);
    if (inside !== previousInside) {
      changed = true;
      const edge = boundary(previous, point, previousInside, path, radiusSq);
      if (previousInside) {
        current = [edge, point];
      } else if (current) {
        if (!samePoint(current[current.length - 1], edge)) current.push(edge);
        if (current.length >= 2) fragments.push(current);
        current = null;
      }
    } else if (!inside && current && !samePoint(current[current.length - 1], point)) {
      current.push(point);
    } else if (inside) {
      changed = true;
    }
    previous = point;
    previousInside = inside;
  }

  if (current && current.length >= 2) fragments.push(current);
  return changed ? { changed: true, fragments } : { changed: false, fragments: [points] };
}
