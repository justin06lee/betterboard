import type { BBox, BoardImage, Camera, Layer, Point, Stroke, Theme } from './types';
import { BRUSHES, bboxIntersects, emptyBBox, growBBox, imageBBox, toScreen, toWorld } from './types';

export type Matrix = [number, number, number, number, number, number];

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
// (x·sx + dx, y·sy + dy), applied to the outline, the grips, and whatever
// strokes and pictures `ids` and `imageIds` list.
export interface Marquee {
  poly: Point[];
  ids: Set<string> | null;
  imageIds?: Set<string> | null;
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

// One ghosted frame: its strokes, how strongly to paint them, and the colour
// to flatten them to (null keeps their own ink).
export interface Ghost {
  strokes: Stroke[];
  images: BoardImage[];
  alpha: number;
  tint: string | null;
}

export interface RenderOpts {
  theme: Theme;
  grid: boolean;
  live: Stroke | null;
  eraser: { x: number; y: number; radius: number } | null; // screen coords
  marquee: Marquee | null;
  layers: Layer[];
  activeLayer: string;
  images: BoardImage[];
  ghosts: Ghost[];
  // The region being asked about, as a world-space quad so it stays pinned to
  // the drawing through pan, zoom and rotation.
  region: Point[] | null;
  // The magic-wand selection: a tinted mask canvas stretched over its picture's
  // world rectangle, so it stays glued to the pixels it selects.
  wand: { x: number; y: number; width: number; height: number; canvas: HTMLCanvasElement } | null;
}

const REGION_COLOR = '#a78bfa';

const GRID_BASE = 40; // world units between dots at scale 1

interface Bucket {
  strokes: Stroke[];
  images: BoardImage[];
}

function bucketByLayer(strokes: Stroke[], images: BoardImage[], layers: Layer[]): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  for (const l of layers) buckets.set(l.id, { strokes: [], images: [] });
  for (const s of strokes) buckets.get(s.layer)?.strokes.push(s);
  for (const im of images) buckets.get(im.layer)?.images.push(im);
  return buckets;
}

// One reusable scratch canvas backs every translucent layer: a layer's opacity
// has to composite the finished layer, not each stroke, or overlapping strokes
// within it would show their seams.
let scratch: HTMLCanvasElement | null = null;
function scratchContext(width: number, height: number, transform: Matrix): CanvasRenderingContext2D {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width;
    scratch.height = height;
  }
  const sctx = scratch.getContext('2d')!;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, width, height);
  sctx.setTransform(...transform);
  return sctx;
}

// Onion frames need one canvas for the flattened frame and another for a
// translucent layer within that frame. Reusing the same canvas would clear the
// layers that were already painted.
let layerScratch: HTMLCanvasElement | null = null;
function layerScratchContext(width: number, height: number, transform: Matrix): CanvasRenderingContext2D {
  if (!layerScratch) layerScratch = document.createElement('canvas');
  if (layerScratch.width !== width || layerScratch.height !== height) {
    layerScratch.width = width;
    layerScratch.height = height;
  }
  const sctx = layerScratch.getContext('2d')!;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, width, height);
  sctx.setTransform(...transform);
  return sctx;
}

// Exports paint at their own size, which has nothing to do with the window, so
// they keep a third scratch canvas rather than fighting the two above for
// dimensions. One canvas serves every frame of an animation.
let exportScratch: HTMLCanvasElement | null = null;
function exportScratchContext(width: number, height: number, transform: Matrix): CanvasRenderingContext2D {
  if (!exportScratch) exportScratch = document.createElement('canvas');
  if (exportScratch.width !== width || exportScratch.height !== height) {
    exportScratch.width = width;
    exportScratch.height = height;
  }
  const sctx = exportScratch.getContext('2d')!;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, width, height);
  sctx.setTransform(...transform);
  return sctx;
}

