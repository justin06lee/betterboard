// A clip is a selection lifted off the board: the ink and pictures inside it,
// moved so the whole thing starts at (0, 0). That one shape serves three
// features — copy/paste, duplicate, and stickers — because all three are the
// same question asked at different times: what was selected, and where should
// it come back?

import { packedBBox, packPoints, unpackPoints } from './points';
import type { BBox, BoardImage, BrushId, Point, Stroke, StrokePoint } from './types';
import { emptyBBox, growBBox, isBrush, uid } from './types';

// Packed like a board stroke, with its origin measured from the clip's
// corner. The points are the very array of the stroke it was cut from rather
// than a copy — committed points never change — so lifting even a huge
// selection costs one small object per stroke.
export interface ClipStroke {
  color: string;
  size: number;
  pen: boolean;
  brush: BrushId;
  seed: number;
  ox: number;
  oy: number;
  pts: Float32Array;
  n: number;
}

export interface ClipImage {
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// `order` runs across both lists at once: a clip has to come back with its ink
// and pictures interleaved the way they were made, or a highlight drawn over a
// photo would land underneath it on paste.
export interface Clip {
  strokes: ClipStroke[];
  images: ClipImage[];
  order: ('stroke' | 'image')[];
  width: number;
  height: number;
}

export function clipBounds(strokes: Stroke[], images: BoardImage[]): BBox | null {
  if (strokes.length === 0 && images.length === 0) return null;
  const b = emptyBBox();
  for (const s of strokes) {
    growBBox(b, s.bbox.minX, s.bbox.minY, 0);
    growBBox(b, s.bbox.maxX, s.bbox.maxY, 0);
  }
  for (const im of images) {
    growBBox(b, im.x, im.y, 0);
    growBBox(b, im.x + im.width, im.y + im.height, 0);
  }
  return b;
}

export function makeClip(strokes: Stroke[], images: BoardImage[]): Clip | null {
  const bounds = clipBounds(strokes, images);
  if (!bounds) return null;
  const ox = bounds.minX;
  const oy = bounds.minY;

  // One merged pass in creation order, so `order` records how the two lists
  // interleave and paste can hand out sequence numbers to match.
  const merged: { seq: number; stroke: Stroke | null; image: BoardImage | null }[] = [];
  for (const s of strokes) merged.push({ seq: s.seq, stroke: s, image: null });
  for (const im of images) merged.push({ seq: im.seq, stroke: null, image: im });
  merged.sort((a, b) => a.seq - b.seq);

  const clip: Clip = {
    strokes: [],
    images: [],
    order: [],
    width: bounds.maxX - ox,
    height: bounds.maxY - oy,
  };
  for (const item of merged) {
    if (item.stroke) {
      const s = item.stroke;
      clip.strokes.push({
        color: s.color,
        size: s.size,
        pen: s.pen,
        brush: s.brush,
        seed: s.seed,
        ox: s.ox - ox,
        oy: s.oy - oy,
        pts: s.pts.length === s.n * 3 ? s.pts : s.pts.slice(0, s.n * 3),
        n: s.n,
      });
      clip.order.push('stroke');
    } else {
      const im = item.image!;
      clip.images.push({
        src: im.src,
        x: im.x - ox,
        y: im.y - oy,
        width: im.width,
        height: im.height,
      });
      clip.order.push('image');
    }
  }
  return clip;
}

export interface PlaceOpts {
  layer: string;
  frame: string;
  takeSeq: () => number;
  scale?: number; // stickers can come back larger or smaller than they were saved
}

// Rebuilds a clip's contents at `at` (its top-left corner) as fresh board
// items. Outlines are left for the renderer to build the first time each
// stroke is painted.
export function placeClip(clip: Clip, at: Point, opts: PlaceOpts): { strokes: Stroke[]; images: BoardImage[] } {
  const k = opts.scale ?? 1;
  const strokes: Stroke[] = [];
  const images: BoardImage[] = [];
  let si = 0;
  let ii = 0;
  for (const kind of clip.order) {
    const seq = opts.takeSeq();
    if (kind === 'stroke') {
      const src = clip.strokes[si++];
      if (!src) continue;
      let pts = src.pts;
      if (k !== 1) {
        pts = new Float32Array(src.n * 3);
        for (let j = 0; j < src.n * 3; j += 3) {
          pts[j] = src.pts[j] * k;
          pts[j + 1] = src.pts[j + 1] * k;
          pts[j + 2] = src.pts[j + 2];
        }
      }
      const packed = { ox: at.x + src.ox * k, oy: at.y + src.oy * k, pts, n: src.n };
      const size = src.size * k;
      strokes.push({
        id: uid(),
        seq,
        color: src.color,
        size,
        pen: src.pen,
        brush: src.brush,
        seed: src.seed,
        layer: opts.layer,
        frame: opts.frame,
        ...packed,
        bbox: packedBBox(packed, src.brush, size),
      });
    } else {
      const src = clip.images[ii++];
      if (!src) continue;
      images.push({
        id: uid(),
        seq,
        src: src.src,
        x: at.x + src.x * k,
        y: at.y + src.y * k,
        width: src.width * k,
        height: src.height * k,
        layer: opts.layer,
        frame: opts.frame,
      });
    }
  }
  return { strokes, images };
}

// ---- on disk --------------------------------------------------------------

// What a clip looks like written down: plain points, the form stickers have
// always been saved in, so a tray written by an older version still loads.
export interface ClipJSON {
  strokes: {
    color: string;
    size: number;
    pen: boolean;
    brush: BrushId;
    seed: number;
    points: StrokePoint[];
  }[];
  images: ClipImage[];
  order: ('stroke' | 'image')[];
  width: number;
  height: number;
}

const round = (v: number, k: number) => Math.round(v * k) / k;

export function clipToJSON(clip: Clip): ClipJSON {
  return {
    strokes: clip.strokes.map((s) => ({
      color: s.color,
      size: s.size,
      pen: s.pen,
      brush: s.brush,
      seed: s.seed,
      points: unpackPoints(s).map((p) => ({ x: round(p.x, 1e4), y: round(p.y, 1e4), p: round(p.p, 1e3) })),
    })),
    images: clip.images.map((im) => ({ ...im })),
    order: [...clip.order],
    width: clip.width,
    height: clip.height,
  };
}

export function clipFromJSON(json: ClipJSON): Clip {
  return {
    strokes: json.strokes.map((s) => ({
      color: String(s.color),
      size: Number(s.size) || 1,
      pen: Boolean(s.pen),
      brush: isBrush(s.brush) ? s.brush : 'pen',
      seed: Number.isFinite(s.seed) ? s.seed >>> 0 : 0,
      ...packPoints(Array.isArray(s.points) ? s.points : []),
    })),
    images: json.images.map((im) => ({ ...im })),
    order: [...json.order],
    width: json.width,
    height: json.height,
  };
}

export function isClip(value: unknown): value is ClipJSON {
  const c = value as ClipJSON | null;
  return (
    !!c &&
    typeof c === 'object' &&
    Array.isArray(c.strokes) &&
    Array.isArray(c.images) &&
    Array.isArray(c.order) &&
    Number.isFinite(c.width) &&
    Number.isFinite(c.height) &&
    (c.strokes.length > 0 || c.images.length > 0)
  );
}

// ---- stickers -------------------------------------------------------------

// A sticker is a clip that outlived the session it was cut from: named, given
// a picture of itself, and written to disk so it can be stamped back onto any
// board later.
export interface Sticker {
  id: string;
  name: string;
  thumb: string; // data URL
  clip: Clip;
  createdAt: number;
}

export interface StickerJSON {
  id: string;
  name: string;
  thumb: string;
  clip: ClipJSON;
  createdAt: number;
}

export const MAX_STICKERS = 60;

export function isSticker(value: unknown): value is StickerJSON {
  const s = value as StickerJSON | null;
  return (
    !!s &&
    typeof s === 'object' &&
    typeof s.id === 'string' &&
    typeof s.name === 'string' &&
    typeof s.thumb === 'string' &&
    isClip(s.clip)
  );
}

export function stickerToJSON(s: Sticker): StickerJSON {
  return { id: s.id, name: s.name, thumb: s.thumb, clip: clipToJSON(s.clip), createdAt: s.createdAt };
}

export function stickerFromJSON(s: StickerJSON): Sticker {
  return { id: s.id, name: s.name, thumb: s.thumb, clip: clipFromJSON(s.clip), createdAt: Number(s.createdAt) || 0 };
}

// Names come from whatever was on the board, which is nothing, so they are
// numbered — but never duplicated, because the tray is read at a glance.
export function stickerName(existing: { name: string }[], base = 'Sticker'): string {
  const taken = new Set(existing.map((s) => s.name));
  for (let i = 1; ; i++) {
    const name = `${base} ${i}`;
    if (!taken.has(name)) return name;
  }
}
