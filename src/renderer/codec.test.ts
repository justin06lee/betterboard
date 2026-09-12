import { describe, expect, test } from 'bun:test';
import { BoardReader, boardFileLines, decodeStrokes, encodeStrokes, fromBase64, parseBoardJSON, toBase64 } from './codec';
import { makeStroke } from './points';
import type { BoardImage, Stroke } from './types';
import { defaultOnion } from './types';

function sample(): Stroke[] {
  return [
    makeStroke({ id: 'a', seq: 3, color: '#e8eaed', size: 6, pen: true, brush: 'pen', seed: 7, layer: 'L', frame: 'F' }, [
      { x: 1, y: 2, p: 0.25 },
      { x: 4, y: 6, p: 0.75 },
    ]),
    // Far out on the board, with a name that is not plain ASCII.
    makeStroke({ id: 'strøke-é', seq: 9, color: '#ef476f', size: 3.5, pen: false, brush: 'chalk', seed: 4_000_000_000, layer: 'L', frame: 'F' }, [
      { x: 9_000_000.5, y: -3_000_000.25, p: 0.5 },
    ]),
    makeStroke({ id: 'c', seq: 11, color: '#06d6a0', size: 12, pen: true, brush: 'marker', seed: 0, layer: 'L2', frame: 'F' }, [
      { x: 0, y: 0, p: 0.1 },
      { x: 10, y: 0, p: 0.2 },
      { x: 20, y: 5, p: 0.3 },
    ]),
  ];
}

// A stroke with its points as a plain list, for comparing.
const plain = (s: Stroke) => ({ ...s, pts: Array.from(s.pts.subarray(0, s.n * 3)), path: undefined, mark: undefined });

describe('stroke records', () => {
  test('come back with every field exactly as they went in', () => {
    const strokes = sample();
    const back: Stroke[] = [];
    decodeStrokes(encodeStrokes(strokes), (s) => back.push(s));
    expect(back.map(plain)).toEqual(strokes.map(plain));
  });

  test('read from bytes that do not start on a word boundary', () => {
    const bytes = encodeStrokes(sample());
    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);
    const back: Stroke[] = [];
    decodeStrokes(shifted.subarray(1), (s) => back.push(s));
    expect(back.map(plain)).toEqual(sample().map(plain));
  });

  test('refuse bytes that are not theirs, or are cut short', () => {
    expect(() => decodeStrokes(new Uint8Array(16), () => {})).toThrow();
    const bytes = encodeStrokes(sample());
    expect(() => decodeStrokes(bytes.slice(0, bytes.length - 5), () => {})).toThrow();
  });

  test('survive base64', () => {
    const bytes = encodeStrokes(sample());
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });
});

const layers = [
  { id: 'L', name: 'Layer 1', opacity: 1, visible: true },
  { id: 'L2', name: 'Layer 2', opacity: 0.5, visible: false },
];
const frames = [{ id: 'F' }, { id: 'G' }];
const picture: BoardImage = { id: 'p', seq: 5, src: 'data:image/png;base64,AAAA', x: 1.25, y: -2.5, width: 30, height: 20, layer: 'L', frame: 'G' };

