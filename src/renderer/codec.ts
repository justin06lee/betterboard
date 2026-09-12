// Boards on disk. Two containers share one way of writing strokes down:
//
// - the autosave, a folder of binary buckets the main process manages, so an
//   edit rewrites the few buckets it touched rather than the whole board;
// - a saved board file: JSON, version 6, one item per line, with strokes as
//   base64 chunks of the same binary records.
//
// Numbers are what make a big board slow to write and read as text — a
// million strokes is well over a gigabyte of digits, past the longest string
// JavaScript can even hold — so strokes go down as packed floats. Everything
// else stays readable JSON, and every file an older version wrote still opens.

import { hashSeed } from './ink';
import { packedBBox } from './points';
import type { BoardImage, BrushId, Camera, Frame, Layer, Onion, Stroke } from './types';
import { BRUSH_ORDER, MAX_FPS, MIN_FPS, defaultOnion, isBrush, newFrame, newLayer, uid } from './types';

export interface BoardSnapshot {
  camera: Camera | null;
  layers: Layer[];
  activeLayer: string;
  frames: Frame[];
  activeFrame: string;
  fps: number;
  onion: Onion;
  strokes: Stroke[];
  images: BoardImage[];
  nextSeq: number;
}

// Everything a writer needs from a board.
export interface BoardData {
  layers: Layer[];
  activeLayer: string;
  frames: Frame[];
  activeFrame: string;
  fps: number;
  onion: Onion;
  strokes: Stroke[];
  images: BoardImage[];
}

// ---- binary stroke records -------------------------------------------------
//
//   'BBS1'  u32 count, then per stroke, starting 4-byte aligned:
//   u32 record bytes · f64 seq · f64 ox · f64 oy · f64 minX minY maxX maxY
//   f32 size · u32 seed · u32 n · u8 brush · u8 pen · u16 0
//   u16 id/color/layer/frame byte lengths · the four strings, utf-8
//   padding to 4 · f32 × 3n points, (x - ox, y - oy, pressure)
//
// Little-endian, which is every machine this runs on; the points are written
// and read as Float32Array views, straight out of and into the file's bytes.

const MAGIC = 0x31534242; // 'BBS1'
const FIXED = 84;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const pad4 = (n: number) => (n + 3) & ~3;

export function encodeStrokes(strokes: readonly Stroke[]): Uint8Array {
  const lens = new Uint16Array(strokes.length * 4);
  let total = 8;
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    const a = (lens[i * 4] = utf8Length(s.id));
    const b = (lens[i * 4 + 1] = utf8Length(s.color));
    const c = (lens[i * 4 + 2] = utf8Length(s.layer));
    const d = (lens[i * 4 + 3] = utf8Length(s.frame));
    total += FIXED + pad4(a + b + c + d) + s.n * 12;
  }
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, strokes.length, true);
  let off = 8;
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    const idL = lens[i * 4];
    const colorL = lens[i * 4 + 1];
    const layerL = lens[i * 4 + 2];
    const frameL = lens[i * 4 + 3];
    const size = FIXED + pad4(idL + colorL + layerL + frameL) + s.n * 12;
    dv.setUint32(off, size, true);
    dv.setFloat64(off + 4, s.seq, true);
    dv.setFloat64(off + 12, s.ox, true);
    dv.setFloat64(off + 20, s.oy, true);
    dv.setFloat64(off + 28, s.bbox.minX, true);
    dv.setFloat64(off + 36, s.bbox.minY, true);
    dv.setFloat64(off + 44, s.bbox.maxX, true);
    dv.setFloat64(off + 52, s.bbox.maxY, true);
    dv.setFloat32(off + 60, s.size, true);
    dv.setUint32(off + 64, s.seed >>> 0, true);
    dv.setUint32(off + 68, s.n, true);
    u8[off + 72] = Math.max(0, BRUSH_ORDER.indexOf(s.brush));
    u8[off + 73] = s.pen ? 1 : 0;
    dv.setUint16(off + 76, idL, true);
    dv.setUint16(off + 78, colorL, true);
    dv.setUint16(off + 80, layerL, true);
    dv.setUint16(off + 82, frameL, true);
    let p = off + FIXED;
    encoder.encodeInto(s.id, u8.subarray(p, (p += idL)));
    encoder.encodeInto(s.color, u8.subarray(p, (p += colorL)));
    encoder.encodeInto(s.layer, u8.subarray(p, (p += layerL)));
    encoder.encodeInto(s.frame, u8.subarray(p, (p += frameL)));
    p = off + FIXED + pad4(idL + colorL + layerL + frameL);
    new Float32Array(buf, p, s.n * 3).set(s.pts.subarray(0, s.n * 3));
    off += size;
  }
  return u8;
}

