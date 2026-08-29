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

// hydrate() decodes through an Image element; tests only need it to not throw.
class TestImage {
  onload: (() => void) | null = null;
  src = '';
}

Object.assign(globalThis, { Path2D: TestPath2D, Image: TestImage });

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

describe('Board.setImageSrc', () => {
  test('swaps the bitmap as one undoable operation', () => {
    const board = new Board();
    const picture = image('picture', 0, board);
    board.images.push(picture);

    board.setImageSrc('picture', 'data:image/png;base64,edited');
    expect(picture.src).toBe('data:image/png;base64,edited');

    board.undo();
    expect(board.images[0].src).toBe('data:image/png;base64,');
    board.redo();
    expect(board.images[0].src).toBe('data:image/png;base64,edited');
  });

  test('an unchanged src records nothing', () => {
    const board = new Board();
    board.images.push(image('picture', 0, board));
    board.setImageSrc('picture', 'data:image/png;base64,');
    expect(board.canUndo).toBe(false);
  });
});

describe('Board.replaceStrokes with image changes', () => {
  test('ink clipping and pixel erasing undo together as one step', () => {
    const board = new Board();
    const a = stroke('a', 0, board);
    const picture = image('picture', 1, board);
    board.strokes.push(a);
    board.images.push(picture);
    picture.src = 'data:image/png;base64,erased'; // the gesture already painted it

    board.replaceStrokes(
      [{ index: 0, before: a, after: [] }],
      [{ id: 'picture', from: 'data:image/png;base64,', to: 'data:image/png;base64,erased' }]
    );
    expect(board.strokes).toHaveLength(0);
    expect(picture.src).toBe('data:image/png;base64,erased');

    board.undo();
    expect(board.strokes.map((item) => item.id)).toEqual(['a']);
    expect(board.images[0].src).toBe('data:image/png;base64,');
    expect(board.canUndo).toBe(false);

    board.redo();
    expect(board.strokes).toHaveLength(0);
    expect(board.images[0].src).toBe('data:image/png;base64,erased');
  });

  test('image-only changes still make an undoable step', () => {
    const board = new Board();
    const picture = image('picture', 0, board);
    board.images.push(picture);
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

describe('Board.animationBBox', () => {
  test('covers every frame, so an export does not jitter between them', () => {
    const board = new Board();
    const first = board.activeFrame;
    const second = board.addFrame().id;

    board.strokes.push({ ...stroke('a', 0, board), frame: first, bbox: { minX: -10, minY: -10, maxX: 0, maxY: 0 } });
    board.strokes.push({ ...stroke('b', 1, board), frame: second, bbox: { minX: 0, minY: 0, maxX: 40, maxY: 5 } });
    board.images.push({ ...image('c', 2, board), frame: second, x: 50, y: -30, width: 10, height: 10 });

    expect(board.animationBBox()).toEqual({ minX: -10, minY: -30, maxX: 60, maxY: 5 });
  });

  test('ignores frames whose only content sits on a hidden layer', () => {
    const board = new Board();
    const visible = board.activeLayer;
    const hidden = board.addLayer().id;
    const other = board.addFrame().id;

    board.strokes.push({
      ...stroke('shown', 0, board),
      frame: board.frames[0].id,
      layer: visible,
      bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    });
    board.strokes.push({
      ...stroke('ghost', 1, board),
      frame: other,
      layer: hidden,
      bbox: { minX: 500, minY: 500, maxX: 600, maxY: 600 },
    });
    board.setLayerVisible(hidden, false);

    expect(board.animationBBox()).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });

  test('is null for a board with nothing on it', () => {
    expect(new Board().animationBBox()).toBeNull();
  });
});
