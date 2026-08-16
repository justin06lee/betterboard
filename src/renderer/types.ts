export interface StrokePoint {
  x: number;
  y: number;
  p: number; // pressure 0..1
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Stroke {
  id: string;
  color: string;
  size: number; // base diameter in world units
  pen: boolean; // true if drawn with real pressure (stylus), false for mouse
  points: StrokePoint[];
  bbox: BBox;
  path?: Path2D; // cached outline, world coordinates
}

// camera.x/y = world coordinates of the screen origin (top-left)
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface Theme {
  bg: string;
  grid: string;
  ink: string;
}

export const THEMES: Record<'dark' | 'light', Theme> = {
  dark: { bg: '#15161a', grid: '#2b2d35', ink: '#e8eaed' },
  light: { bg: '#fafafa', grid: '#d4d4d8', ink: '#1e1e24' },
};

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 24;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

export function toWorld(camera: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: sx / camera.scale + camera.x, y: sy / camera.scale + camera.y };
}

export function emptyBBox(): BBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function growBBox(b: BBox, x: number, y: number, margin: number): void {
  if (x - margin < b.minX) b.minX = x - margin;
  if (y - margin < b.minY) b.minY = y - margin;
  if (x + margin > b.maxX) b.maxX = x + margin;
  if (y + margin > b.maxY) b.maxY = y + margin;
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