// Layer and frame ids, and colours, repeat on nearly every record; decoding
// each one fresh would make a million strings for a handful of values.
class Strings {
  private cache = new Map<number, { bytes: Uint8Array; text: string }[]>();
  get(u8: Uint8Array, start: number, end: number): string {
    let h = 2166136261;
    for (let i = start; i < end; i++) h = Math.imul(h ^ u8[i], 16777619);
    const bucket = this.cache.get(h);
    if (bucket) {
      for (const hit of bucket) {
        if (hit.bytes.length !== end - start) continue;
        let same = true;
        for (let i = 0; i < hit.bytes.length; i++) {
          if (hit.bytes[i] !== u8[start + i]) {
            same = false;
            break;
          }
        }
        if (same) return hit.text;
      }
    }
    const text = decoder.decode(u8.subarray(start, end));
    if (this.cache.size < 4096) {
      const entry = { bytes: u8.slice(start, end), text };
      if (bucket) bucket.push(entry);
      else this.cache.set(h, [entry]);
    }
    return text;
  }
}

// The points of each stroke are views into `bytes` rather than copies, so a
// loaded board costs little more memory than its file.
export function decodeStrokes(bytes: Uint8Array, visit: (s: Stroke) => void): void {
  if (bytes.byteLength < 8) throw new Error('stroke data is truncated');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not betterboard stroke data');
  const count = dv.getUint32(4, true);
  const aligned = bytes.byteOffset % 4 === 0;
  const strings = new Strings();
  let off = 8;
  for (let i = 0; i < count; i++) {
    if (off + FIXED > bytes.byteLength) throw new Error('stroke data is truncated');
    const size = dv.getUint32(off, true);
    const n = dv.getUint32(off + 68, true);
    const idL = dv.getUint16(off + 76, true);
    const colorL = dv.getUint16(off + 78, true);
    const layerL = dv.getUint16(off + 80, true);
    const frameL = dv.getUint16(off + 82, true);
    const at = off + FIXED + pad4(idL + colorL + layerL + frameL);
    if (size < FIXED || off + size > bytes.byteLength || at + n * 12 > off + size) {
      throw new Error('stroke data is corrupt');
    }
    let p = off + FIXED;
    const id = decoder.decode(bytes.subarray(p, (p += idL)));
    const color = strings.get(bytes, p, (p += colorL));
    const layer = strings.get(bytes, p, (p += layerL));
    const frame = strings.get(bytes, p, (p += frameL));
    const start = bytes.byteOffset + at;
    const pts = aligned
      ? new Float32Array(bytes.buffer, start, n * 3)
      : new Float32Array(bytes.buffer.slice(start, start + n * 12));
    visit({
      id,
      seq: dv.getFloat64(off + 4, true),
      color,
      size: dv.getFloat32(off + 60, true),
      pen: bytes[off + 73] === 1,
      brush: BRUSH_ORDER[bytes[off + 72]] ?? 'pen',
      seed: dv.getUint32(off + 64, true),
      layer,
      frame,
      ox: dv.getFloat64(off + 12, true),
      oy: dv.getFloat64(off + 20, true),
      pts,
      n,
      bbox: {
        minX: dv.getFloat64(off + 28, true),
        minY: dv.getFloat64(off + 36, true),
        maxX: dv.getFloat64(off + 44, true),
        maxY: dv.getFloat64(off + 52, true),
      },
    });
    off += size;
  }
}

