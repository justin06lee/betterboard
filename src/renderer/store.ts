import type { BoardSnapshot } from './codec';
import { parseBoardJSON } from './codec';
import { movedStroke, scaledStroke } from './points';
import { SpatialIndex } from './spatial';
import type { BBox, BoardImage, Camera, Frame, Layer, Onion, Stroke } from './types';
import { MAX_FPS, MIN_FPS, defaultOnion, emptyBBox, growBBox, imageBBox, newFrame, newLayer, uid } from './types';

export type Op =
  | { type: 'add'; stroke: Stroke }
  | { type: 'add-many'; strokes: Stroke[] }
  | { type: 'add-items'; strokes: Stroke[]; images: BoardImage[] }
  | { type: 'remove-items'; strokes: Stroke[]; images: { index: number; image: BoardImage }[] }
  | { type: 'remove'; strokes: Stroke[] }
  | { type: 'replace'; changes: StrokeReplacement[]; imageChanges?: ImageSrcChange[] }
  | { type: 'clear'; strokes: Stroke[]; images: { index: number; image: BoardImage }[] }
  | { type: 'scale'; factor: number }
  | { type: 'move'; ids: string[]; images: string[]; dx: number; dy: number }
  | { type: 'image-add'; image: BoardImage }
  | { type: 'image-remove'; removed: { index: number; image: BoardImage }[] }
  | { type: 'transform'; changes: StrokeReplacement[]; images: { id: string; from: Rect; to: Rect }[] }
  | { type: 'image-src'; id: string; from: string; to: string }
  | { type: 'layer-add'; index: number; layer: Layer }
  | { type: 'layer-remove'; index: number; layer: Layer; strokes: Stroke[]; removedImages: BoardImage[] }
  | { type: 'layer-order'; from: number; to: number }
  | { type: 'frame-add'; index: number; frame: Frame; added: Stroke[]; addedImages: BoardImage[] }
  | { type: 'frame-remove'; index: number; frame: Frame; strokes: Stroke[]; removedImages: BoardImage[] }
  | { type: 'frame-order'; from: number; to: number };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// A stroke and what took its place: eraser fragments (any number of them,
// none included), or a reshaped copy.
export interface StrokeReplacement {
  before: Stroke;
  after: Stroke[];
}

// A pixel edit to a placed picture: the whole bitmap swaps, so undo is exact.
export interface ImageSrcChange {
  id: string;
  from: string;
  to: string;
}

const MAX_UNDO = 500;

// One cell of the frame × layer grid: its strokes, indexed by where they sit,
// and its pictures.
interface Cell {
  strokes: SpatialIndex<Stroke>;
  images: BoardImage[];
  top: number; // the highest seq ever placed here
}

const NO_IMAGES: readonly BoardImage[] = [];

export class Board {
  // Every stroke on the board, by id. There is no meaningful order to keep:
  // ink is painted by seq within its layer, whatever order it is stored in. So
  // the board is a map, and finding, adding or removing a stroke — which is
  // all any edit or undo ever does — costs the same on a board of ten strokes
  // as on a board of a million. Nothing walks the whole board to make an edit.
  private all = new Map<string, Stroke>();
  private list: Stroke[] | null = [];
  images: BoardImage[] = [];
  // Handed out to strokes and images alike; see Stroke.seq.
  private nextSeq = 0;
  // Called when a picture finishes decoding and the board should repaint. Kept
  // apart from onChange so a decode does not look like an edit worth saving.
  onRedraw: (() => void) | null = null;
  layers: Layer[] = [newLayer('Layer 1')];
  activeLayer: string = this.layers[0].id;
  frames: Frame[] = [newFrame()];
  activeFrame: string = this.frames[0].id;
  fps = 12;
  onion: Onion = defaultOnion();
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  onChange: (() => void) | null = null;

  // Where the content changed, reported as it happens, for the renderer's tile
  // cache. `onAppend` is the common case worth telling apart — a stroke that
  // lands on top of everything already in its cell can simply be painted over
  // what is cached.
  onDirty: ((frame: string, layer: string, box: BBox) => void) | null = null;
  onAppend: ((stroke: Stroke) => void) | null = null;
  // Every stroke that joins or leaves the board, one at a time — how the
  // autosave keeps track of which of its files an edit has touched.
  onMembership: ((stroke: Stroke, added: boolean) => void) | null = null;
  private resets: (() => void)[] = [];
  // Bumped on every change to what is on the board.
  revision = 0;

  private cells = new Map<string, Map<string, Cell>>();
  private pending: Map<Cell, { frame: string; layer: string; box: BBox }> | null = null;

