import type { BoardSnapshot, StoreMeta } from './codec';
import { BoardReader, StoreLoader, boardFileLines, encodeStrokes } from './codec';
import { hashSeed } from './ink';
import type { Board } from './store';
import type { BoardImage, Camera, Stroke } from './types';

// The autosave. It lives in a folder the main process keeps: a manifest
// (layers, frames, the camera, where every picture sits), bucket files of
// packed strokes, and one file per distinct picture. Strokes are bucketed by
// a hash of their id, and the autosave keeps track of which strokes sit in
// which bucket as the board changes — so an edit rewrites only the buckets
// holding what it touched, and a save never looks at the rest of the board. A
// board of a million strokes saves an edit about as fast as an empty one,
// where writing it all out again would take seconds and gigabytes. A save
// writes its new files first and swaps the manifest over in a single rename,
// so a crash at any moment leaves the last good save whole.

const BUCKET_POINTS = 100_000; // about 1.2 MB of points per bucket file
const MAX_BUCKETS = 4096;
const READ_AHEAD = 6; // bucket files in flight while loading

interface ImageEntry {
  id: string;
  seq: number;
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: string;
  frame: string;
}

export interface Manifest {
  app: 'betterboard-autosave';
  version: 1;
  generation: number;
  buckets: number; // a power of two; a stroke's bucket is hash(id) & (buckets - 1)
  files: Record<string, string>;
  images: ImageEntry[];
  meta: StoreMeta;
}

// The part of the main process's API the autosave uses, so tests can stand
// in for the disk.
export interface StoreApi {
  storeLoad(): Promise<{ manifest: string | null; legacy: boolean }>;
  storeRead(name: string): Promise<Uint8Array>;
  storeReadText(name: string): Promise<string>;
  storePut(name: string, data: Uint8Array | string): Promise<void>;
  storeCommit(manifest: unknown): Promise<void>;
  storeQuarantine(): Promise<void>;
  fileReadBegin(kind: 'open' | 'legacy-autosave'): Promise<{ token: number; size: number; name: string } | null>;
  fileRead(token: number, max: number): Promise<Uint8Array | null>;
  fileReadEnd(token: number): Promise<void>;
}

function bucketsFor(points: number): number {
  let b = 1;
  while (b < MAX_BUCKETS && b * BUCKET_POINTS < points) b *= 2;
  return b;
}

// A picture's file is named for what is in it, so two copies of one
// screenshot are stored once and an unchanged picture is never written again.
const srcKeys = new WeakMap<BoardImage, { src: string; key: string }>();
function keyOf(im: BoardImage): string {
  const hit = srcKeys.get(im);
  if (hit && hit.src === im.src) return hit.key;
  const s = im.src;
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  const key = `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${s.length.toString(36)}`;
  srcKeys.set(im, { src: s, key });
  return key;
}

export class Autosave {
  private manifest: Manifest | null = null;
  private stored = new Set<string>(); // picture keys already on disk
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private queued = false;
  // Which strokes sit in which bucket, kept up to date as they come and go,
  // and which buckets have changed since the last save. `buckets` is 0 until a
  // layout has been chosen; `everything` asks the next save to write it all.
  private buckets = 0;
  private members: Set<Stroke>[] = [];
  private dirty = new Set<number>();
  private everything = true;
  private points = 0;

  constructor(
    private board: Board,
    private camera: () => Camera,
    private api: StoreApi = window.betterboard
  ) {
    board.onMembership = (s, added) => this.track(s, added);
    board.whenReset(() => this.forget());
    // Whatever is on the board already has never been written by this autosave.
    this.forget();
  }