// ---- base64 ---------------------------------------------------------------

type Base64Array = Uint8Array & { toBase64?: () => string };
type Base64Ctor = { fromBase64?: (s: string) => Uint8Array };

export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Base64Array).toBase64;
  if (native) return native.call(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(bin);
}

export function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as unknown as Base64Ctor).fromBase64;
  if (native) return native(text);
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- writing a board file ---------------------------------------------------

export const FILE_VERSION = 6;
const CHUNK_POINTS = 120_000; // about 1.4 MB of binary per stroke chunk

function imageRecord(im: BoardImage): Record<string, unknown> {
  return {
    id: im.id,
    seq: im.seq,
    src: im.src,
    x: Math.round(im.x * 100) / 100,
    y: Math.round(im.y * 100) / 100,
    width: Math.round(im.width * 100) / 100,
    height: Math.round(im.height * 100) / 100,
    layer: im.layer,
    frame: im.frame,
  };
}

export function fileHeader(data: BoardData, camera: Camera | null): Record<string, unknown> {
  return {
    app: 'betterboard',
    version: FILE_VERSION,
    camera,
    layers: data.layers,
    activeLayer: data.activeLayer,
    frames: data.frames,
    activeFrame: data.activeFrame,
    fps: data.fps,
    onion: data.onion,
    strokeFormat: 'bbs1',
  };
}

// The file a line at a time: the header, one line per picture, one per chunk
// of strokes. Taken together the lines are a single JSON document; taken one
// by one they can be written, and read back, without ever holding the whole
// board as one string.
export function* boardFileLines(data: BoardData, camera: Camera | null): Generator<string> {
  const head = JSON.stringify(fileHeader(data, camera));
  yield `${head.slice(0, -1)},"images":[`;
  for (let i = 0; i < data.images.length; i++) {
    yield JSON.stringify(imageRecord(data.images[i])) + (i + 1 < data.images.length ? ',' : '');
  }
  yield '],"strokes":[';
  const strokes = data.strokes;
  let start = 0;
  let points = 0;
  for (let i = 0; i < strokes.length; i++) {
    points += strokes[i].n;
    const last = i + 1 === strokes.length;
    if (points < CHUNK_POINTS && !last) continue;
    yield JSON.stringify(toBase64(encodeStrokes(strokes.slice(start, i + 1)))) + (last ? '' : ',');
    start = i + 1;
    points = 0;
  }
  yield ']}';
}

// ---- reading ------------------------------------------------------------

// Collects a board's pieces as they arrive, checking each against what the
// header promised: a stroke on a layer or frame the file never declared lands
// on the first one, and a duplicated id is given a fresh one.
class SnapshotBuilder {
  private layers: Layer[] = [];
  private known = new Set<string>();
  private frames: Frame[] = [];
  private knownFrames = new Set<string>();
  private data: Record<string, unknown> = {};
  private strokes: Stroke[] = [];
  private images: BoardImage[] = [];
  private ids = new Set<string>();
  private imageIds = new Set<string>();
  private seq = 0; // for files from before items carried a seq
  private maxSeq = -1;

  header(data: Record<string, unknown>): void {
    if (data?.app !== 'betterboard') throw new Error('not a betterboard file');
    this.data = data;
    // Version 1 files predate layers: everything they hold becomes one layer.
    for (const raw of Array.isArray(data.layers) ? data.layers : []) {
      const id = String(raw?.id ?? '');
      if (!id || this.known.has(id)) continue;
      this.known.add(id);
      this.layers.push({
        id,
        name: String(raw.name ?? 'Layer').slice(0, 40) || 'Layer',
        opacity: Number.isFinite(raw.opacity) ? Math.min(1, Math.max(0, raw.opacity)) : 1,
        visible: raw.visible !== false,
      });
    }
    if (this.layers.length === 0) {
      const layer = newLayer('Layer 1');
      this.layers.push(layer);
      this.known.add(layer.id);
    }
    // Versions 1 and 2 predate animation: their whole board is frame one.
    for (const raw of Array.isArray(data.frames) ? data.frames : []) {
      const id = String(raw?.id ?? '');
      if (id && !this.knownFrames.has(id)) {
        this.knownFrames.add(id);
        this.frames.push({ id });
      }
    }
    if (this.frames.length === 0) {
      const frame = newFrame();
      this.frames.push(frame);
      this.knownFrames.add(frame.id);
    }
  }

