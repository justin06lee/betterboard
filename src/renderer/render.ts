import type { BBox, Camera, Point, Stroke, Theme } from './types';
import { bboxIntersects, emptyBBox, growBBox, toScreen, toWorld } from './types';

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

export interface RenderOpts {
  theme: Theme;
  grid: boolean;
  live: Stroke | null;
  eraser: { x: number; y: number; radius: number } | null; // screen coords
  marquee: Marquee | null;
}

const GRID_BASE = 40; // world units between dots at scale 1

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
  ctx.setTransform(
    k * cos,
    k * sin,
    -k * sin,
    k * cos,
    -k * (cos * camera.x - sin * camera.y),
    -k * (sin * camera.x + cos * camera.y)
  );
  if (opts.grid) drawGrid(ctx, camera, view, opts.theme.grid);

  // Strokes being dragged are lifted out of the main pass and redrawn under a
  // translation, so a move costs one extra transform rather than a rebuild.
  const m = opts.marquee;
  const moving = m && m.ids && (m.dx !== 0 || m.dy !== 0) ? m.ids : null;
  for (const s of strokes) {
    if (!s.path || (moving?.has(s.id) ?? false) || !bboxIntersects(s.bbox, view)) continue;
    ctx.fillStyle = s.color;
    ctx.fill(s.path);
  }
  if (moving && m) {
    ctx.save();
    ctx.translate(m.dx, m.dy);
    for (const s of strokes) {
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
  if (opts.live?.path) {
    ctx.fillStyle = opts.live.color;
    ctx.fill(opts.live.path);
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

// Renders all strokes into an offscreen canvas sized to fit the content.
// Exports are always axis-aligned, regardless of the view rotation.
export function renderExport(strokes: Stroke[], content: BBox, theme: Theme): HTMLCanvasElement {
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
  ctx.setTransform(scale, 0, 0, scale, (PAD - content.minX) * scale, (PAD - content.minY) * scale);
  for (const s of strokes) {
    if (!s.path) continue;
    ctx.fillStyle = s.color;
    ctx.fill(s.path);
  }
  return canvas;
}