  schedule(delay = 800): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delay);
  }

  // Saves now. A save already under way finishes first; the one queued behind
  // it picks up everything that changed meanwhile, and the promise settles
  // once that one is on disk.
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.queued) return this.chain;
    this.queued = true;
    this.chain = this.chain.then(async () => {
      this.queued = false;
      try {
        await this.save();
      } catch (err) {
        console.error('autosave failed:', err);
      }
    });
    return this.chain;
  }

  private track(s: Stroke, added: boolean): void {
    this.points += added ? s.n : -s.n;
    if (this.buckets === 0) return;
    const b = hashSeed(s.id) & (this.buckets - 1);
    if (added) this.members[b].add(s);
    else this.members[b].delete(s);
    this.dirty.add(b);
  }

  // The board was replaced wholesale: whatever is on disk no longer describes it.
  private forget(): void {
    this.buckets = 0;
    this.members = [];
    this.dirty.clear();
    this.everything = true;
    this.points = 0;
    for (const s of this.board.eachStroke()) this.points += s.n;
  }

  private layout(buckets: number): void {
    this.buckets = buckets;
    this.members = Array.from({ length: buckets }, () => new Set<Stroke>());
    for (const s of this.board.eachStroke()) this.members[hashSeed(s.id) & (buckets - 1)].add(s);
    this.dirty.clear();
  }

  private meta(): StoreMeta {
    const b = this.board;
    return {
      camera: this.camera(),
      layers: b.layers.map((l) => ({ ...l })),
      activeLayer: b.activeLayer,
      frames: b.frames.map((f) => ({ ...f })),
      activeFrame: b.activeFrame,
      fps: b.fps,
      onion: { ...b.onion },
      nextSeq: b.peekSeq(),
    };
  }

  private async save(): Promise<void> {
    const board = this.board;
    const prev = this.manifest;
    // A board that has grown well past the buckets it was laid out for is
    // spread out again, all at once.
    const full =
      this.everything ||
      !prev ||
      this.buckets === 0 ||
      (this.points > this.buckets * BUCKET_POINTS * 4 && this.buckets < MAX_BUCKETS);
    if (full) this.layout(bucketsFor(this.points));
    const dirty = full ? Array.from({ length: this.buckets }, (_, b) => b) : [...this.dirty];
    this.dirty = new Set();
    this.everything = false;

    // Everything this save writes is captured before the first await: strokes
    // never change once made, so holding the objects is holding the state.
    const groups = dirty.map((b) => [...this.members[b]]);
    const pictures = new Map<string, string>();
    const images: ImageEntry[] = board.images.map((im) => {
      const key = keyOf(im);
      if (!this.stored.has(key)) pictures.set(key, im.src);
      return { id: im.id, seq: im.seq, key, x: im.x, y: im.y, width: im.width, height: im.height, layer: im.layer, frame: im.frame };
    });
    const generation = (prev?.generation ?? 0) + 1;
    const files: Record<string, string> = full ? {} : { ...prev!.files };
    const manifest: Manifest = {
      app: 'betterboard-autosave',
      version: 1,
      generation,
      buckets: this.buckets,
      files,
      images,
      meta: this.meta(),
    };

    try {
      for (let i = 0; i < dirty.length; i++) {
        const b = dirty[i];
        if (groups[i].length === 0) {
          delete files[b];
          continue;
        }
        const name = `s${b}-${generation}.bin`;
        await this.api.storePut(name, encodeStrokes(groups[i]));
        files[b] = name;
      }
      for (const [key, src] of pictures) await this.api.storePut(`i-${key}.txt`, src);
      await this.api.storeCommit(manifest);
    } catch (err) {
      // Whatever this save meant to write is still unwritten.
      if (full) this.everything = true;
      else for (const b of dirty) this.dirty.add(b);
      throw err;
    }
    this.manifest = manifest;
    this.stored = new Set(images.map((im) => im.key));
  }

  // Restores the last session. Returns its camera, or null for a fresh start.
  async load(): Promise<Camera | null> {
    const state = await this.api.storeLoad();
    if (state.manifest) {
      const manifest = JSON.parse(state.manifest) as Manifest;
      if (manifest?.app !== 'betterboard-autosave') throw new Error('not a betterboard autosave');
      const loader = new StoreLoader(manifest.meta);
      // A few files are always on their way while the last one is decoded.
      const names = Object.values(manifest.files);
      const reads: Promise<Uint8Array>[] = [];
      const ask = () => {
        if (reads.length < names.length) reads.push(this.api.storeRead(names[reads.length]));
      };
      for (let i = 0; i < READ_AHEAD; i++) ask();
      for (let i = 0; i < names.length; i++) {
        const bytes = await reads[i];
        ask();
        loader.strokes(bytes);
      }
      for (const im of manifest.images) {
        loader.image({ ...im, src: await this.api.storeReadText(`i-${im.key}.txt`) });
      }
      const camera = this.board.load(loader.finish());
      // What was just read is exactly what is on disk.
      this.layout(manifest.buckets);
      this.everything = false;
      this.manifest = manifest;
      this.stored = new Set(manifest.images.map((im) => im.key));
      return camera;
    }
    if (state.legacy) {
      // The single-file autosave every earlier version wrote. It is read once,
      // a line at a time, and the next save carries it into the store.
      const snap = await readBoard(this.api, 'legacy-autosave');
      if (!snap) return null;
      const camera = this.board.load(snap);
      void this.flush();
      return camera;
    }
    return null;
  }

  // An autosave that cannot be read is set aside rather than overwritten.
  async quarantine(): Promise<void> {
    this.manifest = null;
    await this.api.storeQuarantine();
  }
}