describe('board files', () => {
  test('are one JSON document, a line per item, that reads back whole', () => {
    const strokes = sample();
    const lines = [
      ...boardFileLines(
        { layers, activeLayer: 'L2', frames, activeFrame: 'G', fps: 24, onion: defaultOnion(), strokes, images: [picture] },
        { x: 5, y: 6, scale: 2, rotation: 0.5 }
      ),
    ];
    const text = lines.join('\n');
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text).version).toBe(6);
    expect(lines.length).toBeGreaterThan(3);

    const snap = parseBoardJSON(text);
    expect(snap.strokes.map(plain)).toEqual(strokes.map(plain));
    expect(snap.images).toEqual([picture]);
    expect(snap.layers).toEqual(layers);
    expect(snap.frames).toEqual(frames);
    expect([snap.activeLayer, snap.activeFrame, snap.fps]).toEqual(['L2', 'G', 24]);
    expect(snap.camera).toEqual({ x: 5, y: 6, scale: 2, rotation: 0.5 });
    expect(snap.nextSeq).toBe(12);
  });

  test('split big boards into several stroke chunks', () => {
    const many = Array.from({ length: 3000 }, (_, i) =>
      makeStroke({ id: `s${i}`, seq: i, color: '#fff', size: 2, pen: true, brush: 'pen', seed: i, layer: 'L', frame: 'F' },
        Array.from({ length: 50 }, (__, k) => ({ x: i + k, y: k, p: 0.5 })))
    );
    const lines = [...boardFileLines({ layers, activeLayer: 'L', frames, activeFrame: 'F', fps: 12, onion: defaultOnion(), strokes: many, images: [] }, null)];
    expect(lines.filter((l) => l.startsWith('"')).length).toBeGreaterThan(1);
    const snap = parseBoardJSON(lines.join('\n'));
    expect(snap.strokes.map((s) => s.id)).toEqual(many.map((s) => s.id));
  });

  test('from version 5 and earlier still open', () => {
    const v5 = JSON.stringify({
      app: 'betterboard',
      version: 5,
      camera: { x: 1, y: 2, scale: 3, rotation: 0 },
      layers: [{ id: 'L', name: 'Layer 1', opacity: 1, visible: true }],
      activeLayer: 'L',
      frames: [{ id: 'F' }],
      activeFrame: 'F',
      fps: 12,
      images: [],
      strokes: [
        { id: 'a', seq: 4, color: '#fff', size: 3, pen: true, brush: 'marker', seed: 9, layer: 'L', frame: 'F', points: [[10, 20, 0.5], [12, 21, 0.625]] },
        { id: 'a', seq: 5, color: '#fff', size: 3, pen: true, brush: 'pen', seed: 9, layer: 'gone', frame: 'F', points: [[0, 0, 0.5]] },
      ],
    });
    const snap = parseBoardJSON(v5);
    expect(snap.strokes).toHaveLength(2);
    expect([snap.strokes[0].ox, snap.strokes[0].oy, snap.strokes[0].n]).toEqual([10, 20, 2]);
    expect([...snap.strokes[0].pts]).toEqual([0, 0, 0.5, 2, 1, 0.625]);
    expect(snap.strokes[1].id).not.toBe('a'); // a duplicated id gets a fresh one
    expect(snap.strokes[1].layer).toBe('L'); // an unknown layer falls back to the first
    expect(snap.nextSeq).toBe(6);
    expect(snap.camera).toEqual({ x: 1, y: 2, scale: 3, rotation: 0 });
  });

  test('from version 1, with no layers, frames or order, still open', () => {
    const snap = parseBoardJSON('{"app":"betterboard","version":1,"strokes":[{"points":[[0,0,0.5],[3,4,0.5]]},{"points":[[1,1,0.5]]}]}');
    expect(snap.layers).toHaveLength(1);
    expect(snap.frames).toHaveLength(1);
    expect(snap.strokes.map((s) => [s.seq, s.brush, s.layer, s.frame])).toEqual([
      [0, 'pen', snap.layers[0].id, snap.frames[0].id],
      [1, 'pen', snap.layers[0].id, snap.frames[0].id],
    ]);
  });

  test('written a stroke per line are read a line at a time', () => {
    const reader = new BoardReader();
    for (const line of [
      '{"app":"betterboard","version":5,"layers":[{"id":"L","name":"Layer 1","opacity":1,"visible":true}],"frames":[{"id":"F"}],"images":[],"strokes":[',
      '{"id":"a","seq":0,"color":"#fff","size":2,"pen":true,"brush":"pen","seed":1,"layer":"L","frame":"F","points":[[1,2,0.5]]},',
      '{"id":"b","seq":1,"color":"#fff","size":2,"pen":true,"brush":"liner","seed":1,"layer":"L","frame":"F","points":[[3,4,0.5],[5,6,0.5]]}',
      ']}',
      '',
    ]) {
      reader.feed(line);
    }
    const snap = reader.finish();
    expect(snap.strokes.map((s) => s.id)).toEqual(['a', 'b']);
    expect(snap.strokes[1].brush).toBe('liner');
  });

  test('refuse anything that is not a board', () => {
    expect(() => parseBoardJSON('{"hello":"world"}')).toThrow();
    expect(() => parseBoardJSON('not json at all')).toThrow();
  });
});