// Paints one layer's strokes into a context already carrying the world
// transform. Strokes being dragged are lifted into a transformed pass so a move
// (or a resize with too much ink to rebuild at pointer speed) costs one extra
// transform rather than a rebuild — but they stay inside their own layer, so a
// moving stroke never jumps above the layers over it.
function paintLayer(
  ctx: CanvasRenderingContext2D,
  bucket: Bucket,
  view: BBox,
  m: Marquee | null,
  moving: Set<string> | null,
  live: Stroke | null,
  movingImages: Set<string> | null = null
): void {
  const list = bucket.strokes;
  const pics = bucket.images;
  // Both lists are already in ascending seq (creation order), so one linear
  // merge puts ink and pictures back in the order they were actually made.
  let si = 0;
  let ii = 0;
  while (si < list.length || ii < pics.length) {
    const takeStroke = ii >= pics.length || (si < list.length && list[si].seq <= pics[ii].seq);
    if (takeStroke) {
      const s = list[si++];
      if (!s.path || (moving?.has(s.id) ?? false) || !bboxIntersects(s.bbox, view)) continue;
      fillStroke(ctx, s);
    } else {
      const im = pics[ii++];
      if ((movingImages?.has(im.id) ?? false) || !im.el || !bboxIntersects(imageBBox(im), view)) continue;
      ctx.drawImage(im.el, im.x, im.y, im.width, im.height);
    }
  }
  if (m && (moving || movingImages)) {
    const sx = m.sx ?? 1;
    const sy = m.sy ?? 1;
    ctx.save();
    ctx.transform(sx, 0, 0, sy, m.dx, m.dy);
    for (const s of list) {
      if (!s.path || !moving?.has(s.id)) continue;
      const b = s.bbox;
      const moved = { minX: b.minX * sx + m.dx, minY: b.minY * sy + m.dy, maxX: b.maxX * sx + m.dx, maxY: b.maxY * sy + m.dy };
      if (!bboxIntersects(moved, view)) continue;
      fillStroke(ctx, s);
    }
    for (const im of pics) {
      if (!movingImages?.has(im.id) || !im.el) continue;
      ctx.drawImage(im.el, im.x, im.y, im.width, im.height);
    }
    ctx.restore();
  }
  if (live?.path) fillStroke(ctx, live);
}

// Brushes carry their own opacity — a marker layers where it crosses itself in
// a way a pen never should. globalAlpha is always put back so the caller's
// compositing (layer opacity, onion ghosts) is unaffected.
function fillStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  const alpha = BRUSHES[s.brush]?.alpha ?? 1;
  ctx.fillStyle = s.color;
  if (alpha >= 1) {
    ctx.fill(s.path!);
    return;
  }
  ctx.globalAlpha = alpha;
  ctx.fill(s.path!);
  ctx.globalAlpha = 1;
}

// Drawn under the world transform, so the dots rotate with the canvas.
function drawGrid(ctx: CanvasRenderingContext2D, camera: Camera, view: BBox, color: string): void {
  // Pick the power-of-two multiple of the base spacing that lands in a
  // comfortable on-screen range, and fade dots in as they spread out.
  let spacing = GRID_BASE;
  while (spacing * camera.scale < 14) spacing *= 2;
  while (spacing * camera.scale > 56 && spacing > GRID_BASE / 16) spacing /= 2;
  const screenSpacing = spacing * camera.scale;
  const alpha = Math.min(1, (screenSpacing - 10) / 18);
  if (alpha <= 0) return;

  ctx.globalAlpha = alpha * 0.8;
  ctx.fillStyle = color;
  const r = Math.min(2, Math.max(1, screenSpacing / 24)) / camera.scale;
  const startX = Math.floor(view.minX / spacing) * spacing;
  const startY = Math.floor(view.minY / spacing) * spacing;
  for (let wx = startX; wx <= view.maxX; wx += spacing) {
    for (let wy = startY; wy <= view.maxY; wy += spacing) {
      ctx.fillRect(wx - r / 2, wy - r / 2, r, r);
    }
  }
  ctx.globalAlpha = 1;
}