  // Everything changed at once — a load, or the world rescaled.
  whenReset(fn: () => void): void {
    this.resets.push(fn);
  }

  private changed(): void {
    this.onChange?.();
  }

  private push(op: Op): void {
    this.undoStack.push(op);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack.length = 0;
    this.changed();
  }

  takeSeq(): number {
    return this.nextSeq++;
  }

  peekSeq(): number {
    return this.nextSeq;
  }

  // Every stroke on the board, as a list: built when asked for and kept until
  // the board next changes. Whatever holds one keeps a consistent snapshot —
  // the board never writes into a list it has handed out.
  get strokes(): Stroke[] {
    return (this.list ??= [...this.all.values()]);
  }

  get strokeCount(): number {
    return this.all.size;
  }

  eachStroke(): IterableIterator<Stroke> {
    return this.all.values();
  }

  // ---- indexes ------------------------------------------------------------

  private cell(frame: string, layer: string, create = false): Cell | undefined {
    let layers = this.cells.get(frame);
    if (!layers) {
      if (!create) return undefined;
      layers = new Map();
      this.cells.set(frame, layers);
    }
    let cell = layers.get(layer);
    if (!cell && create) {
      cell = { strokes: new SpatialIndex<Stroke>(), images: [], top: -Infinity };
      layers.set(layer, cell);
    }
    return cell;
  }

  private dirty(cell: Cell, frame: string, layer: string, box: BBox): void {
    this.revision++;
    if (!this.pending) {
      this.onDirty?.(frame, layer, box);
      return;
    }
    const acc = this.pending.get(cell);
    if (!acc) {
      this.pending.set(cell, { frame, layer, box: { ...box } });
      return;
    }
    growBBox(acc.box, box.minX, box.minY, 0);
    growBBox(acc.box, box.maxX, box.maxY, 0);
  }

  // Folds every region `fn` dirties into one report per cell: a clear or an
  // undo can touch a million strokes, and one report beats a million.
  private batch(fn: () => void): void {
    if (this.pending) {
      fn();
      return;
    }
    this.pending = new Map();
    try {
      fn();
    } finally {
      const pending = this.pending;
      this.pending = null;
      for (const { frame, layer, box } of pending.values()) this.onDirty?.(frame, layer, box);
    }
  }

  // `fresh` marks a stroke that has just been made — drawn, pasted, redone —
  // as opposed to one being put back somewhere in the middle of the pile.
  private attach(s: Stroke, fresh: boolean): void {
    this.all.set(s.id, s);
    this.list = null;
    const cell = this.cell(s.frame, s.layer, true)!;
    cell.strokes.insert(s);
    this.onMembership?.(s, true);
    if (fresh && s.seq > cell.top) {
      cell.top = s.seq;
      this.revision++;
      this.onAppend?.(s);
      return;
    }
    if (s.seq > cell.top) cell.top = s.seq;
    this.dirty(cell, s.frame, s.layer, s.bbox);
  }

  // False if `s` is not what the board holds under its id.
  private detach(s: Stroke): boolean {
    if (this.all.get(s.id) !== s) return false;
    this.all.delete(s.id);
    this.list = null;
    this.onMembership?.(s, false);
    const cell = this.cell(s.frame, s.layer);
    if (cell) {
      cell.strokes.remove(s);
      this.dirty(cell, s.frame, s.layer, s.bbox);
    }
    return true;
  }

  // Takes whichever of these strokes are on the board off it; hands back those.
  private take(strokes: Iterable<Stroke>): Stroke[] {
    const taken: Stroke[] = [];
    this.batch(() => {
      for (const s of strokes) if (this.detach(s)) taken.push(s);
    });
    return taken;
  }

  private takeIds(ids: Iterable<string>): Stroke[] {
    const taken: Stroke[] = [];
    this.batch(() => {
      for (const id of ids) {
        const s = this.all.get(id);
        if (s && this.detach(s)) taken.push(s);
      }
    });
    return taken;
  }

  private put(strokes: readonly Stroke[], fresh: boolean): void {
    this.batch(() => {
      for (const s of strokes) this.attach(s, fresh);
    });
  }

  private attachImage(im: BoardImage): void {
    const cell = this.cell(im.frame, im.layer, true)!;
    cell.images.push(im);
    if (im.seq > cell.top) cell.top = im.seq;
    this.dirty(cell, im.frame, im.layer, imageBBox(im));
  }

