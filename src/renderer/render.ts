import { pathOf } from './ink';
import { inkReach } from './points';
import type { BBox, BoardImage, BrushId, Camera, Layer, Point, Stroke, Theme } from './types';
import { BRUSHES, emptyBBox, growBBox, toScreen, toWorld } from './types';

export type Matrix = [number, number, number, number, number, number];

export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// World -> canvas pixels for a camera, at `ratio` canvas pixels per css pixel,
// with the css point (ox, oy) landing on the canvas origin. The same map as
// toScreen, as one setTransform, so the board, a region crop and every overlay
// drawn with toScreen agree whether the view is turned, mirrored or both.
export function worldMatrix(camera: Camera, ratio: number, ox = 0, oy = 0): Matrix {
  const k = ratio * camera.scale;
  const m = camera.flip ? -1 : 1;
  const cos = Math.cos(camera.rotation);
  const sin = Math.sin(camera.rotation);
  return [
    k * m * cos,
    k * m * sin,
    -k * sin,
    k * cos,
    -k * (m * cos * camera.x - sin * camera.y) - ox * ratio,
    -k * (m * sin * camera.x + cos * camera.y) - oy * ratio,
  ];
}

// The lasso being drawn, or a committed selection being dragged. `poly` is in
// world coordinates. The in-progress move or resize is the world -> world map
// (x·sx + dx, y·sy + dy), applied to the outline and the grips.
export interface Marquee {
  poly: Point[];
  // Where the resize grips go, corners first. Given explicitly rather than
  // derived from `poly`, which is the selection outline and may be a freehand
  // lasso with dozens of vertices — one grip per vertex is not what anyone wants.
  grips?: Point[] | null;
  // Draws the box through the corner grips as a hairline of its own, for an
  // outline (a lasso) that says nothing about the box the grips work on.
  frame?: boolean;
  dx: number;
  dy: number;
  sx?: number;
  sy?: number;
  dashOffset: number;
}

const REGION_COLOR = '#a78bfa';
const GRID_BASE = 40; // world units between dots at scale 1
export const HANDLE = 9; // css px

// ---- strokes and pictures -------------------------------------------------

// Level of detail. A stroke a pixel or two across looks the same drawn as a
// speck or a line as it does as its full outline, and a board zoomed out far
// enough to show a million strokes cannot afford a million outlines — so
// small ink gets the cheap version, and never has its outline built at all.
const SPECK_PX = 2; // ink this small across becomes a single soft speck
const HAIRLINE_PX = 1.5; // ink this thin becomes a plain polyline
// A pen's taper, a brush's gaps and chalk's grain all put down less than the
// full width: the stand-ins are drawn to the width and coverage the real
// stroke averages, so zooming across the threshold does not change the weight.
const WIDTH: Record<BrushId, number> = { pen: 0.85, pixel: 1, marker: 1, paint: 0.9, chalk: 0.85, liner: 1 };
const COVER: Record<BrushId, number> = { pen: 1, pixel: 1, marker: 1, paint: 0.75, chalk: 0.6, liner: 1 };

// Paints one stroke under `m`, the world -> target pixel map, which scales by
// `k` target pixels per world unit. `path` overrides the cached outline — the
// stroke being drawn right now brings its own.
export function drawStroke(ctx: Ctx, s: Stroke, m: Matrix, k: number, path?: Path2D): void {
  const [a, b, c, d, e, f] = m;
  const alpha = BRUSHES[s.brush]?.alpha ?? 1;
  if (!path) {
    const box = s.bbox;
    const inset = 2 * inkReach(s.brush, s.size) - s.size;
    const extent = Math.max(box.maxX - box.minX, box.maxY - box.minY) - inset;
    const width = s.size * (WIDTH[s.brush] ?? 1);
    if (extent * k < SPECK_PX) {
      const cx = (box.minX + box.maxX) / 2;
      const cy = (box.minY + box.maxY) / 2;
      const side = Math.max(extent * k, 0.5);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = alpha * (COVER[s.brush] ?? 1) * Math.min(1, Math.max(0.25, width / Math.max(extent, 1e-9)));
      ctx.fillStyle = s.color;
      ctx.fillRect(a * cx + c * cy + e - side / 2, b * cx + d * cy + f - side / 2, side, side);
      ctx.globalAlpha = 1;
      return;
    }
    if (width * k < HAIRLINE_PX) {
      ctx.setTransform(a, b, c, d, a * s.ox + c * s.oy + e, b * s.ox + d * s.oy + f);
      hairline(ctx, s, k);
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = alpha * (COVER[s.brush] ?? 1);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }
  }
  ctx.setTransform(a, b, c, d, a * s.ox + c * s.oy + e, b * s.ox + d * s.oy + f);
  ctx.fillStyle = s.color;
  if (alpha < 1) ctx.globalAlpha = alpha;
  ctx.fill(path ?? pathOf(s));
  if (alpha < 1) ctx.globalAlpha = 1;
}

