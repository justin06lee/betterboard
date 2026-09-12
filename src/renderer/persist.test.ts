import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Manifest, StoreApi } from './persist';
import { Autosave } from './persist';
import { makeStroke, unpackPoints } from './points';
import { Board } from './store';
import type { BoardImage, Camera, Stroke } from './types';

class TestPath2D {
  moveTo(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
  arc(): void {}
  rect(): void {}
  addPath(): void {}
}

class TestImage {
  onload: (() => void) | null = null;
  src = '';
}

Object.assign(globalThis, { Path2D: TestPath2D, Image: TestImage });

// A failed save is logged; the tests that fail one on purpose keep it quiet.
const quietError = console.error;
beforeAll(() => {
  console.error = () => {};
});
afterAll(() => {
  console.error = quietError;
});

// The main process's side of the store, in memory: files by name, and a
// manifest that only ever changes when a save commits — as on disk.
function disk(legacy?: string) {
  const files = new Map<string, Uint8Array | string>();
  let manifest: string | null = null;
  const puts: string[] = [];
  let failAt = -1;
  const api: StoreApi = {
    storeLoad: async () => ({ manifest, legacy: legacy !== undefined }),
    storeRead: async (name) => files.get(name) as Uint8Array,
    storeReadText: async (name) => files.get(name) as string,
    storePut: async (name, data) => {
      if (failAt === 0) {
        failAt = -1;
        throw new Error('disk full');
      }
      if (failAt > 0) failAt--;
      puts.push(name);
      files.set(name, typeof data === 'string' ? data : data.slice());
    },
    storeCommit: async (m) => {
      const next = m as Manifest;
      manifest = JSON.stringify(next);
      const keep = new Set([...Object.values(next.files), ...next.images.map((im) => `i-${im.key}.txt`)]);
      for (const name of [...files.keys()]) if (!keep.has(name)) files.delete(name);
    },
    storeQuarantine: async () => {
      manifest = null;
      files.clear();
    },
    fileReadBegin: async () => (legacy === undefined ? null : { token: 1, size: legacy.length, name: 'autosave.json' }),
    fileRead: async () => {
      if (legacy === undefined || legacy === '') return null;
      const bytes = new TextEncoder().encode(legacy);
      legacy = '';
      return bytes;
    },
    fileReadEnd: async () => {},
  };
  return {
    api,
    files,
    puts,
    manifest: () => (manifest ? (JSON.parse(manifest) as Manifest) : null),
    failPut: (after = 0) => {
      failAt = after;
    },
  };
}

const camera: Camera = { x: 12, y: -34, scale: 1.5, rotation: 0.25 };

function line(id: string, seq: number, board: Board, at: number, points = 4, layer = board.activeLayer): Stroke {
  return makeStroke(
    { id, seq, color: '#ef476f', size: 3, pen: true, brush: 'pen', seed: seq, layer, frame: board.activeFrame },
    Array.from({ length: points }, (_, k) => ({ x: at + k * 1.5, y: at * 0.5 + k, p: 0.5 }))
  );
}

function fill(board: Board, count: number, points = 4): void {
  const strokes = Array.from({ length: count }, (_, i) => line(`s${i}`, i, board, i * 7, points));
  board.load({
    camera: null,
    layers: board.layers,
    activeLayer: board.activeLayer,
    frames: board.frames,
    activeFrame: board.activeFrame,
    fps: board.fps,
    onion: board.onion,
    strokes,
    images: [],
    nextSeq: count,
  });
}

const plain = (s: Stroke) => ({ id: s.id, seq: s.seq, color: s.color, size: s.size, layer: s.layer, frame: s.frame, points: unpackPoints(s) });
const byId = (board: Board) => board.strokes.map(plain).sort((a, b) => (a.id < b.id ? -1 : 1));

describe('the autosave', () => {
  test('reads back exactly the board it wrote', async () => {
    const d = disk();
    const board = new Board();
    const second = board.addLayer().id;
    fill(board, 300);
    board.addStroke(line('top', board.takeSeq(), board, 5, 6, second));
    const picture: BoardImage = { id: 'pic', seq: board.takeSeq(), src: 'data:image/png;base64,AAAA', x: 3, y: 4, width: 50, height: 25, layer: second, frame: board.activeFrame };
    board.addImage(picture);
    await new Autosave(board, () => camera, d.api).flush();

    const restored = new Board();
    const cam = await new Autosave(restored, () => camera, d.api).load();
    expect(cam).toEqual(camera);
    expect(byId(restored)).toEqual(byId(board));
    expect(restored.images.map(({ el: _el, ...im }) => im)).toEqual([picture]);
    expect(restored.layers).toEqual(board.layers);
    expect(restored.activeLayer).toBe(board.activeLayer);
    expect(restored.peekSeq()).toBe(board.peekSeq());
  });

  test('an edit rewrites only the bucket holding what it touched', async () => {
    const d = disk();
    const board = new Board();
    fill(board, 400, 4000); // 1.6 million points: sixteen buckets
    const save = new Autosave(board, () => camera, d.api);
    await save.flush();
    expect(d.manifest()!.buckets).toBe(16);
    expect(d.puts).toHaveLength(16);

    d.puts.length = 0;
    board.addStroke(line('fresh', 5000, board, 1));
    await save.flush();
    expect(d.puts).toHaveLength(1);

    d.puts.length = 0;
    board.removeStrokes(new Set(['s7']));
    await save.flush();
    expect(d.puts).toHaveLength(1);

    d.puts.length = 0;
    await save.flush(); // nothing changed: the manifest alone
    expect(d.puts).toHaveLength(0);

    const restored = new Board();
    await new Autosave(restored, () => camera, d.api).load();
    expect(byId(restored)).toEqual(byId(board));
  });

  test('a save that fails is tried again by the next one', async () => {
    const d = disk();
    const board = new Board();
    fill(board, 50);
    const save = new Autosave(board, () => camera, d.api);
    await save.flush();

    board.addStroke(line('late', 500, board, 2));
    d.failPut();
    await save.flush();
    expect(d.manifest()!.generation).toBe(1);

    await save.flush();
    const restored = new Board();
    await new Autosave(restored, () => camera, d.api).load();
    expect(restored.stroke('late')).toBeDefined();
  });

  test('a save that dies part way leaves the last good one whole', async () => {
    const d = disk();
    const board = new Board();
    fill(board, 400, 4000);
    const save = new Autosave(board, () => camera, d.api);
    await save.flush();
    const good = byId(board);

    board.scaleAll(2); // every stroke changes: a full rewrite
    d.failPut(5);
    await save.flush();

    const restored = new Board();
    await new Autosave(restored, () => camera, d.api).load();
    expect(byId(restored)).toEqual(good);
  });

  test('a board just read back has nothing to write', async () => {
    const d = disk();
    const board = new Board();
    fill(board, 400, 4000);
    await new Autosave(board, () => camera, d.api).flush();

    d.puts.length = 0;
    const restored = new Board();
    const save = new Autosave(restored, () => camera, d.api);
    await save.load();
    await save.flush();
    expect(d.puts).toHaveLength(0);
  });

  test('carries the old single-file autosave into the store', async () => {
    const legacy = JSON.stringify({
      app: 'betterboard',
      version: 5,
      camera,
      layers: [{ id: 'L', name: 'Layer 1', opacity: 1, visible: true }],
      frames: [{ id: 'F' }],
      images: [],
      strokes: [
        { id: 'a', seq: 0, color: '#fff', size: 3, pen: true, brush: 'pen', seed: 1, layer: 'L', frame: 'F', points: [[1, 2, 0.5], [3, 4, 0.5]] },
      ],
    });
    const d = disk(legacy);
    const board = new Board();
    const save = new Autosave(board, () => camera, d.api);
    expect(await save.load()).toEqual(camera);
    expect(board.stroke('a')).toBeDefined();
    await save.flush();
    expect(d.manifest()).not.toBeNull();

    const restored = new Board();
    await new Autosave(restored, () => camera, disk().api).load(); // a different, empty disk
    expect(restored.strokeCount).toBe(0);
  });
});
