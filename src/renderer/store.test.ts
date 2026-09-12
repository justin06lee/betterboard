import { describe, expect, test } from 'bun:test';
import { makeStroke } from './points';
import { Board } from './store';
import type { BBox, BoardImage, Stroke } from './types';

class TestPath2D {
  moveTo(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
  arc(): void {}
  rect(): void {}
  addPath(): void {}
}

// hydrate() decodes through an Image element; tests only need it to not throw.
class TestImage {
  onload: (() => void) | null = null;
  src = '';
}

Object.assign(globalThis, { Path2D: TestPath2D, Image: TestImage });

function stroke(id: string, seq: number, board: Board, at = 0): Stroke {
  return makeStroke(
    { id, seq, color: '#000000', size: 4, pen: false, brush: 'pen', seed: 1, layer: board.activeLayer, frame: board.activeFrame },
    [{ x: at, y: at, p: 0.5 }]
  );
}

function image(id: string, seq: number, board: Board): BoardImage {
  return {
    id,
    seq,
    src: 'data:image/png;base64,',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    layer: board.activeLayer,
    frame: board.activeFrame,
  };
}

// Puts strokes and pictures on the board as though a file had just been
// opened: indexed, with nothing to undo. The board takes ownership of the
// lists it loads, so it is handed copies and the test keeps its own.
function seed(board: Board, strokes: Stroke[], images: BoardImage[] = []): void {
  board.load({
    camera: null,
    layers: board.layers,
    activeLayer: board.activeLayer,
    frames: board.frames,
    activeFrame: board.activeFrame,
    fps: board.fps,
    onion: board.onion,
    strokes: [...strokes],
    images: [...images],
    nextSeq: Math.max(0, ...[...strokes, ...images].map((item) => item.seq + 1)),
  });
}

const everywhere: BBox = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };

// Everything on the board can be found through the index, in the right cell,
// and nothing that is not on the board can.
function expectIndexed(board: Board): void {
  let indexed = 0;
  for (const frame of board.frames) {
    for (const layer of board.layers) {
      for (const s of board.query(frame.id, layer.id, everywhere)) {
        indexed++;
        expect(board.stroke(s.id)).toBe(s);
        expect(s.frame).toBe(frame.id);
        expect(s.layer).toBe(layer.id);
      }
    }
  }
  expect(indexed).toBe(board.strokeCount);
  for (const s of board.strokes) {
    expect(board.stroke(s.id)).toBe(s);
    expect(board.query(s.frame, s.layer, s.bbox)).toContain(s);
  }
}

// What is on the board. Order in storage means nothing — ink is painted by
// seq — so boards are compared as sets.
const ids = (board: Board) => board.strokes.map((s) => s.id).sort();
// The order the ink paints in.
const painted = (board: Board) => [...board.strokes].sort((a, b) => a.seq - b.seq).map((s) => s.id);

describe('Board.clear', () => {
  test('clears ink and images as one undoable operation', () => {
    const board = new Board();
    seed(board, [stroke('stroke', 0, board)], [image('image', 1, board)]);

    board.clear();
    expect(board.strokes).toHaveLength(0);
    expect(board.images).toHaveLength(0);

    board.undo();
    expect(ids(board)).toEqual(['stroke']);
    expect(board.images.map((item) => item.id)).toEqual(['image']);
    expect(board.canUndo).toBe(false);

    board.redo();
    expect(board.strokes).toHaveLength(0);
    expect(board.images).toHaveLength(0);
  });

  test('leaves other frames alone, and puts the frame back painting as it did', () => {
    const board = new Board();
    const activeFrame = board.activeFrame;
    const otherFrame = 'other-frame';
    board.frames.push({ id: otherFrame });
    const activeStroke = stroke('active-stroke', 0, board);
    const otherStroke = { ...stroke('other-stroke', 1, board), frame: otherFrame };
    const activeImage = image('active-image', 2, board);
    const otherImage = { ...image('other-image', 3, board), frame: otherFrame };
    seed(board, [activeStroke, otherStroke], [activeImage, otherImage]);
    board.activeFrame = activeFrame;

    board.clear();
    expect(ids(board)).toEqual(['other-stroke']);
    board.undo();

    expect(painted(board)).toEqual(['active-stroke', 'other-stroke']);
    expect(board.images.map((item) => item.id)).toEqual(['active-image', 'other-image']);
    expectIndexed(board);
  });
});