// The centerline, skipping points closer than most of a pixel to the last one
// kept — a line that thin cannot show the difference.
function hairline(ctx: Ctx, s: Stroke, k: number): void {
  const { pts, n } = s;
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  if (n === 1) {
    ctx.lineTo(pts[0] + 0.01, pts[1]);
    return;
  }
  const minSq = (0.75 / k) ** 2;
  let lx = pts[0];
  let ly = pts[1];
  const last = (n - 1) * 3;
  for (let j = 3; j <= last; j += 3) {
    const x = pts[j];
    const y = pts[j + 1];
    const dx = x - lx;
    const dy = y - ly;
    if (dx * dx + dy * dy < minSq && j < last) continue;
    ctx.lineTo(x, y);
    lx = x;
    ly = y;
  }
}

export function drawImageItem(ctx: Ctx, im: BoardImage, m: Matrix): void {
  if (!im.el) return;
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(im.el, im.x, im.y, im.width, im.height);
}

// Ink and pictures in one list, painted in the order they were made.
export type Item = Stroke | BoardImage;

export function isStroke(item: Item): item is Stroke {
  return (item as Stroke).pts !== undefined;
}

export function bySeq(a: Item, b: Item): number {
  return a.seq - b.seq;
}

// Paints items from `from` on, stopping early once `deadline` passes, and
// returns where it stopped — so a tile too heavy for one frame can be painted
// across several.
export function paintItems(ctx: Ctx, items: readonly Item[], m: Matrix, k: number, from = 0, deadline = Infinity): number {
  for (let i = from; i < items.length; i++) {
    const item = items[i];
    if (isStroke(item)) drawStroke(ctx, item, m, k);
    else drawImageItem(ctx, item, m);
    if ((i & 15) === 15 && performance.now() > deadline) return i + 1;
  }
  return items.length;
}

// ---- the dot grid ---------------------------------------------------------

// The dots go down as one path, built for a stretch of board somewhat larger
// than the view and rebuilt only once the view leaves it — so drawing over an
// idle grid costs one fill, not thousands of little ones. The path is measured
// from its own corner, like a stroke, so it stays exact far from the origin.
let gridCache: { path: Path2D; spacing: number; r: number; box: BBox } | null = null;

export function drawGrid(ctx: Ctx, camera: Camera, view: BBox, color: string, m: Matrix): void {
  // Pick the power-of-two multiple of the base spacing that lands in a
  // comfortable on-screen range, and fade dots in as they spread out.
  let spacing = GRID_BASE;
  while (spacing * camera.scale < 14) spacing *= 2;
  while (spacing * camera.scale > 56 && spacing > GRID_BASE / 16) spacing /= 2;
  const screenSpacing = spacing * camera.scale;
  const alpha = Math.min(1, (screenSpacing - 10) / 18);
  if (alpha <= 0) return;
  const r = Math.min(2, Math.max(1, screenSpacing / 24)) / camera.scale;

  const g = gridCache;
  const inside =
    g && g.spacing === spacing && g.r === r &&
    view.minX >= g.box.minX && view.maxX <= g.box.maxX && view.minY >= g.box.minY && view.maxY <= g.box.maxY;
  if (!inside) {
    const padX = (view.maxX - view.minX) * 0.25;
    const padY = (view.maxY - view.minY) * 0.25;
    const box = {
      minX: Math.floor((view.minX - padX) / spacing) * spacing,
      minY: Math.floor((view.minY - padY) / spacing) * spacing,
      maxX: view.maxX + padX,
      maxY: view.maxY + padY,
    };
    const path = new Path2D();
    for (let wx = box.minX; wx <= box.maxX; wx += spacing) {
      for (let wy = box.minY; wy <= box.maxY; wy += spacing) {
        path.rect(wx - box.minX - r / 2, wy - box.minY - r / 2, r, r);
      }
    }
    gridCache = { path, spacing, r, box };
  }
  const { path, box } = gridCache!;
  const [a, b, c, d, e, f] = m;
  ctx.setTransform(a, b, c, d, a * box.minX + c * box.minY + e, b * box.minX + d * box.minY + f);
  ctx.globalAlpha = alpha * 0.8;
  ctx.fillStyle = color;
  ctx.fill(path);
  ctx.globalAlpha = 1;
}