  private detachImage(im: BoardImage): void {
    const cell = this.cell(im.frame, im.layer);
    if (!cell) return;
    const i = cell.images.indexOf(im);
    if (i >= 0) cell.images.splice(i, 1);
    this.dirty(cell, im.frame, im.layer, imageBBox(im));
  }

  // A picture changed where it stands: moved, resized, or its bitmap swapped.
  private imageChanged(im: BoardImage, before?: BBox): void {
    const cell = this.cell(im.frame, im.layer, true)!;
    if (before) this.dirty(cell, im.frame, im.layer, before);
    this.dirty(cell, im.frame, im.layer, imageBBox(im));
  }

  // Every index rebuilt from scratch — after a load, or a rescale that has
  // moved everything at once.
  private reindex(): void {
    this.cells.clear();
    this.list = null;
    for (const s of this.all.values()) {
      const cell = this.cell(s.frame, s.layer, true)!;
      cell.strokes.insert(s);
      if (s.seq > cell.top) cell.top = s.seq;
    }
    for (const im of this.images) {
      const cell = this.cell(im.frame, im.layer, true)!;
      cell.images.push(im);
      if (im.seq > cell.top) cell.top = im.seq;
    }
    this.revision++;
    for (const fn of this.resets) fn();
  }

  // Pictures are few, and do keep their order in a list.
  private extractImages(drop: (im: BoardImage) => boolean): { index: number; image: BoardImage }[] {
    const removed: { index: number; image: BoardImage }[] = [];
    for (let i = 0; i < this.images.length; i++) {
      if (drop(this.images[i])) removed.push({ index: i, image: this.images[i] });
    }
    if (removed.length === 0) return removed;
    this.images = this.images.filter((im) => !drop(im));
    this.batch(() => {
      for (const r of removed) this.detachImage(r.image);
    });
    return removed;
  }

  private restoreImages(entries: readonly { index: number; image: BoardImage }[]): void {
    this.batch(() => {
      for (const { index, image } of entries) {
        this.images.splice(Math.min(index, this.images.length), 0, image);
        this.attachImage(image);
      }
    });
  }

  private appendImages(images: readonly BoardImage[]): void {
    this.batch(() => {
      for (const image of images) {
        this.hydrate(image);
        this.images.push(image);
        this.attachImage(image);
      }
    });
  }

  // ---- queries --------------------------------------------------------------

  stroke(id: string): Stroke | undefined {
    return this.all.get(id);
  }

  // The strokes of one cell whose bounds reach into `box`, in no particular
  // order — whoever paints them sorts by seq.
  query(frame: string, layer: string, box: BBox, out: Stroke[] = []): Stroke[] {
    const cell = this.cell(frame, layer);
    return cell ? cell.strokes.query(box, out) : out;
  }

  cellStrokes(frame: string, layer: string): Stroke[] {
    return this.cell(frame, layer)?.strokes.all() ?? [];
  }

  cellImages(frame: string, layer: string): readonly BoardImage[] {
    return this.cell(frame, layer)?.images ?? NO_IMAGES;
  }

  // Strokes and pictures in one cell, or in a whole frame.
  count(frame: string, layer?: string): number {
    const layers = this.cells.get(frame);
    if (!layers) return 0;
    if (layer !== undefined) {
      const cell = layers.get(layer);
      return cell ? cell.strokes.size + cell.images.length : 0;
    }
    let n = 0;
    for (const cell of layers.values()) n += cell.strokes.size + cell.images.length;
    return n;
  }

  // Every stroke in a frame, in no particular order.
  frameStrokes(frame: string = this.activeFrame): Stroke[] {
    const out: Stroke[] = [];
    for (const cell of this.cells.get(frame)?.values() ?? []) cell.strokes.forEach((s) => out.push(s));
    return out;
  }

  visibleStrokes(frame: string = this.activeFrame): Stroke[] {
    const out: Stroke[] = [];
    for (const layer of this.layers) {
      if (layer.visible) this.cell(frame, layer.id)?.strokes.forEach((s) => out.push(s));
    }
    return out;
  }

  // The strokes on a frame's visible layers that reach into `box`.
  visibleStrokesIn(frame: string, box: BBox): Stroke[] {
    const out: Stroke[] = [];
    for (const layer of this.layers) {
      if (layer.visible) this.query(frame, layer.id, box, out);
    }
    return out;
  }

  // Every stroke on one layer, across all frames.
  private layerStrokes(layer: string): Stroke[] {
    const out: Stroke[] = [];
    for (const layers of this.cells.values()) layers.get(layer)?.strokes.forEach((s) => out.push(s));
    return out;
  }

  // ---- strokes and pictures -----------------------------------------------