describe('Board.replaceStrokes', () => {
  test('undoes and redoes multiple split/deleted strokes atomically', () => {
    const board = new Board();
    const a = stroke('a', 0, board);
    const b = stroke('b', 1, board);
    const c = stroke('c', 2, board);
    const a1 = { ...a, id: 'a1' };
    const a2 = { ...a, id: 'a2' };
    seed(board, [a, b, c]);

    board.replaceStrokes([
      { before: a, after: [a1, a2] },
      { before: c, after: [] },
    ]);
    expect(ids(board)).toEqual(['a1', 'a2', 'b']);

    board.undo();
    expect(ids(board)).toEqual(['a', 'b', 'c']);
    expect(painted(board)).toEqual(['a', 'b', 'c']);

    board.redo();
    expect(ids(board)).toEqual(['a1', 'a2', 'b']);
    expectIndexed(board);
  });

  test('fragments paint where the stroke they came from did', () => {
    const board = new Board();
    const strokes = Array.from({ length: 60 }, (_, i) => stroke(`s${i}`, i, board, i * 10));
    seed(board, strokes);
    const cut = strokes.filter((_, i) => i % 4 === 0);
    board.replaceStrokes(
      cut.map((before) => ({
        before,
        after: [
          { ...before, id: `${before.id}.1` },
          { ...before, id: `${before.id}.2` },
        ],
      }))
    );
    // Ties within one seq are a stroke and its own fragments; any order of
    // those paints the same.
    const bySeq = [...board.strokes].sort((x, y) => x.seq - y.seq).map((s) => s.id.split('.')[0]);
    expect(bySeq).toEqual(strokes.flatMap((s) => (cut.includes(s) ? [s.id, s.id] : [s.id])));
    expectIndexed(board);
    board.undo();
    expect(painted(board)).toEqual(strokes.map((s) => s.id));
    expectIndexed(board);
  });
});

describe('Board.transformItems', () => {
  test('reshapes ink and pictures in one step, keeping ids', () => {
    const board = new Board();
    const a = stroke('a', 0, board);
    const b = stroke('b', 1, board);
    const picture = image('picture', 2, board);
    seed(board, [a, b], [picture]);
    const bigger = { ...b, size: 8, ox: 5, oy: 5 };

    board.transformItems([bigger], [{ id: 'picture', to: { x: 1, y: 2, width: 30, height: 10 } }]);
    expect(board.stroke('b')).toBe(bigger);
    expect(board.stroke('a')).toBe(a);
    expect(picture).toMatchObject({ x: 1, y: 2, width: 30, height: 10 });

    board.undo();
    expect(board.stroke('b')).toBe(b);
    expect(picture).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });

    board.redo();
    expect(board.stroke('b')).toBe(bigger);
    expect(picture).toMatchObject({ x: 1, y: 2, width: 30, height: 10 });
    expectIndexed(board);
  });

  test('a reshape that changes nothing records nothing', () => {
    const board = new Board();
    seed(board, [], [image('picture', 0, board)]);
    board.transformItems([], [{ id: 'picture', to: { x: 0, y: 0, width: 10, height: 10 } }]);
    expect(board.canUndo).toBe(false);
  });
});

describe('Board.setImageSrc', () => {
  test('swaps the bitmap as one undoable operation', () => {
    const board = new Board();
    const picture = image('picture', 0, board);
    seed(board, [], [picture]);

    board.setImageSrc('picture', 'data:image/png;base64,edited');
    expect(picture.src).toBe('data:image/png;base64,edited');

    board.undo();
    expect(board.images[0].src).toBe('data:image/png;base64,');
    board.redo();
    expect(board.images[0].src).toBe('data:image/png;base64,edited');
  });

  test('an unchanged src records nothing', () => {
    const board = new Board();
    seed(board, [], [image('picture', 0, board)]);
    board.setImageSrc('picture', 'data:image/png;base64,');
    expect(board.canUndo).toBe(false);
  });
});

