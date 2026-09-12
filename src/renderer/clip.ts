// A clip is a selection lifted off the board: the ink and pictures inside it,
// moved so the whole thing starts at (0, 0), with nothing in it that cannot be
// written to JSON. That one shape serves three features — copy/paste,
// duplicate, and stickers — because all three are the same question asked at
// different times: what was selected, and where should it come back?

import type { BBox, BoardImage, BrushId, Point, Stroke, StrokePoint } from './types';
import { emptyBBox, growBBox, uid } from './types';

export interface ClipStroke {
  color: string;
  size: number;
  pen: boolean;
  brush: BrushId;
  seed: number;
  points: StrokePoint[];
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
  const merged = [
    ...strokes.map((s) => ({ seq: s.seq, stroke: s, image: null as BoardImage | null })),
    ...images.map((im) => ({ seq: im.seq, stroke: null as Stroke | null, image: im })),
  ].sort((a, b) => a.seq - b.seq);

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
        points: s.points.map((p) => ({ x: p.x - ox, y: p.y - oy, p: p.p })),
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
// items. Paths are deliberately left unbuilt: Path2D is a browser object, and
// leaving it to the caller keeps this side testable and the ink module in one
// place.
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
      const points = src.points.map((p) => ({ x: at.x + p.x * k, y: at.y + p.y * k, p: p.p }));
      const size = src.size * k;
      const bbox = emptyBBox();
      for (const p of points) growBBox(bbox, p.x, p.y, size / 2 + 2);
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
        points,
        bbox,
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

export function isClip(value: unknown): value is Clip {
  const c = value as Clip | null;
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

export const MAX_STICKERS = 60;

export function isSticker(value: unknown): value is Sticker {
  const s = value as Sticker | null;
  return (
    !!s &&
    typeof s === 'object' &&
    typeof s.id === 'string' &&
    typeof s.name === 'string' &&
    typeof s.thumb === 'string' &&
    isClip(s.clip)
  );
}

// Names come from whatever was on the board, which is nothing, so they are
// numbered — but never duplicated, because the tray is read at a glance.
export function stickerName(existing: Sticker[], base = 'Sticker'): string {
  const taken = new Set(existing.map((s) => s.name));
  for (let i = 1; ; i++) {
    const name = `${base} ${i}`;
    if (!taken.has(name)) return name;
  }
}