  addStroke(stroke: Stroke): void {
    this.attach(stroke, true);
    this.push({ type: 'add', stroke });
  }

  addStrokes(strokes: Stroke[]): void {
    if (strokes.length === 0) return;
    this.put(strokes, true);
    this.push({ type: 'add-many', strokes });
  }

  // Ink and pictures arriving together — a paste, a duplicate, a sticker
  // stamped down — are one thing that happened, so they undo in one step.
  addItems(strokes: Stroke[], images: BoardImage[]): void {
    if (strokes.length === 0 && images.length === 0) return;
    this.put(strokes, true);
    this.appendImages(images);
    this.push({ type: 'add-items', strokes, images });
  }

  // The other half of addItems: deleting a mixed selection is one step, so
  // getting it back is one press of undo rather than one per kind.
  removeItems(strokeIds: Set<string>, imageIds: Set<string>): void {
    const strokes = this.takeIds(strokeIds);
    const images = imageIds.size ? this.extractImages((im) => imageIds.has(im.id)) : [];
    if (strokes.length === 0 && images.length === 0) return;
    this.push({ type: 'remove-items', strokes, images });
  }

  addImage(image: BoardImage): void {
    this.appendImages([image]);
    this.push({ type: 'image-add', image });
  }

  removeImages(ids: Set<string>): void {
    if (ids.size === 0) return;
    const removed = this.extractImages((im) => ids.has(im.id));
    if (removed.length === 0) return;
    this.push({ type: 'image-remove', removed });
  }

  // Reshapes a selection — ink and pictures together — as one step. Each stroke
  // is swapped for a reshaped copy that keeps its id, so whatever holds the
  // selection still holds it; each picture's rectangle moves. Undo swaps the
  // originals straight back rather than running the arithmetic in reverse, so
  // nothing drifts however many times it goes back and forth.
  transformItems(strokes: Stroke[], images: { id: string; to: Rect }[]): void {
    const changes: StrokeReplacement[] = [];
    for (const after of strokes) {
      const before = this.all.get(after.id);
      if (before) changes.push({ before, after: [after] });
    }
    const rects: { id: string; from: Rect; to: Rect }[] = [];
    for (const { id, to } of images) {
      const image = this.images.find((im) => im.id === id);
      if (!image) continue;
      const from = { x: image.x, y: image.y, width: image.width, height: image.height };
      if (from.x === to.x && from.y === to.y && from.width === to.width && from.height === to.height) continue;
      rects.push({ id, from, to });
    }
    if (changes.length === 0 && rects.length === 0) return;
    this.applyReplacements(changes, true);
    for (const r of rects) this.applyRectById(r.id, r.to);
    this.push({ type: 'transform', changes, images: rects });
  }

  private applyRectById(id: string, r: Rect): void {
    const image = this.images.find((im) => im.id === id);
    if (!image) return;
    const before = imageBBox(image);
    image.x = r.x;
    image.y = r.y;
    image.width = r.width;
    image.height = r.height;
    this.imageChanged(image, before);
  }

  // Swaps a picture's bitmap for an edited one (wand cut-out, pixel erase).
  setImageSrc(id: string, to: string): void {
    const image = this.images.find((im) => im.id === id);
    if (!image || image.src === to) return;
    const from = image.src;
    this.applyImageSrc(image, to);
    this.push({ type: 'image-src', id, from, to });
  }

  private applyImageSrc(image: BoardImage, src: string): void {
    image.src = src;
    image.el = undefined;
    this.imageChanged(image);
    this.hydrate(image);
  }

  private applyImageSrcById(id: string, src: string): void {
    const image = this.images.find((im) => im.id === id);
    if (image) this.applyImageSrc(image, src);
  }

  imagesOn(frame: string = this.activeFrame): BoardImage[] {
    return this.images.filter((im) => im.frame === frame);
  }

  visibleImages(frame: string = this.activeFrame): BoardImage[] {
    const hidden = new Set(this.layers.filter((l) => !l.visible).map((l) => l.id));
    return this.images.filter((im) => im.frame === frame && !hidden.has(im.layer));
  }

  // Decoding is asynchronous, so a picture paints as soon as its bitmap lands
  // rather than holding up everything else.
  hydrate(image: BoardImage): void {
    if (image.el) return;
    const src = image.src;
    const el = new Image();
    el.onload = () => {
      if (image.src !== src) return; // a later bitmap has replaced this one
      image.el = el;
      if (this.cell(image.frame, image.layer)) this.onDirty?.(image.frame, image.layer, imageBBox(image));
      this.onRedraw?.();
    };
    el.src = src;
  }

