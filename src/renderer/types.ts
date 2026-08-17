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

// camera.x/y = world coordinates of the screen origin (top-left);
// rotation = clockwise view rotation in radians.
// world -> screen: s = R(rotation) * (w - camera.xy) * scale
export interface Camera {
  x: number;
  y: number;
  scale: number;
  rotation: number;
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
  const cos = Math.cos(camera.rotation);
  const sin = Math.sin(camera.rotation);
  const ux = sx / camera.scale;
  const uy = sy / camera.scale;
  return { x: camera.x + ux * cos + uy * sin, y: camera.y - ux * sin + uy * cos };
}

// Repositions camera.x/y so the world point `w` lands on screen point (sx, sy)
// under the camera's current scale and rotation.
export function anchorCamera(camera: Camera, w: { x: number; y: number }, sx: number, sy: number): void {
  const cos = Math.cos(camera.rotation);
  const sin = Math.sin(camera.rotation);
  camera.x = w.x - (sx * cos + sy * sin) / camera.scale;
  camera.y = w.y - (-sx * sin + sy * cos) / camera.scale;
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
