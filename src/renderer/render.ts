import type { BBox, Camera, Stroke, Theme } from './types';
import { bboxIntersects } from './types';

export interface RenderOpts {
  theme: Theme;
  grid: boolean;
  live: Stroke | null;
  eraser: { x: number; y: number; radius: number } | null; // screen coords
}

const GRID_BASE = 40; // world units between dots at scale 1

function drawGrid(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  width: number,
  height: number,
  color: string
): void {
  // Pick the power-of-two multiple of the base spacing that lands in a
  // comfortable on-screen range, and fade dots in as they spread out.
  let spacing = GRID_BASE;
  while (spacing * camera.scale < 14) spacing *= 2;
  while (spacing * camera.scale > 56 && spacing > GRID_BASE / 16) spacing /= 2;
  const screenSpacing = spacing * camera.scale;
  const alpha = Math.min(1, (screenSpacing - 10) / 18);
  if (alpha <= 0) return;

  ctx.save();
  ctx.globalAlpha = alpha * 0.8;
  ctx.fillStyle = color;
  const startX = Math.floor(camera.x / spacing) * spacing;
  const startY = Math.floor(camera.y / spacing) * spacing;
  const r = Math.min(2, Math.max(1, screenSpacing / 24));
  for (let wx = startX; (wx - camera.x) * camera.scale < width; wx += spacing) {
    const sx = (wx - camera.x) * camera.scale;
    for (let wy = startY; (wy - camera.y) * camera.scale < height; wy += spacing) {
      const sy = (wy - camera.y) * camera.scale;
      ctx.fillRect(sx - r / 2, sy - r / 2, r, r);
    }
  }
  ctx.restore();
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

  if (opts.grid) drawGrid(ctx, camera, width, height, opts.theme.grid);

  // World-space pass: one transform, cached Path2D per stroke, viewport culling.
  const view: BBox = {
    minX: camera.x,
    minY: camera.y,
    maxX: camera.x + width / camera.scale,
    maxY: camera.y + height / camera.scale,
  };
  ctx.setTransform(
    dpr * camera.scale,
    0,
    0,
    dpr * camera.scale,
    -camera.x * camera.scale * dpr,
    -camera.y * camera.scale * dpr
  );
  for (const s of strokes) {
    if (!s.path || !bboxIntersects(s.bbox, view)) continue;
    ctx.fillStyle = s.color;
    ctx.fill(s.path);
  }
  if (opts.live?.path) {
    ctx.fillStyle = opts.live.color;
    ctx.fill(opts.live.path);
  }

  // Screen-space overlay.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
