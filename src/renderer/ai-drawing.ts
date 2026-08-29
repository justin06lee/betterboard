import type { Point, StrokePoint } from './types';

export interface AiLine {
  color: string;
  size: number;
  points: StrokePoint[];
}

interface DrawStyle {
  color: string;
  size: number;
}

const MAX_COMMANDS = 100;
const MAX_POINTS_PER_STROKE = 500;
const MAX_TOTAL_POINTS = 5000;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizedPoint(raw: unknown): StrokePoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const x = finite(value.x);
  const y = finite(value.y);
  if (x === null || y === null) return null;
  const pressure = finite(value.pressure);
  return {
    x: Math.min(1000, Math.max(0, x)),
    y: Math.min(1000, Math.max(0, y)),
    p: pressure === null ? 0.5 : Math.min(1, Math.max(0.05, pressure)),
  };
}

function styleOf(command: Record<string, unknown>, fallback: DrawStyle, worldPerPixel: number): DrawStyle {
  const color = typeof command.color === 'string' && /^#[0-9a-f]{6}$/i.test(command.color)
    ? command.color
    : fallback.color;
  const requested = finite(command.size);
  const screenSize = requested === null ? fallback.size : Math.min(28, Math.max(1, requested));
  return { color, size: screenSize * worldPerPixel };
}

function endpoints(command: Record<string, unknown>): [StrokePoint, StrokePoint] | null {
  const a = normalizedPoint({ x: command.x1, y: command.y1 });
  const b = normalizedPoint({ x: command.x2, y: command.y2 });
  return a && b ? [a, b] : null;
}

function shapePoints(command: Record<string, unknown>, type: 'rectangle' | 'ellipse'): StrokePoint[] | null {
  const x = finite(command.x);
  const y = finite(command.y);
  const width = finite(command.width);
  const height = finite(command.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (type === 'rectangle') {
    const points = [
      normalizedPoint({ x, y }),
      normalizedPoint({ x: x + width, y }),
      normalizedPoint({ x: x + width, y: y + height }),
      normalizedPoint({ x, y: y + height }),
      normalizedPoint({ x, y }),
    ];
    return points.every((point) => point !== null) ? points as StrokePoint[] : null;
  }
  const points: StrokePoint[] = [];
  const cx = x + width / 2;
  const cy = y + height / 2;
  for (let i = 0; i <= 32; i++) {
    const angle = (i / 32) * Math.PI * 2;
    const point = normalizedPoint({ x: cx + Math.cos(angle) * width / 2, y: cy + Math.sin(angle) * height / 2 });
    if (!point) return null;
    points.push(point);
  }
  return points;
}

function mapToRegion(point: StrokePoint, quad: Point[]): StrokePoint {
  const u = point.x / 1000;
  const v = point.y / 1000;
  return {
    x: quad[0].x + (quad[1].x - quad[0].x) * u + (quad[3].x - quad[0].x) * v,
    y: quad[0].y + (quad[1].y - quad[0].y) * u + (quad[3].y - quad[0].y) * v,
    p: point.p,
  };
}

// Converts untrusted model output into bounded world-space centerlines. It
// deliberately supports only geometry—never scripts, board IDs, or file paths.
export function drawingToLines(
  payload: unknown,
  quad: Point[],
  worldPerPixel: number,
  fallback: DrawStyle
): AiLine[] {
  if (!payload || typeof payload !== 'object' || quad.length !== 4 || !Number.isFinite(worldPerPixel) || worldPerPixel <= 0) return [];
  const commands = (payload as { commands?: unknown }).commands;
  if (!Array.isArray(commands)) return [];
  const lines: AiLine[] = [];
  let totalPoints = 0;

  const add = (points: StrokePoint[], style: DrawStyle) => {
    if (points.length === 0 || points.length > MAX_POINTS_PER_STROKE) return;
    if (totalPoints + points.length > MAX_TOTAL_POINTS) return;
    totalPoints += points.length;
    lines.push({ ...style, points: points.map((point) => mapToRegion(point, quad)) });
  };

  for (const raw of commands.slice(0, MAX_COMMANDS)) {
    if (!raw || typeof raw !== 'object') continue;
    const command = raw as Record<string, unknown>;
    const style = styleOf(command, fallback, worldPerPixel);
    if (command.type === 'stroke' && Array.isArray(command.points)) {
      const points = command.points.slice(0, MAX_POINTS_PER_STROKE).map(normalizedPoint).filter((point): point is StrokePoint => point !== null);
      add(points, style);
    } else if (command.type === 'line') {
      const points = endpoints(command);
      if (points) add(points, style);
    } else if (command.type === 'arrow') {
      const points = endpoints(command);
      if (!points) continue;
      add(points, style);
      const [a, b] = points;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const head = Math.min(45, Math.max(18, Math.hypot(b.x - a.x, b.y - a.y) * 0.16));
      for (const side of [-1, 1]) {
        const wing = angle + Math.PI + side * Math.PI / 6;
        const end = normalizedPoint({ x: b.x + Math.cos(wing) * head, y: b.y + Math.sin(wing) * head });
        if (end) add([b, end], style);
      }
    } else if (command.type === 'rectangle' || command.type === 'ellipse') {
      const points = shapePoints(command, command.type);
      if (points) add(points, style);
    }
  }
  return lines;
}
