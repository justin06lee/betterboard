import type { BBox, BoardImage, Camera, Layer, Point, Stroke, Theme } from './types';
import { BRUSHES, bboxIntersects, emptyBBox, growBBox, imageBBox, toScreen, toWorld } from './types';

type Matrix = [number, number, number, number, number, number];

// The lasso being drawn, or a committed selection being dragged. `poly` is in
// world coordinates; `dx`/`dy` is the in-progress move offset, also in world
// units, applied to both the outline and the strokes it holds.
export interface Marquee {
  poly: Point[];
  ids: Set<string> | null;
  imageIds?: Set<string> | null;
  handles?: boolean; // corner grips, shown when a single picture is selected
  dx: number;
  dy: number;
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

// Paints one layer's strokes into a context already carrying the world
// transform. Strokes being dragged are lifted into a translated pass so a move
// costs one extra transform rather than a rebuild — but they stay inside their
// own layer, so a moving stroke never jumps above the layers over it.
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
    ctx.save();
    ctx.translate(m.dx, m.dy);
    for (const s of list) {
      if (!s.path || !moving?.has(s.id)) continue;
      const b = s.bbox;
      if (!bboxIntersects({ minX: b.minX + m.dx, minY: b.minY + m.dy, maxX: b.maxX + m.dx, maxY: b.maxY + m.dy }, view)) {
        continue;
      }
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
  ctx.beginPath();
  for (let i = 0; i < m.poly.length; i++) {
    const p = toScreen(camera, m.poly[i].x + m.dx, m.poly[i].y + m.dy);
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

  if (!m.handles) return;
  for (const p of m.poly) {
    const s = toScreen(camera, p.x + m.dx, p.y + m.dy);
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
  const k = dpr * camera.scale;
  const cos = Math.cos(camera.rotation);
  const sin = Math.sin(camera.rotation);
  const world: Matrix = [
    k * cos,
    k * sin,
    -k * sin,
    k * cos,
    -k * (cos * camera.x - sin * camera.y),
    -k * (sin * camera.x + cos * camera.y),
  ];
  ctx.setTransform(...world);
  if (opts.grid) drawGrid(ctx, camera, view, opts.theme.grid);

  // Onion skins sit under the live frame. Each ghost frame is flattened through
  // the scratch canvas and composited once, so a ghost reads as one translucent
  // drawing rather than a pile of overlapping translucent strokes.
  for (const ghost of opts.ghosts) {
    if (ghost.strokes.length === 0 && ghost.images.length === 0) continue;
    const gctx = scratchContext(canvas.width, canvas.height, world);
    for (const im of ghost.images) {
      if (!im.el || !bboxIntersects(imageBBox(im), view)) continue;
      gctx.drawImage(im.el, im.x, im.y, im.width, im.height);
    }
    for (const s of ghost.strokes) {
      if (!s.path || !bboxIntersects(s.bbox, view)) continue;
      // A tinted ghost is a flat silhouette; an untinted one should look like
      // the frame it came from, brush opacity and all.
      gctx.fillStyle = ghost.tint ?? s.color;
      gctx.globalAlpha = ghost.tint ? 1 : (BRUSHES[s.brush]?.alpha ?? 1);
      gctx.fill(s.path);
    }
    gctx.globalAlpha = 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = ghost.alpha;
    ctx.drawImage(scratch!, 0, 0);
    ctx.restore();
  }

  const m = opts.marquee;
  const moving = m && m.ids && (m.dx !== 0 || m.dy !== 0) ? m.ids : null;
  const movingImages = m && m.imageIds && (m.dx !== 0 || m.dy !== 0) ? m.imageIds : null;
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
  const k = scale * camera.scale;
  const cos = Math.cos(camera.rotation);
  const sin = Math.sin(camera.rotation);
  const world: Matrix = [
    k * cos,
    k * sin,
    -k * sin,
    k * cos,
    -k * (cos * camera.x - sin * camera.y) - rect.x * scale,
    -k * (sin * camera.x + cos * camera.y) - rect.y * scale,
  ];

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

// Renders the visible layers into an offscreen canvas sized to fit the content.
// Exports are always axis-aligned, regardless of the view rotation.
export function renderExport(
  strokes: Stroke[],
  images: BoardImage[],
  layers: Layer[],
  content: BBox,
  theme: Theme
): HTMLCanvasElement {
  const PAD = 60;
  const MAX_DIM = 4096;
  const w = content.maxX - content.minX + PAD * 2;
  const h = content.maxY - content.minY + PAD * 2;
  const scale = Math.min(2, MAX_DIM / Math.max(w, h));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const transform: Matrix = [scale, 0, 0, scale, (PAD - content.minX) * scale, (PAD - content.minY) * scale];
  const everything: BBox = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };
  const buckets = bucketByLayer(strokes, images, layers);
  ctx.setTransform(...transform);
  for (const layer of layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    const list = buckets.get(layer.id)!;
    if (list.strokes.length === 0 && list.images.length === 0) continue;
    if (layer.opacity >= 1) {
      paintLayer(ctx, list, everything, null, null, null);
      continue;
    }
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    const tctx = tmp.getContext('2d')!;
    tctx.setTransform(...transform);
    paintLayer(tctx, list, everything, null, null, null);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
  }
  return canvas;
}
