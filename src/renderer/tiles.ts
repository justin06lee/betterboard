import type { Item, Marquee, Matrix } from './render';
import { bySeq, drawGrid, drawImageItem, drawOverlays, drawStroke, paintItems, viewBBox, worldMatrix } from './render';
import type { Board } from './store';
import type { BBox, BoardImage, Camera, Layer, Point, Stroke, Theme } from './types';

// The board is painted once into tiles and the tiles are what reach the
// screen. Drawing a stroke, marching the ants, sweeping the eraser cursor,
// dragging a selection — none of them repaint the board any more, so none of
// them get slower as the board grows: a frame is a few dozen tile copies plus
// whatever is actually moving.
//
// Tiles live in "view space": the world under the camera's scale, rotation
// and mirroring, but not its position. Panning therefore only slides them,
// and with the translation snapped to whole device pixels each tile lands
// exactly, never resampled. Each cell of the frame × layer grid has its own
// tiles, holding that layer's ink at full strength, so layer opacity, order,
// visibility and onion skins are all decided while compositing, for free.
//
// A zoom or turn changes view space. The old tiles are kept as a stand-in —
// scaled to fit, clipped to wherever a new tile is still missing — while new
// ones are painted a few milliseconds' worth at a time, nearest the middle of
// the screen first. A board light enough to repaint within one frame never
// shows the stand-in at all.

export const TILE = 512; // device px along a tile's side
const WORK_MS = 8; // tile painting allowed per frame once anything is on screen
const FIRST_PAINT_MS = 32; // …and before anything is
const MAX_TILES = 224; // tile canvases held at once, beyond those in view
// A lifted selection with more ink than this is painted into tiles once
// rather than drawn over again every frame of the drag.
export const LIFT_DIRECT = 1500;

interface Zoom {
  a: number;
  b: number;
  c: number;
  d: number;
  // the inverse, view -> world
  ia: number;
  ib: number;
  ic: number;
  id: number;
  k: number; // device px per world unit
  key: string;
}

