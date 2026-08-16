import { buildPath } from './ink';
import type { BBox, Camera, Stroke } from './types';
import { emptyBBox, growBBox } from './types';

type Op =
  | { type: 'add'; stroke: Stroke }
  | { type: 'remove'; removed: { index: number; stroke: Stroke }[] }
  | { type: 'clear'; strokes: Stroke[] };

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

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const op = this.undoStack.pop();
    if (!op) return;
    if (op.type === 'add') {
      this.strokes = this.strokes.filter((s) => s.id !== op.stroke.id);
    } else if (op.type === 'remove') {
      for (const { index, stroke } of op.removed) {
        this.strokes.splice(Math.min(index, this.strokes.length), 0, stroke);
      }
    } else {
      this.strokes = op.strokes;
    }
    this.redoStack.push(op);
    this.changed();
  }

  redo(): void {
    const op = this.redoStack.pop();
    if (!op) return;
    if (op.type === 'add') {
      this.strokes.push(op.stroke);
    } else if (op.type === 'remove') {
      const ids = new Set(op.removed.map((r) => r.stroke.id));
      this.strokes = this.strokes.filter((s) => !ids.has(s.id));
    } else {
      this.strokes = [];
    }
    this.undoStack.push(op);
    this.changed();
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
          Math.round(pt.x * 100) / 100,
          Math.round(pt.y * 100) / 100,
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
      return { x: c.x, y: c.y, scale: c.scale };
    }
    return null;
  }
}
