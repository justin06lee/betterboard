import { describe, expect, test } from 'bun:test';
import { SpatialIndex } from './spatial';
import type { BBox } from './types';

interface Item {
  id: number;
  bbox: BBox;
  mark?: number;
}

function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Boxes from a pixel wide to a million units wide, scattered over a board a
// few million units across — the spread an infinite canvas actually sees.
function box(rand: () => number): BBox {
  const w = 10 ** (rand() * 6);
  const h = w * (0.2 + rand() * 2);
  const x = (rand() - 0.5) * 4e6;
  const y = (rand() - 0.5) * 4e6;
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}

const overlaps = (a: BBox, b: BBox) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

describe('SpatialIndex', () => {
  test('finds exactly what a full scan would, at every scale', () => {
    const rand = random(7);
    const index = new SpatialIndex<Item>();
    const items: Item[] = [];
    for (let id = 0; id < 3000; id++) {
      const item = { id, bbox: box(rand) };
      items.push(item);
      index.insert(item);
    }
    expect(index.size).toBe(3000);
    for (let q = 0; q < 300; q++) {
      const query = box(rand);
      const got = index.query(query).map((i) => i.id).sort((a, b) => a - b);
      const want = items.filter((i) => overlaps(i.bbox, query)).map((i) => i.id);
      expect(got).toEqual(want);
    }
  });

  test('reports an item that spans many cells once', () => {
    const index = new SpatialIndex<Item>();
    const wide = { id: 1, bbox: { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 } };
    index.insert(wide);
    expect(index.query({ minX: -6000, minY: -6000, maxX: 6000, maxY: 6000 })).toEqual([wide]);
  });

  test('removes what it is given, and only that', () => {
    const rand = random(11);
    const index = new SpatialIndex<Item>();
    const items = Array.from({ length: 500 }, (_, id) => ({ id, bbox: box(rand) }));
    for (const item of items) index.insert(item);
    for (const item of items.filter((i) => i.id % 2 === 0)) expect(index.remove(item)).toBe(true);
    expect(index.remove(items[0])).toBe(false);
    expect(index.size).toBe(250);
    const all = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };
    expect(index.query(all).map((i) => i.id).sort((a, b) => a - b)).toEqual(
      items.filter((i) => i.id % 2 === 1).map((i) => i.id)
    );
  });

  test('keeps anything without a usable box, and always reports it', () => {
    const index = new SpatialIndex<Item>();
    const broken = { id: 1, bbox: { minX: NaN, minY: 0, maxX: 1, maxY: 1 } };
    const empty = { id: 2, bbox: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity } };
    index.insert(broken);
    index.insert(empty);
    expect(index.query({ minX: 0, minY: 0, maxX: 1, maxY: 1 }).map((i) => i.id).sort()).toEqual([1, 2]);
    expect(index.remove(broken)).toBe(true);
    expect(index.size).toBe(1);
  });

  test('walks everything it holds exactly once', () => {
    const rand = random(3);
    const index = new SpatialIndex<Item>();
    for (let id = 0; id < 200; id++) index.insert({ id, bbox: box(rand) });
    expect(index.all().map((i) => i.id).sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });
});
