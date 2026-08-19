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

export type BrushId = 'pen' | 'pixel' | 'marker' | 'paint';

export interface Brush {
  id: BrushId;
  label: string;
  hint: string;
  alpha: number; // strokes of this brush are filled at this opacity
  sizeScale: number; // the size slider means different things to different brushes
}

export const BRUSHES: Record<BrushId, Brush> = {
  pen: {
    id: 'pen',
    label: 'Pen',
    hint: 'Pen (1) — pressure-tapered ink',
    alpha: 1,
    sizeScale: 1,
  },
  pixel: {
    id: 'pixel',
    label: 'Pixel',
    hint: 'Pixel (2) — snaps to a shared grid; size sets the pixel',
    alpha: 1,
    sizeScale: 1,
  },
  marker: {
    id: 'marker',
    label: 'Marker',
    hint: 'Marker (3) — flat chisel tip, translucent, layers where it crosses',
    alpha: 0.62,
    sizeScale: 1.7,
  },
  paint: {
    id: 'paint',
    label: 'Paint',
    hint: 'Paint (4) — dry bristle brush that streaks',
    alpha: 0.9,
    sizeScale: 1.9,
  },
};

export const BRUSH_ORDER: BrushId[] = ['pen', 'pixel', 'marker', 'paint'];

export function isBrush(v: unknown): v is BrushId {
  return typeof v === 'string' && v in BRUSHES;
}

// Strokes and images share one running sequence number per board, so within a
// layer they can be painted back in the order they were actually made rather
// than all the ink always landing on top of all the pictures.
export interface Stroke {
  id: string;
  seq: number;
  color: string;
  size: number; // base diameter in world units, already scaled for the brush
  pen: boolean; // true if drawn with real pressure (stylus), false for mouse
  brush: BrushId;
  // Fixed at creation and carried through copies and moves, so brushes with
  // any randomness in them (paint's bristles) look the same forever.
  seed: number;
  layer: string; // id of the owning layer
  frame: string; // id of the owning frame
  points: StrokePoint[];
  bbox: BBox;
  path?: Path2D; // cached outline, world coordinates
}

// A placed picture: pasted, dropped, or inserted from a file. Axis-aligned in
// world space, so it pans, zooms and turns with everything else.
export interface BoardImage {
  id: string;
  seq: number;
  src: string; // data URL, embedded so a board file stays one portable thing
  x: number;
  y: number;
  width: number;
  height: number;
  layer: string;
  frame: string;
  el?: HTMLImageElement; // decoded bitmap, rebuilt on load rather than saved
}

// Anything imported larger than this is scaled down on the way in: a board file
// carries its pictures inline, and a few full-resolution screenshots would
// otherwise dwarf the drawing they annotate.
export const MAX_IMAGE_DIM = 1600;

export function imageBBox(img: BoardImage): BBox {
  return { minX: img.x, minY: img.y, maxX: img.x + img.width, maxY: img.y + img.height };
}

export function imageHit(img: BoardImage, x: number, y: number): boolean {
  return x >= img.x && x <= img.x + img.width && y >= img.y && y <= img.y + img.height;
}

// Frames are the animation's columns and layers its rows: every frame draws on
// the same layer stack, and a stroke sits in exactly one cell of that grid.
export interface Frame {
  id: string;
}

export function newFrame(): Frame {
  return { id: uid() };
}

export interface Onion {
  enabled: boolean;
  before: number; // frames of history to ghost in
  after: number;
  opacity: number; // 0..1, for the nearest ghost; further ones fall off
  tint: boolean; // colour ghosts warm behind / cool ahead instead of their own ink
}

export const ONION_BEFORE = '#ff5d5d';
export const ONION_AFTER = '#3fd0c9';

export function defaultOnion(): Onion {
  return { enabled: false, before: 1, after: 1, opacity: 0.35, tint: true };
}

export const MIN_FPS = 1;
export const MAX_FPS = 60;

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