  // ---- layers -------------------------------------------------------------

  layer(id: string): Layer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  get active(): Layer {
    return this.layer(this.activeLayer) ?? this.layers[this.layers.length - 1];
  }

  setActiveLayer(id: string): void {
    if (!this.layer(id) || id === this.activeLayer) return;
    this.activeLayer = id;
    this.changed();
  }

  // Named after the layer it sits above, so the numbering stays sensible as
  // layers come and go.
  addLayer(): Layer {
    let n = this.layers.length + 1;
    while (this.layers.some((l) => l.name === `Layer ${n}`)) n++;
    const layer = newLayer(`Layer ${n}`);
    const index = this.layers.findIndex((l) => l.id === this.activeLayer) + 1;
    this.layers.splice(index, 0, layer);
    this.activeLayer = layer.id;
    this.push({ type: 'layer-add', index, layer });
    return layer;
  }

  // Removing a layer takes its strokes with it; both come back together on undo.
  removeLayer(id: string): boolean {
    if (this.layers.length <= 1) return false;
    const index = this.layers.findIndex((l) => l.id === id);
    if (index < 0) return false;
    const layer = this.layers[index];
    this.layers.splice(index, 1);
    const strokes = this.take(this.layerStrokes(id));
    const removedImages = this.extractImages((im) => im.layer === id).map((r) => r.image);
    if (this.activeLayer === id) {
      this.activeLayer = this.layers[Math.min(index, this.layers.length - 1)].id;
    }
    this.push({ type: 'layer-remove', index, layer, strokes, removedImages });
    return true;
  }

