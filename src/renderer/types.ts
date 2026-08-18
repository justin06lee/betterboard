export interface Point {
  x: number;
  y: number;
}

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
  layer: string; // id of the owning layer
  points: StrokePoint[];
  bbox: BBox;
  path?: Path2D; // cached outline, world coordinates
}

// Layers are held bottom-first: layers[0] paints under everything. The panel
// lists them the other way up, the way every other drawing app does.
export interface Layer {
  id: string;
  name: string;
  opacity: number; // 0..1, applied to the layer as a whole
  visible: boolean;
}

export function newLayer(name: string): Layer {
  return { id: uid(), name, opacity: 1, visible: true };
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
  accent: string;
}

export const THEMES: Record<'dark' | 'light', Theme> = {
  dark: { bg: '#15161a', grid: '#2b2d35', ink: '#e8eaed', accent: '#4cc9f0' },
  light: { bg: '#fafafa', grid: '#d4d4d8', ink: '#1e1e24', accent: '#0ea5c6' },
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

export function toScreen(camera: Camera, wx: number, wy: number): { x: number; y: number } {
  const cos = Math.cos(camera.rotation);
  const sin = Math.sin(camera.rotation);
  const dx = (wx - camera.x) * camera.scale;
  const dy = (wy - camera.y) * camera.scale;
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

// Screen-space delta -> world-space delta (undoes rotation and scale).
export function toWorldDelta(camera: Camera, dx: number, dy: number): { x: number; y: number } {
  const cos = Math.cos(camera.rotation);
  const sin = Math.sin(camera.rotation);
  return { x: (dx * cos + dy * sin) / camera.scale, y: (-dx * sin + dy * cos) / camera.scale };
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

export function polygonBBox(poly: Point[]): BBox {
  const b = emptyBBox();
  for (const p of poly) growBBox(b, p.x, p.y, 0);
  return b;
}

// Even-odd ray cast. The polygon is treated as closed, so the lasso does not
// have to be drawn back to its own start.
export function pointInPolygon(poly: Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