  // A file written in one piece: every version before 6, whose strokes are
  // objects with their points spelled out.
  whole(data: Record<string, unknown>): void {
    if (data?.app !== 'betterboard' || !Array.isArray(data.strokes)) throw new Error('not a betterboard file');
    this.header(data);
    for (const raw of data.strokes) this.stroke(raw);
    for (const raw of Array.isArray(data.images) ? data.images : []) this.image(raw);
  }

  stroke(raw: unknown): void {
    if (typeof raw === 'string') {
      decodeStrokes(fromBase64(raw), (s) => this.add(s));
      return;
    }
    this.strokeObject(raw);
  }

  private strokeObject(raw: unknown): void {
    const r = raw as Record<string, unknown>;
    const list = r?.points;
    if (!Array.isArray(list) || list.length === 0) return;
    const n = list.length;
    const first = list[0] as number[];
    const ox = Number(first[0]) || 0;
    const oy = Number(first[1]) || 0;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const pt = list[i] as number[];
      pts[i * 3] = Number(pt[0]) - ox;
      pts[i * 3 + 1] = Number(pt[1]) - oy;
      pts[i * 3 + 2] = Number(pt[2]);
    }
    const size = Number(r.size) || 6;
    const brush: BrushId = isBrush(r.brush) ? r.brush : 'pen'; // pre-brush files are all pen
    const packed = { ox, oy, pts, n };
    this.add({
      id: String(r.id ?? Math.random().toString(36).slice(2)),
      // Files written before pictures existed have no ordering to preserve,
      // so array order becomes the order.
      seq: Number.isFinite(r.seq) ? Number(r.seq) : this.seq++,
      color: String(r.color ?? '#e8eaed'),
      size,
      pen: Boolean(r.pen),
      brush,
      seed: Number.isFinite(r.seed) ? Number(r.seed) >>> 0 : hashSeed(String(r.id ?? '')),
      layer: String(r.layer ?? ''),
      frame: String(r.frame ?? ''),
      ...packed,
      bbox: packedBBox(packed, brush, size),
    });
  }

  add(s: Stroke): void {
    if (!this.known.has(s.layer)) s.layer = this.layers[0].id;
    if (!this.knownFrames.has(s.frame)) s.frame = this.frames[0].id;
    if (this.ids.has(s.id)) s.id = uid();
    this.ids.add(s.id);
    if (s.seq > this.maxSeq) this.maxSeq = s.seq;
    this.strokes.push(s);
  }

  image(raw: unknown): void {
    const r = raw as Record<string, unknown>;
    const src = String(r?.src ?? '');
    if (!src.startsWith('data:image/')) return;
    const layer = String(r.layer ?? '');
    const frame = String(r.frame ?? '');
    let id = String(r.id ?? uid());
    if (this.imageIds.has(id)) id = uid();
    this.imageIds.add(id);
    const image: BoardImage = {
      id,
      seq: Number.isFinite(r.seq) ? Number(r.seq) : this.seq++,
      src,
      x: Number(r.x) || 0,
      y: Number(r.y) || 0,
      width: Math.max(1, Number(r.width) || 1),
      height: Math.max(1, Number(r.height) || 1),
      layer: this.known.has(layer) ? layer : this.layers[0].id,
      frame: this.knownFrames.has(frame) ? frame : this.frames[0].id,
    };
    if (image.seq > this.maxSeq) this.maxSeq = image.seq;
    this.images.push(image);
  }

  done(): BoardSnapshot {
    const data = this.data;
    const c = data.camera as Record<string, number> | undefined;
    const camera =
      c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.scale) && c.scale > 0
        ? { x: c.x, y: c.y, scale: c.scale, rotation: Number.isFinite(c.rotation) ? c.rotation : 0 }
        : null;
    const fps = Number(data.fps);
    return {
      camera,
      layers: this.layers,
      activeLayer: this.known.has(String(data.activeLayer))
        ? String(data.activeLayer)
        : this.layers[this.layers.length - 1].id,
      frames: this.frames,
      activeFrame: this.knownFrames.has(String(data.activeFrame)) ? String(data.activeFrame) : this.frames[0].id,
      fps: Number.isFinite(fps) ? Math.round(Math.min(MAX_FPS, Math.max(MIN_FPS, fps))) : 12,
      onion: { ...defaultOnion(), ...(data.onion && typeof data.onion === 'object' ? (data.onion as Partial<Onion>) : {}) },
      strokes: this.strokes,
      images: this.images,
      nextSeq: Math.max(this.seq, this.maxSeq + 1, Number(data.nextSeq) || 0, 0),
    };
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Reads a board file a line at a time — any version. A file written in one
// line (every version before 6) is one JSON value and is parsed whole; a file
// written a line per item is streamed, header first, never becoming one string.
export class BoardReader {
  private phase: 'start' | 'items' | 'done' = 'start';
  private key: 'images' | 'strokes' = 'strokes';
  private build = new SnapshotBuilder();