function zoomOf(m: Matrix): Zoom {
  const [a, b, c, d] = m;
  const det = a * d - b * c;
  return { a, b, c, d, ia: d / det, ib: -b / det, ic: -c / det, id: a / det, k: Math.sqrt(Math.abs(det)), key: `${a},${b},${c},${d}` };
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Job {
  items: Item[];
  at: number;
  canvas: HTMLCanvasElement;
}

interface Tile {
  canvas: HTMLCanvasElement | null; // null once ready means the tile is empty
  ready: boolean;
  dirty: Rect | null; // tile pixels to repaint before it is next shown
  job: Job | null; // a first paint spread across frames
  used: number; // frame it was last shown in
}

class TileSet {
  tiles = new Map<number, Tile>();
  constructor(readonly key: string, readonly collect: (box: BBox) => Item[]) {}
}

const OFF = 2 ** 25;
const SPAN = 2 ** 26;
const tileKey = (tx: number, ty: number) => (tx + OFF) * SPAN + (ty + OFF);

export interface Ghost {
  frame: string;
  alpha: number;
  tint: string | null;
}

// A selection picked up by a drag. Its strokes and pictures are hidden from
// their cell and drawn here instead, through the world -> world map (x·sx + dx,
// y·sy + dy) the drag has made so far.
export interface Lift {
  map: { sx: number; sy: number; dx: number; dy: number };
  items: Item[]; // drawn through the map every frame, unless `tiles`
  tiles: boolean; // the ink was too much for that: it was painted into tiles
  preview: Stroke[] | null; // reshaped copies standing in for the ink, drawn as they are
}

export interface FrameOpts {
  theme: Theme;
  grid: boolean;
  layers: Layer[];
  activeLayer: string;
  frame: string;
  ghosts: Ghost[];
  live: { stroke: Stroke; path: Path2D } | null;
  lift: Lift | null;
  marquee: Marquee | null;
  eraser: { x: number; y: number; radius: number } | null;
  region: Point[] | null;
  // The magic-wand selection: a tinted mask canvas stretched over its picture's
  // world rectangle, so it stays glued to the pixels it selects.
  wand: { x: number; y: number; width: number; height: number; canvas: HTMLCanvasElement } | null;
}

interface Override {
  frame: string;
  layer: string;
  swap: ((s: Stroke) => Stroke[] | undefined) | null;
  images: Set<string> | null;
}

export class Compositor {
  // Tiles still to paint for what is on screen: the caller should ask for
  // another frame.
  pending = false;
  stats = { workMs: 0, tiles: 0, canvases: 0, missing: 0 };

  private zoom: Zoom | null = null;
  private sets = new Map<string, TileSet>();
  private fallback: { zoom: Zoom; sets: Map<string, TileSet> } | null = null;
  private pool: HTMLCanvasElement[] = [];
  private held = 0;
  private frameNo = 0;
  private range: Rect = { x0: 0, y0: 0, x1: -1, y1: -1 };
  private order: [number, number][] = [];
  private orderKey = '';
  private coverage = 0;
  private scratch: HTMLCanvasElement | null = null;
  private override: Override | null = null;
  private liftSource: { frame: string; layer: string; ids: Set<string>; images: Set<string> } | null = null;

  constructor(private board: Board) {}

  // ---- what changed ---------------------------------------------------------

  // Everything is stale: a new board, or the world rescaled under the view.
  reset(): void {
    this.dropSets(this.sets);
    this.sets = new Map();
    if (this.fallback) this.dropSets(this.fallback.sets);
    this.fallback = null;
  }

  // Part of one cell changed. Tiles on screen repaint just that part before
  // they are next shown; tiles off screen are dropped and painted afresh if
  // they come back into view.
  invalidate(frame: string, layer: string, box: BBox): void {
    const zoom = this.zoom;
    if (!zoom) return;
    const key = cellKey(frame, layer);
    const set = this.sets.get(key);
    if (set) {
      const r = viewRect(zoom, box, 2);
      this.forTiles(r, (tx, ty) => {
        const k = tileKey(tx, ty);
        const tile = set.tiles.get(k);
        if (!tile) return;
        if (tile.job || !this.inView(tx, ty)) {
          this.dropTile(set, k, tile);
          return;
        }
        const local = clipRect(r, tx, ty);
        tile.dirty = tile.dirty ? union(tile.dirty, local) : local;
      });
    }
    const old = this.fallback;
    const stale = old?.sets.get(key);
    if (old && stale) {
      this.forTiles(viewRect(old.zoom, box, 2), (tx, ty) => {
        const k = tileKey(tx, ty);
        const tile = stale.tiles.get(k);
        if (tile) this.dropTile(stale, k, tile);
      });
    }
  }

  // A stroke landed on top of everything else in its cell: paint it over the
  // tiles as they are. This is the pen's common case — a stroke finished on a
  // board of a million costs one stroke's worth of painting.
  append(s: Stroke): void {
    const zoom = this.zoom;
    if (!zoom) return;
    const key = cellKey(s.frame, s.layer);
    const set = this.sets.get(key);
    if (set) {
      const r = viewRect(zoom, s.bbox, 2);
      this.forTiles(r, (tx, ty) => {
        const k = tileKey(tx, ty);
        const tile = set.tiles.get(k);
        if (!tile) return;
        if (tile.job) {
          tile.job.items.push(s); // newest of all, so it belongs at the end
          return;
        }
        if (!tile.ready) return;
        if (tile.dirty) {
          tile.dirty = union(tile.dirty, clipRect(r, tx, ty));
          return;
        }
        if (!tile.canvas) tile.canvas = this.take();
        drawStroke(tile.canvas.getContext('2d')!, s, tileMatrix(zoom, tx, ty), zoom.k);
      });
    }
    const old = this.fallback;
    const stale = old?.sets.get(key);
    if (old && stale) {
      this.forTiles(viewRect(old.zoom, s.bbox, 2), (tx, ty) => {
        const k = tileKey(tx, ty);
        const tile = stale.tiles.get(k);
        if (tile) this.dropTile(stale, k, tile);
      });
    }
  }

  // How the active cell should look while a gesture is in flight: strokes
  // swapped for eraser fragments, or strokes and pictures hidden because a
  // drag has lifted them. The caller invalidates whatever it changes.
  setOverride(frame: string, layer: string, swap: Override['swap'], images: Set<string> | null): void {
    this.override = swap || images ? { frame, layer, swap, images } : null;
  }

  // A selection too heavy to draw every frame is painted into tiles of its own.
  setLiftSource(src: { frame: string; layer: string; ids: Set<string>; images: Set<string> } | null): void {
    this.liftSource = src;
    const set = this.sets.get(LIFT);
    if (set) {
      this.dropSets(new Map([[LIFT, set]]));
      this.sets.delete(LIFT);
    }
  }

  // ---- a frame ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, camera: Camera, o: FrameOpts): void {
    const started = performance.now();
    this.frameNo++;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width;
    const H = canvas.height;
    const m = worldMatrix(camera, dpr);
    // Whole device pixels, so every tile lands exactly where it was painted.
    m[4] = Math.round(m[4]);
    m[5] = Math.round(m[5]);
    const zoom = zoomOf(m);
    if (!this.zoom || this.zoom.key !== zoom.key) this.switchZoom(zoom);
    const e = m[4];
    const f = m[5];
    this.range = {
      x0: Math.floor(-e / TILE),
      y0: Math.floor(-f / TILE),
      x1: Math.floor((W - 1 - e) / TILE),
      y1: Math.floor((H - 1 - f) / TILE),
    };
    const order = this.tileOrder(this.range);

    // What this frame shows, most important first: the layer being worked on,
    // the rest of its frame top down, then the onion skins.
    const frameLayers = o.layers.filter((l) => l.visible && l.opacity > 0);
    const shown: TileSet[] = [];
    const byLayer = new Map<string, TileSet>();
    for (let i = frameLayers.length - 1; i >= 0; i--) {
      const l = frameLayers[i];
      if (this.board.count(o.frame, l.id) === 0) continue;
      const set = this.cellSet(o.frame, l.id);
      byLayer.set(l.id, set);
      if (l.id === o.activeLayer) shown.unshift(set);
      else shown.push(set);
    }
    const ghostSets: TileSet[][] = [];
    for (const ghost of o.ghosts) {
      const sets: TileSet[] = [];
      for (const l of frameLayers) {
        if (this.board.count(ghost.frame, l.id) === 0) continue;
        const set = this.cellSet(ghost.frame, l.id);
        sets.push(set);
        shown.push(set);
      }
      ghostSets.push(sets);
    }

    // Repaint what changed, then paint what is missing for as long as the
    // budget allows. A lifted selection is painted in full straight away: it
    // was already on screen a moment ago and must not blink out.
    for (const set of shown) {
      for (const [tx, ty] of order) {
        const tile = set.tiles.get(tileKey(tx, ty));
        if (tile?.dirty) this.redo(set, tile, tx, ty, zoom);
      }
    }
    const liftDraw = o.lift?.tiles && this.liftSource ? this.liftTransform(o.lift, zoom, e, f, W, H) : null;
    if (liftDraw) {
      const set = this.liftSet();
      this.forTiles(liftDraw.range, (tx, ty) => {
        const tile = set.tiles.get(tileKey(tx, ty));
        if (!tile?.ready) this.fill(set, tx, ty, zoom, Infinity);
      });
    }
    // The longer budget is only for a screen with nothing at all to show yet —
    // a fresh launch — never for one the old zoom's tiles are standing in on.
    const deadline = performance.now() + (this.coverage === 0 && !this.fallback ? FIRST_PAINT_MS : WORK_MS);
    let missing = 0;
    for (const set of shown) {
      for (const [tx, ty] of order) {
        const tile = set.tiles.get(tileKey(tx, ty));
        if (tile?.ready) continue;
        if (performance.now() > deadline || !this.fill(set, tx, ty, zoom, deadline)) missing++;
      }
    }

    // Composite.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = o.theme.bg;
    ctx.fillRect(0, 0, W, H);
    if (o.grid) drawGrid(ctx, camera, viewBBox(camera, W / dpr, H / dpr), o.theme.grid, m);

    // Onion skins sit under the live frame. Each ghost frame is flattened
    // first and composited once, so it reads as one translucent drawing rather
    // than a pile of translucent strokes.
    o.ghosts.forEach((ghost, i) => {
      const sets = ghostSets[i];
      if (sets.length === 0) return;
      const g = this.scratchContext(W, H);
      for (const set of sets) {
        const layer = frameLayers.find((l) => set.key === cellKey(ghost.frame, l.id));
        this.drawSet(g, set, layer?.opacity ?? 1, e, f, false);
      }
      if (ghost.tint) {
        // Colour the composited frame in one pass, pictures included. The
        // source-in operation keeps transparency while replacing visible pixels.
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalCompositeOperation = 'source-in';
        g.fillStyle = ghost.tint;
        g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = 'source-over';
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = ghost.alpha;
      ctx.drawImage(g.canvas, 0, 0);
      ctx.globalAlpha = 1;
    });

    let ready = 0;
    let total = 0;
    for (const layer of frameLayers) {
      const set = byLayer.get(layer.id);
      const active = layer.id === o.activeLayer;
      const dynamic = active && (o.live !== null || o.lift !== null);
      if (!set && !dynamic) continue;
      // Anything moving inside a translucent layer has to be flattened with
      // the rest of the layer, or its overlaps would show through.
      const flatten = dynamic && layer.opacity < 1;
      const target: CanvasRenderingContext2D = flatten ? this.scratchContext(W, H) : ctx;
      if (set) {
        const counted = this.drawSet(target, set, flatten ? 1 : layer.opacity, e, f, true);
        ready += counted.ready;
        total += counted.total;
      }
      if (dynamic) this.drawDynamic(target, o, m, zoom, liftDraw);
      if (flatten) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = layer.opacity;
        ctx.drawImage(target.canvas, 0, 0);
        ctx.globalAlpha = 1;
      }
    }
    this.coverage = total === 0 ? 1 : ready / total;

    if (o.wand) {
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.drawImage(o.wand.canvas, o.wand.x, o.wand.y, o.wand.width, o.wand.height);
    }
    drawOverlays(ctx, camera, dpr, o);

    this.pending = missing > 0;
    this.evict();
    this.stats.workMs = performance.now() - started;
    this.stats.canvases = this.held;
    this.stats.missing = missing;
    let tiles = 0;
    for (const set of this.sets.values()) tiles += set.tiles.size;
    this.stats.tiles = tiles;
  }

  // The live stroke and whatever a drag has lifted, drawn into their layer.
  private drawDynamic(
    g: CanvasRenderingContext2D,
    o: FrameOpts,
    m: Matrix,
    zoom: Zoom,
    liftDraw: { q: Matrix; range: Rect } | null
  ): void {
    const lift = o.lift;
    if (lift) {
      const { sx, sy, dx, dy } = lift.map;
      const lm: Matrix = [m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy, m[0] * dx + m[2] * dy + m[4], m[1] * dx + m[3] * dy + m[5]];
      const lk = zoom.k * Math.sqrt(Math.abs(sx * sy));
      if (liftDraw) {
        const set = this.liftSet();
        const q = liftDraw.q;
        g.setTransform(q[0], q[1], q[2], q[3], q[4], q[5]);
        g.globalAlpha = 1;
        this.forTiles(liftDraw.range, (tx, ty) => {
          const tile = set.tiles.get(tileKey(tx, ty));
          if (!tile?.ready || !tile.canvas) return;
          tile.used = this.frameNo;
          g.drawImage(tile.canvas, tx * TILE, ty * TILE);
        });
      }
      for (const item of lift.items) {
        if ((item as Stroke).pts !== undefined) drawStroke(g, item as Stroke, lm, lk);
        else drawImageItem(g, item as BoardImage, lm);
      }
      for (const s of lift.preview ?? []) drawStroke(g, s, m, zoom.k, s.path);
    }
    if (o.live) drawStroke(g, o.live.stroke, m, zoom.k, o.live.path);
  }

  // Tiles of a lifted selection are painted where the selection sat; on
  // screen they go through the drag's map. In view space that map is
  // L·S·L⁻¹ plus a shift — which is what `q` is.
  private liftTransform(lift: Lift, zoom: Zoom, e: number, f: number, W: number, H: number): { q: Matrix; range: Rect } {
    const { sx, sy, dx, dy } = lift.map;
    // L·S, then ·L⁻¹
    const ls = [zoom.a * sx, zoom.b * sx, zoom.c * sy, zoom.d * sy];
    const qa = ls[0] * zoom.ia + ls[2] * zoom.ib;
    const qb = ls[1] * zoom.ia + ls[3] * zoom.ib;
    const qc = ls[0] * zoom.ic + ls[2] * zoom.id;
    const qd = ls[1] * zoom.ic + ls[3] * zoom.id;
    // Snapped to whole pixels, like the board, so a dragged selection stays sharp.
    const tx = Math.round(zoom.a * dx + zoom.c * dy + e);
    const ty = Math.round(zoom.b * dx + zoom.d * dy + f);
    const q: Matrix = [qa, qb, qc, qd, tx, ty];
    // Which lift tiles reach the screen: the screen's corners taken back
    // through q.
    const det = qa * qd - qb * qc || 1;
    const corners = [
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
    ];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [px, py] of corners) {
      const rx = px - tx;
      const ry = py - ty;
      const vx = (qd * rx - qc * ry) / det;
      const vy = (-qb * rx + qa * ry) / det;
      x0 = Math.min(x0, vx);
      y0 = Math.min(y0, vy);
      x1 = Math.max(x1, vx);
      y1 = Math.max(y1, vy);
    }
    return {
      q,
      range: { x0: Math.floor(x0 / TILE), y0: Math.floor(y0 / TILE), x1: Math.floor(x1 / TILE), y1: Math.floor(y1 / TILE) },
    };
  }

  // Copies a set's tiles in view onto `g`. Where a tile is not ready yet the
  // old zoom's tiles stand in, scaled to fit and clipped to the gap.
  private drawSet(g: CanvasRenderingContext2D, set: TileSet, alpha: number, e: number, f: number, count: boolean): { ready: number; total: number } {
    const r = this.range;
    let ready = 0;
    let total = 0;
    const gaps: [number, number][] = [];
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = alpha;
    for (let ty = r.y0; ty <= r.y1; ty++) {
      for (let tx = r.x0; tx <= r.x1; tx++) {
        const tile = set.tiles.get(tileKey(tx, ty));
        total++;
        if (!tile?.ready) {
          gaps.push([tx, ty]);
          continue;
        }
        ready++;
        tile.used = this.frameNo;
        if (tile.canvas) g.drawImage(tile.canvas, tx * TILE + e, ty * TILE + f);
      }
    }
    const old = this.fallback;
    const stale = old?.sets.get(set.key);
    if (gaps.length && old && stale && this.zoom) {
      g.save();
      g.beginPath();
      for (const [tx, ty] of gaps) g.rect(tx * TILE + e, ty * TILE + f, TILE, TILE);
      g.clip();
      // screen = Lnow · Lold⁻¹ · (old view) + t
      const z = this.zoom;
      const oz = old.zoom;
      g.setTransform(
        z.a * oz.ia + z.c * oz.ib,
        z.b * oz.ia + z.d * oz.ib,
        z.a * oz.ic + z.c * oz.id,
        z.b * oz.ic + z.d * oz.id,
        e,
        f
      );
      for (const [key, tile] of stale.tiles) {
        if (!tile.ready || !tile.canvas) continue;
        const tx = Math.floor(key / SPAN) - OFF;
        const ty = key - (tx + OFF) * SPAN - OFF;
        g.drawImage(tile.canvas, tx * TILE, ty * TILE);
      }
      g.restore();
    }
    g.globalAlpha = 1;
    return count ? { ready, total } : { ready: 0, total: 0 };
  }

  // ---- painting tiles --------------------------------------------------------

  // Starts or continues a tile's first paint. True once it is ready.
  private fill(set: TileSet, tx: number, ty: number, zoom: Zoom, deadline: number): boolean {
    const key = tileKey(tx, ty);
    let tile = set.tiles.get(key);
    if (!tile) {
      tile = { canvas: null, ready: false, dirty: null, job: null, used: this.frameNo };
      set.tiles.set(key, tile);
    }
    if (tile.ready) return true;
    if (!tile.job) {
      const items = set.collect(tileWorld(zoom, tx, ty));
      if (items.length === 0) {
        tile.ready = true;
        return true;
      }
      const canvas = this.take();
      tile.job = { items, at: 0, canvas };
    }
    const job = tile.job;
    job.at = paintItems(job.canvas.getContext('2d')!, job.items, tileMatrix(zoom, tx, ty), zoom.k, job.at, deadline);
    if (job.at < job.items.length) return false;
    tile.canvas = job.canvas;
    tile.job = null;
    tile.ready = true;
    return true;
  }

  // Repaints the part of a ready tile that changed.
  private redo(set: TileSet, tile: Tile, tx: number, ty: number, zoom: Zoom): void {
    const r = tile.dirty!;
    tile.dirty = null;
    if (!tile.ready) return;
    const [ox, oy] = [tx * TILE, ty * TILE];
    const items = set.collect(worldOf(zoom, { x0: r.x0 + ox, y0: r.y0 + oy, x1: r.x1 + ox, y1: r.y1 + oy }, 2));
    if (!tile.canvas) {
      if (items.length === 0) return;
      tile.canvas = this.take();
    }
    const g = tile.canvas.getContext('2d')!;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.beginPath();
    g.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    g.clip();
    g.clearRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    paintItems(g, items, tileMatrix(zoom, tx, ty), zoom.k);
    g.restore();
  }

  private cellSet(frame: string, layer: string): TileSet {
    const key = cellKey(frame, layer);
    let set = this.sets.get(key);
    if (!set) {
      set = new TileSet(key, (box) => this.collectCell(frame, layer, box));
      this.sets.set(key, set);
    }
    return set;
  }

  private liftSet(): TileSet {
    let set = this.sets.get(LIFT);
    if (!set) {
      set = new TileSet(LIFT, (box) => {
        const src = this.liftSource;
        if (!src) return [];
        const items: Item[] = this.board.query(src.frame, src.layer, box).filter((s) => src.ids.has(s.id));
        for (const im of this.board.cellImages(src.frame, src.layer)) {
          if (src.images.has(im.id) && overlapsImage(im, box)) items.push(im);
        }
        return items.sort(bySeq);
      });
      this.sets.set(LIFT, set);
    }
    return set;
  }

  // One cell's ink and pictures inside `box`, as the screen should show them.
  private collectCell(frame: string, layer: string, box: BBox): Item[] {
    const strokes = this.board.query(frame, layer, box);
    const o = this.override && this.override.frame === frame && this.override.layer === layer ? this.override : null;
    let items: Item[] = strokes;
    if (o?.swap) {
      items = [];
      for (const s of strokes) {
        const sub = o.swap(s);
        if (sub === undefined) items.push(s);
        else for (const t of sub) items.push(t);
      }
    }
    for (const im of this.board.cellImages(frame, layer)) {
      if (o?.images?.has(im.id) || !overlapsImage(im, box)) continue;
      items.push(im);
    }
    return items.sort(bySeq);
  }

  // ---- housekeeping ----------------------------------------------------------

  private switchZoom(next: Zoom): void {
    if (this.zoom) {
      // Keep whichever tiles are the better stand-in: these, if most of the
      // screen was painted, else the stand-in they were themselves covering for.
      const lift = this.sets.get(LIFT);
      if (lift) {
        this.dropSets(new Map([[LIFT, lift]]));
        this.sets.delete(LIFT);
      }
      if (this.coverage >= 0.7 || !this.fallback) {
        if (this.fallback) this.dropSets(this.fallback.sets);
        for (const set of this.sets.values()) {
          for (const [key, tile] of set.tiles) if (tile.job) this.dropTile(set, key, tile);
        }
        this.fallback = { zoom: this.zoom, sets: this.sets };
      } else {
        this.dropSets(this.sets);
      }
    }
    this.zoom = next;
    this.sets = new Map();
    this.coverage = 0;
  }

  private inView(tx: number, ty: number): boolean {
    const r = this.range;
    return tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1;
  }

  private forTiles(r: Rect, visit: (tx: number, ty: number) => void): void {
    const x0 = Math.floor(r.x0 / TILE);
    const y0 = Math.floor(r.y0 / TILE);
    const x1 = Math.floor(r.x1 / TILE);
    const y1 = Math.floor(r.y1 / TILE);
    // A box so big it covers more tiles than any set holds is not walked
    // tile by tile.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
      const keys = new Set<number>();
      for (const set of this.sets.values()) for (const key of set.tiles.keys()) keys.add(key);
      for (const set of this.fallback?.sets.values() ?? []) for (const key of set.tiles.keys()) keys.add(key);
      for (const key of keys) {
        const tx = Math.floor(key / SPAN) - OFF;
        const ty = key - (tx + OFF) * SPAN - OFF;
        if (tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1) visit(tx, ty);
      }
      return;
    }
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) visit(tx, ty);
  }

  private tileOrder(r: Rect): [number, number][] {
    const key = `${r.x0},${r.y0},${r.x1},${r.y1}`;
    if (key === this.orderKey) return this.order;
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    const order: [number, number][] = [];
    for (let ty = r.y0; ty <= r.y1; ty++) for (let tx = r.x0; tx <= r.x1; tx++) order.push([tx, ty]);
    order.sort((a, b) => (a[0] - cx) ** 2 + (a[1] - cy) ** 2 - ((b[0] - cx) ** 2 + (b[1] - cy) ** 2));
    this.order = order;
    this.orderKey = key;
    return order;
  }

  private take(): HTMLCanvasElement {
    this.held++;
    const canvas = this.pool.pop();
    if (canvas) {
      const g = canvas.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, TILE, TILE);
      return canvas;
    }
    // A plain canvas element rather than an OffscreenCanvas: on the page's
    // own thread Chromium copies an OffscreenCanvas out every time it is
    // drawn, which made compositing a screenful of tiles seven times slower.
    const el = document.createElement('canvas');
    el.width = TILE;
    el.height = TILE;
    return el;
  }

  private give(canvas: HTMLCanvasElement): void {
    this.held--;
    if (this.pool.length < 24) this.pool.push(canvas);
  }

  private dropTile(set: TileSet, key: number, tile: Tile): void {
    if (tile.canvas) this.give(tile.canvas);
    if (tile.job) this.give(tile.job.canvas);
    set.tiles.delete(key);
  }

  private dropSets(sets: Map<string, TileSet>): void {
    for (const set of sets.values()) {
      for (const [key, tile] of set.tiles) this.dropTile(set, key, tile);
    }
  }

  // Past the cap, the stand-in goes first, then whatever has been off screen
  // longest. Tiles on screen always stay.
  private evict(): void {
    if (this.held <= MAX_TILES) return;
    if (this.fallback) {
      this.dropSets(this.fallback.sets);
      this.fallback = null;
      if (this.held <= MAX_TILES) return;
    }
    const old: [TileSet, number, Tile][] = [];
    for (const set of this.sets.values()) {
      for (const [key, tile] of set.tiles) {
        if (tile.used < this.frameNo && (tile.canvas || tile.job)) old.push([set, key, tile]);
      }
    }
    old.sort((a, b) => a[2].used - b[2].used);
    for (const [set, key, tile] of old) {
      if (this.held <= MAX_TILES * 0.85) break;
      this.dropTile(set, key, tile);
    }
  }

  private scratchContext(width: number, height: number): CanvasRenderingContext2D {
    if (!this.scratch) this.scratch = document.createElement('canvas');
    if (this.scratch.width !== width || this.scratch.height !== height) {
      this.scratch.width = width;
      this.scratch.height = height;
    }
    const g = this.scratch.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, width, height);
    return g;
  }
}