// World-space AABB of the (possibly rotated) viewport.
export function viewBBox(camera: Camera, width: number, height: number): BBox {
  const view = emptyBBox();
  for (const [sx, sy] of [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ]) {
    const w = toWorld(camera, sx, sy);
    growBBox(view, w.x, w.y, 0);
  }
  return view;
}

// ---- overlays ---------------------------------------------------------------

// Drawn in screen space: the dashes keep the same on-screen size at any zoom,
// and the marching-ants offset reads the same whichever way the canvas is turned.
function drawMarquee(ctx: CanvasRenderingContext2D, camera: Camera, m: Marquee, theme: Theme): void {
  if (m.poly.length < 2) return;
  const sx = m.sx ?? 1;
  const sy = m.sy ?? 1;
  const at = (p: Point) => toScreen(camera, p.x * sx + m.dx, p.y * sy + m.dy);
  ctx.beginPath();
  for (let i = 0; i < m.poly.length; i++) {
    const p = at(m.poly[i]);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();

  ctx.fillStyle = theme.accent;
  ctx.globalAlpha = 0.09;
  ctx.fill();
  ctx.globalAlpha = 1;

  // A dark underlay keeps the dashes legible over ink of any color.
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = theme.bg;
  ctx.globalAlpha = 0.55;
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.setLineDash([5, 4]);
  ctx.lineDashOffset = m.dashOffset;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = theme.accent;
  ctx.stroke();
  ctx.setLineDash([]);

  if (!m.grips) return;
  const grips = m.grips.map(at);
  if (m.frame && grips.length >= 4) {
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      if (i === 0) ctx.moveTo(grips[i].x, grips[i].y);
      else ctx.lineTo(grips[i].x, grips[i].y);
    }
    ctx.closePath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.accent;
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (const s of grips) {
    ctx.beginPath();
    ctx.rect(s.x - HANDLE / 2, s.y - HANDLE / 2, HANDLE, HANDLE);
    ctx.fillStyle = theme.accent;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = theme.bg;
    ctx.stroke();
  }
}

export interface Overlays {
  theme: Theme;
  marquee: Marquee | null;
  eraser: { x: number; y: number; radius: number } | null; // screen coords
  // The region being asked about, as a world-space quad so it stays pinned to
  // the drawing through pan, zoom and rotation.
  region: Point[] | null;
}

export function drawOverlays(ctx: CanvasRenderingContext2D, camera: Camera, dpr: number, o: Overlays): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  if (o.region && o.region.length > 1) {
    ctx.beginPath();
    o.region.forEach((p, i) => {
      const s = toScreen(camera, p.x, p.y);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.fillStyle = REGION_COLOR;
    ctx.globalAlpha = 0.07;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = REGION_COLOR;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (o.marquee) drawMarquee(ctx, camera, o.marquee, o.theme);
  if (o.eraser) {
    ctx.beginPath();
    ctx.arc(o.eraser.x, o.eraser.y, o.eraser.radius, 0, Math.PI * 2);
    ctx.strokeStyle = o.theme.ink;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// ---- exports ----------------------------------------------------------------

// One layer's ink and pictures inside `view`, in the order they were made.
function layerItems(strokes: readonly Stroke[], images: readonly BoardImage[], layer: string, view: BBox | null): Item[] {
  const items: Item[] = [];
  for (const s of strokes) {
    if (s.layer !== layer) continue;
    if (view && (s.bbox.minX > view.maxX || s.bbox.maxX < view.minX || s.bbox.minY > view.maxY || s.bbox.maxY < view.minY)) continue;
    items.push(s);
  }
  for (const im of images) {
    if (im.layer !== layer) continue;
    if (view && (im.x > view.maxX || im.x + im.width < view.minX || im.y > view.maxY || im.y + im.height < view.minY)) continue;
    items.push(im);
  }
  return items.sort(bySeq);
}

// Paints the visible layers of a set of strokes and pictures into `ctx`, which
// has nothing on it yet but a background. A translucent layer is flattened in
// `scratch` first and composited once, so overlaps inside it never show seams.
function paintLayers(
  ctx: Ctx,
  strokes: readonly Stroke[],
  images: readonly BoardImage[],
  layers: Layer[],
  m: Matrix,
  k: number,
  view: BBox | null,
  scratch: () => Ctx
): void {
  for (const layer of layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    const items = layerItems(strokes, images, layer.id, view);
    if (items.length === 0) continue;
    if (layer.opacity >= 1) {
      paintItems(ctx, items, m, k);
      continue;
    }
    const s = scratch();
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.clearRect(0, 0, s.canvas.width, s.canvas.height);
    paintItems(s, items, m, k);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(s.canvas, 0, 0);
    ctx.globalAlpha = 1;
  }
}

// Exports paint at their own size, which has nothing to do with the window, so
// they keep a scratch canvas of their own. One serves every frame of an
// animation.
let exportScratch: HTMLCanvasElement | null = null;
function exportScratchContext(width: number, height: number): Ctx {
  if (!exportScratch) exportScratch = document.createElement('canvas');
  if (exportScratch.width !== width || exportScratch.height !== height) {
    exportScratch.width = width;
    exportScratch.height = height;
  }
  return exportScratch.getContext('2d')!;
}

// Captures one on-screen rectangle as a standalone image, at the camera's
// current position, scale and rotation — so it matches what the user boxed.
// The dot grid, onion ghosts and marquee are deliberately left out: they are
// interface, not drawing, and would only be noise to whoever reads the crop.
export function renderRegion(
  strokes: Stroke[],
  images: BoardImage[],
  layers: Layer[],
  camera: Camera,
  rect: { x: number; y: number; width: number; height: number }, // css px on the board canvas
  theme: Theme,
  maxDim = 1092
): HTMLCanvasElement {
  const scale = Math.min(2, Math.max(0.25, maxDim / Math.max(rect.width, rect.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Same world transform the board uses, shifted so the rectangle's top-left
  // corner becomes the image origin.
  const world = worldMatrix(camera, scale, rect.x, rect.y);
  const view = emptyBBox();
  for (const [sx, sy] of [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ]) {
    const w = toWorld(camera, sx, sy);
    growBBox(view, w.x, w.y, 0);
  }
  let tmp: HTMLCanvasElement | null = null;
  paintLayers(ctx, strokes, images, layers, world, scale * camera.scale, view, () => {
    if (!tmp) {
      tmp = document.createElement('canvas');
      tmp.width = canvas.width;
      tmp.height = canvas.height;
    }
    return tmp.getContext('2d')!;
  });
  return canvas;
}

// Geometry shared by every export, still or moving: how large the image is and
// where the world sits inside it. An animation works out one layout for the
// whole timeline and reuses it — sizing each frame to its own content would
// make the drawing jump around as the bounds changed under it.
export interface ExportLayout {
  width: number;
  height: number;
  transform: Matrix;
}

export interface ExportLayoutOpts {
  pad?: number; // world units of margin around the content
  maxDim?: number; // cap on the longest side, in pixels
  maxScale?: number; // cap on magnification, so a small sketch is not blown up
  // Rounds both sides up to a multiple of this. Video encoders want even
  // dimensions: H.264 subsamples chroma in 2x2 blocks, so an odd side is either
  // rejected outright or silently padded with a smeared edge column.
  quantize?: number;
}

export function exportLayout(content: BBox, opts: ExportLayoutOpts = {}): ExportLayout {
  const { pad = 60, maxDim = 4096, maxScale = 2, quantize = 1 } = opts;
  const w = content.maxX - content.minX + pad * 2;
  const h = content.maxY - content.minY + pad * 2;
  const scale = Math.min(maxScale, maxDim / Math.max(w, h));
  const side = (v: number) => Math.max(quantize, Math.ceil((v * scale) / quantize) * quantize);
  return {
    width: side(w),
    height: side(h),
    transform: [scale, 0, 0, scale, (pad - content.minX) * scale, (pad - content.minY) * scale],
  };
}

// Paints the visible layers into a canvas already sized by `exportLayout`.
// Exports are always axis-aligned, regardless of the view rotation. The canvas
// is cleared first, so an animation can pour every frame through one canvas
// instead of allocating a new one per frame.
export function paintExport(
  canvas: HTMLCanvasElement,
  strokes: Stroke[],
  images: BoardImage[],
  layers: Layer[],
  theme: Theme,
  layout: ExportLayout,
  // Null leaves the canvas transparent, which is what a sticker thumbnail
  // wants: it has to sit on whichever board colour is up at the time.
  background: string | null = theme.bg
): void {
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (background !== null) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  paintLayers(ctx, strokes, images, layers, layout.transform, layout.transform[0], null, () =>
    exportScratchContext(canvas.width, canvas.height)
  );
}

// Renders the visible layers into an offscreen canvas sized to fit the content.
export function renderExport(
  strokes: Stroke[],
  images: BoardImage[],
  layers: Layer[],
  content: BBox,
  theme: Theme,
  opts: ExportLayoutOpts & { background?: string | null } = {}
): HTMLCanvasElement {
  const layout = exportLayout(content, opts);
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  // `??` would swallow an explicit null, which is the whole point of the option.
  const background = 'background' in opts ? (opts.background as string | null) : theme.bg;
  paintExport(canvas, strokes, images, layers, theme, layout, background);
  return canvas;
}