// ---- board files ------------------------------------------------------------

export type Progress = (done: number, total: number) => void;

// Reads a board file in chunks and feeds it to the reader a line at a time,
// so however big the board, no part of it is ever one enormous string.
async function readBoard(api: StoreApi, kind: 'open' | 'legacy-autosave', progress?: Progress): Promise<BoardSnapshot | null> {
  const begun = await api.fileReadBegin(kind);
  if (!begun) return null;
  const reader = new BoardReader();
  const decoder = new TextDecoder();
  let parts: string[] = [];
  const feed = (piece: string): void => {
    let nl = piece.indexOf('\n');
    if (nl < 0) {
      if (piece) parts.push(piece);
      return;
    }
    reader.feed(parts.length ? parts.join('') + piece.slice(0, nl) : piece.slice(0, nl));
    parts = [];
    let start = nl + 1;
    while ((nl = piece.indexOf('\n', start)) >= 0) {
      reader.feed(piece.slice(start, nl));
      start = nl + 1;
    }
    if (start < piece.length) parts.push(piece.slice(start));
  };
  let done = 0;
  try {
    for (;;) {
      const chunk = await api.fileRead(begun.token, 8 << 20);
      if (!chunk) break;
      done += chunk.byteLength;
      feed(decoder.decode(chunk, { stream: true }));
      progress?.(done, begun.size);
    }
    feed(decoder.decode());
    if (parts.length) reader.feed(parts.join(''));
    return reader.finish();
  } finally {
    await api.fileReadEnd(begun.token);
  }
}

export function openBoardFile(progress?: Progress): Promise<BoardSnapshot | null> {
  return readBoard(window.betterboard, 'open', progress);
}

// Writes the board as a version 6 file, a few megabytes at a time. Returns
// false if the save dialog was dismissed.
export async function saveBoardFile(board: Board, camera: Camera): Promise<boolean> {
  const token = await window.betterboard.fileWriteBegin();
  if (token === null) return false;
  // The lists as they stand now. Strokes never change once made, so the file
  // is one consistent moment however long the writing takes.
  const data = {
    layers: board.layers.map((l) => ({ ...l })),
    activeLayer: board.activeLayer,
    frames: board.frames.map((f) => ({ ...f })),
    activeFrame: board.activeFrame,
    fps: board.fps,
    onion: { ...board.onion },
    strokes: board.strokes,
    images: board.images.map((im) => ({ ...im, el: undefined })),
  };
  let ok = false;
  try {
    let batch: string[] = [];
    let size = 0;
    for (const line of boardFileLines(data, camera)) {
      batch.push(line);
      size += line.length;
      if (size < 4 << 20) continue;
      await window.betterboard.fileWrite(token, `${batch.join('\n')}\n`);
      batch = [];
      size = 0;
    }
    if (batch.length) await window.betterboard.fileWrite(token, `${batch.join('\n')}\n`);
    ok = true;
    return true;
  } finally {
    await window.betterboard.fileWriteEnd(token, ok);
  }
}