const LIFT = 'lift';

function cellKey(frame: string, layer: string): string {
  return `${frame}\n${layer}`;
}

// View space -> one tile's pixels.
function tileMatrix(z: Zoom, tx: number, ty: number): Matrix {
  return [z.a, z.b, z.c, z.d, -tx * TILE, -ty * TILE];
}

// A world box's footprint in view space, grown by `pad` device pixels for the
// anti-aliasing that spills past any edge.
function viewRect(z: Zoom, b: BBox, pad: number): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [wx, wy] of [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.minX, b.maxY],
    [b.maxX, b.maxY],
  ]) {
    const vx = z.a * wx + z.c * wy;
    const vy = z.b * wx + z.d * wy;
    if (vx < x0) x0 = vx;
    if (vx > x1) x1 = vx;
    if (vy < y0) y0 = vy;
    if (vy > y1) y1 = vy;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

// The world box a view-space rectangle covers, grown by `pad` device pixels.
function worldOf(z: Zoom, r: Rect, pad: number): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [vx, vy] of [
    [r.x0 - pad, r.y0 - pad],
    [r.x1 + pad, r.y0 - pad],
    [r.x0 - pad, r.y1 + pad],
    [r.x1 + pad, r.y1 + pad],
  ]) {
    const wx = z.ia * vx + z.ic * vy;
    const wy = z.ib * vx + z.id * vy;
    if (wx < minX) minX = wx;
    if (wx > maxX) maxX = wx;
    if (wy < minY) minY = wy;
    if (wy > maxY) maxY = wy;
  }
  return { minX, minY, maxX, maxY };
}

function tileWorld(z: Zoom, tx: number, ty: number): BBox {
  return worldOf(z, { x0: tx * TILE, y0: ty * TILE, x1: (tx + 1) * TILE, y1: (ty + 1) * TILE }, 2);
}

// The part of a view-space rectangle that falls inside one tile, in that
// tile's own pixels, rounded out to whole pixels.
function clipRect(r: Rect, tx: number, ty: number): Rect {
  const ox = tx * TILE;
  const oy = ty * TILE;
  return {
    x0: Math.max(0, Math.floor(r.x0 - ox)),
    y0: Math.max(0, Math.floor(r.y0 - oy)),
    x1: Math.min(TILE, Math.ceil(r.x1 - ox)),
    y1: Math.min(TILE, Math.ceil(r.y1 - oy)),
  };
}

function union(a: Rect, b: Rect): Rect {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function overlapsImage(im: BoardImage, box: BBox): boolean {
  return !(im.x > box.maxX || im.x + im.width < box.minX || im.y > box.maxY || im.y + im.height < box.minY);
}
