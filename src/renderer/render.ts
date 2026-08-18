import type { BBox, Camera, Layer, Point, Stroke, Theme } from './types';
import { bboxIntersects, emptyBBox, growBBox, toScreen, toWorld } from './types';

type Matrix = [number, number, number, number, number, number];

// The lasso being drawn, or a committed selection being dragged. `poly` is in
// world coordinates; `dx`/`dy` is the in-progress move offset, also in world
// units, applied to both the outline and the strokes it holds.
export interface Marquee {
  poly: Point[];
  ids: Set<string> | null;
  dx: number;
  dy: number;
  dashOffset: number;
}

// One ghosted frame: its strokes, how strongly to paint them, and the colour
// to flatten them to (null keeps their own ink).
export interface Ghost {
  strokes: Stroke[];
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
  ghosts: Ghost[];
}

const GRID_BASE = 40; // world units between dots at scale 1

function bucketByLayer(strokes: Stroke[], layers: Layer[]): Map<string, Stroke[]> {
  const buckets = new Map<string, Stroke[]>();
  for (const l of layers) buckets.set(l.id, []);
  for (const s of strokes) buckets.get(s.layer)?.push(s);
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
  list: Stroke[],
  view: BBox,
  m: Marquee | null,
  moving: Set<string> | null,
  live: Stroke | null
): void {
  for (const s of list) {
    if (!s.path || (moving?.has(s.id) ?? false) || !bboxIntersects(s.bbox, view)) continue;
    ctx.fillStyle = s.color;
    ctx.fill(s.path);
  }
  if (moving && m) {
    ctx.save();
    ctx.translate(m.dx, m.dy);
    for (const s of list) {
      if (!s.path || !moving.has(s.id)) continue;
      const b = s.bbox;
      if (!bboxIntersects({ minX: b.minX + m.dx, minY: b.minY + m.dy, maxX: b.maxX + m.dx, maxY: b.maxY + m.dy }, view)) {
        continue;
      }
      ctx.fillStyle = s.color;
      ctx.fill(s.path);
    }
    ctx.restore();
  }
  if (live?.path) {
    ctx.fillStyle = live.color;
    ctx.fill(live.path);
  }
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
}

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
    if (ghost.strokes.length === 0) continue;
    const gctx = scratchContext(canvas.width, canvas.height, world);
    for (const s of ghost.strokes) {
      if (!s.path || !bboxIntersects(s.bbox, view)) continue;
      gctx.fillStyle = ghost.tint ?? s.color;
      gctx.fill(s.path);
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = ghost.alpha;
    ctx.drawImage(scratch!, 0, 0);
    ctx.restore();
  }

  const m = opts.marquee;
  const moving = m && m.ids && (m.dx !== 0 || m.dy !== 0) ? m.ids : null;
  const buckets = bucketByLayer(strokes, opts.layers);
  for (const layer of opts.layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    const list = buckets.get(layer.id)!;
    const live = layer.id === opts.activeLayer ? opts.live : null;
    if (list.length === 0 && !live) continue;
    if (layer.opacity >= 1) {
      paintLayer(ctx, list, view, m, moving, live);
      continue;
    }
    paintLayer(scratchContext(canvas.width, canvas.height, world), list, view, m, moving, live);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(scratch!, 0, 0);
    ctx.restore();
  }

  // Screen-space overlay.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

// Renders the visible layers into an offscreen canvas sized to fit the content.
// Exports are always axis-aligned, regardless of the view rotation.
export function renderExport(
  strokes: Stroke[],
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
  const buckets = bucketByLayer(strokes, layers);
  ctx.setTransform(...transform);
  for (const layer of layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    const list = buckets.get(layer.id)!;
    if (list.length === 0) continue;
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
