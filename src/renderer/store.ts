import { buildPath } from './ink';
import type { BBox, Camera, Stroke } from './types';
import { emptyBBox, growBBox } from './types';

export type Op =
  | { type: 'add'; stroke: Stroke }
  | { type: 'remove'; removed: { index: number; stroke: Stroke }[] }
  | { type: 'clear'; strokes: Stroke[] }
  | { type: 'scale'; factor: number }
  | { type: 'move'; ids: string[]; dx: number; dy: number };

const MAX_UNDO = 500;

export class Board {
  strokes: Stroke[] = [];
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

  clear(): void {
    if (this.strokes.length === 0) return;
    const strokes = this.strokes;
    this.strokes = [];
    this.push({ type: 'clear', strokes });
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
    } else if (op.type === 'clear') {
      this.strokes = op.strokes;
    } else if (op.type === 'move') {
      this.applyMove(op.ids, -op.dx, -op.dy);
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
    } else if (op.type === 'clear') {
      this.strokes = [];
    } else if (op.type === 'move') {
      this.applyMove(op.ids, op.dx, op.dy);
    } else {
      this.applyScale(op.factor);
    }
    this.undoStack.push(op);
    this.changed();
    return op;
  }

  contentBBox(): BBox | null {
    if (this.strokes.length === 0) return null;
    const b = emptyBBox();
    for (const s of this.strokes) {
      growBBox(b, s.bbox.minX, s.bbox.minY, 0);
      growBBox(b, s.bbox.maxX, s.bbox.maxY, 0);
    }
    return b;
  }

  serialize(camera: Camera): string {
    return JSON.stringify({
      app: 'betterboard',
      version: 1,
      camera,
      strokes: this.strokes.map((s) => ({
        id: s.id,
        color: s.color,
        size: s.size,
        pen: s.pen,
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
    const strokes: Stroke[] = [];
    for (const raw of data.strokes) {
      const points = (raw.points as [number, number, number][]).map(([x, y, p]) => ({ x, y, p }));
      if (points.length === 0) continue;
      const size = Number(raw.size) || 6;
      const bbox = emptyBBox();
      for (const pt of points) growBBox(bbox, pt.x, pt.y, size / 2 + 1);
      const stroke: Stroke = {
        id: String(raw.id ?? Math.random().toString(36).slice(2)),
        color: String(raw.color ?? '#e8eaed'),
        size,
        pen: Boolean(raw.pen),
        points,
        bbox,
      };
      stroke.path = buildPath(stroke);
      strokes.push(stroke);
    }
    this.strokes = strokes;
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