  moveLayer(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.layers.length || to >= this.layers.length) {
      return;
    }
    this.applyLayerMove(from, to);
    this.push({ type: 'layer-order', from, to });
  }

  private applyLayerMove(from: number, to: number): void {
    const [layer] = this.layers.splice(from, 1);
    this.layers.splice(to, 0, layer);
  }

  // ---- frames -------------------------------------------------------------

  get frameIndex(): number {
    const i = this.frames.findIndex((f) => f.id === this.activeFrame);
    return i < 0 ? 0 : i;
  }

  setActiveFrame(id: string): void {
    if (id === this.activeFrame || !this.frames.some((f) => f.id === id)) return;
    this.activeFrame = id;
    this.changed();
  }

  stepFrame(delta: number, wrap = true): void {
    const n = this.frames.length;
    let i = this.frameIndex + delta;
    if (wrap) i = ((i % n) + n) % n;
    else i = Math.min(n - 1, Math.max(0, i));
    this.setActiveFrame(this.frames[i].id);
  }

  // A new frame lands right after the current one, so drawing runs left to
  // right. Duplicating copies the current frame's strokes onto it — sharing
  // their points and outlines, which never change.
  addFrame(duplicate = false): Frame {
    const frame = newFrame();
    const index = this.frameIndex + 1;
    this.frames.splice(index, 0, frame);
    const added: Stroke[] = [];
    const addedImages: BoardImage[] = [];
    if (duplicate) {
      const contents: ({ seq: number; stroke: Stroke; image: null } | { seq: number; stroke: null; image: BoardImage })[] = [];
      for (const stroke of this.frameStrokes()) contents.push({ seq: stroke.seq, stroke, image: null });
      for (const image of this.imagesOn()) contents.push({ seq: image.seq, stroke: null, image });
      contents.sort((a, b) => a.seq - b.seq);
      for (const item of contents) {
        if (item.stroke) {
          added.push({ ...item.stroke, id: uid(), seq: this.takeSeq(), frame: frame.id, mark: undefined });
        } else {
          addedImages.push({ ...item.image, id: uid(), seq: this.takeSeq(), frame: frame.id, el: item.image.el });
        }
      }
      this.put(added, true);
      this.appendImages(addedImages);
    }
    this.activeFrame = frame.id;
    this.push({ type: 'frame-add', index, frame, added, addedImages });
    return frame;
  }

  removeFrame(id: string): boolean {
    if (this.frames.length <= 1) return false;
    const index = this.frames.findIndex((f) => f.id === id);
    if (index < 0) return false;
    const frame = this.frames[index];
    this.frames.splice(index, 1);
    const strokes = this.take(this.frameStrokes(id));
    const removedImages = this.extractImages((im) => im.frame === id).map((r) => r.image);
    if (this.activeFrame === id) {
      this.activeFrame = this.frames[Math.min(index, this.frames.length - 1)].id;
    }
    this.push({ type: 'frame-remove', index, frame, strokes, removedImages });
    return true;
  }

  moveFrame(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.frames.length || to >= this.frames.length) {
      return;
    }
    this.applyFrameMove(from, to);
    this.push({ type: 'frame-order', from, to });
  }

  private applyFrameMove(from: number, to: number): void {
    const [frame] = this.frames.splice(from, 1);
    this.frames.splice(to, 0, frame);
  }

  setFps(fps: number): void {
    const v = Math.round(Math.min(MAX_FPS, Math.max(MIN_FPS, fps)));
    if (!Number.isFinite(v) || v === this.fps) return;
    this.fps = v;
    this.changed();
  }

  setOnion(patch: Partial<Onion>): void {
    this.onion = { ...this.onion, ...patch };
    this.onion.before = Math.min(3, Math.max(0, Math.round(this.onion.before)));
    this.onion.after = Math.min(3, Math.max(0, Math.round(this.onion.after)));
    this.onion.opacity = Math.min(1, Math.max(0.02, this.onion.opacity));
    this.changed();
  }

  // Opacity and visibility are view switches rather than edits: they redraw and
  // autosave, but they do not land on the undo stack (nor clear the redo one).
  setLayerOpacity(id: string, opacity: number): void {
    const layer = this.layer(id);
    if (!layer) return;
    layer.opacity = Math.min(1, Math.max(0, opacity));
    this.changed();
  }

  setLayerVisible(id: string, visible: boolean): void {
    const layer = this.layer(id);
    if (!layer || layer.visible === visible) return;
    layer.visible = visible;
    this.changed();
  }

  renameLayer(id: string, name: string): void {
    const layer = this.layer(id);
    const trimmed = name.trim();
    if (!layer || !trimmed || layer.name === trimmed) return;
    layer.name = trimmed.slice(0, 40);
    this.changed();
  }

  // Removes strokes by id; a single gesture's erasures collapse into one undo step.
  removeStrokes(ids: Set<string>): void {
    if (ids.size === 0) return;
    const strokes = this.takeIds(ids);
    if (strokes.length === 0) return;
    this.push({ type: 'remove', strokes });
  }

  // Replaces one or more strokes with clipped fragments, optionally alongside
  // pixel edits to pictures the same gesture touched. Keeping all of it one
  // operation is what makes an entire area-eraser pass undo in one step.
  // Image edits arrive already painted — the gesture drew straight onto each
  // picture's working canvas — so only the source strings still have to move.
  replaceStrokes(changes: StrokeReplacement[], imageChanges: ImageSrcChange[] = []): void {
    if (changes.length === 0 && imageChanges.length === 0) return;
    this.applyReplacements(changes, true);
    for (const change of imageChanges) {
      const image = this.images.find((im) => im.id === change.id);
      if (image) image.src = change.to;
    }
    this.push({ type: 'replace', changes, imageChanges });
  }

  // What comes off is found by id, not by object: a move made since this edit
  // swapped in a copy under the same id, and undoing that move made another.
  private applyReplacements(changes: StrokeReplacement[], forward: boolean): void {
    this.batch(() => {
      for (const change of changes) {
        const off = forward ? [change.before] : change.after;
        const on = forward ? change.after : [change.before];
        for (const s of off) {
          const held = this.all.get(s.id);
          if (held) this.detach(held);
        }
        for (const s of on) this.attach(s, false);
      }
    });
  }

  // Clears the current frame only — wiping every frame at once is not something
  // a single menu item should be able to do to an animation.
  clear(): void {
    const frame = this.activeFrame;
    const strokes = this.take(this.frameStrokes(frame));
    const images = this.extractImages((im) => im.frame === frame);
    if (strokes.length === 0 && images.length === 0) return;
    this.push({ type: 'clear', strokes, images });
  }

  // Rescales the whole world around the origin, e.g. to rebase the current
  // zoom level as the new 100%. Only strokes currently on the board are
  // touched; strokes held inside older undo ops stay in their era's scale,
  // which is consistent because ops are only ever replayed in stack order.
  scaleAll(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
    this.applyScale(factor);
    this.push({ type: 'scale', factor });
  }

  // Translates a selection. Each stroke is swapped for a moved copy; its
  // points are relative to its own origin, so the copy shares them, and its
  // outline too.
  moveItems(strokeIds: Set<string>, imageIds: Set<string>, dx: number, dy: number): void {
    if ((strokeIds.size === 0 && imageIds.size === 0) || (dx === 0 && dy === 0)) return;
    const ids = [...strokeIds];
    const images = [...imageIds];
    this.applyMove(ids, images, dx, dy);
    this.push({ type: 'move', ids, images, dx, dy });
  }

  private applyMove(ids: string[], imageIds: string[], dx: number, dy: number): void {
    const pictures = new Set(imageIds);
    this.batch(() => {
      for (const im of this.images) {
        if (!pictures.has(im.id)) continue;
        const before = imageBBox(im);
        im.x += dx;
        im.y += dy;
        this.imageChanged(im, before);
      }
      for (const id of ids) {
        const s = this.all.get(id);
        if (!s) continue;
        this.detach(s);
        this.attach(movedStroke(s, dx, dy), false);
      }
    });
  }

  private applyScale(f: number): void {
    for (const im of this.images) {
      im.x *= f;
      im.y *= f;
      im.width *= f;
      im.height *= f;
    }
    const scaled = new Map<string, Stroke>();
    for (const s of this.all.values()) scaled.set(s.id, scaledStroke(s, f));
    this.all = scaled;
    this.reindex();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): Op | undefined {
    const op = this.undoStack.pop();
    if (!op) return undefined;
    if (op.type === 'add') {
      this.takeIds([op.stroke.id]);
    } else if (op.type === 'add-many') {
      this.takeIds(op.strokes.map((s) => s.id));
    } else if (op.type === 'add-items') {
      const pics = new Set(op.images.map((image) => image.id));
      this.takeIds(op.strokes.map((s) => s.id));
      if (pics.size) this.extractImages((image) => pics.has(image.id));
    } else if (op.type === 'remove-items') {
      this.put(op.strokes, false);
      this.restoreImages(op.images);
    } else if (op.type === 'remove') {
      this.put(op.strokes, false);
    } else if (op.type === 'replace') {
      this.applyReplacements(op.changes, false);
      for (const change of op.imageChanges ?? []) this.applyImageSrcById(change.id, change.from);
    } else if (op.type === 'clear') {
      this.put(op.strokes, false);
      this.restoreImages(op.images);
    } else if (op.type === 'move') {
      this.applyMove(op.ids, op.images, -op.dx, -op.dy);
    } else if (op.type === 'image-add') {
      this.extractImages((im) => im.id === op.image.id);
    } else if (op.type === 'image-remove') {
      this.restoreImages(op.removed);
    } else if (op.type === 'transform') {
      this.applyReplacements(op.changes, false);
      for (const r of op.images) this.applyRectById(r.id, r.from);
    } else if (op.type === 'image-src') {
      this.applyImageSrcById(op.id, op.from);
    } else if (op.type === 'layer-add') {
      this.layers.splice(op.index, 1);
      if (this.activeLayer === op.layer.id) {
        this.activeLayer = this.layers[Math.min(op.index, this.layers.length - 1)].id;
      }
    } else if (op.type === 'layer-remove') {
      this.layers.splice(op.index, 0, op.layer);
      this.put(op.strokes, false);
      this.appendImages(op.removedImages);
      this.activeLayer = op.layer.id;
    } else if (op.type === 'layer-order') {
      this.applyLayerMove(op.to, op.from);
    } else if (op.type === 'frame-add') {
      const pics = new Set(op.addedImages.map((im) => im.id));
      this.frames.splice(op.index, 1);
      this.takeIds(op.added.map((s) => s.id));
      if (pics.size) this.extractImages((im) => pics.has(im.id));
      if (this.activeFrame === op.frame.id) {
        this.activeFrame = this.frames[Math.min(op.index, this.frames.length - 1)].id;
      }
    } else if (op.type === 'frame-remove') {
      this.frames.splice(op.index, 0, op.frame);
      this.put(op.strokes, false);
      this.appendImages(op.removedImages);
      this.activeFrame = op.frame.id;
    } else if (op.type === 'frame-order') {
      this.applyFrameMove(op.to, op.from);
    } else {
      this.applyScale(1 / op.factor);
    }
    this.redoStack.push(op);
    this.changed();
    return op;
  }

  redo(): Op | undefined {
    const op = this.redoStack.pop();
    if (!op) return undefined;
    if (op.type === 'add') {
      this.put([op.stroke], true);
    } else if (op.type === 'add-many') {
      this.put(op.strokes, true);
    } else if (op.type === 'add-items') {
      this.put(op.strokes, true);
      this.appendImages(op.images);
    } else if (op.type === 'remove-items') {
      const pics = new Set(op.images.map(({ image }) => image.id));
      this.takeIds(op.strokes.map((s) => s.id));
      if (pics.size) this.extractImages((image) => pics.has(image.id));
    } else if (op.type === 'remove') {
      this.takeIds(op.strokes.map((s) => s.id));
    } else if (op.type === 'replace') {
      this.applyReplacements(op.changes, true);
      for (const change of op.imageChanges ?? []) this.applyImageSrcById(change.id, change.to);
    } else if (op.type === 'clear') {
      const imageIds = new Set(op.images.map(({ image }) => image.id));
      this.takeIds(op.strokes.map((s) => s.id));
      this.extractImages((im) => imageIds.has(im.id));
    } else if (op.type === 'move') {
      this.applyMove(op.ids, op.images, op.dx, op.dy);
    } else if (op.type === 'image-add') {
      this.appendImages([op.image]);
    } else if (op.type === 'image-remove') {
      const gone = new Set(op.removed.map((r) => r.image.id));
      this.extractImages((im) => gone.has(im.id));
    } else if (op.type === 'transform') {
      this.applyReplacements(op.changes, true);
      for (const r of op.images) this.applyRectById(r.id, r.to);
    } else if (op.type === 'image-src') {
      this.applyImageSrcById(op.id, op.to);
    } else if (op.type === 'layer-add') {
      this.layers.splice(op.index, 0, op.layer);
      this.activeLayer = op.layer.id;
    } else if (op.type === 'layer-remove') {
      const pics = new Set(op.removedImages.map((im) => im.id));
      this.layers.splice(op.index, 1);
      this.takeIds(op.strokes.map((s) => s.id));
      this.extractImages((im) => pics.has(im.id));
      if (this.activeLayer === op.layer.id) {
        this.activeLayer = this.layers[Math.min(op.index, this.layers.length - 1)].id;
      }
    } else if (op.type === 'layer-order') {
      this.applyLayerMove(op.from, op.to);
    } else if (op.type === 'frame-add') {
      this.frames.splice(op.index, 0, op.frame);
      this.put(op.added, true);
      this.appendImages(op.addedImages);
      this.activeFrame = op.frame.id;
    } else if (op.type === 'frame-remove') {
      const pics = new Set(op.removedImages.map((im) => im.id));
      this.frames.splice(op.index, 1);
      this.takeIds(op.strokes.map((s) => s.id));
      this.extractImages((im) => pics.has(im.id));
      if (this.activeFrame === op.frame.id) {
        this.activeFrame = this.frames[Math.min(op.index, this.frames.length - 1)].id;
      }
    } else if (op.type === 'frame-order') {
      this.applyFrameMove(op.from, op.to);
    } else {
      this.applyScale(op.factor);
    }
    this.undoStack.push(op);
    this.changed();
    return op;
  }

  // The bounds of everything visible across the whole timeline. An animation
  // export renders every frame into one fixed canvas, so the box has to cover
  // all of them — measuring each frame on its own would make the drawing jump
  // between frames as its own content grew and shrank.
  animationBBox(): BBox | null {
    let box: BBox | null = null;
    for (const frame of this.frames) {
      const b = this.contentBBox(this.visibleStrokes(frame.id), this.visibleImages(frame.id));
      if (!b) continue;
      if (!box) {
        box = b;
        continue;
      }
      growBBox(box, b.minX, b.minY, 0);
      growBBox(box, b.maxX, b.maxY, 0);
    }
    return box;
  }

  contentBBox(strokes: Iterable<Stroke> = this.all.values(), images: BoardImage[] = []): BBox | null {
    const b = emptyBBox();
    let any = false;
    for (const s of strokes) {
      any = true;
      growBBox(b, s.bbox.minX, s.bbox.minY, 0);
      growBBox(b, s.bbox.maxX, s.bbox.maxY, 0);
    }
    for (const im of images) {
      any = true;
      growBBox(b, im.x, im.y, 0);
      growBBox(b, im.x + im.width, im.y + im.height, 0);
    }
    return any ? b : null;
  }

  // ---- loading ----------------------------------------------------------------

  // Replaces the board's contents. Returns the saved camera, if any.
  load(snap: BoardSnapshot): Camera | null {
    this.all = new Map();
    for (const s of snap.strokes) this.all.set(s.id, s);
    this.images = snap.images;
    for (const image of this.images) this.hydrate(image);
    this.nextSeq = snap.nextSeq;
    this.layers = snap.layers;
    this.activeLayer = snap.activeLayer;
    this.frames = snap.frames;
    this.activeFrame = snap.activeFrame;
    this.fps = snap.fps;
    this.onion = snap.onion;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.reindex();
    this.changed();
    return snap.camera;
  }

  // Replaces board contents from JSON text. Returns the saved camera, if any.
  // Throws on bad input.
  deserialize(json: string): Camera | null {
    return this.load(parseBoardJSON(json));
  }
}