describe('Board.replaceStrokes with image changes', () => {
  test('ink clipping and pixel erasing undo together as one step', () => {
    const board = new Board();
    const a = stroke('a', 0, board);
    const picture = image('picture', 1, board);
    seed(board, [a], [picture]);
    picture.src = 'data:image/png;base64,erased'; // the gesture already painted it

    board.replaceStrokes(
      [{ before: a, after: [] }],
      [{ id: 'picture', from: 'data:image/png;base64,', to: 'data:image/png;base64,erased' }]
    );
    expect(board.strokes).toHaveLength(0);
    expect(picture.src).toBe('data:image/png;base64,erased');

    board.undo();
    expect(ids(board)).toEqual(['a']);
    expect(board.images[0].src).toBe('data:image/png;base64,');
    expect(board.canUndo).toBe(false);

    board.redo();
    expect(board.strokes).toHaveLength(0);
    expect(board.images[0].src).toBe('data:image/png;base64,erased');
  });

  test('image-only changes still make an undoable step', () => {
    const board = new Board();
    const picture = image('picture', 0, board);
    seed(board, [], [picture]);
    picture.src = 'data:image/png;base64,erased';

    board.replaceStrokes([], [{ id: 'picture', from: 'data:image/png;base64,', to: 'data:image/png;base64,erased' }]);
    board.undo();
    expect(board.images[0].src).toBe('data:image/png;base64,');
  });
});

describe('Board.addStrokes', () => {
  test('adds a model drawing as one undoable operation', () => {
    const board = new Board();
    const a = stroke('a', 0, board);
    const b = stroke('b', 1, board);
    board.addStrokes([a, b]);
    expect(board.strokes).toHaveLength(2);
    board.undo();
    expect(board.strokes).toHaveLength(0);
    board.redo();
    expect(ids(board)).toEqual(['a', 'b']);
    expectIndexed(board);
  });
});

describe('Board.addFrame', () => {
  test('preserves stroke/image stacking order when duplicating', () => {
    const board = new Board();
    const first = stroke('first', 0, board);
    const middle = image('middle', 1, board);
    const last = stroke('last', 2, board);
    seed(board, [first, last], [middle]);

    const duplicate = board.addFrame(true);
    const order = [
      ...board.strokes.filter((item) => item.frame === duplicate.id).map((item) => ({ kind: 'stroke', seq: item.seq })),
      ...board.images.filter((item) => item.frame === duplicate.id).map((item) => ({ kind: 'image', seq: item.seq })),
    ]
      .sort((a, b) => a.seq - b.seq)
      .map((item) => item.kind);

    expect(order).toEqual(['stroke', 'image', 'stroke']);
    expectIndexed(board);
  });

  test('a duplicated frame shares its points with the original', () => {
    const board = new Board();
    const original = stroke('a', 0, board, 5);
    seed(board, [original]);
    const copy = board.frameStrokes(board.addFrame(true).id)[0];
    expect(copy.id).not.toBe('a');
    expect(copy.pts).toBe(original.pts);
  });
});