  feed(line: string): void {
    if (this.phase === 'done' || line.trim() === '') return;
    if (this.phase === 'start') {
      const whole = tryParse(line);
      if (whole && typeof whole === 'object') {
        this.build.whole(whole as Record<string, unknown>);
        this.phase = 'done';
        return;
      }
      const open = /"(images|strokes)":\[\s*$/.exec(line);
      if (!open) throw new Error('not a betterboard file');
      const head = line.slice(0, open.index).replace(/,\s*$/, '');
      this.build.header(JSON.parse(`${head}}`));
      this.key = open[1] as 'images' | 'strokes';
      this.phase = 'items';
      return;
    }
    const t = line.trim();
    if (t.startsWith(']')) {
      const next = /^\]\s*,\s*"(images|strokes)":\[$/.exec(t);
      if (next) this.key = next[1] as 'images' | 'strokes';
      else this.phase = 'done';
      return;
    }
    const item = JSON.parse(t.endsWith(',') ? t.slice(0, -1) : t);
    if (this.key === 'images') this.build.image(item);
    else this.build.stroke(item);
  }

  finish(): BoardSnapshot {
    if (this.phase === 'start') throw new Error('not a betterboard file');
    return this.build.done();
  }
}

export function parseBoardJSON(json: string): BoardSnapshot {
  const reader = new BoardReader();
  // A one-line file is fed whole rather than split, which would only find the
  // one line again the slow way.
  if (!json.includes('\n')) reader.feed(json);
  else for (const line of json.split('\n')) reader.feed(line);
  return reader.finish();
}

// A snapshot of the autosave's meta: the board minus its strokes and picture
// bitmaps, which live in their own files.
export interface StoreMeta {
  camera: Camera | null;
  layers: Layer[];
  activeLayer: string;
  frames: Frame[];
  activeFrame: string;
  fps: number;
  onion: Onion;
  nextSeq: number;
}

// Assembles a board from the autosave's pieces, checked the same way a file is.
export class StoreLoader {
  private build = new SnapshotBuilder();

  constructor(private meta: StoreMeta) {
    this.build.header({ app: 'betterboard', ...meta } as unknown as Record<string, unknown>);
  }

  strokes(bytes: Uint8Array): void {
    decodeStrokes(bytes, (s) => this.build.add(s));
  }

  image(raw: Record<string, unknown>): void {
    this.build.image(raw);
  }

  finish(): BoardSnapshot {
    const snap = this.build.done();
    snap.camera = this.meta.camera;
    snap.nextSeq = Math.max(snap.nextSeq, this.meta.nextSeq || 0);
    return snap;
  }
}
