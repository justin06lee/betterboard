import { buildPath, hashSeed } from './ink';
import type { BBox, BrushId, Camera, Frame, Layer, Onion, Stroke } from './types';
import { MAX_FPS, MIN_FPS, defaultOnion, emptyBBox, growBBox, isBrush, newFrame, newLayer, uid } from './types';

export type Op =
  | { type: 'add'; stroke: Stroke }
  | { type: 'remove'; removed: { index: number; stroke: Stroke }[] }
  | { type: 'scale'; factor: number }
  | { type: 'move'; ids: string[]; dx: number; dy: number }
  | { type: 'layer-add'; index: number; layer: Layer }
  | { type: 'layer-remove'; index: number; layer: Layer; removed: { index: number; stroke: Stroke }[] }
  | { type: 'layer-order'; from: number; to: number }
  | { type: 'frame-add'; index: number; frame: Frame; added: Stroke[] }
  | { type: 'frame-remove'; index: number; frame: Frame; removed: { index: number; stroke: Stroke }[] }
  | { type: 'frame-order'; from: number; to: number };

const MAX_UNDO = 500;

export class Board {
  // Flat, in draw order within a layer; cross-layer order comes from `layers`,
  // so a stroke never has to move in this array when layers are reordered.
  strokes: Stroke[] = [];
  layers: Layer[] = [newLayer('Layer 1')];
  activeLayer: string = this.layers[0].id;
  frames: Frame[] = [newFrame()];
  activeFrame: string = this.frames[0].id;
  fps = 12;
  onion: Onion = defaultOnion();
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  onChange: (() => void) | null = null;

  private changed(): void {
    this.onChange?.();
  }

  private push(op: Op): void {
    this.undoStack.push(op);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack.length = 0;
    this.changed();
  }

  addStroke(stroke: Stroke): void {
    this.strokes.push(stroke);
    this.push({ type: 'add', stroke });
  }

  // ---- layers -------------------------------------------------------------

  layer(id: string): Layer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  get active(): Layer {
    return this.layer(this.activeLayer) ?? this.layers[this.layers.length - 1];
  }

  frameStrokes(frame: string = this.activeFrame): Stroke[] {
    return this.strokes.filter((s) => s.frame === frame);
  }