describe('Board.animationBBox', () => {
  test('covers every frame, so an export does not jitter between them', () => {
    const board = new Board();
    const first = board.activeFrame;
    const second = board.addFrame().id;
    seed(
      board,
      [
        { ...stroke('a', 0, board), frame: first, bbox: { minX: -10, minY: -10, maxX: 0, maxY: 0 } },
        { ...stroke('b', 1, board), frame: second, bbox: { minX: 0, minY: 0, maxX: 40, maxY: 5 } },
      ],
      [{ ...image('c', 2, board), frame: second, x: 50, y: -30, width: 10, height: 10 }]
    );

    expect(board.animationBBox()).toEqual({ minX: -10, minY: -30, maxX: 60, maxY: 5 });
  });

  test('ignores frames whose only content sits on a hidden layer', () => {
    const board = new Board();
    const visible = board.activeLayer;
    const hidden = board.addLayer().id;
    const other = board.addFrame().id;
    seed(board, [
      { ...stroke('shown', 0, board), frame: board.frames[0].id, layer: visible, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
      { ...stroke('ghost', 1, board), frame: other, layer: hidden, bbox: { minX: 500, minY: 500, maxX: 600, maxY: 600 } },
    ]);
    board.setLayerVisible(hidden, false);

    expect(board.animationBBox()).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });

  test('is null for a board with nothing on it', () => {
    expect(new Board().animationBBox()).toBeNull();
  });
});

describe('Board.addItems / removeItems', () => {
  test('paste of mixed ink and pictures is one undo step', () => {
    const board = new Board();
    const ink = stroke('ink', 0, board);
    const pic = image('pic', 1, board);

    board.addItems([ink], [pic]);
    expect(board.strokes).toHaveLength(1);
    expect(board.images).toHaveLength(1);

    board.undo();
    expect(board.strokes).toHaveLength(0);
    expect(board.images).toHaveLength(0);

    board.redo();
    expect(ids(board)).toEqual(['ink']);
    expect(board.images.map((im) => im.id)).toEqual(['pic']);
  });

  test('deleting a mixed selection is one undo step', () => {
    const board = new Board();
    seed(board, [stroke('keep', 0, board), stroke('cut', 1, board)], [image('pic', 2, board)]);

    board.removeItems(new Set(['cut']), new Set(['pic']));
    expect(ids(board)).toEqual(['keep']);
    expect(board.images).toHaveLength(0);

    board.undo();
    expect(painted(board)).toEqual(['keep', 'cut']);
    expect(board.images.map((im) => im.id)).toEqual(['pic']);
  });

  test('nothing selected pushes nothing to undo', () => {
    const board = new Board();
    seed(board, [stroke('a', 0, board)]);
    board.removeItems(new Set(['missing']), new Set());
    board.addItems([], []);
    expect(board.canUndo).toBe(false);
  });
});

describe('the index', () => {
  test('follows every kind of edit, undo and redo included', () => {
    const board = new Board();
    const strokes = Array.from({ length: 40 }, (_, i) => stroke(`s${i}`, i, board, i * 30));
    seed(board, strokes);
    expectIndexed(board);

    board.addStroke(stroke('new', 100, board, 5));
    expectIndexed(board);
    board.removeStrokes(new Set(['s3', 's17', 's30']));
    expectIndexed(board);
    board.moveItems(new Set(['s5', 's6']), new Set(), 100, -50);
    expectIndexed(board);
    const first = board.stroke('s0')!;
    board.replaceStrokes([{ before: first, after: [{ ...first, id: 'f1' }, { ...first, id: 'f2' }] }]);
    expectIndexed(board);
    board.clear();
    expectIndexed(board);

    while (board.canUndo) {
      board.undo();
      expectIndexed(board);
    }
    expect(painted(board)).toEqual(strokes.map((s) => s.id));
    while (board.canRedo) {
      board.redo();
      expectIndexed(board);
    }
    expect(board.strokes).toHaveLength(0);
  });

  test('taking many strokes off and putting them back loses none', () => {
    const board = new Board();
    const strokes = Array.from({ length: 100 }, (_, i) => stroke(`s${i}`, i, board, i));
    seed(board, strokes);
    board.removeStrokes(new Set(strokes.filter((_, i) => i % 3 === 0).map((s) => s.id)));
    expect(board.strokeCount).toBe(66);
    board.undo();
    expect(painted(board)).toEqual(strokes.map((s) => s.id));
    expectIndexed(board);
    board.redo();
    expect(board.strokeCount).toBe(66);
    expectIndexed(board);
  });

  test('a move swaps in copies that share the points, and leaves the originals alone', () => {
    const board = new Board();
    const a = stroke('a', 0, board, 10);
    seed(board, [a]);
    board.moveItems(new Set(['a']), new Set(), 5, 7);
    const moved = board.stroke('a')!;
    expect(moved).not.toBe(a);
    expect(moved.pts).toBe(a.pts);
    expect([moved.ox, moved.oy]).toEqual([15, 17]);
    expect(moved.bbox.minX).toBeCloseTo(a.bbox.minX + 5);
    expect([a.ox, a.oy]).toEqual([10, 10]);
    board.undo();
    expect(board.stroke('a')!.ox).toBe(10);
    expectIndexed(board);
  });

  // A move swaps in a copy under the same id, and undoing it makes another —
  // so an older edit's undo cannot count on finding the object it put down.
  test('undoing a reshape finds the stroke after a move has been and gone', () => {
    const board = new Board();
    const a = stroke('a', 0, board, 10);
    seed(board, [a]);
    board.transformItems([{ ...a, size: 8 }], []);
    board.moveItems(new Set(['a']), new Set(), 5, 5);

    board.undo();
    board.undo();
    expect(board.stroke('a')).toBe(a);
    expect(board.cellStrokes(board.activeFrame, board.activeLayer)).toHaveLength(1);
    expectIndexed(board);

    board.redo();
    board.redo();
    expect(board.stroke('a')!.size).toBe(8);
    expect(board.cellStrokes(board.activeFrame, board.activeLayer)).toHaveLength(1);
    expectIndexed(board);
  });

  test('undoing an erase takes back a fragment that was moved since', () => {
    const board = new Board();
    const a = stroke('a', 0, board, 10);
    seed(board, [a]);
    board.replaceStrokes([{ before: a, after: [{ ...a, id: 'f' }] }]);
    board.moveItems(new Set(['f']), new Set(), 5, 5);

    board.undo();
    board.undo();
    expect(ids(board)).toEqual(['a']);
    expect(board.stroke('a')).toBe(a);
    expectIndexed(board);
  });

  test('a list handed out is never written into', () => {
    const board = new Board();
    seed(board, [stroke('a', 0, board)]);
    const before = board.strokes;
    board.addStroke(stroke('b', 1, board));
    expect(before.map((s) => s.id)).toEqual(['a']);
    expect(ids(board)).toEqual(['a', 'b']);
  });
});

describe('change reports', () => {
  test('a fresh stroke on top is an append; anything else is a region', () => {
    const board = new Board();
    const appended: string[] = [];
    const dirty: BBox[] = [];
    board.onAppend = (s) => appended.push(s.id);
    board.onDirty = (_frame, _layer, box) => dirty.push(box);

    board.addStroke(stroke('a', board.takeSeq(), board, 0));
    const b = stroke('b', board.takeSeq(), board, 100);
    board.addStroke(b);
    expect(appended).toEqual(['a', 'b']);
    expect(dirty).toHaveLength(0);

    board.undo();
    expect(dirty).toEqual([b.bbox]);
  });

  test('a big edit is one region per cell', () => {
    const board = new Board();
    const strokes = Array.from({ length: 50 }, (_, i) => stroke(`s${i}`, i, board, i * 20));
    seed(board, strokes);
    const dirty: BBox[] = [];
    board.onDirty = (_frame, _layer, box) => dirty.push(box);
    board.clear();
    expect(dirty).toHaveLength(1);
    expect(dirty[0].minX).toBeLessThanOrEqual(strokes[0].bbox.minX);
    expect(dirty[0].maxX).toBeGreaterThanOrEqual(strokes[49].bbox.maxX);
  });

  test('every stroke joining or leaving is reported, one at a time', () => {
    const board = new Board();
    seed(board, [stroke('s1', 0, board), stroke('s2', 1, board)]);
    const seen: string[] = [];
    board.onMembership = (s, added) => seen.push(`${added ? '+' : '-'}${s.id}`);
    board.addStroke(stroke('x', 2, board));
    board.removeStrokes(new Set(['s1']));
    board.moveItems(new Set(['s2']), new Set(), 1, 1);
    expect(seen).toEqual(['+x', '-s1', '-s2', '+s2']);
  });

  test('a load says everything changed', () => {
    const board = new Board();
    let resets = 0;
    board.whenReset(() => resets++);
    seed(board, [stroke('a', 0, board)]);
    board.scaleAll(2);
    expect(resets).toBe(2);
  });
});
