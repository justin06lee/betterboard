import type { BBox } from './types';

// Finds what overlaps a box without looking at everything. A flat grid breaks
// down on an infinite board — a stroke drawn zoomed right out can cross a
// thousand of the cells a tiny one sits in — so the grid is layered: each
// level's cells are twice the size of the one below, and an item lives on the
// level where it spans at most two cells each way. Inserting and removing touch
// four cells at most, and a query only visits the cells its box covers.

const BASE = 64; // world units along the side of a level-0 cell
const OFF = 2 ** 25; // cell coordinates are clamped to ±OFF…
const SPAN = 2 ** 26; // …so (x, y) packs into one number below 2^52
const MAX_LEVEL = 40;

export interface Spatial {
  bbox: BBox;
  mark?: number;
}

// Each query stamps what it has already seen, so an item sitting in several
// cells is reported once without a Set being built per query.
let stamp = 0;

function levelOf(b: BBox): number {
  const extent = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  if (!(extent > BASE)) return 0;
  return Math.min(MAX_LEVEL, Math.ceil(Math.log2(extent / BASE)));
}

function cellOf(v: number, side: number): number {
  const c = Math.floor(v / side);
  if (c !== c) return 0; // NaN
  return c < -OFF ? -OFF : c > OFF - 1 ? OFF - 1 : c;
}

function usable(b: BBox): boolean {
  return b.minX <= b.maxX && b.minY <= b.maxY && Number.isFinite(b.minX + b.minY + b.maxX + b.maxY);
}

function overlaps(a: BBox, b: BBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export class SpatialIndex<T extends Spatial> {
  private levels: (Map<number, T[]> | undefined)[] = [];
  // Anything without a usable box — a stroke with no points, or one whose
  // numbers came in broken from a file — is kept aside and always reported.
  private loose: T[] = [];
  size = 0;

  insert(item: T): void {
    this.size++;
    const b = item.bbox;
    if (!usable(b)) {
      this.loose.push(item);
      return;
    }
    const lvl = levelOf(b);
    const side = BASE * 2 ** lvl;
    let grid = this.levels[lvl];
    if (!grid) grid = this.levels[lvl] = new Map();
    const x1 = cellOf(b.maxX, side);
    const y1 = cellOf(b.maxY, side);
    for (let cx = cellOf(b.minX, side); cx <= x1; cx++) {
      for (let cy = cellOf(b.minY, side); cy <= y1; cy++) {
        const key = (cx + OFF) * SPAN + (cy + OFF);
        const list = grid.get(key);
        if (list) list.push(item);
        else grid.set(key, [item]);
      }
    }
  }

  // The item's bbox must be the one it was inserted with — which it always is,
  // since nothing indexed here is ever changed in place.
  remove(item: T): boolean {
    const b = item.bbox;
    if (!usable(b)) {
      const i = this.loose.lastIndexOf(item);
      if (i < 0) return false;
      this.loose[i] = this.loose[this.loose.length - 1];
      this.loose.pop();
      this.size--;
      return true;
    }
    const lvl = levelOf(b);
    const grid = this.levels[lvl];
    if (!grid) return false;
    const side = BASE * 2 ** lvl;
    let found = false;
    const x1 = cellOf(b.maxX, side);
    const y1 = cellOf(b.maxY, side);
    for (let cx = cellOf(b.minX, side); cx <= x1; cx++) {
      for (let cy = cellOf(b.minY, side); cy <= y1; cy++) {
        const key = (cx + OFF) * SPAN + (cy + OFF);
        const list = grid.get(key);
        if (!list) continue;
        const i = list.lastIndexOf(item);
        if (i < 0) continue;
        found = true;
        list[i] = list[list.length - 1];
        list.pop();
        if (list.length === 0) grid.delete(key);
      }
    }
    if (found) this.size--;
    return found;
  }

  // Everything whose bbox overlaps `box`, in no particular order.
  query(box: BBox, out: T[] = []): T[] {
    const s = ++stamp;
    for (const item of this.loose) {
      item.mark = s;
      out.push(item);
    }
    for (let lvl = 0; lvl < this.levels.length; lvl++) {
      const grid = this.levels[lvl];
      if (!grid || grid.size === 0) continue;
      const side = BASE * 2 ** lvl;
      const x0 = cellOf(box.minX, side);
      const y0 = cellOf(box.minY, side);
      const x1 = cellOf(box.maxX, side);
      const y1 = cellOf(box.maxY, side);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > grid.size) {
        // The box covers more cells than are occupied: walk the occupied ones.
        for (const [key, list] of grid) {
          const cx = Math.floor(key / SPAN) - OFF;
          const cy = key - (cx + OFF) * SPAN - OFF;
          if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
          collect(list, box, s, out);
        }
        continue;
      }
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const list = grid.get((cx + OFF) * SPAN + (cy + OFF));
          if (list) collect(list, box, s, out);
        }
      }
    }
    return out;
  }

  forEach(visit: (item: T) => void): void {
    const s = ++stamp;
    for (const item of this.loose) visit(item);
    for (const grid of this.levels) {
      if (!grid) continue;
      for (const list of grid.values()) {
        for (const item of list) {
          if (item.mark === s) continue;
          item.mark = s;
          visit(item);
        }
      }
    }
  }

  all(): T[] {
    const out: T[] = [];
    this.forEach((item) => out.push(item));
    return out;
  }
}

function collect<T extends Spatial>(list: T[], box: BBox, s: number, out: T[]): void {
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item.mark === s) continue;
    item.mark = s;
    if (overlaps(item.bbox, box)) out.push(item);
  }
}