  visibleStrokes(frame: string = this.activeFrame): Stroke[] {
    const hidden = new Set(this.layers.filter((l) => !l.visible).map((l) => l.id));
    return this.strokes.filter((s) => s.frame === frame && !hidden.has(s.layer));
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
    const removed: { index: number; stroke: Stroke }[] = [];
    for (let i = 0; i < this.strokes.length; i++) {
      if (this.strokes[i].layer === id) removed.push({ index: i, stroke: this.strokes[i] });
    }
    this.layers.splice(index, 1);
    this.strokes = this.strokes.filter((s) => s.layer !== id);
    if (this.activeLayer === id) {
      this.activeLayer = this.layers[Math.min(index, this.layers.length - 1)].id;
    }
    this.push({ type: 'layer-remove', index, layer, removed });
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
  // right. Duplicating copies the current frame's strokes onto it.
  addFrame(duplicate = false): Frame {
    const frame = newFrame();
    const index = this.frameIndex + 1;
    this.frames.splice(index, 0, frame);
    const added: Stroke[] = [];
    if (duplicate) {
      for (const s of this.frameStrokes()) {
        const copy: Stroke = {
          ...s,
          id: uid(),
          frame: frame.id,
          points: s.points.map((pt) => ({ ...pt })),
          bbox: { ...s.bbox },
        };
        copy.path = buildPath(copy);
        added.push(copy);
      }
      this.strokes.push(...added);
    }
    this.activeFrame = frame.id;
    this.push({ type: 'frame-add', index, frame, added });
    return frame;
  }

  removeFrame(id: string): boolean {
    if (this.frames.length <= 1) return false;
    const index = this.frames.findIndex((f) => f.id === id);
    if (index < 0) return false;
    const frame = this.frames[index];
    const removed: { index: number; stroke: Stroke }[] = [];
    for (let i = 0; i < this.strokes.length; i++) {
      if (this.strokes[i].frame === id) removed.push({ index: i, stroke: this.strokes[i] });
    }
    this.frames.splice(index, 1);
    this.strokes = this.strokes.filter((s) => s.frame !== id);
    if (this.activeFrame === id) {
      this.activeFrame = this.frames[Math.min(index, this.frames.length - 1)].id;
    }
    this.push({ type: 'frame-remove', index, frame, removed });
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
    const removed: { index: number; stroke: Stroke }[] = [];
    for (let i = 0; i < this.strokes.length; i++) {
      if (ids.has(this.strokes[i].id)) removed.push({ index: i, stroke: this.strokes[i] });
    }
    if (removed.length === 0) return;
    this.strokes = this.strokes.filter((s) => !ids.has(s.id));
    this.push({ type: 'remove', removed });
  }

  // Clears the current frame only — wiping every frame at once is not something
  // a single menu item should be able to do to an animation.
  clear(): void {
    this.removeStrokes(new Set(this.frameStrokes().map((s) => s.id)));
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

  // Translates a selection. The cached outline is reused under a translation
  // matrix rather than rebuilt, so dragging stays cheap on large selections.
  moveStrokes(ids: Set<string>, dx: number, dy: number): void {
    if (ids.size === 0 || (dx === 0 && dy === 0)) return;
    const list = [...ids];
    this.applyMove(list, dx, dy);
    this.push({ type: 'move', ids: list, dx, dy });
  }

  private applyMove(ids: string[], dx: number, dy: number): void {
    const set = new Set(ids);
    for (const s of this.strokes) {
      if (!set.has(s.id)) continue;
      for (const pt of s.points) {
        pt.x += dx;
        pt.y += dy;
      }
      s.bbox = {
        minX: s.bbox.minX + dx,
        minY: s.bbox.minY + dy,
        maxX: s.bbox.maxX + dx,
        maxY: s.bbox.maxY + dy,
      };
      if (s.path) {
        const moved = new Path2D();
        moved.addPath(s.path, new DOMMatrix().translate(dx, dy));
        s.path = moved;
      }
    }
  }

  private applyScale(f: number): void {
    for (const s of this.strokes) {
      for (const pt of s.points) {
        pt.x *= f;
        pt.y *= f;
      }
      s.size *= f;
      const b = emptyBBox();
      for (const pt of s.points) growBBox(b, pt.x, pt.y, s.size / 2 + 2);
      s.bbox = b;
      s.path = buildPath(s);
    }
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
      this.strokes = this.strokes.filter((s) => s.id !== op.stroke.id);
    } else if (op.type === 'remove') {
      for (const { index, stroke } of op.removed) {
        this.strokes.splice(Math.min(index, this.strokes.length), 0, stroke);
      }
    } else if (op.type === 'move') {
      this.applyMove(op.ids, -op.dx, -op.dy);
    } else if (op.type === 'layer-add') {
      this.layers.splice(op.index, 1);
      if (this.activeLayer === op.layer.id) {
        this.activeLayer = this.layers[Math.min(op.index, this.layers.length - 1)].id;
      }
    } else if (op.type === 'layer-remove') {
      this.layers.splice(op.index, 0, op.layer);
      for (const { index, stroke } of op.removed) {
        this.strokes.splice(Math.min(index, this.strokes.length), 0, stroke);
      }
      this.activeLayer = op.layer.id;
    } else if (op.type === 'layer-order') {
      this.applyLayerMove(op.to, op.from);
    } else if (op.type === 'frame-add') {
      const ids = new Set(op.added.map((s) => s.id));
      this.frames.splice(op.index, 1);
      if (ids.size) this.strokes = this.strokes.filter((s) => !ids.has(s.id));
      if (this.activeFrame === op.frame.id) {
        this.activeFrame = this.frames[Math.min(op.index, this.frames.length - 1)].id;
      }
    } else if (op.type === 'frame-remove') {
      this.frames.splice(op.index, 0, op.frame);
      for (const { index, stroke } of op.removed) {
        this.strokes.splice(Math.min(index, this.strokes.length), 0, stroke);
      }
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
      this.strokes.push(op.stroke);
    } else if (op.type === 'remove') {
      const ids = new Set(op.removed.map((r) => r.stroke.id));
      this.strokes = this.strokes.filter((s) => !ids.has(s.id));
    } else if (op.type === 'move') {
      this.applyMove(op.ids, op.dx, op.dy);
    } else if (op.type === 'layer-add') {
      this.layers.splice(op.index, 0, op.layer);
      this.activeLayer = op.layer.id;
    } else if (op.type === 'layer-remove') {
      const ids = new Set(op.removed.map((r) => r.stroke.id));
      this.layers.splice(op.index, 1);
      this.strokes = this.strokes.filter((s) => !ids.has(s.id));
      if (this.activeLayer === op.layer.id) {
        this.activeLayer = this.layers[Math.min(op.index, this.layers.length - 1)].id;
      }
    } else if (op.type === 'layer-order') {
      this.applyLayerMove(op.from, op.to);
    } else if (op.type === 'frame-add') {
      this.frames.splice(op.index, 0, op.frame);
      if (op.added.length) this.strokes.push(...op.added);
      this.activeFrame = op.frame.id;
    } else if (op.type === 'frame-remove') {
      const ids = new Set(op.removed.map((r) => r.stroke.id));
      this.frames.splice(op.index, 1);
      this.strokes = this.strokes.filter((s) => !ids.has(s.id));
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

  contentBBox(strokes: Stroke[] = this.strokes): BBox | null {
    if (strokes.length === 0) return null;
    const b = emptyBBox();
    for (const s of strokes) {
      growBBox(b, s.bbox.minX, s.bbox.minY, 0);
      growBBox(b, s.bbox.maxX, s.bbox.maxY, 0);
    }
    return b;
  }

  serialize(camera: Camera): string {
    return JSON.stringify({
      app: 'betterboard',
      version: 4,
      camera,
      layers: this.layers,
      activeLayer: this.activeLayer,
      frames: this.frames,
      activeFrame: this.activeFrame,
      fps: this.fps,
      onion: this.onion,
      strokes: this.strokes.map((s) => ({
        id: s.id,
        color: s.color,
        size: s.size,
        pen: s.pen,
        brush: s.brush,
        seed: s.seed,
        layer: s.layer,
        frame: s.frame,
        points: s.points.map((pt) => [
          Math.round(pt.x * 10000) / 10000,
          Math.round(pt.y * 10000) / 10000,
          Math.round(pt.p * 1000) / 1000,
        ]),
      })),
    });
  }

  // Replaces board contents. Returns the saved camera, if any. Throws on bad input.
  deserialize(json: string): Camera | null {
    const data = JSON.parse(json);
    if (data?.app !== 'betterboard' || !Array.isArray(data.strokes)) {
      throw new Error('not a betterboard file');
    }
    // Version 1 files predate layers: everything they hold becomes one layer.
    const layers: Layer[] = [];
    for (const raw of Array.isArray(data.layers) ? data.layers : []) {
      const id = String(raw?.id ?? '');
      if (!id || layers.some((l) => l.id === id)) continue;
      layers.push({
        id,
        name: String(raw.name ?? 'Layer').slice(0, 40) || 'Layer',
        opacity: Number.isFinite(raw.opacity) ? Math.min(1, Math.max(0, raw.opacity)) : 1,
        visible: raw.visible !== false,
      });
    }
    if (layers.length === 0) layers.push(newLayer('Layer 1'));
    const known = new Set(layers.map((l) => l.id));
    const fallback = layers[0].id;

    // Versions 1 and 2 predate animation: their whole board is frame one.
    const frames: Frame[] = [];
    for (const raw of Array.isArray(data.frames) ? data.frames : []) {
      const id = String(raw?.id ?? '');
      if (id && !frames.some((f) => f.id === id)) frames.push({ id });
    }
    if (frames.length === 0) frames.push(newFrame());
    const knownFrames = new Set(frames.map((f) => f.id));
    const frameFallback = frames[0].id;

    const strokes: Stroke[] = [];
    for (const raw of data.strokes) {
      const points = (raw.points as [number, number, number][]).map(([x, y, p]) => ({ x, y, p }));
      if (points.length === 0) continue;
      const size = Number(raw.size) || 6;
      const bbox = emptyBBox();
      for (const pt of points) growBBox(bbox, pt.x, pt.y, size / 2 + 1);
      const layer = String(raw.layer ?? '');
      const frame = String(raw.frame ?? '');
      const stroke: Stroke = {
        id: String(raw.id ?? Math.random().toString(36).slice(2)),
        color: String(raw.color ?? '#e8eaed'),
        size,
        pen: Boolean(raw.pen),
        brush: isBrush(raw.brush) ? (raw.brush as BrushId) : 'pen', // pre-brush files are all pen
        seed: Number.isFinite(raw.seed) ? raw.seed >>> 0 : hashSeed(String(raw.id ?? '')),
        layer: known.has(layer) ? layer : fallback,
        frame: knownFrames.has(frame) ? frame : frameFallback,
        points,
        bbox,
      };
      stroke.path = buildPath(stroke);
      strokes.push(stroke);
    }
    this.strokes = strokes;
    this.layers = layers;
    this.activeLayer = known.has(String(data.activeLayer)) ? String(data.activeLayer) : layers[layers.length - 1].id;
    this.frames = frames;
    this.activeFrame = knownFrames.has(String(data.activeFrame)) ? String(data.activeFrame) : frames[0].id;
    this.fps = Number.isFinite(data.fps)
      ? Math.round(Math.min(MAX_FPS, Math.max(MIN_FPS, data.fps)))
      : 12;
    this.onion = { ...defaultOnion(), ...(data.onion && typeof data.onion === 'object' ? data.onion : {}) };
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.changed();
    const c = data.camera;
    if (c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.scale) && c.scale > 0) {
      return {
        x: c.x,
        y: c.y,
        scale: c.scale,
        rotation: Number.isFinite(c.rotation) ? c.rotation : 0,
      };
    }
    return null;
  }
}
