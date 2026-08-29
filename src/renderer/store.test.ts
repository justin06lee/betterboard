import { describe, expect, test } from 'bun:test';
import { Board } from './store';
import type { BoardImage, Stroke } from './types';

class TestPath2D {
  moveTo(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
  arc(): void {}
  rect(): void {}
  addPath(): void {}
}

Object.assign(globalThis, { Path2D: TestPath2D });

function stroke(id: string, seq: number, board: Board): Stroke {
  return {
    id,
    seq,
    color: '#000000',
    size: 4,
    pen: false,
    brush: 'pen',
    seed: 1,
    layer: board.activeLayer,
    frame: board.activeFrame,
    points: [{ x: 0, y: 0, p: 0.5 }],
    bbox: { minX: -2, minY: -2, maxX: 2, maxY: 2 },
  };
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

describe('Board.clear', () => {
  test('clears ink and images as one undoable operation', () => {
    const board = new Board();
    board.strokes.push(stroke('stroke', 0, board));
    board.images.push(image('image', 1, board));

    board.clear();
    expect(board.strokes).toHaveLength(0);
    expect(board.images).toHaveLength(0);

    board.undo();
    expect(board.strokes.map((item) => item.id)).toEqual(['stroke']);
    expect(board.images.map((item) => item.id)).toEqual(['image']);
    expect(board.canUndo).toBe(false);

    board.redo();
    expect(board.strokes).toHaveLength(0);
    expect(board.images).toHaveLength(0);
  });

  test('restores interleaved frames at their original array positions', () => {
    const board = new Board();
    const activeFrame = board.activeFrame;
    const otherFrame = 'other-frame';
    const activeStroke = stroke('active-stroke', 0, board);
    const otherStroke = { ...stroke('other-stroke', 1, board), frame: otherFrame };
    const activeImage = image('active-image', 2, board);
    const otherImage = { ...image('other-image', 3, board), frame: otherFrame };
    board.frames.push({ id: otherFrame });
    board.activeFrame = activeFrame;
    board.strokes.push(activeStroke, otherStroke);
    board.images.push(activeImage, otherImage);

    board.clear();
    board.undo();

    expect(board.strokes.map((item) => item.id)).toEqual(['active-stroke', 'other-stroke']);
    expect(board.images.map((item) => item.id)).toEqual(['active-image', 'other-image']);
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
    board.strokes.push(a, b, c);

    board.replaceStrokes([
      { index: 0, before: a, after: [a1, a2] },
      { index: 2, before: c, after: [] },
    ]);
    expect(board.strokes.map((item) => item.id)).toEqual(['a1', 'a2', 'b']);

    board.undo();
    expect(board.strokes.map((item) => item.id)).toEqual(['a', 'b', 'c']);

    board.redo();
    expect(board.strokes.map((item) => item.id)).toEqual(['a1', 'a2', 'b']);
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
    expect(board.strokes.map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('Board.addFrame', () => {
  test('preserves stroke/image stacking order when duplicating', () => {
    const board = new Board();
    const first = stroke('first', board.takeSeq(), board);
    const middle = image('middle', board.takeSeq(), board);
    const last = stroke('last', board.takeSeq(), board);
    board.strokes.push(first, last);
    board.images.push(middle);

    const duplicate = board.addFrame(true);
    const order = [
      ...board.strokes.filter((item) => item.frame === duplicate.id).map((item) => ({ kind: 'stroke', seq: item.seq })),
      ...board.images.filter((item) => item.frame === duplicate.id).map((item) => ({ kind: 'image', seq: item.seq })),
    ]
      .sort((a, b) => a.seq - b.seq)
      .map((item) => item.kind);

    expect(order).toEqual(['stroke', 'image', 'stroke']);
  });
});