// Drawn in screen space: the dashes keep the same on-screen size at any zoom,
// and the marching-ants offset reads the same whichever way the canvas is turned.
function drawMarquee(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  m: Marquee,
  theme: Theme
): void {
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

export const HANDLE = 9; // css px

export function render(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  camera: Camera,
  strokes: Stroke[],
  opts: RenderOpts
): void {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = opts.theme.bg;
  ctx.fillRect(0, 0, width, height);

  // World-space AABB of the (possibly rotated) viewport, for culling and grid.
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

  // World-space pass: one transform, cached Path2D per stroke.
  const world = worldMatrix(camera, dpr);
  ctx.setTransform(...world);
  if (opts.grid) drawGrid(ctx, camera, view, opts.theme.grid);

  // Onion skins sit under the live frame. Each ghost frame is flattened through
  // the scratch canvas and composited once, so a ghost reads as one translucent
  // drawing rather than a pile of overlapping translucent strokes.
  for (const ghost of opts.ghosts) {
    if (ghost.strokes.length === 0 && ghost.images.length === 0) continue;
    const gctx = scratchContext(canvas.width, canvas.height, world);
    const ghostBuckets = bucketByLayer(ghost.strokes, ghost.images, opts.layers);
    for (const layer of opts.layers) {
      if (!layer.visible || layer.opacity === 0) continue;
      const bucket = ghostBuckets.get(layer.id)!;
      if (bucket.strokes.length === 0 && bucket.images.length === 0) continue;
      if (layer.opacity >= 1) {
        paintLayer(gctx, bucket, view, null, null, null);
        continue;
      }
      const lctx = layerScratchContext(canvas.width, canvas.height, world);
      paintLayer(lctx, bucket, view, null, null, null);
      gctx.save();
      gctx.setTransform(1, 0, 0, 1, 0, 0);
      gctx.globalAlpha = layer.opacity;
      gctx.drawImage(layerScratch!, 0, 0);
      gctx.restore();
    }
    if (ghost.tint) {
      // Colour the fully composited frame in one pass, including pictures. The
      // source-in operation keeps transparency while replacing visible pixels.
      gctx.save();
      gctx.setTransform(1, 0, 0, 1, 0, 0);
      gctx.globalCompositeOperation = 'source-in';
      gctx.fillStyle = ghost.tint;
      gctx.fillRect(0, 0, canvas.width, canvas.height);
      gctx.restore();
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = ghost.alpha;
    ctx.drawImage(scratch!, 0, 0);
    ctx.restore();
  }

  const m = opts.marquee;
  const lifted = m !== null && (m.dx !== 0 || m.dy !== 0 || (m.sx ?? 1) !== 1 || (m.sy ?? 1) !== 1);
  const moving = lifted && m?.ids ? m.ids : null;
  const movingImages = lifted && m?.imageIds ? m.imageIds : null;
  const buckets = bucketByLayer(strokes, opts.images, opts.layers);
  for (const layer of opts.layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    const list = buckets.get(layer.id)!;
    const live = layer.id === opts.activeLayer ? opts.live : null;
    if (list.strokes.length === 0 && list.images.length === 0 && !live) continue;
    if (layer.opacity >= 1) {
      paintLayer(ctx, list, view, m, moving, live, movingImages);
      continue;
    }
    paintLayer(scratchContext(canvas.width, canvas.height, world), list, view, m, moving, live, movingImages);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(scratch!, 0, 0);
    ctx.restore();
  }

  if (opts.wand) {
    ctx.setTransform(...world);
    ctx.drawImage(opts.wand.canvas, opts.wand.x, opts.wand.y, opts.wand.width, opts.wand.height);
  }

  // Screen-space overlay.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (opts.region && opts.region.length > 1) {
    ctx.beginPath();
    opts.region.forEach((p, i) => {
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
  if (opts.marquee) drawMarquee(ctx, camera, opts.marquee, opts.theme);
  if (opts.eraser) {
    ctx.beginPath();
    ctx.arc(opts.eraser.x, opts.eraser.y, opts.eraser.radius, 0, Math.PI * 2);
    ctx.strokeStyle = opts.theme.ink;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
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

  const buckets = bucketByLayer(strokes, images, layers);
  ctx.setTransform(...world);
  for (const layer of layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    const list = buckets.get(layer.id)!;
    if (list.strokes.length === 0 && list.images.length === 0) continue;
    if (layer.opacity >= 1) {
      paintLayer(ctx, list, view, null, null, null);
      continue;
    }
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    const tctx = tmp.getContext('2d')!;
    tctx.setTransform(...world);
    paintLayer(tctx, list, view, null, null, null);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
  }
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

  const everything: BBox = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };
  const buckets = bucketByLayer(strokes, images, layers);
  ctx.setTransform(...layout.transform);
  for (const layer of layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    const list = buckets.get(layer.id)!;
    if (list.strokes.length === 0 && list.images.length === 0) continue;
    if (layer.opacity >= 1) {
      paintLayer(ctx, list, everything, null, null, null);
      continue;
    }
    const tctx = exportScratchContext(canvas.width, canvas.height, layout.transform);
    paintLayer(tctx, list, everything, null, null, null);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(tctx.canvas, 0, 0);
    ctx.restore();
  }
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
