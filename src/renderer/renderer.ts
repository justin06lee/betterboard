import { buildPath, strokeHit } from './ink';
import { eraseStrokePoints } from './erase';
import { backgroundSelect, dilate, floodSelect, maskBounds, maskTouchesBorder, similarSelect } from './pixels';
import { drawingToLines } from './ai-drawing';
import type { AiConnection, AiConnectionKind, AiConnectionState } from './global';
import type { Item, Marquee } from './render';
import type { ImageSrcChange, Rect, StrokeReplacement } from './store';
import type { AnimFormat, AnimSettings } from './animation';
import { animationLayout, exportAnimation, gifDelayMs } from './animation';
import { HANDLE, bySeq, drawStroke, exportLayout, paintExport, renderExport, renderRegion } from './render';
import type { Ghost, Lift } from './tiles';
import { Compositor, LIFT_DIRECT } from './tiles';
import { Autosave, openBoardFile, saveBoardFile } from './persist';
import { appendPoint, makeStroke, sealPoints, unpackPoints } from './points';
import { Board } from './store';
import type { Clip, Sticker } from './clip';
import { MAX_STICKERS, isSticker, makeClip, placeClip, stickerFromJSON, stickerName, stickerToJSON } from './clip';
import type { Dock, DockSide } from './dock';
import { createDock, isDockSide } from './dock';
import type { GripMode } from './transform';
import {
  OPPOSITE,
  bboxRect,
  boxAffine,
  boxGrips,
  gripMode,
  mapPoint,
  resizeCursor,
  resizeRect,
  transformRect,
  transformStroke,
} from './transform';
import type { HSV } from './color';
import { hexToRgb, hsvToRgb, parseColor, pushRecent, rgbToHex, rgbToHsv } from './color';
import type { BBox, BoardImage, BrushId, Camera, Point, Stroke, StrokePoint } from './types';
import {
  BRUSHES,
  BRUSH_ORDER,
  MAX_FPS,
  MIN_FPS,
  MIN_SCALE,
  ONION_AFTER,
  ONION_BEFORE,
  THEMES,
  anchorCamera,
  bboxIntersects,
  clampScale,
  emptyBBox,
  growBBox,
  pointInPolygon,
  polygonBBox,
  toWorld,
  MAX_IMAGE_DIM,
  imageBBox,
  toScreen,
  imageHit,
  isBrush,
  mirrorView,
  toWorldDelta,
  uid,
} from './types';

type Tool = 'pen' | 'eraser' | 'fill' | 'select' | 'wand' | 'picker' | 'ask' | 'hand';
type ThemeName = 'dark' | 'light';
type EraserMode = 'stroke' | 'area';
type WandMode = 'point' | 'background';
type FillMode = 'region' | 'similar';
type Persona = 'student' | 'artist' | 'animator' | 'photo' | 'anything';

const TIMELINE_H = 68; // px, mirrors --timeline-h
const ERASER_RADIUS = 16; // screen px
const MIN_DIST = 0.75; // screen px between recorded points
const LASSO_MIN_DIST = 2.5; // screen px between recorded lasso points
const TAP_SLOP = 6; // screen px: a lasso smaller than this counts as a tap
const ENCLOSED = 0.7; // fraction of a stroke's points that must fall inside the lasso
const SWATCHES = ['#e8eaed', '#1e1e24', '#ef476f', '#ffb703', '#06d6a0', '#4cc9f0', '#a78bfa'];
const EMPTY_BOARD = '{"app":"betterboard","version":1,"strokes":[]}';
// Where a pasted or duplicated copy lands relative to the original, in screen
// pixels, when there is no pointer to put it under: far enough to see that
// something happened, near enough to still be one gesture from where it was.
const NUDGE = 18;

// ---- state ----------------------------------------------------------------

const board = new Board();
const camera: Camera = { x: 0, y: 0, scale: 1, rotation: 0, flip: false };
let tool: Tool = 'pen';
let color = SWATCHES[0];
let brush: BrushId = 'pen';
let size = 6;
let themeName: ThemeName = 'dark';
let grid = true;
let eraserMode: EraserMode = 'stroke';
let layersOpen = true;
let stickersOpen = false;
let timelineOpen = false;
let playing = false;
let loop = true;
let dockSide: DockSide = 'top';

let wandMode: WandMode = 'point';
let wandTolerance = 32;
let fillMode: FillMode = 'region';
let fillTolerance = 26;

// Colours reached for lately, most recent first. Kept in prefs rather than the
// board: it is how you work, not what you drew.
let recent: string[] = [];

// The board's own clipboard. `clipMark` is the picture that was put on the
// system clipboard alongside it; if the system clipboard still holds exactly
// that, the copy is still ours and paste can bring back real strokes instead
// of a flat picture of them.
let clipboard: Clip | null = null;
let clipMark: string | null = null;

let stickers: Sticker[] = [];

let live: Stroke | null = null;
// Its outline, rebuilt at most once a frame however many pointer events
// arrived since the last one.
let livePath: Path2D | null = null;
let liveDirty = false;
let spaceHeld = false;
let eraserCursor: { x: number; y: number } | null = null;
const erasePending = new Set<string>();
const areaEraseChanges = new Map<string, StrokeReplacement>();
let areaEraseLast: Point | null = null;
// Pictures the current area-erase gesture is carving pixels out of. Each entry
// holds the working canvas the gesture paints into and the bitmap to undo to.
const imageErase = new Map<string, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; before: string }>();

// The wand's pixel selection: a mask over one picture's bitmap, plus the
// tinted overlay canvas that shows it. Cleared by anything that could move the
// pixels out from under it.
let wandSel: { imageId: string; mask: Uint8Array; width: number; height: number; overlay: HTMLCanvasElement } | null = null;

// The lasso path while it is being drawn, then the committed selection it
// produced. Both live in world coordinates, so they stay put under pan, zoom
// and rotation without any bookkeeping. `loop` marks an outline that is the
// lasso as drawn; any other selection is outlined by its box, worked out fresh
// from what it holds every time it is drawn — until it is reshaped, when `box`
// keeps the box exactly as it was let go (see selectionBox).
interface BoardSelection {
  ids: Set<string>;
  images: Set<string>;
  poly: Point[];
  loop?: boolean;
  box?: Rect;
}
let lasso: Point[] | null = null;
let selection: BoardSelection | null = null;
let moveX = 0;
let moveY = 0;
let hoverInSelection = false;
let hoverHandle: string | null = null;
let dashOffset = 0;
let antsTimer: number | undefined;

// A grip being dragged. Everything is reshaped from the originals each frame,
// never from the frame before, so nothing drifts however long the drag runs.
interface Reshape {
  kind: 'transform';
  from: Rect; // the selection's box when the grip was taken
  to: Rect; // where the box has been dragged
  anchor: Point; // the grip across from the one in hand
  mode: GripMode;
  cursor: string;
  strokes: Stroke[]; // the originals
  images: Map<string, Rect>; // each picture's rectangle at the start
  preview: Map<string, Stroke>; // reshaped copies standing in on screen
  stale: boolean; // `to` has moved since the preview was built
  // Too much ink to rebuild at pointer speed: the originals are drawn through
  // a stretched canvas instead, and rebuilt once, when the drag ends.
  affine: boolean;
}

type Drag =
  | { kind: 'draw' }
  | { kind: 'erase' }
  | { kind: 'lasso' }
  | { kind: 'move'; startX: number; startY: number }
  | { kind: 'region'; x0: number; y0: number }
  | Reshape
  | { kind: 'pan'; startX: number; startY: number; camX: number; camY: number };
let drag: Drag | null = null;
let activePointer: number | null = null;

// Where the pointer last was over the board, in css pixels. The loupe follows
// it, and a paste with no drop point of its own lands under it.
let lastPointer: Point | null = null;
// The picker can be a tool you switch to or a key you lean on; either way the
// magnifier comes up and the next click takes the colour.
let pickerHeld = false;
let pickedFrom: Tool | null = null; // tool to fall back to once a pick is made

let cssWidth = 0;
let cssHeight = 0;

// ---- dom ------------------------------------------------------------------

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { desynchronized: true, alpha: false })!;
// The board's painted tiles; see tiles.ts.
const compositor = new Compositor(board);
const $ = (id: string) => document.getElementById(id)!;
// 'pen' is not here: the draw tool is represented by whichever brush button is
// lit, so it is tracked separately.
const toolButtons: Record<Exclude<Tool, 'pen'>, HTMLElement> = {
  eraser: $('tool-eraser'),
  fill: $('tool-fill'),
  select: $('tool-select'),
  wand: $('tool-wand'),
  picker: $('tool-picker'),
  ask: $('tool-ask'),
  hand: $('tool-hand'),
};
const toolSettings = $('tool-settings');
const eraserModes = $('eraser-modes');
const eraserModeButtons = [...eraserModes.querySelectorAll<HTMLButtonElement>('[data-eraser-mode]')];
const wandModes = $('wand-modes');
const wandModeButtons = [...wandModes.querySelectorAll<HTMLButtonElement>('[data-wand-mode]')];
const wandToleranceInput = $('wand-tolerance') as HTMLInputElement;
const fillModes = $('fill-modes');
const fillModeButtons = [...fillModes.querySelectorAll<HTMLButtonElement>('[data-fill-mode]')];
const fillToleranceInput = $('fill-tolerance') as HTMLInputElement;
const wandActions = $('wand-actions');
const selActions = $('sel-actions');
const selHint = $('sel-hint');
const welcomeEl = $('welcome');
const brushButtons: Record<BrushId, HTMLElement> = {
  pen: $('tool-pen'),
  pixel: $('brush-pixel'),
  marker: $('brush-marker'),
  paint: $('brush-paint'),
  chalk: $('brush-chalk'),
  liner: $('brush-liner'),
};
const swatchesEl = $('swatches');
const colorChip = $('color-chip');
const colorChipDot = $('color-chip-dot');
const sizeChip = $('size-chip');
const sizeChipLabel = $('size-chip-label');
const sizeInput = $('size-input') as HTMLInputElement;
const sizeNumber = $('size-number') as HTMLInputElement;
const sizeReadout = $('size-readout');
const sizePad = $('size-pad') as HTMLCanvasElement;
const sizeDot = $('size-dot');
const scrim = $('scrim');
const colorPop = $('color-pop');
const svCanvas = $('cp-sv') as HTMLCanvasElement;
const hueInput = $('cp-hue') as HTMLInputElement;
const cpPreview = $('cp-preview');
const cpHex = $('cp-hex') as HTMLInputElement;
const cpR = $('cp-r') as HTMLInputElement;
const cpG = $('cp-g') as HTMLInputElement;
const cpB = $('cp-b') as HTMLInputElement;
const cpRecent = $('cp-recent');
const cpPick = $('cp-pick');
const recentBtn = $('recent-btn');
const recentPop = $('recent-pop');
const recentGrid = $('recent-grid');
const sizePop = $('size-pop');
const loupeEl = $('loupe');
const loupeCanvas = $('loupe-canvas') as HTMLCanvasElement;
const loupeSwatch = $('loupe-swatch');
const loupeHex = $('loupe-hex');
const stickersPanel = $('stickers');
const stickersBtn = $('stickers-btn');
const stickerList = $('sticker-list');
const stickersEmpty = $('stickers-empty');
const toastEl = $('toast');
const undoBtn = $('undo') as HTMLButtonElement;
const redoBtn = $('redo') as HTMLButtonElement;
const gridBtn = $('grid-btn');
const themeBtn = $('theme-btn');
const zoomLabel = $('zoom-label');
const normalizeBtn = $('normalize') as HTMLButtonElement;
const layersBtn = $('layers-btn');
const layersPanel = $('layers');
const layerList = $('layer-list');
const layerAddBtn = $('layer-add') as HTMLButtonElement;
const layerDeleteBtn = $('layer-delete') as HTMLButtonElement;
const layerOpacityInput = $('layer-opacity') as HTMLInputElement;
const layerOpacityVal = $('layer-opacity-val');
const timelineBtn = $('timeline-btn');
const timelineEl = $('timeline');
const frameStrip = $('frame-strip');
const frameLabel = $('frame-label');
const playBtn = $('play');
const loopBtn = $('loop-btn');
const fpsInput = $('fps') as HTMLInputElement;
const onionBtn = $('onion-btn');
const onionPanel = $('onion-panel');
const onionBefore = $('onion-before') as HTMLInputElement;
const onionAfter = $('onion-after') as HTMLInputElement;
const onionOpacity = $('onion-opacity') as HTMLInputElement;
const onionTint = $('onion-tint') as HTMLInputElement;

// ---- rendering loop -------------------------------------------------------

let dirty = false;
function requestRender(): void {
  if (dirty) return;
  dirty = true;
  requestAnimationFrame(() => {
    dirty = false;
    drawFrame();
  });
}

// One frame. The board comes out of the tile cache, so only what is moving —
// the live stroke, a dragged selection, the overlays — is drawn fresh, and a
// frame costs the same on an empty board as on a full one.
function drawFrame(): void {
  syncSelectionBar();
  const reshape = drag?.kind === 'transform' ? drag : null;
  if (reshape) refreshReshape(reshape);
  if (live && (liveDirty || !livePath)) {
    livePath = buildPath(live, true);
    liveDirty = false;
  }
  const frame = board.activeFrame;
  compositor.draw(ctx, canvas, camera, {
    theme: THEMES[themeName],
    grid,
    layers: board.layers,
    activeLayer: board.activeLayer,
    frame,
    ghosts: playing ? [] : ghostCache,
    live: live && livePath ? { stroke: live, path: livePath } : null,
    lift: currentLift(),
    eraser:
      (tool === 'eraser' || drag?.kind === 'erase') && eraserCursor
        ? { x: eraserCursor.x, y: eraserCursor.y, radius: ERASER_RADIUS }
        : null,
    marquee: lasso ? { poly: lasso, dx: 0, dy: 0, dashOffset } : selection ? selectionMarquee(selection) : null,
    region: regionDrag ?? region?.quad ?? null,
    wand: wandOverlay(frame),
  });
  // Tiles still to paint for this view: carry on next frame.
  if (compositor.pending) requestRender();
}

function resizeCanvas(): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cssWidth = rect.width;
  cssHeight = rect.height;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  requestRender();
}

// ---- persistence ----------------------------------------------------------

// Writes only what changed since the last save — see persist.ts — so an edit
// on a huge board costs about what it would on an empty one.
const autosave = new Autosave(board, () => fileCamera());
function scheduleAutosave(): void {
  autosave.schedule();
}

const TOOLS: Tool[] = ['pen', 'eraser', 'fill', 'select', 'wand', 'picker', 'ask', 'hand'];

function savePrefs(): void {
  localStorage.setItem(
    'bb:prefs',
    JSON.stringify({
      tool,
      brush,
      color,
      size,
      themeName,
      grid,
      eraserMode,
      wandMode,
      wandTolerance,
      fillMode,
      fillTolerance,
      layersOpen,
      stickersOpen,
      timelineOpen,
      loop,
      dockSide,
      recent,
    })
  );
}

function loadPrefs(): void {
  try {
    const p = JSON.parse(localStorage.getItem('bb:prefs') ?? '{}');
    // The picker is a momentary thing, not a place to be left standing on a
    // fresh launch with a magnifier stuck to the pointer.
    if (TOOLS.includes(p.tool) && p.tool !== 'picker') tool = p.tool;
    if (isBrush(p.brush)) brush = p.brush;
    if (typeof p.color === 'string') color = p.color;
    if (Number.isFinite(p.size)) size = Math.min(28, Math.max(1, p.size));
    if (p.themeName === 'light' || p.themeName === 'dark') themeName = p.themeName;
    if (typeof p.grid === 'boolean') grid = p.grid;
    if (p.eraserMode === 'stroke' || p.eraserMode === 'area') eraserMode = p.eraserMode;
    if (p.wandMode === 'point' || p.wandMode === 'background') wandMode = p.wandMode;
    if (Number.isFinite(p.wandTolerance)) wandTolerance = Math.min(120, Math.max(0, p.wandTolerance));
    if (p.fillMode === 'region' || p.fillMode === 'similar') fillMode = p.fillMode;
    if (Number.isFinite(p.fillTolerance)) fillTolerance = Math.min(120, Math.max(0, p.fillTolerance));
    if (typeof p.layersOpen === 'boolean') layersOpen = p.layersOpen;
    if (typeof p.stickersOpen === 'boolean') stickersOpen = p.stickersOpen;
    if (typeof p.timelineOpen === 'boolean') timelineOpen = p.timelineOpen;
    if (typeof p.loop === 'boolean') loop = p.loop;
    if (isDockSide(p.dockSide)) dockSide = p.dockSide;
    if (Array.isArray(p.recent)) recent = p.recent.filter((c: unknown) => typeof c === 'string').slice(0, 24);
  } catch {}
}

// ---- camera ---------------------------------------------------------------

let pulseTimer: number | undefined;
function nudgeNormalize(): void {
  normalizeBtn.classList.add('pulse');
  clearTimeout(pulseTimer);
  pulseTimer = window.setTimeout(() => normalizeBtn.classList.remove('pulse'), 1600);
}

function zoomAt(sx: number, sy: number, factor: number): void {
  if (factor < 1 && camera.scale <= MIN_SCALE) nudgeNormalize();
  const w = toWorld(camera, sx, sy);
  camera.scale = clampScale(camera.scale * factor);
  anchorCamera(camera, w, sx, sy);
  updateZoomLabel();
  requestRender();
  scheduleAutosave();
}

function zoomTo(scale: number): void {
  const cx = cssWidth / 2;
  const cy = cssHeight / 2;
  const w = toWorld(camera, cx, cy);
  camera.scale = clampScale(scale);
  anchorCamera(camera, w, cx, cy);
  updateZoomLabel();
  requestRender();
  scheduleAutosave();
}

function zoomFit(): void {
  camera.rotation = 0; // fit re-frames everything axis-aligned
  updateWheel();
  const b = board.contentBBox(board.visibleStrokes(), board.visibleImages());
  // Placed by anchoring rather than by arithmetic on the corner, so it lands
  // centred whether or not the view is mirrored.
  if (!b) {
    camera.scale = 1;
    anchorCamera(camera, { x: 0, y: 0 }, cssWidth / 2, cssHeight / 2);
  } else {
    const pad = 80;
    const w = Math.max(b.maxX - b.minX, 1);
    const h = Math.max(b.maxY - b.minY, 1);
    camera.scale = clampScale(
      Math.min((cssWidth - pad * 2) / w, (cssHeight - pad * 2) / h, 4)
    );
    anchorCamera(camera, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, cssWidth / 2, cssHeight / 2);
  }
  updateZoomLabel();
  requestRender();
  scheduleAutosave();
}

function updateZoomLabel(): void {
  zoomLabel.textContent = `${Math.round(camera.scale * 100)}%`;
}

// Rebases the world so the current view becomes the new 100%: every stored
// point and stroke size is multiplied by the current scale, the camera
// compensates, and nothing moves on screen — but the full zoom range is
// available again from here.
function normalize(): void {
  if (drag || live || camera.scale === 1) return;
  clearSelection(); // every world coordinate is about to change
  const f = camera.scale;
  board.scaleAll(f);
  camera.x *= f;
  camera.y *= f;
  camera.scale = 1;
  updateZoomLabel();
  requestRender();
  scheduleAutosave();
}

// Scale ops change world coordinates, so undo/redo of one must counter-move
// the camera to keep the view visually anchored.
function doUndo(): void {
  const op = board.undo();
  if (!op) return;
  if (op.type === 'scale') {
    camera.x /= op.factor;
    camera.y /= op.factor;
    camera.scale = clampScale(camera.scale * op.factor);
    updateZoomLabel();
    requestRender();
  } else {
    afterEdit(op.type === 'move' ? { ids: op.ids, dx: -op.dx, dy: -op.dy } : null, op.type);
  }
}

function doRedo(): void {
  const op = board.redo();
  if (!op) return;
  if (op.type === 'scale') {
    camera.x *= op.factor;
    camera.y *= op.factor;
    camera.scale = clampScale(camera.scale / op.factor);
    updateZoomLabel();
    requestRender();
  } else {
    afterEdit(op.type === 'move' ? { ids: op.ids, dx: op.dx, dy: op.dy } : null, op.type);
  }
}

// Undoing a move should leave the outline wrapped around the strokes it holds;
// any other edit can invalidate what is selected, so the selection is dropped.
function afterEdit(moved: { ids: string[]; dx: number; dy: number } | null, kind?: string): void {
  clearWandSelection(); // any edit can move the pixels out from under the mask
  const sel = selection;
  if (!sel) return;
  if (moved && moved.ids.length === sel.ids.size && moved.ids.every((id) => sel.ids.has(id))) {
    shiftSelection(sel, moved.dx, moved.dy);
    requestRender();
    return;
  }
  // A reshape keeps every id it touched, so undoing or redoing one leaves the
  // selection good — only its box changed, and the outline follows the box.
  if (kind === 'transform') {
    sel.box = undefined; // measured afresh from the ink it now holds
    const box = selectionBox();
    if (box) {
      sel.loop = false;
      sel.poly = boxPoly(box);
      requestRender();
      return;
    }
  }
  clearSelection();
}

// ---- rotation wheel ---------------------------------------------------------

const rotWheel = $('rot-wheel');
const rotKnob = $('rot-knob');
const rotLabel = $('rot-label');
let rHeld = false;
let rotDragging = false;
let rotGrabAngle = 0;
let rotStart = 0;

function updateWheel(): void {
  rotWheel.classList.toggle('hidden', !(rHeld || rotDragging));
  const deg = (camera.rotation * 180) / Math.PI;
  rotKnob.style.transform = `rotate(${deg}deg) translateY(-70px)`;
  rotLabel.textContent = `${Math.round(((deg % 360) + 360) % 360)}°`;
}

function setRotation(theta: number): void {
  const step = Math.PI / 4;
  const nearest = Math.round(theta / step) * step;
  if (Math.abs(theta - nearest) < (4 * Math.PI) / 180) theta = nearest;
  // Pivot around the screen center: the world point there stays put.
  const cx = cssWidth / 2;
  const cy = cssHeight / 2;
  const w = toWorld(camera, cx, cy);
  camera.rotation = theta;
  anchorCamera(camera, w, cx, cy);
  updateWheel();
  requestRender();
  scheduleAutosave();
}

// Pointer angle around the wheel center, clockwise from 12 o'clock.
function wheelPointerAngle(e: PointerEvent): number {
  const r = rotWheel.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  return Math.atan2(dx, -dy);
}

rotWheel.addEventListener('pointerdown', (e) => {
  rotDragging = true;
  rotGrabAngle = wheelPointerAngle(e);
  rotStart = camera.rotation;
  rotWheel.setPointerCapture(e.pointerId);
  e.preventDefault();
});
rotWheel.addEventListener('pointermove', (e) => {
  if (!rotDragging) return;
  setRotation(rotStart + wheelPointerAngle(e) - rotGrabAngle);
});
function endRotDrag(): void {
  if (!rotDragging) return;
  rotDragging = false;
  camera.rotation = Math.atan2(Math.sin(camera.rotation), Math.cos(camera.rotation));
  updateWheel();
}
rotWheel.addEventListener('pointerup', endRotDrag);
rotWheel.addEventListener('pointercancel', endRotDrag);
rotWheel.addEventListener('dblclick', () => setRotation(0));

// ---- mirrored view ----------------------------------------------------------

// Flipping is how an artist catches what their eye has stopped seeing: a lean,
// a face drifting to one side, an arm too long. It changes only how the board
// is looked at — strokes, exports and saved files all stay the right way round.
const flipBtn = $('flip-btn');
const flipBadge = $('flip-badge');
let flippedBy: 'h' | 'v' = 'h'; // so the badge undoes whichever flip is showing

function flipView(axis: 'h' | 'v'): void {
  if (drag || live) return; // the pointer's world position would jump mid-gesture
  if (!camera.flip) flippedBy = axis;
  mirrorView(camera, cssWidth / 2, cssHeight / 2, axis);
  syncFlip();
  updateWheel();
  requestRender();
  if (!camera.flip) toast('Canvas flipped back');
  else toast(axis === 'h' ? 'Canvas flipped — M flips it back' : 'Canvas flipped upside down — ⇧M flips it back');
}

function syncFlip(): void {
  flipBtn.classList.toggle('active', camera.flip === true);
  flipBadge.classList.toggle('hidden', !camera.flip);
}

// A file never records a mirrored view. It writes down the same spot the right
// way round, so a board always reopens reading correctly.
function fileCamera(): Camera {
  if (!camera.flip) return camera;
  const unflipped = { ...camera };
  mirrorView(unflipped, cssWidth / 2, cssHeight / 2, flippedBy);
  return unflipped;
}

flipBtn.addEventListener('click', () => flipView('h'));
flipBadge.addEventListener('click', () => flipView(flippedBy));

// ---- ui sync --------------------------------------------------------------

function setTool(t: Tool): void {
  const previous = tool;
  tool = t;
  for (const [name, el] of Object.entries(toolButtons)) {
    el.classList.toggle('active', name === t);
  }
  syncBrushButtons();
  eraserModes.classList.toggle('hidden', t !== 'eraser');
  wandModes.classList.toggle('hidden', t !== 'wand');
  fillModes.classList.toggle('hidden', t !== 'fill');
  toolSettings.classList.toggle('hidden', t !== 'eraser' && t !== 'wand' && t !== 'fill');
  placeToolSettings();
  if (t !== 'eraser') eraserCursor = null;
  if (t !== 'select') clearSelection(); // also drops any wand selection
  else clearWandSelection(); // the lasso survives, but the wand mask belongs to its tool
  // Leaving the picker by any route other than taking a colour drops the loupe
  // and the memory of where it was meant to go back to.
  if (t !== 'picker' && previous === 'picker') pickedFrom = null;
  syncPicker();
  updateCursor();
  savePrefs();
  requestRender();
}

function setWandMode(mode: WandMode): void {
  wandMode = mode;
  for (const button of wandModeButtons) {
    button.classList.toggle('active', button.dataset.wandMode === mode);
  }
  toolButtons.wand.title = mode === 'point'
    ? 'Magic wand (W) — click a picture to select its color region'
    : 'Magic wand (W) — click a picture to select its whole background';
  savePrefs();
}

function setFillMode(mode: FillMode): void {
  fillMode = mode;
  for (const button of fillModeButtons) {
    button.classList.toggle('active', button.dataset.fillMode === mode);
  }
  toolButtons.fill.title = mode === 'region'
    ? 'Fill (F) — click a closed shape to flood it with the current colour'
    : 'Fill (F) — recolours every matching pixel in view, connected or not';
  savePrefs();
}

function setEraserMode(mode: EraserMode): void {
  eraserMode = mode;
  for (const button of eraserModeButtons) {
    button.classList.toggle('active', button.dataset.eraserMode === mode);
  }
  toolButtons.eraser.title = mode === 'stroke'
    ? 'Eraser (E) — remove whole strokes'
    : 'Eraser (E) — erase ink and image pixels under the circle';
  savePrefs();
}

function syncBrushButtons(): void {
  for (const id of BRUSH_ORDER) {
    brushButtons[id].classList.toggle('active', tool === 'pen' && id === brush);
  }
}

function setBrush(id: BrushId): void {
  brush = id;
  if (tool !== 'pen') setTool('pen');
  else syncBrushButtons();
  setSize(size); // the size dot means different things to different brushes
  savePrefs();
}

function setColor(c: string, remember = false): void {
  color = c;
  colorChipDot.style.background = c;
  colorChip.title = `Colour ${c.toUpperCase()} — click to open the picker`;
  for (const el of swatchesEl.children) {
    el.classList.toggle('active', (el as HTMLElement).dataset.color?.toLowerCase() === c.toLowerCase());
  }
  if (remember) {
    recent = pushRecent(recent, c);
    renderRecents();
  }
  syncPickerFields();
  savePrefs();
}

// The size the brush actually paints, which is not the number on the slider:
// every brush scales it differently, and telling someone "6" when the marker
// lays down ten board pixels is the kind of small lie that makes a slider
// feel untrustworthy.
function brushPixels(v = size, id: BrushId = brush): number {
  return Math.max(1, Math.round(v * BRUSHES[id].sizeScale));
}

function setSize(v: number): void {
  size = v;
  const d = Math.min(18, Math.max(3, v * BRUSHES[brush].sizeScale * 0.75));
  sizeDot.style.width = `${d}px`;
  sizeDot.style.height = `${d}px`;
  sizeDot.style.borderRadius = brush === 'pixel' ? '2px' : '50%';
  const px = brushPixels();
  sizeChipLabel.innerHTML = `${px}<i>px</i>`;
  sizeReadout.textContent = `${px} px · ${BRUSHES[brush].label}`;
  if (document.activeElement !== sizeInput) sizeInput.value = String(v);
  if (document.activeElement !== sizeNumber) sizeNumber.value = String(v);
  syncSlider(sizeInput);
  savePrefs();
}

function applyTheme(): void {
  document.body.classList.toggle('light', themeName === 'light');
  themeBtn.classList.toggle('active', themeName === 'light');
  requestRender();
}

function toggleTheme(): void {
  const oldInk = THEMES[themeName].ink;
  themeName = themeName === 'dark' ? 'light' : 'dark';
  if (color === oldInk) setColor(THEMES[themeName].ink);
  applyTheme();
  savePrefs();
}

function updateUndoButtons(): void {
  undoBtn.disabled = !board.canUndo;
  redoBtn.disabled = !board.canRedo;
}

function updateCursor(): void {
  if (drag?.kind === 'pan') canvas.style.cursor = 'grabbing';
  else if (drag?.kind === 'move') canvas.style.cursor = 'grabbing';
  else if (drag?.kind === 'transform') canvas.style.cursor = drag.cursor;
  else if (pickerActive()) canvas.style.cursor = 'none'; // the loupe is the cursor
  else if (tool === 'select' && hoverHandle) canvas.style.cursor = hoverHandle;
  else if (spaceHeld || tool === 'hand') canvas.style.cursor = 'grab';
  else if (tool === 'eraser') canvas.style.cursor = 'none';
  else if (tool === 'select' && hoverInSelection) canvas.style.cursor = 'move';
  else canvas.style.cursor = 'crosshair';
}

// ---- drawing --------------------------------------------------------------

function pressureOf(e: PointerEvent): number {
  return e.pointerType === 'pen' ? Math.max(e.pressure, 0.02) : 0.5;
}

function addLivePoint(e: PointerEvent): boolean {
  if (!live) return false;
  const w = toWorld(camera, e.offsetX, e.offsetY);
  const p = pressureOf(e);
  if (live.n > 0) {
    const j = (live.n - 1) * 3;
    const dx = (w.x - (live.ox + live.pts[j])) * camera.scale;
    const dy = (w.y - (live.oy + live.pts[j + 1])) * camera.scale;
    if (dx * dx + dy * dy < MIN_DIST * MIN_DIST) {
      // Keep pressure fresh even when the pen barely moves.
      live.pts[j + 2] = Math.max(live.pts[j + 2], p);
      return false;
    }
  }
  appendPoint(live, w.x, w.y, p);
  return true;
}

function startStroke(e: PointerEvent): void {
  const w = toWorld(camera, e.offsetX, e.offsetY);
  live = {
    id: uid(),
    seq: board.takeSeq(),
    color,
    size: size * BRUSHES[brush].sizeScale,
    pen: e.pointerType === 'pen',
    brush,
    seed: (Math.random() * 0xffffffff) >>> 0,
    layer: board.activeLayer,
    frame: board.activeFrame,
    ox: w.x,
    oy: w.y,
    pts: new Float32Array(96),
    n: 0,
    bbox: emptyBBox(),
  };
  appendPoint(live, w.x, w.y, pressureOf(e));
  livePath = buildPath(live, true);
  liveDirty = false;
  requestRender();
}

// The stroke joins the board and is painted straight onto its tiles; from
// the next frame on it costs nothing to show.
function finishStroke(): void {
  if (!live) return;
  const done = live;
  live = null;
  livePath = null;
  sealPoints(done);
  board.addStroke(done);
}

// Every edit is confined to the active cell of the frame x layer grid — that
// is what layers are for, and it keeps a traced-over sketch safe underneath.
// The board's index answers for just the neighbourhood asked about.
function editableNear(box: BBox): Stroke[] {
  return board.query(board.activeFrame, board.activeLayer, box);
}

function eraseAt(e: PointerEvent): void {
  const w = toWorld(camera, e.offsetX, e.offsetY);
  const radius = ERASER_RADIUS / camera.scale;
  const near = { minX: w.x - radius, minY: w.y - radius, maxX: w.x + radius, maxY: w.y + radius };
  for (const s of editableNear(near)) {
    if (erasePending.has(s.id) || !strokeHit(s, w.x, w.y, radius)) continue;
    erasePending.add(s.id);
    compositor.invalidate(s.frame, s.layer, s.bbox);
  }
}

function fragmentStroke(stroke: Stroke, points: StrokePoint[][]): Stroke[] {
  return points.map((fragment) => makeStroke({ ...stroke, id: uid() }, fragment));
}

function eraseAreaAt(e: PointerEvent): void {
  const point = toWorld(camera, e.offsetX, e.offsetY);
  const path = areaEraseLast ? [areaEraseLast, point] : [point];
  const radius = ERASER_RADIUS / camera.scale;
  const eraserBox = {
    minX: Math.min(point.x, areaEraseLast?.x ?? point.x) - radius,
    minY: Math.min(point.y, areaEraseLast?.y ?? point.y) - radius,
    maxX: Math.max(point.x, areaEraseLast?.x ?? point.x) + radius,
    maxY: Math.max(point.y, areaEraseLast?.y ?? point.y) + radius,
  };
  // What has to be repainted: the eraser's own sweep, and every stroke it cut.
  const repaint = { ...eraserBox };

  for (const original of editableNear(eraserBox)) {
    const previous = areaEraseChanges.get(original.id)?.after ?? [original];
    const after: Stroke[] = [];
    let changed = false;
    for (const fragment of previous) {
      if (!bboxIntersects(fragment.bbox, eraserBox)) {
        after.push(fragment);
        continue;
      }
      const result = eraseStrokePoints(unpackPoints(fragment), path, radius + fragment.size / 2);
      if (!result.changed) {
        after.push(fragment);
        continue;
      }
      changed = true;
      after.push(...fragmentStroke(fragment, result.fragments));
    }
    if (!changed) continue;
    areaEraseChanges.set(original.id, { before: original, after });
    growBBox(repaint, original.bbox.minX, original.bbox.minY, 0);
    growBBox(repaint, original.bbox.maxX, original.bbox.maxY, 0);
  }
  // The same pass carves pixels out of any picture it crosses — erasing feels
  // the same on a photograph as it does on ink, with no mode to enter first.
  for (const image of board.cellImages(board.activeFrame, board.activeLayer)) {
    if (!bboxIntersects(imageBBox(image), eraserBox)) continue;
    eraseImagePixels(image, path, radius);
  }
  areaEraseLast = point;
  compositor.invalidate(board.activeFrame, board.activeLayer, repaint);
}


// The first touch swaps the picture's bitmap for a working canvas; every
// following segment is punched straight out of it, so the hole appears under
// the eraser as it moves. The bitmap swap is committed once, at gesture end.
function eraseImagePixels(image: BoardImage, path: Point[], radius: number): void {
  let entry = imageErase.get(image.id);
  if (!entry) {
    if (!image.el) return; // still decoding; nothing visible to erase yet
    const { width, height } = naturalSize(image.el);
    if (!width || !height) return;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const c = canvas.getContext('2d')!;
    c.drawImage(image.el, 0, 0, width, height);
    entry = { canvas, ctx: c, before: image.src };
    imageErase.set(image.id, entry);
    image.el = canvas;
  }
  const c = entry.ctx;
  c.save();
  // World → bitmap transform: under it the eraser capsule is drawn in world
  // units and still lands on the right pixels, even on a stretched picture.
  c.scale(entry.canvas.width / image.width, entry.canvas.height / image.height);
  c.translate(-image.x, -image.y);
  c.globalCompositeOperation = 'destination-out';
  c.fillStyle = '#000';
  c.strokeStyle = '#000';
  c.lineWidth = radius * 2;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  if (path.length === 1) {
    c.arc(path[0].x, path[0].y, radius, 0, Math.PI * 2);
    c.fill();
  } else {
    c.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) c.lineTo(path[i].x, path[i].y);
    c.stroke();
  }
  c.restore();
}

// Encodes each carved picture once, at gesture end, and reports the swaps so
// they join the same undo step as the ink the gesture clipped.
function commitImageErase(): ImageSrcChange[] {
  const changes: ImageSrcChange[] = [];
  for (const [id, entry] of imageErase) {
    changes.push({ id, from: entry.before, to: entry.canvas.toDataURL('image/png') });
  }
  imageErase.clear();
  return changes;
}

function beginErase(e: PointerEvent): void {
  eraserCursor = { x: e.offsetX, y: e.offsetY };
  // Until the gesture ends, the active cell shows the board as the eraser has
  // left it: whole strokes gone, clipped ones swapped for their fragments.
  compositor.setOverride(
    board.activeFrame,
    board.activeLayer,
    (s) => (erasePending.has(s.id) ? [] : areaEraseChanges.get(s.id)?.after),
    null
  );
  if (eraserMode === 'area') {
    areaEraseChanges.clear();
    imageErase.clear();
    areaEraseLast = null;
    eraseAreaAt(e);
  } else {
    eraseAt(e);
  }
}

// ---- animation ------------------------------------------------------------

// Which neighbouring frames to ghost and how strongly, worked out on board
// changes rather than per frame. The ghosts themselves are painted from the
// same tiles those frames show when they are the one being worked on.
let ghostCache: Ghost[] = [];

function refreshGhosts(): void {
  const o = board.onion;
  if (!o.enabled) {
    ghostCache = [];
    return;
  }
  const out: Ghost[] = [];
  const here = board.frameIndex;
  // Farthest first, so the nearest neighbour ends up on top of the pile.
  const push = (distance: number, direction: -1 | 1) => {
    const i = here + distance * direction;
    if (i < 0 || i >= board.frames.length) return;
    out.push({
      frame: board.frames[i].id,
      alpha: o.opacity * Math.pow(0.55, distance - 1),
      tint: o.tint ? (direction < 0 ? ONION_BEFORE : ONION_AFTER) : null,
    });
  };
  for (let d = o.before; d >= 1; d--) push(d, -1);
  for (let d = o.after; d >= 1; d--) push(d, 1);
  ghostCache = out;
}

// Called on every board change, so it first checks whether anything it shows
// has changed at all — a new stroke almost never changes the timeline.
let timelineKey = '';
function renderTimeline(): void {
  if (frameDrag?.moved) return;
  const n = board.frames.length;
  const here = board.frameIndex;
  frameLabel.textContent = `${here + 1} / ${n}`;

  const filled = new Set(board.frames.filter((f) => board.count(f.id) > 0).map((f) => f.id));
  const key = [
    board.activeFrame,
    ...board.frames.map((f) => (filled.has(f.id) ? `+${f.id}` : f.id)),
    playing,
    loop,
    board.onion.enabled,
    board.fps,
  ].join('|');
  if (key === timelineKey) return;
  timelineKey = key;
  frameStrip.textContent = '';
  board.frames.forEach((f, i) => {
    const cell = document.createElement('button');
    cell.className =
      'frame-cell' + (f.id === board.activeFrame ? ' active' : '') + (filled.has(f.id) ? ' filled' : '');
    cell.dataset.id = f.id;
    cell.textContent = String(i + 1);
    cell.title = `Frame ${i + 1}`;
    cell.addEventListener('pointerdown', (e) => beginFrameDrag(e, f.id));
    frameStrip.appendChild(cell);
  });

  ($('frame-del') as HTMLButtonElement).disabled = n <= 1;
  playBtn.classList.toggle('on', playing);
  playBtn.innerHTML = playing
    ? '<svg viewBox="0 0 24 24"><path d="M8 5.5h3.2v13H8zM12.8 5.5H16v13h-3.2z" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor"/></svg>';
  loopBtn.classList.toggle('on', loop);
  onionBtn.classList.toggle('on', board.onion.enabled);
  if (document.activeElement !== fpsInput) fpsInput.value = String(board.fps);
}

// Keeping the active cell in view matters most during playback, where the
// strip would otherwise run away from the frame being shown.
function scrollFrameIntoView(): void {
  const cell = frameStrip.querySelector<HTMLElement>('.frame-cell.active');
  if (!cell) return;
  const strip = frameStrip.getBoundingClientRect();
  const r = cell.getBoundingClientRect();
  if (r.left < strip.left) frameStrip.scrollLeft -= strip.left - r.left + 8;
  else if (r.right > strip.right) frameStrip.scrollLeft += r.right - strip.right + 8;
}

let frameDrag: { id: string; startX: number; moved: boolean } | null = null;

function beginFrameDrag(e: PointerEvent, id: string): void {
  if (e.button !== 0) return;
  stopPlayback();
  if (id !== board.activeFrame) clearSelection();
  board.setActiveFrame(id);
  frameDrag = { id, startX: e.clientX, moved: false };
  frameStrip.setPointerCapture(e.pointerId);
}

frameStrip.addEventListener('pointermove', (e) => {
  if (!frameDrag) return;
  const cell = frameStrip.querySelector<HTMLElement>(`.frame-cell[data-id="${frameDrag.id}"]`);
  if (!cell) return;
  if (!frameDrag.moved) {
    if (Math.abs(e.clientX - frameDrag.startX) < 6) return;
    frameDrag.moved = true;
    cell.classList.add('dragging');
  }
  // Placed by where the pointer is, not by swapping with one neighbour at a
  // time, so a fast flick across several cells lands in the right slot.
  const others = [...frameStrip.querySelectorAll<HTMLElement>('.frame-cell')].filter((c) => c !== cell);
  const target = others.find((c) => {
    const r = c.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2;
  });
  frameStrip.insertBefore(cell, target ?? null);
});

function endFrameDrag(): void {
  if (!frameDrag) return;
  const { id, moved } = frameDrag;
  frameDrag = null;
  if (!moved) return;
  const cells = [...frameStrip.querySelectorAll<HTMLElement>('.frame-cell')];
  board.moveFrame(
    board.frames.findIndex((f) => f.id === id),
    cells.findIndex((c) => c.dataset.id === id)
  );
  timelineKey = ''; // the drag rearranged the cells by hand; lay them out afresh
  renderTimeline();
}

frameStrip.addEventListener('pointerup', endFrameDrag);
frameStrip.addEventListener('pointercancel', endFrameDrag);

// ---- playback -------------------------------------------------------------

let playRaf = 0;
let playAcc = 0;
let playLast = 0;
let playReturnTo: string | null = null;

function startPlayback(): void {
  if (playing || board.frames.length < 2) return;
  playing = true;
  playReturnTo = board.activeFrame; // playing is a preview: it should not move you
  playAcc = 0;
  playLast = performance.now();
  playRaf = requestAnimationFrame(playTick);
  renderTimeline();
  requestRender();
}

function stopPlayback(): void {
  if (!playing) return;
  playing = false;
  cancelAnimationFrame(playRaf);
  if (playReturnTo) board.setActiveFrame(playReturnTo);
  playReturnTo = null;
  refreshGhosts();
  renderTimeline();
  requestRender();
}

function togglePlayback(): void {
  if (playing) stopPlayback();
  else startPlayback();
}

// Time-based rather than one frame per tick, so 12fps plays at 12fps on a
// 120Hz display and a slow frame drops rather than stretches.
function playTick(now: number): void {
  if (!playing) return;
  const step = 1000 / board.fps;
  playAcc += now - playLast;
  playLast = now;
  let advanced = false;
  while (playAcc >= step) {
    playAcc -= step;
    const i = board.frameIndex;
    if (i + 1 >= board.frames.length && !loop) {
      playAcc = 0;
      stopPlayback();
      return;
    }
    board.activeFrame = board.frames[(i + 1) % board.frames.length].id;
    advanced = true;
  }
  if (advanced) {
    renderTimeline();
    scrollFrameIntoView();
    requestRender();
  }
  playRaf = requestAnimationFrame(playTick);
}

function setTimelineOpen(open: boolean): void {
  timelineOpen = open;
  document.body.classList.toggle('timeline-open', open);
  timelineEl.classList.toggle('hidden', !open);
  timelineBtn.classList.toggle('active', open);
  if (!open) {
    stopPlayback();
    onionPanel.classList.add('hidden');
  }
  stackRightPanels();
  savePrefs();
  resizeCanvas();
  renderTimeline();
}

function syncOnionPanel(): void {
  const o = board.onion;
  onionBefore.value = String(o.before);
  onionAfter.value = String(o.after);
  onionOpacity.value = String(Math.round(o.opacity * 100));
  onionTint.checked = o.tint;
  $('onion-before-val').textContent = String(o.before);
  $('onion-after-val').textContent = String(o.after);
  $('onion-opacity-val').textContent = `${Math.round(o.opacity * 100)}%`;
  syncSliders(); // the tracks are painted from the value, so set both together
}

function gotoFrame(delta: number): void {
  stopPlayback();
  clearSelection();
  board.stepFrame(delta);
  scrollFrameIntoView();
}

$('frame-prev').addEventListener('click', () => gotoFrame(-1));
$('frame-next').addEventListener('click', () => gotoFrame(1));
playBtn.addEventListener('click', togglePlayback);
loopBtn.addEventListener('click', () => {
  loop = !loop;
  savePrefs();
  renderTimeline();
});
timelineBtn.addEventListener('click', () => setTimelineOpen(!timelineOpen));
$('frame-add').addEventListener('click', () => {
  stopPlayback();
  clearSelection();
  board.addFrame(false);
  scrollFrameIntoView();
});
$('frame-dup').addEventListener('click', () => {
  stopPlayback();
  clearSelection();
  board.addFrame(true);
  scrollFrameIntoView();
});
$('frame-del').addEventListener('click', () => {
  stopPlayback();
  clearSelection();
  board.removeFrame(board.activeFrame);
});
fpsInput.addEventListener('change', () => {
  board.setFps(Number(fpsInput.value));
  fpsInput.value = String(board.fps);
});

onionBtn.addEventListener('click', () => {
  // First press turns onion skin on and reveals its settings; the next one
  // hides the settings again, and the button stays lit while it is on.
  if (!board.onion.enabled) {
    board.setOnion({ enabled: true });
    onionPanel.classList.remove('hidden');
  } else if (onionPanel.classList.contains('hidden')) {
    onionPanel.classList.remove('hidden');
  } else {
    board.setOnion({ enabled: false });
    onionPanel.classList.add('hidden');
  }
});

for (const [el, key] of [
  [onionBefore, 'before'],
  [onionAfter, 'after'],
  [onionOpacity, 'opacity'],
] as const) {
  el.addEventListener('input', () => {
    const raw = Number(el.value);
    board.setOnion({ [key]: key === 'opacity' ? raw / 100 : raw });
    syncOnionPanel();
  });
}
onionTint.addEventListener('change', () => board.setOnion({ tint: onionTint.checked }));

// ---- layers panel ---------------------------------------------------------

const EYE_ON =
  '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';
const EYE_OFF =
  '<svg viewBox="0 0 24 24"><path d="M4 4l16 16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M9.8 6.1A9.6 9.6 0 0 1 12 5.8c6 0 9.5 6.2 9.5 6.2a17 17 0 0 1-3 3.7M6.6 7.9A16.6 16.6 0 0 0 2.5 12S6 18.2 12 18.2a9.4 9.4 0 0 0 3.3-.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

// Rows are listed top layer first, the way every drawing app shows them, so
// display index and model index are mirror images of each other.
function modelIndex(displayIndex: number): number {
  return board.layers.length - 1 - displayIndex;
}

let layerDrag: { id: string; startY: number; moved: boolean } | null = null;
let renamingId: string | null = null;

// Like the timeline, rebuilt only when something it shows has changed.
let layersKey = '';
function renderLayers(): void {
  if (layerDrag?.moved || renamingId) return; // never yank the DOM out from under an interaction
  const counts = new Map<string, number>();
  for (const layer of board.layers) counts.set(layer.id, board.count(board.activeFrame, layer.id));
  const key = [
    board.activeLayer,
    ...board.layers.map((l) => `${l.id}:${l.name}:${l.visible}:${l.opacity}:${counts.get(l.id)}`),
  ].join('|');
  if (key === layersKey) return;
  layersKey = key;
  layerList.textContent = '';

  for (let i = board.layers.length - 1; i >= 0; i--) {
    const layer = board.layers[i];
    const row = document.createElement('div');
    row.className = 'layer-row' + (layer.id === board.activeLayer ? ' active' : '');
    row.dataset.id = layer.id;

    const eye = document.createElement('button');
    eye.className = 'layer-eye' + (layer.visible ? '' : ' off');
    eye.innerHTML = layer.visible ? EYE_ON : EYE_OFF;
    eye.title = layer.visible ? 'Hide layer' : 'Show layer';
    eye.addEventListener('pointerdown', (e) => e.stopPropagation());
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      board.setLayerVisible(layer.id, !layer.visible);
      if (!layer.visible && layer.id === board.activeLayer) clearSelection();
    });

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.name;
    name.title = `${layer.name} — double-click to rename`;

    const count = document.createElement('span');
    count.className = 'layer-count';
    count.textContent = String(counts.get(layer.id) ?? 0);

    row.append(eye, name, count);
    row.addEventListener('pointerdown', (e) => beginLayerDrag(e, layer.id));
    // Bound on the row, not the name: activating a layer rebuilds these rows
    // between the two clicks, so the pair only shares the row as a target.
    row.addEventListener('dblclick', (e) => {
      if (renamingId || (e.target as HTMLElement).closest('.layer-eye')) return;
      startRename(row, layer.id, layer.name);
    });
    layerList.appendChild(row);
  }

  const active = board.active;
  layerOpacityInput.value = String(Math.round(active.opacity * 100));
  layerOpacityVal.textContent = `${Math.round(active.opacity * 100)}%`;
  syncSlider(layerOpacityInput);
  layerDeleteBtn.disabled = board.layers.length <= 1;
  stackRightPanels(); // a layer added or removed changes where the tray starts
}

function startRename(row: HTMLElement, id: string, current: string): void {
  const input = document.createElement('input');
  input.className = 'layer-name';
  input.value = current;
  renamingId = id;
  row.replaceChild(input, row.children[1]);
  input.focus();
  input.select();
  const commit = (save: boolean) => {
    if (renamingId !== id) return;
    renamingId = null;
    if (save) board.renameLayer(id, input.value);
    layersKey = ''; // the row still holds the text field
    renderLayers();
  };
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
    e.stopPropagation();
  });
}

// Reordering moves the row through the list as the pointer crosses its
// neighbours, then commits the finished order as one undoable step.
function beginLayerDrag(e: PointerEvent, id: string): void {
  if (e.button !== 0 || renamingId) return;
  if (id !== board.activeLayer) clearSelection();
  board.setActiveLayer(id); // this rebuilds the rows, so the list holds the capture
  layerDrag = { id, startY: e.clientY, moved: false };
  layerList.setPointerCapture(e.pointerId);
}

layerList.addEventListener('pointermove', (e) => {
  if (!layerDrag) return;
  const row = layerList.querySelector<HTMLElement>(`.layer-row[data-id="${layerDrag.id}"]`);
  if (!row) return;
  if (!layerDrag.moved) {
    if (Math.abs(e.clientY - layerDrag.startY) < 5) return;
    layerDrag.moved = true;
    row.classList.add('dragging');
  }
  const others = [...layerList.querySelectorAll<HTMLElement>('.layer-row')].filter((r) => r !== row);
  const target = others.find((r) => {
    const b = r.getBoundingClientRect();
    return e.clientY < b.top + b.height / 2;
  });
  layerList.insertBefore(row, target ?? null);
});

function endLayerDrag(): void {
  if (!layerDrag) return;
  const { id, moved } = layerDrag;
  layerDrag = null;
  if (!moved) return;
  const rows = [...layerList.querySelectorAll<HTMLElement>('.layer-row')];
  const to = modelIndex(rows.findIndex((r) => r.dataset.id === id));
  const from = board.layers.findIndex((l) => l.id === id);
  board.moveLayer(from, to);
  layersKey = ''; // the drag rearranged the rows by hand
  renderLayers();
}

layerList.addEventListener('pointerup', endLayerDrag);
layerList.addEventListener('pointercancel', endLayerDrag);

function setLayersOpen(open: boolean): void {
  layersOpen = open;
  layersPanel.classList.toggle('hidden', !open);
  layersBtn.classList.toggle('active', open);
  // Both right-hand panels share an edge; the class lets the stickers tray
  // step out of the way when layers is up.
  document.body.classList.toggle('layers-open', open);
  stackRightPanels();
  savePrefs();
}

// Drawing on a hidden layer would go nowhere visible, so it is refused and the
// row is flashed instead of silently swallowing the stroke.
function flashActiveLayer(): void {
  if (!layersOpen) setLayersOpen(true);
  const row = layerList.querySelector<HTMLElement>(`.layer-row[data-id="${board.activeLayer}"]`);
  if (!row) return;
  row.classList.remove('flash');
  void row.offsetWidth; // restart the animation
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1100);
}

function canEditActive(): boolean {
  if (board.active.visible) return true;
  flashActiveLayer();
  return false;
}

layerAddBtn.addEventListener('click', () => {
  clearSelection();
  board.addLayer();
});
layerDeleteBtn.addEventListener('click', () => {
  clearSelection();
  board.removeLayer(board.activeLayer);
});
layersBtn.addEventListener('click', () => setLayersOpen(!layersOpen));
layerOpacityInput.addEventListener('input', () => {
  board.setLayerOpacity(board.activeLayer, Number(layerOpacityInput.value) / 100);
  layerOpacityVal.textContent = `${layerOpacityInput.value}%`;
});

// ---- ask / draw -----------------------------------------------------------

interface AskMessage {
  role: 'user' | 'assistant';
  text: string;
  image?: string; // base64 png, on the message the region was attached to
  error?: boolean;
}

const askPanel = $('ask');
const askThreadEl = $('ask-thread');
const askInput = $('ask-input') as HTMLTextAreaElement;
const askSend = $('ask-send') as HTMLButtonElement;
const askForget = $('ask-forget') as HTMLButtonElement;
const askConnectionSelect = $('ask-connection') as HTMLSelectElement;
const askSettings = $('ask-settings');
const askConnectionName = $('ask-connection-name') as HTMLInputElement;
const askConnectionKind = $('ask-connection-kind') as HTMLSelectElement;
const askConnectionModel = $('ask-connection-model') as HTMLInputElement;
const askConnectionUrl = $('ask-connection-url') as HTMLInputElement;
const askConnectionKey = $('ask-connection-key') as HTMLInputElement;
const askConnectionUrlRow = $('ask-connection-url-row');
const askConnectionKeyRow = $('ask-connection-key-row');
const askConnectionNote = $('ask-connection-note');
const askConnectionDelete = $('ask-connection-delete') as HTMLButtonElement;

// The boxed region, kept as a world-space quad so it stays pinned to the
// drawing while you pan and zoom, plus the crop that was captured from it.
let region: { quad: Point[]; dataURL: string; base64: string } | null = null;
let regionDrag: Point[] | null = null; // live rubber band, also world space
let thread: AskMessage[] = [];
let pendingImage: string | null = null;
let streamEl: HTMLElement | null = null;
let streaming = false;
let connections: AiConnection[] = [];
let activeConnectionId = '';
let editingConnectionId: string | null = null;
let connectionUsable = false;
let drawTarget: {
  requestId: string;
  quad: Point[];
  frame: string;
  layer: string;
  worldPerPixel: number;
  color: string;
  size: number;
  strokes: Stroke[];
} | null = null;
// The connection editor auto-hides once the active connection is usable. When
// opened deliberately from the menu it stays visible until the panel closes.
let settingsForced = false;
let localProviderProbe = 0;

function quadFromScreenRect(x0: number, y0: number, x1: number, y1: number): Point[] {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const right = Math.max(x0, x1);
  const bottom = Math.max(y0, y1);
  return [
    toWorld(camera, left, top),
    toWorld(camera, right, top),
    toWorld(camera, right, bottom),
    toWorld(camera, left, bottom),
  ];
}

function setAskOpen(open: boolean): void {
  askPanel.classList.toggle('hidden', !open);
  if (open) void refreshConnections();
  else settingsForced = false;
}

function usableConnection(connection: AiConnection | undefined): boolean {
  if (!connection) return false;
  return connection.kind === 'embedded' || connection.url.length > 0;
}

function activeConnection(): AiConnection | undefined {
  return connections.find((connection) => connection.id === activeConnectionId);
}

function syncConnectionMode(kind: AiConnectionKind): void {
  const remote = kind === 'remote';
  askConnectionUrlRow.classList.toggle('hidden', !remote);
  askConnectionKeyRow.classList.toggle('hidden', !remote);
}

async function showLocalProviders(): Promise<void> {
  const probe = ++localProviderProbe;
  askConnectionNote.textContent = 'Detecting installed coding-agent CLIs…';
  const state = await window.betterboard.aiLocalProviders();
  if (probe !== localProviderProbe || askConnectionKind.value !== 'embedded') return;
  askConnectionNote.textContent = state.error
    ? state.error
    : `Detected on this computer: ${state.providers.join(', ')}.`;
}

function fillConnectionEditor(connection?: AiConnection): void {
  const kind = connection?.kind ?? 'embedded';
  editingConnectionId = connection?.id ?? null;
  askConnectionName.value = connection?.name ?? 'This computer';
  askConnectionKind.value = kind;
  askConnectionModel.value = connection?.model ?? '';
  askConnectionUrl.value = connection?.url ?? '';
  askConnectionKey.value = '';
  askConnectionKey.placeholder = connection?.keySet
    ? `Saved Yagami key ends in ${connection.keyHint}`
    : 'ygm_… or blank';
  askConnectionDelete.disabled = !connection;
  askConnectionNote.textContent = kind === 'embedded'
    ? 'Uses the signed-in coding-agent CLIs installed on this computer.'
    : connection?.keySet ? `Personal key saved (…${connection.keyHint}).` : 'No personal key saved.';
  syncConnectionMode(kind);
  if (kind === 'embedded') void showLocalProviders();
}

function applyConnectionState(state: AiConnectionState): void {
  connections = state.connections;
  activeConnectionId = state.active;
  askConnectionSelect.textContent = '';
  for (const connection of connections) {
    const option = document.createElement('option');
    option.value = connection.id;
    option.textContent = connection.name;
    askConnectionSelect.appendChild(option);
  }
  askConnectionSelect.value = activeConnectionId;
  const connection = activeConnection();
  connectionUsable = usableConnection(connection);
  askSettings.classList.toggle('hidden', connectionUsable && !settingsForced);
  askSend.disabled = streaming ? false : !connectionUsable;
  fillConnectionEditor(connection);
  if (state.error) askConnectionNote.textContent = state.error;
}

async function refreshConnections(): Promise<void> {
  applyConnectionState(await window.betterboard.aiConnections());
}

function captureRegion(x0: number, y0: number, x1: number, y1: number): void {
  const rect = {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
  if (rect.width < 12 || rect.height < 12) return; // a stray tap, not a box
  const quad = quadFromScreenRect(x0, y0, x1, y1);
  const canvasEl = renderRegion(
    board.visibleStrokesIn(board.activeFrame, polygonBBox(quad)),
    board.visibleImages(),
    board.layers,
    camera,
    rect,
    THEMES[themeName]
  );
  const dataURL = canvasEl.toDataURL('image/png');
  region = {
    quad,
    dataURL,
    base64: dataURL.slice(dataURL.indexOf(',') + 1),
  };
  // A new region is a new subject, so it starts a new thread.
  thread = [];
  pendingImage = region.base64;
  askForget.classList.remove('hidden');
  setAskOpen(true);
  renderThread();
  askInput.focus();
  requestRender();
}

function clearRegion(): void {
  region = null;
  pendingImage = null;
  askForget.classList.add('hidden');
  renderThread(); // the crop is drawn from `region`, so the panel has to redraw too
  requestRender();
}

function newThread(): void {
  if (streaming) void window.betterboard.aiCancel();
  streamEl = null;
  drawTarget = null;
  thread = [];
  pendingImage = region?.base64 ?? null;
  setStreamingUi(false);
  renderThread();
}

function renderThread(): void {
  askThreadEl.textContent = '';
  if (region) {
    const img = document.createElement('img');
    img.className = 'ask-crop';
    img.src = region.dataURL;
    img.alt = 'The region being asked about';
    askThreadEl.appendChild(img);
  }
  if (thread.length === 0 && !region) {
    const hint = document.createElement('p');
    hint.className = 'ask-empty';
    hint.innerHTML =
      'Pick the <b>Ask</b> tool and drag a box around part of your board. Ask a question—or ask the model to draw, circle, or connect something.';
    askThreadEl.appendChild(hint);
  }
  for (const m of thread) {
    const el = document.createElement('div');
    el.className = `ask-msg ${m.role === 'user' ? 'user' : 'assistant'}${m.error ? ' error' : ''}`;
    el.textContent = m.text;
    askThreadEl.appendChild(el);
  }
  askThreadEl.scrollTop = askThreadEl.scrollHeight;
}

function setStreamingUi(on: boolean): void {
  streaming = on;
  askSend.textContent = on ? 'Stop' : 'Ask';
  askSend.disabled = on ? false : !connectionUsable;
  askConnectionSelect.disabled = on;
}

async function sendAsk(): Promise<void> {
  if (streaming) {
    await window.betterboard.aiCancel();
    finishStream();
    return;
  }
  const text = askInput.value.trim();
  if (!text || !connectionUsable || !activeConnectionId) return;

  const message: AskMessage = { role: 'user', text };
  if (pendingImage) {
    message.image = pendingImage;
    pendingImage = null;
  }
  thread.push(message);
  askInput.value = '';
  renderThread();

  const messages = thread.filter((message) => !message.error).map(({ role, text, image }) => ({ role, text, image }));
  const requestId = uid();
  drawTarget = region ? {
    requestId,
    quad: region.quad.map((point) => ({ ...point })),
    frame: board.activeFrame,
    layer: board.activeLayer,
    worldPerPixel: 1 / camera.scale,
    color,
    size,
    strokes: [],
  } : null;

  setStreamingUi(true);
  streamEl = document.createElement('div');
  streamEl.className = 'ask-msg assistant streaming';
  askThreadEl.appendChild(streamEl);
  askThreadEl.scrollTop = askThreadEl.scrollHeight;

  await window.betterboard.aiAsk({ requestId, connectionId: activeConnectionId, messages });
}

function finishStream(): void {
  if (streamEl) {
    const text = streamEl.textContent ?? '';
    streamEl.classList.remove('streaming');
    if (text.trim()) thread.push({ role: 'assistant', text });
    else streamEl.remove();
  }
  streamEl = null;
  if (drawTarget?.strokes.length) board.addStrokes(drawTarget.strokes);
  drawTarget = null;
  setStreamingUi(false);
}

window.betterboard.onAiDelta((text) => {
  if (!streamEl) return;
  streamEl.textContent = (streamEl.textContent ?? '') + text;
  askThreadEl.scrollTop = askThreadEl.scrollHeight;
});

window.betterboard.onAiDone(finishStream);

window.betterboard.onAiDraw(({ requestId, drawing }) => {
  const target = drawTarget;
  if (!target || target.requestId !== requestId) return;
  if (!board.frames.some((frame) => frame.id === target.frame) || !board.layers.some((layer) => layer.id === target.layer)) return;
  const lines = drawingToLines(drawing, target.quad, target.worldPerPixel, {
    color: target.color,
    size: target.size,
  });
  const strokes = lines.map((line) =>
    makeStroke(
      {
        id: uid(),
        seq: board.takeSeq(),
        color: line.color,
        size: line.size,
        pen: false,
        brush: 'pen',
        seed: (Math.random() * 0xffffffff) >>> 0,
        layer: target.layer,
        frame: target.frame,
      },
      line.points
    )
  );
  // A response may issue more than one tool call. Buffer all of them until the
  // response finishes so the complete annotation is one undo operation.
  target.strokes.push(...strokes);
});

window.betterboard.onAiError((message) => {
  streamEl?.remove();
  streamEl = null;
  setStreamingUi(false);
  thread.push({ role: 'assistant', text: message, error: true });
  renderThread();
  drawTarget = null;
  void refreshConnections();
});

$('ask-compose').addEventListener('submit', (e) => {
  e.preventDefault();
  void sendAsk();
});
askInput.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter is a newline. Stops here so the canvas shortcuts
  // (Enter plays the animation) never fire while typing.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void sendAsk();
  }
  e.stopPropagation();
});
askForget.addEventListener('click', clearRegion);
$('ask-new').addEventListener('click', newThread);
$('ask-settings-toggle').addEventListener('click', () => {
  if (!askSettings.classList.contains('hidden') && connectionUsable) {
    settingsForced = false;
    askSettings.classList.add('hidden');
  } else {
    settingsForced = true;
    askSettings.classList.remove('hidden');
    fillConnectionEditor(activeConnection());
    askConnectionName.focus();
  }
});
$('ask-close').addEventListener('click', () => {
  settingsForced = false;
  setAskOpen(false);
});

askConnectionSelect.addEventListener('change', () => {
  void window.betterboard.aiSetActive(askConnectionSelect.value).then(applyConnectionState);
});

$('ask-connection-new').addEventListener('click', () => {
  settingsForced = true;
  askSettings.classList.remove('hidden');
  fillConnectionEditor();
  askConnectionName.focus();
});

askConnectionKind.addEventListener('change', () => {
  const kind = askConnectionKind.value as AiConnectionKind;
  askConnectionName.value = kind === 'embedded' ? 'This computer' : 'Yagami server';
  syncConnectionMode(kind);
  askConnectionNote.textContent = kind === 'embedded'
    ? 'Uses the signed-in coding-agent CLIs installed on this computer.'
    : 'A personal key is optional; use one if your server requires it.';
  if (kind === 'embedded') void showLocalProviders();
});

$('ask-connection-save').addEventListener('click', () => {
  void window.betterboard.aiSaveConnection({
    id: editingConnectionId ?? undefined,
    name: askConnectionName.value,
    kind: askConnectionKind.value as AiConnectionKind,
    model: askConnectionModel.value,
    url: askConnectionUrl.value,
    key: askConnectionKey.value,
  }).then((state) => {
    // Keep invalid form values in place so the user can correct one field
    // instead of retyping the whole connection.
    if (state.error) askConnectionNote.textContent = state.error;
    else applyConnectionState(state);
  });
});

askConnectionDelete.addEventListener('click', () => {
  if (!editingConnectionId) return;
  void window.betterboard.aiDeleteConnection(editingConnectionId).then(applyConnectionState);
});

$('ask-secret-clear').addEventListener('click', () => {
  if (!editingConnectionId) return;
  void window.betterboard.aiSaveConnection({
    id: editingConnectionId,
    kind: askConnectionKind.value as AiConnectionKind,
    clearKey: true,
  }).then(applyConnectionState);
});

for (const input of [askConnectionName, askConnectionKind, askConnectionModel, askConnectionUrl, askConnectionKey]) {
  input.addEventListener('keydown', (event) => event.stopPropagation());
}

// ---- images ---------------------------------------------------------------

// Anything oversized is scaled on the way in: a board file carries its pictures
// inline, so a handful of full-resolution screenshots would otherwise dwarf the
// drawing they annotate. Anything already small enough keeps its original bytes
// and format, rather than being re-encoded for no reason.
async function normalizeImage(src: string): Promise<{ src: string; width: number; height: number } | null> {
  const el = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    el.onload = () => resolve(true);
    el.onerror = () => resolve(false);
    el.src = src;
  });
  if (!loaded || !el.naturalWidth || !el.naturalHeight) return null;

  const longest = Math.max(el.naturalWidth, el.naturalHeight);
  if (longest <= MAX_IMAGE_DIM) {
    return { src, width: el.naturalWidth, height: el.naturalHeight };
  }
  const k = MAX_IMAGE_DIM / longest;
  const canvasEl = document.createElement('canvas');
  canvasEl.width = Math.round(el.naturalWidth * k);
  canvasEl.height = Math.round(el.naturalHeight * k);
  const c = canvasEl.getContext('2d')!;
  c.imageSmoothingQuality = 'high';
  c.drawImage(el, 0, 0, canvasEl.width, canvasEl.height);
  // Photographs stay photographs; anything else keeps a lossless path.
  const jpeg = src.startsWith('data:image/jpeg') || src.startsWith('data:image/jpg');
  return {
    src: canvasEl.toDataURL(jpeg ? 'image/jpeg' : 'image/png', jpeg ? 0.9 : undefined),
    width: canvasEl.width,
    height: canvasEl.height,
  };
}

// Drops a picture at a world point (or the middle of the view), scaled so it
// sits comfortably inside the viewport rather than swamping it.
async function placeImage(src: string, at?: Point): Promise<void> {
  if (!canEditActive()) return;
  const sized = await normalizeImage(src);
  if (!sized) {
    void window.betterboard.confirm('Could not read that image', 'It may be an unsupported format.');
    return;
  }
  const fit = Math.min(
    1,
    (cssWidth * 0.5) / (sized.width * camera.scale),
    (cssHeight * 0.5) / (sized.height * camera.scale)
  );
  const width = sized.width * fit;
  const height = sized.height * fit;
  const center = at ?? toWorld(camera, cssWidth / 2, cssHeight / 2);

  const image: BoardImage = {
    id: uid(),
    seq: board.takeSeq(),
    src: sized.src,
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
    layer: board.activeLayer,
    frame: board.activeFrame,
  };
  board.addImage(image);
  selectImage(image);
}

// A freshly placed picture arrives selected, so it can be moved or resized
// straight away without hunting for it.
function selectImage(image: BoardImage): void {
  setTool('select');
  selection = { ids: new Set(), images: new Set([image.id]), poly: rectPoly(imageBBox(image)) };
  moveX = 0;
  moveY = 0;
  syncAnts();
  requestRender();
}

// ---- reshaping a selection --------------------------------------------------

// The box a selection's grips sit on: everything it holds, ink margins and all
// — or, once it has been reshaped, the box exactly as it was let go. Measuring
// the ink again would pull the grips in from under the pointer, anchored edge
// included, because a line's width follows a stretch less than its length does.
// Measured once per selection and board revision: hovering asks for it on
// every pointer move, and a big selection is a lot of boxes to add up.
let boxMemo: { sel: BoardSelection; revision: number; box: Rect | null } | null = null;
function selectionBox(): Rect | null {
  const sel = selection;
  if (!sel) return null;
  if (sel.box) return sel.box;
  if (boxMemo && boxMemo.sel === sel && boxMemo.revision === board.revision) return boxMemo.box;
  const b = board.contentBBox(selectedStrokes(), selectedImages());
  const box = b ? bboxRect(b) : null;
  boxMemo = { sel, revision: board.revision, box };
  return box;
}

function shiftSelection(sel: BoardSelection, dx: number, dy: number): void {
  sel.poly = sel.poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  if (sel.box) sel.box = { ...sel.box, x: sel.box.x + dx, y: sel.box.y + dy };
}

function boxPoly(r: Rect): Point[] {
  return rectPoly({ minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height });
}

// The grips worth showing on a box, by their index into boxGrips. An edge grip
// drops out when its side is too short on screen to hold one between the
// corners, which leaves a small selection four grips instead of a clump.
// `shown` is the box as it is on screen now — mid-drag, not the one the grips
// are measured from.
function gripsOf(box: Rect, shown: Rect = box): { i: number; p: Point }[] {
  const a = toScreen(camera, shown.x, shown.y);
  const b = toScreen(camera, shown.x + shown.width, shown.y);
  const c = toScreen(camera, shown.x, shown.y + shown.height);
  const across = Math.hypot(b.x - a.x, b.y - a.y) >= HANDLE * 3;
  const down = Math.hypot(c.x - a.x, c.y - a.y) >= HANDLE * 3;
  return boxGrips(box).flatMap((p, i) => {
    const mode = gripMode(i);
    // Left and right grips sit halfway down a side, top and bottom halfway across.
    const fits = mode === 'corner' || (mode === 'x' ? down : across);
    return fits ? [{ i, p }] : [];
  });
}

// Which grip, if any, is under a screen point: the box it belongs to, what it
// does, the point across the box that holds still, and the cursor for it.
function gripAt(sx: number, sy: number): { box: Rect; anchor: Point; mode: GripMode; cursor: string } | null {
  if (!selection) return null;
  const box = selectionBox();
  if (!box) return null;
  const all = boxGrips(box);
  const centre = toScreen(camera, box.x + box.width / 2, box.y + box.height / 2);
  for (const { i, p } of gripsOf(box)) {
    const s = toScreen(camera, p.x, p.y);
    if (Math.abs(s.x - sx) <= HANDLE && Math.abs(s.y - sy) <= HANDLE) {
      return { box, anchor: all[OPPOSITE[i]], mode: gripMode(i), cursor: resizeCursor(s.x - centre.x, s.y - centre.y) };
    }
  }
  return null;
}

const MIN_BOX = 6; // css px: the smallest a selection can be squeezed to on screen
// Rebuilding a selection's strokes costs time in proportion to its ink. Past
// this many milliseconds in one frame, a drag stops rebuilding live.
const RESHAPE_BUDGET = 24;

function beginReshape(grip: NonNullable<ReturnType<typeof gripAt>>): Reshape {
  const images = new Map<string, Rect>();
  for (const im of selectedImages()) images.set(im.id, { x: im.x, y: im.y, width: im.width, height: im.height });
  return {
    kind: 'transform',
    from: grip.box,
    to: grip.box,
    anchor: grip.anchor,
    mode: grip.mode,
    cursor: grip.cursor,
    strokes: selectedStrokes(),
    images,
    preview: new Map(),
    stale: false,
    // A selection too big to lift stroke by stroke is too big to rebuild
    // either: it goes straight to the stretched pass.
    affine: lifted?.tiles === true,
  };
}

// Brings the on-screen preview up to the latest `to`, once per frame however
// many pointer events arrived. Pictures need nothing: they are drawn through
// the drag's map, which is exact for a rectangle.
function refreshReshape(t: Reshape): void {
  if (!t.stale) return;
  t.stale = false;
  if (t.affine) return;
  const started = performance.now();
  for (const s of t.strokes) {
    const copy = transformStroke(s, t.from, t.to);
    copy.path = buildPath(copy);
    t.preview.set(s.id, copy);
  }
  if (performance.now() - started > RESHAPE_BUDGET) {
    t.affine = true;
    t.preview.clear();
  }
}

function commitReshape(t: Reshape): void {
  const { from, to } = t;
  if (from.x === to.x && from.y === to.y && from.width === to.width && from.height === to.height) return;
  board.transformItems(
    t.strokes.map((s) => transformStroke(s, from, to)),
    [...t.images].map(([id, r]) => ({ id, to: transformRect(r, from, to) }))
  );
  const sel = selection;
  if (!sel) return;
  sel.box = to;
  // A lasso outline is carried along with what it holds; a box outline is the box.
  sel.poly = sel.loop ? sel.poly.map((p) => mapPoint(p, from, to)) : boxPoly(to);
}

// The outline, grips and in-flight change for the selection, this frame.
function selectionMarquee(sel: BoardSelection): Marquee {
  const t = drag?.kind === 'transform' ? drag : null;
  const box = t ? t.from : selectionBox();
  const map = t ? boxAffine(t.from, t.to) : { sx: 1, sy: 1, dx: moveX, dy: moveY };
  return {
    poly: sel.loop || !box ? sel.poly : boxPoly(box),
    grips: box ? gripsOf(box, t ? t.to : box).map((g) => g.p) : null,
    frame: sel.loop === true,
    ...map,
    dashOffset,
  };
}

// A selection picked up by a drag: hidden from its cell until the drag ends,
// and drawn on top of it through the drag's map meanwhile. Up to a point it
// is drawn stroke by stroke every frame; past that it is painted into tiles
// of its own once and those are what move.
let lifted: { items: Item[]; images: BoardImage[]; tiles: boolean; box: BBox } | null = null;

function liftSelection(): void {
  const sel = selection;
  if (!sel || lifted) return;
  const strokes = selectedStrokes();
  const images = selectedImages();
  let points = 0;
  for (const s of strokes) points += s.n;
  const tiles = strokes.length > LIFT_DIRECT || points > LIFT_DIRECT * 100;
  const items: Item[] = tiles ? [] : [...strokes, ...images].sort(bySeq);
  lifted = { items, images, tiles, box: board.contentBBox(strokes, images) ?? emptyBBox() };
  const frame = board.activeFrame;
  const layer = board.activeLayer;
  compositor.setOverride(frame, layer, (s) => (sel.ids.has(s.id) ? [] : undefined), sel.images);
  if (tiles) compositor.setLiftSource({ frame, layer, ids: sel.ids, images: sel.images });
  compositor.invalidate(frame, layer, lifted.box);
}

// Puts the selection back down. Whatever the drag committed has already
// reported where it changed the board; this repaints where it was lifted from,
// which matters when the drag ended where it began.
function dropLift(): void {
  if (!lifted) return;
  const box = lifted.box;
  lifted = null;
  compositor.setOverride(board.activeFrame, board.activeLayer, null, null);
  compositor.setLiftSource(null);
  compositor.invalidate(board.activeFrame, board.activeLayer, box);
  requestRender();
}

// What the frame should show of the lifted selection right now. A move
// carries everything bodily; a reshape shows rebuilt copies of the ink while
// it can afford to, and the ink itself, stretched, once it cannot.
function currentLift(): Lift | null {
  if (!lifted || !selection) return null;
  const t = drag?.kind === 'transform' ? drag : null;
  const map = t ? boxAffine(t.from, t.to) : { sx: 1, sy: 1, dx: moveX, dy: moveY };
  const preview = t && !t.affine ? [...t.preview.values()] : null;
  return {
    map,
    items: lifted.tiles ? [] : preview ? lifted.images : lifted.items,
    tiles: lifted.tiles,
    preview,
  };
}

// Inside the outline or inside the box the grips are on: a lasso loop can be
// drawn tighter or looser than the ink, and either should pick it up.
function insideSelection(w: Point): boolean {
  const sel = selection;
  if (!sel) return false;
  if (pointInPolygon(sel.poly, w.x, w.y)) return true;
  const box = selectionBox();
  return box !== null && w.x >= box.x && w.x <= box.x + box.width && w.y >= box.y && w.y <= box.y + box.height;
}

function rectPoly(b: { minX: number; minY: number; maxX: number; maxY: number }): Point[] {
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function insertImageFile(): Promise<void> {
  const files = await window.betterboard.openImages();
  for (const file of files) await placeImage(file);
}

const isTextField = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

// Guards against one keystroke being served twice, on any platform where the
// menu does not swallow it and a DOM paste event lands as well.
let lastPasteAt = 0;

// Cmd+V arrives here from the menu rather than as a paste event: Chromium only
// runs its paste command for editable targets, so over the canvas nothing fires
// at all. Since the accelerator is consumed, typing fields have to be served
// too, which is what the text branch is for.
async function pasteFromClipboard(fallback?: () => Promise<string | null>): Promise<void> {
  const now = Date.now();
  if (now - lastPasteAt < 300) return;
  // Claimed before the first await: reading the clipboard is asynchronous, so
  // two deliveries of one keystroke would both clear a guard set afterwards.
  lastPasteAt = now;

  const focused = document.activeElement;
  if (isTextField(focused)) {
    const text = await window.betterboard.clipboardText();
    if (!text) return;
    const start = focused.selectionStart ?? focused.value.length;
    const end = focused.selectionEnd ?? start;
    focused.value = focused.value.slice(0, start) + text + focused.value.slice(end);
    focused.selectionStart = focused.selectionEnd = start + text.length;
    focused.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  // The board's own copy wins while the marker written beside it is still on
  // the clipboard — that is what makes ⌘C then ⌘V give back real strokes rather
  // than a flat snapshot of them. Copy anything else anywhere on the computer
  // and the marker goes with it, so the outside world takes over again.
  if (clipboard && clipMark && (await window.betterboard.clipboardText()) === clipMark) {
    pasteClip(clipboard);
    return;
  }
  const src = (await window.betterboard.clipboardImage()) ?? (await fallback?.());
  if (src) {
    await placeImage(src);
    return;
  }
  // Nothing outside to paste, but ours is still good.
  if (clipboard) pasteClip(clipboard);
}

// Kept as a second route: a real paste event still fires for drags out of other
// apps and anywhere the platform delivers one.
window.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    e.preventDefault();
    // Routed through the same function as the menu, so both routes make the
    // same choice between the board's clipboard and the system's. The blob is
    // handed over as a fallback for formats the platform clipboard cannot
    // hand back as an image on its own.
    void pasteFromClipboard(() => blobToDataURL(blob));
    return;
  }
});

// Without this, dropping a file anywhere outside the canvas makes the window
// navigate to it and the app disappears.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => {
    if ((e as DragEvent).dataTransfer?.types.includes('Files')) e.preventDefault();
  });
}

// Dropping onto the canvas places the picture where it landed — and so does
// dragging a sticker out of the tray, which is the same gesture for the same
// reason.
canvas.addEventListener('dragover', (e) => {
  const types = e.dataTransfer?.types;
  if (types?.includes('Files') || types?.includes(STICKER_DRAG_TYPE)) {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  }
});

canvas.addEventListener('drop', (e) => {
  const stickerId = e.dataTransfer?.getData(STICKER_DRAG_TYPE);
  if (stickerId) {
    e.preventDefault();
    const sticker = stickers.find((s) => s.id === stickerId);
    if (!sticker) return;
    const centre = toWorld(camera, e.offsetX, e.offsetY);
    pasteClip(sticker.clip, {
      x: centre.x - sticker.clip.width / 2,
      y: centre.y - sticker.clip.height / 2,
    });
    return;
  }
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (files.length === 0) return;
  e.preventDefault();
  const at = toWorld(camera, e.offsetX, e.offsetY);
  void (async () => {
    for (const file of files) await placeImage(await blobToDataURL(file), at);
  })();
});

// ---- magic wand -----------------------------------------------------------

function naturalSize(el: HTMLImageElement | HTMLCanvasElement): { width: number; height: number } {
  return el instanceof HTMLCanvasElement
    ? { width: el.width, height: el.height }
    : { width: el.naturalWidth, height: el.naturalHeight };
}

// Rasterizes a picture's current bitmap so its pixels can be read.
function imagePixels(image: BoardImage): { data: Uint8ClampedArray; width: number; height: number } | null {
  if (!image.el) return null;
  const { width, height } = naturalSize(image.el);
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  c.drawImage(image.el, 0, 0, width, height);
  return { data: c.getImageData(0, 0, width, height).data, width, height };
}

// The selection made visible: a soft accent tint over the chosen pixels and a
// solid rim just outside them, baked into one canvas the renderer stretches
// over the picture.
function buildWandOverlay(mask: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const c = canvas.getContext('2d')!;
  const rim = dilate(mask, width, height);
  const img = c.createImageData(width, height);
  const { r, g, b } = hexToRgb(THEMES[themeName].accent) ?? { r: 76, g: 201, b: 240 };
  for (let p = 0; p < mask.length; p++) {
    const o = p * 4;
    if (mask[p]) {
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 84;
    } else if (rim[p]) {
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  return canvas;
}

// Where the overlay goes this frame — looked up per render so it follows the
// picture if it is moved or resized before the selection is used.
function wandOverlay(frame: string): { x: number; y: number; width: number; height: number; canvas: HTMLCanvasElement } | null {
  if (!wandSel) return null;
  const image = board.images.find((im) => im.id === wandSel!.imageId);
  if (!image || image.frame !== frame) return null;
  return { x: image.x, y: image.y, width: image.width, height: image.height, canvas: wandSel.overlay };
}

function clearWandSelection(): void {
  if (!wandSel) return;
  wandSel = null;
  wandActions.classList.add('hidden');
  requestRender();
}

// One wand click: find the topmost picture in the active cell under the
// pointer and select by color — the touched region in Point mode, the whole
// border-connected backdrop in Background mode.
function wandAt(e: PointerEvent): void {
  const w = toWorld(camera, e.offsetX, e.offsetY);
  let target: BoardImage | null = null;
  for (let i = board.images.length - 1; i >= 0; i--) {
    const im = board.images[i];
    if (im.frame !== board.activeFrame || im.layer !== board.activeLayer) continue;
    if (imageHit(im, w.x, w.y)) {
      target = im;
      break;
    }
  }
  clearWandSelection();
  if (!target) {
    requestRender();
    return;
  }
  const px = imagePixels(target);
  if (!px) return;
  const sx = Math.min(px.width - 1, Math.max(0, Math.floor(((w.x - target.x) / target.width) * px.width)));
  const sy = Math.min(px.height - 1, Math.max(0, Math.floor(((w.y - target.y) / target.height) * px.height)));
  const mask = wandMode === 'background'
    ? backgroundSelect(px.data, px.width, px.height, wandTolerance)
    : floodSelect(px.data, px.width, px.height, sx, sy, wandTolerance);
  if (!maskBounds(mask, px.width, px.height)) return;
  wandSel = {
    imageId: target.id,
    mask,
    width: px.width,
    height: px.height,
    overlay: buildWandOverlay(mask, px.width, px.height),
  };
  wandActions.classList.remove('hidden');
  requestRender();
}

// Applies the wand selection: cut the chosen pixels away, or keep only them
// and cut everything else. Either way it is one undoable bitmap swap.
function applyWandCut(keepSelected: boolean): void {
  const sel = wandSel;
  if (!sel) return;
  const image = board.images.find((im) => im.id === sel.imageId);
  if (!image || !image.el) return;
  // Cutting away uses the mask grown by a pixel, so the anti-aliased fringe
  // goes with the region it blends into instead of remaining as a halo.
  const cut = keepSelected ? sel.mask : dilate(sel.mask, sel.width, sel.height);
  const hole = document.createElement('canvas');
  hole.width = sel.width;
  hole.height = sel.height;
  const hctx = hole.getContext('2d')!;
  const stencil = hctx.createImageData(sel.width, sel.height);
  for (let p = 0; p < cut.length; p++) {
    if (keepSelected ? !cut[p] : cut[p]) stencil.data[p * 4 + 3] = 255;
  }
  hctx.putImageData(stencil, 0, 0);

  const out = document.createElement('canvas');
  out.width = sel.width;
  out.height = sel.height;
  const octx = out.getContext('2d')!;
  octx.drawImage(image.el, 0, 0, sel.width, sel.height);
  octx.globalCompositeOperation = 'destination-out';
  octx.drawImage(hole, 0, 0);
  board.setImageSrc(image.id, out.toDataURL('image/png'));
  // The working canvas already shows the result; keep it on screen while the
  // fresh data URL decodes so the picture never blinks out.
  image.el = out;
  clearWandSelection();
}

// ---- lasso selection ------------------------------------------------------

// The ants only crawl while there is something to outline, so an idle board
// costs nothing.
function syncAnts(): void {
  const wanted = lasso !== null || selection !== null;
  if (wanted && antsTimer === undefined) {
    antsTimer = window.setInterval(() => {
      dashOffset -= 1;
      requestRender();
    }, 70);
  } else if (!wanted && antsTimer !== undefined) {
    clearInterval(antsTimer);
    antsTimer = undefined;
  }
}

function clearSelection(): void {
  clearWandSelection();
  dropLift();
  if (!selection && !lasso) return;
  selection = null;
  lasso = null;
  moveX = 0;
  moveY = 0;
  hoverInSelection = false;
  hoverHandle = null;
  syncAnts();
  updateCursor();
  requestRender();
}

function addLassoPoint(e: PointerEvent): void {
  if (!lasso) return;
  const w = toWorld(camera, e.offsetX, e.offsetY);
  const last = lasso[lasso.length - 1];
  if (last) {
    const dx = (w.x - last.x) * camera.scale;
    const dy = (w.y - last.y) * camera.scale;
    if (dx * dx + dy * dy < LASSO_MIN_DIST * LASSO_MIN_DIST) return;
  }
  lasso.push(w);
}

// A stroke joins the selection when most of it is inside the loop; requiring
// every point makes grazing a long stroke's tail feel broken.
function strokesInside(poly: Point[]): Set<string> {
  const ids = new Set<string>();
  for (const s of editableNear(polygonBBox(poly))) {
    let hits = 0;
    for (let j = 0, end = s.n * 3; j < end; j += 3) {
      if (pointInPolygon(poly, s.ox + s.pts[j], s.oy + s.pts[j + 1])) hits++;
    }
    if (hits / s.n >= ENCLOSED) ids.add(s.id);
  }
  return ids;
}

// Picks the topmost stroke under a point and wraps it in its own outline, so a
// tap is a one-stroke selection and a tap on nothing is a deselect.
function selectAt(w: Point): void {
  const radius = 8 / camera.scale;
  for (let i = board.images.length - 1; i >= 0; i--) {
    const im = board.images[i];
    if (im.frame !== board.activeFrame || im.layer !== board.activeLayer) continue;
    if (!imageHit(im, w.x, w.y)) continue;
    selection = { ids: new Set(), images: new Set([im.id]), poly: rectPoly(imageBBox(im)) };
    return;
  }
  let top: Stroke | null = null;
  for (const s of editableNear({ minX: w.x - radius, minY: w.y - radius, maxX: w.x + radius, maxY: w.y + radius })) {
    if (strokeHit(s, w.x, w.y, radius) && (!top || s.seq > top.seq)) top = s;
  }
  if (top) {
    const s = top;
    const pad = 6 / camera.scale;
    const b = s.bbox;
    selection = {
      ids: new Set([s.id]),
      images: new Set(),
      poly: [
        { x: b.minX - pad, y: b.minY - pad },
        { x: b.maxX + pad, y: b.minY - pad },
        { x: b.maxX + pad, y: b.maxY + pad },
        { x: b.minX - pad, y: b.maxY + pad },
      ],
    };
    return;
  }
  selection = null;
}

function imagesInside(poly: Point[]): Set<string> {
  const ids = new Set<string>();
  for (const im of board.images) {
    if (im.frame !== board.activeFrame || im.layer !== board.activeLayer) continue;
    if (pointInPolygon(poly, im.x + im.width / 2, im.y + im.height / 2)) ids.add(im.id);
  }
  return ids;
}

function commitLasso(): void {
  const poly = lasso;
  lasso = null;
  if (!poly) return;
  const box = polygonBBox(poly);
  const span = Math.max(box.maxX - box.minX, box.maxY - box.minY) * camera.scale;
  if (poly.length < 3 || span < TAP_SLOP) {
    selectAt(poly[0]);
    return;
  }
  const ids = strokesInside(poly);
  const pics = imagesInside(poly);
  if (ids.size === 0 && pics.size === 1) {
    // One picture on its own: show its bounds rather than the loop drawn round
    // it, so the outline matches what the grips will resize.
    const image = board.images.find((im) => im.id === [...pics][0]);
    selection = image ? { ids, images: pics, poly: rectPoly(imageBBox(image)) } : null;
    return;
  }
  selection = ids.size > 0 || pics.size > 0 ? { ids, images: pics, poly, loop: true } : null;
}

function deleteSelection(): void {
  if (!selection) return;
  board.removeItems(selection.ids, selection.images);
  clearSelection();
}

// ---- pointer input --------------------------------------------------------

canvas.addEventListener('pointerdown', (e) => {
  if (drag) return; // ignore extra pointers mid-gesture
  // A pick is the whole gesture: it takes the pixel under the pointer and hands
  // the tool back, without ever touching the board.
  if (pickerActive() && e.button === 0) {
    lastPointer = { x: e.offsetX, y: e.offsetY };
    takeColorAt(e.offsetX, e.offsetY);
    return;
  }
  if (playing) {
    // Playback is a preview; the press stops it and returns to the frame you
    // were editing rather than drawing onto whichever frame happened to show.
    stopPlayback();
    return;
  }
  const panWanted =
    e.pointerType === 'touch' ||
    e.button === 1 ||
    (e.buttons & 2) !== 0 || // right mouse button / pen barrel button
    spaceHeld ||
    tool === 'hand';
  const eraseWanted =
    !panWanted && ((e.pointerType === 'pen' && (e.buttons & 32) !== 0) || tool === 'eraser');

  if (!panWanted && !canEditActive()) return;

  if (panWanted) {
    drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y };
  } else if (eraseWanted) {
    drag = { kind: 'erase' };
    beginErase(e);
    requestRender();
  } else if (tool === 'ask' && e.button === 0) {
    drag = { kind: 'region', x0: e.offsetX, y0: e.offsetY };
    regionDrag = quadFromScreenRect(e.offsetX, e.offsetY, e.offsetX, e.offsetY);
    requestRender();
  } else if (tool === 'wand' && e.button === 0) {
    // A wand pick is a click, not a drag: select and end the gesture here.
    wandAt(e);
    return;
  } else if (tool === 'fill' && e.button === 0) {
    // So is a bucket drop.
    fillAt(e);
    return;
  } else if (tool === 'select' && e.button === 0) {
    const w = toWorld(camera, e.offsetX, e.offsetY);
    const grip = gripAt(e.offsetX, e.offsetY);
    if (grip) {
      liftSelection();
      drag = beginReshape(grip);
    } else if (selection && insideSelection(w)) {
      // Press inside the outline picks the selection up instead of redrawing it.
      drag = { kind: 'move', startX: e.clientX, startY: e.clientY };
      moveX = 0;
      moveY = 0;
      liftSelection();
    } else {
      selection = null;
      hoverInSelection = false;
      hoverHandle = null;
      lasso = [w];
      drag = { kind: 'lasso' };
      syncAnts();
    }
    requestRender();
  } else if (e.button === 0) {
    drag = { kind: 'draw' };
    startStroke(e);
  } else {
    return;
  }
  activePointer = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  updateCursor();
});

canvas.addEventListener('pointermove', (e) => {
  lastPointer = { x: e.offsetX, y: e.offsetY };
  if (pickerActive()) {
    drawLoupe(e.offsetX, e.offsetY);
    return;
  }
  if (drag === null || e.pointerId !== activePointer) {
    if (tool === 'eraser') {
      eraserCursor = { x: e.offsetX, y: e.offsetY };
      requestRender();
    } else if (tool === 'select' && selection) {
      const w = toWorld(camera, e.offsetX, e.offsetY);
      const inside = insideSelection(w);
      const onGrip = gripAt(e.offsetX, e.offsetY)?.cursor ?? null;
      if (inside !== hoverInSelection || onGrip !== hoverHandle) {
        hoverInSelection = inside;
        hoverHandle = onGrip;
        updateCursor();
      }
    }
    return;
  }
  if (drag.kind === 'transform') {
    // Shift frees a corner's proportions; Option grows the box about its middle.
    const t = drag;
    const centre = { x: t.from.x + t.from.width / 2, y: t.from.y + t.from.height / 2 };
    t.to = resizeRect(t.from, e.altKey ? centre : t.anchor, toWorld(camera, e.offsetX, e.offsetY), t.mode, {
      free: e.shiftKey,
      centered: e.altKey,
      min: MIN_BOX / camera.scale,
    });
    t.stale = true;
    requestRender();
    return;
  }
  if (drag.kind === 'move') {
    const d = toWorldDelta(camera, e.clientX - drag.startX, e.clientY - drag.startY);
    moveX = d.x;
    moveY = d.y;
    requestRender();
    return;
  }
  if (drag.kind === 'region') {
    regionDrag = quadFromScreenRect(drag.x0, drag.y0, e.offsetX, e.offsetY);
    requestRender();
    return;
  }
  if (drag.kind === 'lasso') {
    for (const ev of e.getCoalescedEvents?.() ?? [e]) addLassoPoint(ev);
    requestRender();
    return;
  }
  if (drag.kind === 'pan') {
    const d = toWorldDelta(camera, e.clientX - drag.startX, e.clientY - drag.startY);
    camera.x = drag.camX - d.x;
    camera.y = drag.camY - d.y;
    requestRender();
    scheduleAutosave();
    return;
  }
  const events = e.getCoalescedEvents?.() ?? [e];
  if (drag.kind === 'draw') {
    let added = false;
    for (const ev of events) added = addLivePoint(ev) || added;
    if (added && live) {
      liveDirty = true;
      requestRender();
    }
  } else {
    for (const ev of events) {
      if (eraserMode === 'area') eraseAreaAt(ev);
      else eraseAt(ev);
    }
    eraserCursor = { x: e.offsetX, y: e.offsetY };
    requestRender();
  }
});

function endGesture(e: PointerEvent): void {
  if (drag === null || e.pointerId !== activePointer) return;
  if (drag.kind === 'draw') {
    addLivePoint(e);
    finishStroke();
  } else if (drag.kind === 'erase') {
    if (eraserMode === 'area') {
      eraseAreaAt(e);
      board.replaceStrokes([...areaEraseChanges.values()], commitImageErase());
      areaEraseChanges.clear();
      areaEraseLast = null;
    } else {
      eraseAt(e);
      board.removeStrokes(new Set(erasePending));
    }
    erasePending.clear();
    compositor.setOverride(board.activeFrame, board.activeLayer, null, null);
  } else if (drag.kind === 'lasso') {
    addLassoPoint(e);
    commitLasso();
    syncAnts();
  } else if (drag.kind === 'transform') {
    commitReshape(drag);
  } else if (drag.kind === 'region') {
    regionDrag = null;
    captureRegion(drag.x0, drag.y0, e.offsetX, e.offsetY);
  } else if (drag.kind === 'move' && selection) {
    // Commit once, as a single undo step, and carry the outline along with it.
    board.moveItems(selection.ids, selection.images, moveX, moveY);
    shiftSelection(selection, moveX, moveY);
    moveX = 0;
    moveY = 0;
  }
  if (drag.kind === 'move' || drag.kind === 'transform') dropLift();
  drag = null;
  activePointer = null;
  if (tool !== 'eraser') eraserCursor = null;
  updateCursor();
  requestRender();
}

canvas.addEventListener('pointerup', endGesture);
canvas.addEventListener('pointercancel', endGesture);
canvas.addEventListener('pointerleave', () => {
  lastPointer = null;
  loupeEl.classList.add('hidden');
  if (eraserCursor && drag === null) {
    eraserCursor = null;
    requestRender();
  }
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.01));
    } else {
      const d = toWorldDelta(camera, e.deltaX, e.deltaY);
      camera.x += d.x;
      camera.y += d.y;
      requestRender();
      scheduleAutosave();
    }
  },
  { passive: false }
);

// ---- keyboard -------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
  if (e.key === ' ') {
    if (!spaceHeld) {
      spaceHeld = true;
      updateCursor();
    }
    e.preventDefault();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') {
    if (openPops.length > 0) {
      closeTopPop();
      return;
    }
    if (pickerActive()) {
      pickerHeld = false;
      if (tool === 'picker') setTool(pickedFrom && pickedFrom !== 'picker' ? pickedFrom : 'pen');
      else syncPicker();
      return;
    }
    if (!exportAnimEl.classList.contains('hidden')) {
      closeExportDialog();
      return;
    }
    stopPlayback();
    clearSelection();
    if (regionDrag) {
      regionDrag = null;
      drag = null;
      requestRender();
    }
    return;
  }
  if (e.key === 'Enter') {
    if (!timelineOpen) setTimelineOpen(true);
    togglePlayback();
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    gotoFrame(e.key === 'ArrowLeft' ? -1 : 1);
    e.preventDefault();
    return;
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && (wandSel || selection)) {
    if (wandSel) applyWandCut(false);
    else deleteSelection();
    e.preventDefault();
    return;
  }
  switch (e.key.toLowerCase()) {
    case 'b':
    case 'p':
      setTool('pen');
      break;
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6': {
      const picked = BRUSH_ORDER[Number(e.key) - 1];
      if (picked) setBrush(picked);
      break;
    }
    case 'e':
      setTool(tool === 'eraser' ? 'pen' : 'eraser');
      break;
    case 'f':
      setTool(tool === 'fill' ? 'pen' : 'fill');
      break;
    case 's':
      setTool(tool === 'select' ? 'pen' : 'select');
      break;
    case 'w':
      setTool(tool === 'wand' ? 'pen' : 'wand');
      break;
    // Held down it is a momentary picker: lean on it, hover the colour you
    // want, let go. Pressed while the tool is already on, it puts it away.
    case 'i':
      if (tool === 'picker') {
        setTool(pickedFrom && pickedFrom !== 'picker' ? pickedFrom : 'pen');
      } else if (!pickerHeld) {
        pickerHeld = true;
        pickedFrom = tool;
        syncPicker();
        updateCursor();
      }
      break;
    case 'a':
      if (tool === 'ask') {
        setTool('pen');
        setAskOpen(false);
      } else {
        setTool('ask');
        setAskOpen(true);
      }
      break;
    case 'h':
      setTool('hand');
      break;
    case 'l':
      setLayersOpen(!layersOpen);
      break;
    case 't':
      setTimelineOpen(!timelineOpen);
      break;
    case '[':
      sizeInput.value = String(Math.max(1, size - 1));
      sizeInput.dispatchEvent(new Event('input'));
      break;
    case ']':
      sizeInput.value = String(Math.min(28, size + 1));
      sizeInput.dispatchEvent(new Event('input'));
      break;
    case 'm':
      if (!e.repeat) flipView(e.shiftKey ? 'v' : 'h');
      break;
    case 'r':
      if (!rHeld) {
        rHeld = true;
        updateWheel();
      }
      break;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceHeld = false;
    updateCursor();
  }
  if (e.key.toLowerCase() === 'r') {
    rHeld = false;
    updateWheel();
  }
  // Letting go over the board is the pick. Letting go anywhere else just puts
  // the magnifier away, so a stray press costs nothing.
  if (e.key.toLowerCase() === 'i' && pickerHeld) {
    if (lastPointer) takeColorAt(lastPointer.x, lastPointer.y);
    else {
      pickerHeld = false;
      pickedFrom = null;
      syncPicker();
      updateCursor();
    }
  }
});

// A lost keyup (app switch mid-hold) must not leave the wheel stuck on screen.
window.addEventListener('blur', () => {
  rHeld = false;
  spaceHeld = false;
  pickerHeld = false;
  updateWheel();
  syncPicker();
  updateCursor();
});

// ---- menu / file actions --------------------------------------------------

async function newBoard(): Promise<void> {
  if (board.strokeCount > 0 || board.images.length > 0) {
    const ok = await window.betterboard.confirm(
      'Start a new board?',
      'The current board will be cleared. Save it first if you want to keep it.'
    );
    if (!ok) return;
  }
  clearSelection();
  board.deserialize(EMPTY_BOARD);
  camera.x = -cssWidth / 2;
  camera.y = -cssHeight / 2;
  camera.scale = 1;
  camera.rotation = 0;
  camera.flip = false;
  syncFlip();
  updateWheel();
  updateZoomLabel();
  requestRender();
  scheduleAutosave();
}

// A file is read in pieces, so a board of any size opens; a big one says how
// far along it is rather than leaving the window apparently frozen.
async function openBoard(): Promise<void> {
  let saved: Camera | null;
  try {
    const snap = await openBoardFile((done, total) => {
      if (total > 32 << 20) toast(`Opening… ${Math.round((done / total) * 100)}%`);
    });
    if (!snap) return;
    clearSelection();
    saved = board.load(snap);
  } catch {
    await window.betterboard.confirm('Could not open file', 'It is not a BetterBoard board.');
    return;
  }
  // A board always opens the right way round; see fileCamera.
  camera.flip = false;
  syncFlip();
  if (saved) {
    camera.x = saved.x;
    camera.y = saved.y;
    camera.scale = saved.scale;
    camera.rotation = saved.rotation;
    updateWheel();
    updateZoomLabel();
    requestRender();
  } else {
    zoomFit();
  }
  if (board.strokeCount > 50_000) toast(`Opened ${board.strokeCount.toLocaleString()} strokes`);
  scheduleAutosave();
}

async function saveBoard(): Promise<void> {
  const big = board.strokeCount > 50_000;
  try {
    if (big) toast('Saving…');
    if ((await saveBoardFile(board, fileCamera())) && big) toast('Saved');
  } catch (err) {
    await window.betterboard.confirm('Could not save the board', err instanceof Error ? err.message : String(err));
  }
}

async function exportPNG(): Promise<void> {
  const visible = board.visibleStrokes();
  const pictures = board.visibleImages();
  const content = board.contentBBox(visible, pictures);
  if (!content) return;
  const exportCanvas = renderExport(visible, pictures, board.layers, content, THEMES[themeName]);
  await window.betterboard.exportPNG(exportCanvas.toDataURL('image/png'));
}

// ---- animation export -----------------------------------------------------

const exportAnimEl = $('export-anim');
const exportFormatSel = $('export-anim-format') as HTMLSelectElement;
const exportFpsInput = $('export-anim-fps') as HTMLInputElement;
const exportSizeSel = $('export-anim-size') as HTMLSelectElement;
const exportNote = $('export-anim-note');
const exportBar = $('export-anim-bar');
const exportFill = $('export-anim-fill');
const exportGoBtn = $('export-anim-go') as HTMLButtonElement;
const exportCloseBtn = $('export-anim-close') as HTMLButtonElement;
const exportFields = [exportFormatSel, exportFpsInput, exportSizeSel];

let exporting = false;
let exportCancelled = false;
// Measured once when the dialog opens: the board cannot change while it is up,
// and walking every frame on each keystroke would be wasted work.
let exportContent: BBox | null = null;

function exportSettings(): AnimSettings {
  const fps = Math.round(Number(exportFpsInput.value));
  return {
    format: exportFormatSel.value as AnimFormat,
    fps: Number.isFinite(fps) ? Math.min(MAX_FPS, Math.max(MIN_FPS, fps)) : board.fps,
    maxDim: Number(exportSizeSel.value),
  };
}

// Says what the file will actually be before anyone commits to making it —
// including where the chosen format bends the numbers that were asked for.
function updateExportNote(): void {
  if (exporting) return;
  if (!exportContent) {
    exportNote.textContent = 'This board has nothing on it yet — draw something first.';
    exportGoBtn.disabled = true;
    return;
  }
  exportGoBtn.disabled = false;
  const settings = exportSettings();
  const layout = animationLayout(exportContent, settings);
  const frames = board.frames.length;
  const seconds = frames / settings.fps;
  const parts = [
    `${frames} frame${frames === 1 ? '' : 's'} · ${layout.width}×${layout.height} · ${seconds.toFixed(seconds < 10 ? 2 : 1)}s`,
  ];
  if (settings.format === 'gif') {
    const real = 1000 / gifDelayMs(settings.fps);
    if (Math.abs(real - settings.fps) > 0.05) {
      parts.push(`GIF times frames in hundredths of a second, so this plays at about ${real.toFixed(1)}fps.`);
    }
    parts.push('GIF is capped at 256 colours a frame and grows quickly with size.');
  }
  exportNote.textContent = parts.join(' ');
}

function openExportDialog(): void {
  if (exporting) return;
  stopPlayback();
  exportContent = board.animationBBox();
  exportFpsInput.value = String(board.fps);
  exportBar.classList.add('hidden');
  exportFill.style.width = '0%';
  updateExportNote();
  exportAnimEl.classList.remove('hidden');
}

// While an export is running the same button stops it: the encode unwinds at
// the next frame boundary and nothing half-written ever reaches a file.
function closeExportDialog(): void {
  if (exporting) {
    exportCancelled = true;
    exportNote.textContent = 'Stopping…';
    return;
  }
  exportAnimEl.classList.add('hidden');
}

function setExportBusy(busy: boolean): void {
  exporting = busy;
  exportGoBtn.disabled = busy;
  for (const field of exportFields) field.disabled = busy;
  exportBar.classList.toggle('hidden', !busy);
}

async function runExportAnimation(): Promise<void> {
  if (exporting || !exportContent) return;
  const settings = exportSettings();
  setExportBusy(true);
  exportCancelled = false;
  exportFill.style.width = '0%';
  exportNote.textContent = `Rendering ${board.frames.length} frames…`;
  try {
    const result = await exportAnimation(board, THEMES[themeName], settings, {
      onFrame: (done, total) => {
        exportFill.style.width = `${Math.round((done / total) * 100)}%`;
        exportNote.textContent = `Encoding frame ${done} of ${total}…`;
      },
      cancelled: () => exportCancelled,
    });
    setExportBusy(false);
    exportCancelled = false;
    if (result) await window.betterboard.exportAnimation(result.bytes, result.format);
    exportAnimEl.classList.add('hidden');
  } catch (err) {
    setExportBusy(false);
    exportCancelled = false;
    exportNote.textContent = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

$('frame-export').addEventListener('click', openExportDialog);
exportGoBtn.addEventListener('click', () => void runExportAnimation());
exportCloseBtn.addEventListener('click', closeExportDialog);
for (const field of exportFields) {
  field.addEventListener('change', updateExportNote);
  field.addEventListener('input', updateExportNote);
}
exportAnimEl.addEventListener('pointerdown', (e) => {
  if (e.target === exportAnimEl) closeExportDialog();
});

window.betterboard.onMenu((action) => {
  switch (action) {
    case 'new':
      void newBoard();
      break;
    case 'open':
      void openBoard();
      break;
    case 'save':
      void saveBoard();
      break;
    case 'export':
      void exportPNG();
      break;
    case 'export-animation':
      openExportDialog();
      break;
    case 'insert-image':
      void insertImageFile();
      break;
    case 'paste':
      void pasteFromClipboard();
      break;
    case 'copy':
      copyAction(false);
      break;
    case 'cut':
      copyAction(true);
      break;
    case 'duplicate':
      duplicateAction();
      break;
    case 'select-all':
      selectAll();
      break;
    case 'sticker-save':
      saveSelectionAsSticker();
      break;
    case 'toggle-stickers':
      setStickersOpen(!stickersOpen);
      break;
    case 'dock-top':
      setDockSide('top');
      break;
    case 'dock-right':
      setDockSide('right');
      break;
    case 'dock-bottom':
      setDockSide('bottom');
      break;
    case 'dock-left':
      setDockSide('left');
      break;
    case 'undo':
      doUndo();
      break;
    case 'redo':
      doRedo();
      break;
    case 'normalize':
      normalize();
      break;
    case 'clear':
      void (async () => {
        if (board.count(board.activeFrame) === 0) return;
        if (await window.betterboard.confirm('Clear this frame?', 'You can undo this.')) {
          clearSelection();
          board.clear();
        }
      })();
      break;
    case 'zoom-in':
      zoomAt(cssWidth / 2, cssHeight / 2, 1.25);
      break;
    case 'zoom-out':
      zoomAt(cssWidth / 2, cssHeight / 2, 0.8);
      break;
    case 'zoom-reset':
      zoomTo(1);
      break;
    case 'zoom-fit':
      zoomFit();
      break;
    case 'toggle-grid':
      grid = !grid;
      gridBtn.classList.toggle('active', grid);
      savePrefs();
      requestRender();
      break;
    case 'flip-h':
      flipView('h');
      break;
    case 'flip-v':
      flipView('v');
      break;
    case 'toggle-theme':
      toggleTheme();
      break;
    case 'choose-workspace':
      welcomeEl.classList.remove('hidden');
      break;
    case 'ai-connections':
      settingsForced = true;
      setAskOpen(true);
      askSettings.classList.remove('hidden');
      askConnectionName.focus();
      break;
    case 'ask-region':
      setTool('ask');
      setAskOpen(true);
      break;
    case 'toggle-layers':
      setLayersOpen(!layersOpen);
      break;
    case 'toggle-timeline':
      setTimelineOpen(!timelineOpen);
      break;
    case 'frame-new':
    case 'frame-duplicate':
      stopPlayback();
      clearSelection();
      if (!timelineOpen) setTimelineOpen(true);
      board.addFrame(action === 'frame-duplicate');
      scrollFrameIntoView();
      break;
    case 'frame-delete':
      stopPlayback();
      clearSelection();
      board.removeFrame(board.activeFrame);
      break;
    case 'frame-next':
      gotoFrame(1);
      break;
    case 'frame-prev':
      gotoFrame(-1);
      break;
    case 'play':
      if (!timelineOpen) setTimelineOpen(true);
      togglePlayback();
      break;
    case 'toggle-onion':
      if (!timelineOpen) setTimelineOpen(true);
      board.setOnion({ enabled: !board.onion.enabled });
      break;
    case 'layer-new':
      clearSelection();
      board.addLayer();
      if (!layersOpen) setLayersOpen(true);
      break;
    case 'layer-delete':
      clearSelection();
      board.removeLayer(board.activeLayer);
      break;
    case 'layer-toggle-visible':
      board.setLayerVisible(board.activeLayer, !board.active.visible);
      clearSelection();
      break;
  }
});

// ---- toolbar wiring ---------------------------------------------------------

toolButtons.eraser.addEventListener('click', () => setTool('eraser'));
for (const button of eraserModeButtons) {
  button.addEventListener('click', () => setEraserMode(button.dataset.eraserMode as EraserMode));
}
for (const id of BRUSH_ORDER) {
  brushButtons[id].addEventListener('click', () => setBrush(id));
}
toolButtons.select.addEventListener('click', () => setTool('select'));
toolButtons.wand.addEventListener('click', () => setTool('wand'));
toolButtons.fill.addEventListener('click', () => setTool('fill'));
// The picker button is a toggle, so pressing it a second time gives back the
// tool you were on rather than stranding you on a magnifier.
toolButtons.picker.addEventListener('click', () => {
  if (tool === 'picker') setTool(pickedFrom && pickedFrom !== 'picker' ? pickedFrom : 'pen');
  else startPicking();
});
for (const button of wandModeButtons) {
  button.addEventListener('click', () => setWandMode(button.dataset.wandMode as WandMode));
}
wandToleranceInput.addEventListener('input', () => {
  wandTolerance = Number(wandToleranceInput.value);
  $('wand-tolerance-val').textContent = String(wandTolerance);
  savePrefs();
});
for (const button of fillModeButtons) {
  button.addEventListener('click', () => {
    setFillMode(button.dataset.fillMode as FillMode);
    placeToolSettings();
  });
}
fillToleranceInput.addEventListener('input', () => {
  fillTolerance = Number(fillToleranceInput.value);
  $('fill-tolerance-val').textContent = String(fillTolerance);
  savePrefs();
});
$('wand-cut').addEventListener('click', () => applyWandCut(false));
$('wand-keep').addEventListener('click', () => applyWandCut(true));
toolButtons.ask.addEventListener('click', () => setTool('ask'));
toolButtons.hand.addEventListener('click', () => setTool('hand'));

$('sel-duplicate').addEventListener('click', () => duplicateAction());
$('sel-copy').addEventListener('click', () => copyAction(false));
$('sel-sticker').addEventListener('click', saveSelectionAsSticker);
$('sel-delete').addEventListener('click', deleteSelection);
stickersBtn.addEventListener('click', () => setStickersOpen(!stickersOpen));
$('stickers-close').addEventListener('click', () => setStickersOpen(false));
$('sticker-add').addEventListener('click', saveSelectionAsSticker);

// ---- welcome / workspace picker ---------------------------------------------

// Every tool stays available to everyone; the choice only arranges the opening
// layout, so a first launch lands in a workspace shaped for the work at hand.
// `anything` is the answer for people who do not want one: it is the app's own
// defaults, spelled out, so picking it is a decision rather than a shrug.
interface Workspace {
  tool: Tool;
  brush: BrushId;
  grid: boolean;
  layers: boolean;
  timeline: boolean;
}

const WORKSPACES: Record<Persona, Workspace> = {
  anything: { tool: 'pen', brush: 'pen', grid: true, layers: true, timeline: false },
  student: { tool: 'pen', brush: 'pen', grid: true, layers: false, timeline: false },
  artist: { tool: 'pen', brush: 'paint', grid: false, layers: true, timeline: false },
  animator: { tool: 'pen', brush: 'pen', grid: false, layers: true, timeline: true },
  photo: { tool: 'wand', brush: 'pen', grid: false, layers: true, timeline: false },
};

function applyPersona(persona: Persona): void {
  const workspace = WORKSPACES[persona] ?? WORKSPACES.anything;
  localStorage.setItem('bb:persona', persona);
  welcomeEl.classList.add('hidden');
  // Brush first: setBrush pulls the tool back to the pen, which would undo a
  // workspace that opens on a different one.
  setBrush(workspace.brush);
  setTool(workspace.tool);
  grid = workspace.grid;
  gridBtn.classList.toggle('active', grid);
  setLayersOpen(workspace.layers);
  setTimelineOpen(workspace.timeline);
  savePrefs();
  requestRender();
}

for (const button of welcomeEl.querySelectorAll<HTMLButtonElement>('[data-persona]')) {
  button.addEventListener('click', () => applyPersona(button.dataset.persona as Persona));
}
$('welcome-skip').addEventListener('click', () => {
  localStorage.setItem('bb:persona', 'skipped');
  welcomeEl.classList.add('hidden');
});

for (const c of SWATCHES) {
  const btn = document.createElement('button');
  btn.className = 'swatch';
  btn.dataset.color = c;
  btn.style.background = c;
  btn.title = c;
  btn.addEventListener('click', () => {
    setColor(c, true);
    // The bucket paints in the current colour too, so picking one should not
    // drag you off it.
    if (tool !== 'pen' && tool !== 'fill') setTool('pen');
  });
  swatchesEl.appendChild(btn);
}

sizeInput.addEventListener('input', () => setSize(Number(sizeInput.value)));

undoBtn.addEventListener('click', doUndo);
redoBtn.addEventListener('click', doRedo);
gridBtn.addEventListener('click', () => {
  grid = !grid;
  gridBtn.classList.toggle('active', grid);
  savePrefs();
  requestRender();
});
themeBtn.addEventListener('click', toggleTheme);

$('zoom-in').addEventListener('click', () => zoomAt(cssWidth / 2, cssHeight / 2, 1.25));
$('zoom-out').addEventListener('click', () => zoomAt(cssWidth / 2, cssHeight / 2, 0.8));
zoomLabel.addEventListener('click', () => zoomTo(1));
normalizeBtn.addEventListener('click', normalize);

// ---- small shared ui ------------------------------------------------------

let toastTimer: number | undefined;
function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Chromium has no way to paint the filled half of a range track, so every
// slider carries its own percentage and the track is a gradient stop.
function syncSlider(el: HTMLInputElement): void {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const pct = max === min ? 0 : ((Number(el.value) - min) / (max - min)) * 100;
  el.style.setProperty('--pct', `${clamp(pct, 0, 100)}%`);
}

function syncSliders(): void {
  for (const el of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) syncSlider(el);
}

function wireSliders(): void {
  for (const el of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    el.addEventListener('input', () => syncSlider(el));
  }
  syncSliders();
}

// Backing store at device resolution, drawing coordinates in css pixels — the
// picker's square and the loupe are both read closely enough that a soft
// upscale would show.
function sizeCanvas(el: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (el.width !== w || el.height !== h) {
    el.width = w;
    el.height = h;
  }
  const c = el.getContext('2d', { willReadFrequently: true })!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return c;
}

// ---- popovers -------------------------------------------------------------

// Everything that hangs off the toolbar opens the same way: as a toggle, over
// a scrim that swallows the click which closes it. That last part is the point
// — dismissing the colour picker must never leave a dot on the board.
const openPops: { el: HTMLElement; anchor: HTMLElement }[] = [];

function popOpen(el: HTMLElement): boolean {
  return openPops.some((open) => open.el === el);
}

function closePops(): void {
  for (const open of openPops.splice(0)) open.el.classList.add('hidden');
  scrim.classList.add('hidden');
  syncPopAnchors();
}

function closeTopPop(): void {
  const open = openPops.pop();
  if (!open) return;
  open.el.classList.add('hidden');
  scrim.classList.toggle('hidden', openPops.length === 0);
  syncPopAnchors();
}

function showPop(el: HTMLElement, anchor: HTMLElement): void {
  // A popover opened from inside another one stacks; anything else replaces.
  const nested = openPops.some((open) => open.el.contains(anchor));
  if (!nested) closePops();
  el.classList.remove('hidden');
  openPops.push({ el, anchor });
  placePop(el, anchor);
  scrim.classList.remove('hidden');
  syncPopAnchors();
}

// Anchored to whatever opened it, on whichever side of the dock leaves room.
// An anchor inside another popover is measured where it actually is, which is
// why the stack keeps the element rather than a rectangle taken at open time.
function placePop(el: HTMLElement, anchor: HTMLElement): void {
  const a = anchor.getBoundingClientRect();
  el.style.visibility = 'hidden';
  const p = el.getBoundingClientRect();
  const gap = 10;
  let left: number;
  let top: number;
  if (dockSide === 'left' || dockSide === 'right') {
    top = a.top + a.height / 2 - p.height / 2;
    left = dockSide === 'left' ? a.right + gap : a.left - p.width - gap;
  } else {
    left = a.left + a.width / 2 - p.width / 2;
    top = dockSide === 'bottom' ? a.top - p.height - gap : a.bottom + gap;
  }
  el.style.left = `${clamp(left, 8, Math.max(8, window.innerWidth - p.width - 8))}px`;
  el.style.top = `${clamp(top, 8, Math.max(8, window.innerHeight - p.height - 8))}px`;
  el.style.visibility = '';
}

function placeOpenPops(): void {
  for (const open of openPops) placePop(open.el, open.anchor);
}

function togglePop(el: HTMLElement, anchor: HTMLElement): void {
  if (popOpen(el)) closePops();
  else showPop(el, anchor);
}

// Buttons that own a popover light up while it is up, so a toggle looks like
// one rather than like something that failed to close.
function syncPopAnchors(): void {
  colorChip.classList.toggle('on', popOpen(colorPop));
  sizeChip.classList.toggle('on', popOpen(sizePop));
  recentBtn.classList.toggle('on', popOpen(recentPop));
  dockMoreBtn.classList.toggle('active', popOpen(dockOverflow));
}

scrim.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  closePops();
});

// ---- the dock -------------------------------------------------------------

const dockEl = $('dock');
const dockMain = $('dock-main');
const dockMoreBtn = $('dock-more');
const dockGrip = $('dock-grip');
const dockOverflow = $('dock-overflow');
let dock: Dock | null = null;

// On macOS the bar sits right at the top edge, and only steps down when it is
// actually wide enough to run into the traffic lights — which, since it is
// centred and sheds sections as it narrows, is a question about this window at
// this moment rather than about the platform.
const LIGHTS = 96; // px of window corner the traffic lights own

function placeDock(): void {
  if (dockSide !== 'top' || !document.body.classList.contains('mac')) {
    dockEl.style.removeProperty('--dock-top');
    return;
  }
  dockEl.style.setProperty('--dock-top', '10px');
  if (dockEl.getBoundingClientRect().left < LIGHTS) {
    dockEl.style.setProperty('--dock-top', 'calc(var(--safe-top) + 4px)');
  }
}

function applyDockPads(): void {
  if (!dock) return;
  placeDock();
  const pads = dock.pads();
  const style = document.body.style;
  style.setProperty('--pad-top', `${pads.top}px`);
  style.setProperty('--pad-right', `${pads.right}px`);
  style.setProperty('--pad-bottom', `${pads.bottom}px`);
  style.setProperty('--pad-left', `${pads.left}px`);
  stackRightPanels();
}

// Layers and the stickers tray share the right-hand rail. Where the first one
// ends depends on how many layers there are, so the second is hung off its
// real bottom edge rather than guessed at from the window — on a short window
// a guess is the difference between a tidy column and two panels on top of
// each other.
function stackRightPanels(): void {
  stickersPanel.style.top = '';
  stickersPanel.style.bottom = '';
  stickersPanel.style.maxHeight = '';
  if (!stickersOpen || !layersOpen) return;
  const gap = 10;
  const below = layersPanel.getBoundingClientRect().bottom + gap;
  // Zoom pill, its margin, and a gap — the tray stops above all three.
  const floor = (dock?.pads().bottom ?? 0) + (timelineOpen ? TIMELINE_H : 0) + 56;
  stickersPanel.style.top = `${below}px`;
  stickersPanel.style.bottom = 'auto';
  // A floor, because a tray too short to show a sticker is worse than one that
  // has to scroll — and on a window that small, something has to give.
  stickersPanel.style.maxHeight = `${Math.max(96, window.innerHeight - below - floor)}px`;
}

// The live tool's options ride alongside the dock rather than inside it: they
// stay in view on every edge without having to fold into a column.
function placeToolSettings(): void {
  if (toolSettings.classList.contains('hidden')) return;
  const r = dockEl.getBoundingClientRect();
  const p = toolSettings.getBoundingClientRect();
  const gap = 8;
  let left: number;
  let top: number;
  // On the sides it rides at the dock's middle rather than its top: the top
  // corners are where the layers and stickers panels live.
  if (dockSide === 'left') {
    left = r.right + gap;
    top = r.top + r.height / 2 - p.height / 2;
  } else if (dockSide === 'right') {
    left = r.left - p.width - gap;
    top = r.top + r.height / 2 - p.height / 2;
  } else if (dockSide === 'bottom') {
    left = r.left + r.width / 2 - p.width / 2;
    top = r.top - p.height - gap;
  } else {
    left = r.left + r.width / 2 - p.width / 2;
    top = r.bottom + gap;
  }
  toolSettings.style.left = `${clamp(left, 8, Math.max(8, window.innerWidth - p.width - 8))}px`;
  toolSettings.style.top = `${clamp(top, 8, Math.max(8, window.innerHeight - p.height - 8))}px`;
}

function setupDock(): void {
  dockEl.dataset.side = dockSide;
  dock = createDock({
    dock: dockEl,
    main: dockMain,
    more: dockMoreBtn,
    grip: dockGrip,
    overflow: dockOverflow,
    // Board toggles and history live in the menus too, so they are the first
    // things to fold away; the colour and size chips outlast them, because
    // nothing else in the app puts them a single click from the drawing. The
    // brushes and the tools are last and only go on a genuinely tiny window —
    // but they do go, because a bar with its end cut off is worse than a bar
    // that admits it needs a menu.
    shedOrder: ['view', 'history', 'color', 'size', 'tools', 'brushes'],
    onSide: (side) => {
      dockSide = side;
      savePrefs();
      requestRender();
    },
    onLayout: () => {
      applyDockPads();
      placeToolSettings();
    },
    closeOverflow: () => closePops(),
    travelling: () => (toolSettings.classList.contains('hidden') ? [] : [toolSettings]),
  });
  dock.relayout();
  dockMoreBtn.addEventListener('click', () => togglePop(dockOverflow, dockMoreBtn));
  window.addEventListener('resize', () => {
    applyDockPads();
    placeToolSettings();
    placeOpenPops();
  });
}

function setDockSide(side: DockSide): void {
  dock?.setSide(side);
}

// ---- colour picker --------------------------------------------------------

// The square is driven by HSV and the board by hex, and the square has to stay
// the authority while it is being used: black and grey have no hue to convert
// back out of, so a round trip through hex would drop the marker to red every
// time someone dragged into a corner.
let hsv: HSV = { h: 0, s: 0, v: 1 };
let hsvOwned = false;

const SV_W = 252;
const SV_H = 150;

function drawSV(): void {
  const c = sizeCanvas(svCanvas, SV_W, SV_H);
  c.fillStyle = rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }));
  c.fillRect(0, 0, SV_W, SV_H);
  const white = c.createLinearGradient(0, 0, SV_W, 0);
  white.addColorStop(0, 'rgba(255,255,255,1)');
  white.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = white;
  c.fillRect(0, 0, SV_W, SV_H);
  const black = c.createLinearGradient(0, 0, 0, SV_H);
  black.addColorStop(0, 'rgba(0,0,0,0)');
  black.addColorStop(1, 'rgba(0,0,0,1)');
  c.fillStyle = black;
  c.fillRect(0, 0, SV_W, SV_H);

  const x = clamp(hsv.s * SV_W, 0, SV_W);
  const y = clamp((1 - hsv.v) * SV_H, 0, SV_H);
  c.beginPath();
  c.arc(x, y, 6.5, 0, Math.PI * 2);
  c.strokeStyle = '#fff';
  c.lineWidth = 2;
  c.stroke();
  c.beginPath();
  c.arc(x, y, 8, 0, Math.PI * 2);
  c.strokeStyle = 'rgba(0,0,0,0.55)';
  c.lineWidth = 1.2;
  c.stroke();
}

function commitPickerHsv(remember: boolean): void {
  hsvOwned = true;
  setColor(rgbToHex(hsvToRgb(hsv)), remember);
  hsvOwned = false;
}

function syncPickerFields(): void {
  if (!hsvOwned) {
    const from = hexToRgb(color);
    if (from) hsv = rgbToHsv(from);
  }
  const rgb = hexToRgb(color) ?? { r: 0, g: 0, b: 0 };
  hueInput.value = String(Math.round(hsv.h));
  syncSlider(hueInput);
  cpPreview.style.background = color;
  if (document.activeElement !== cpHex) cpHex.value = color.replace('#', '').toUpperCase();
  if (document.activeElement !== cpR) cpR.value = String(Math.round(rgb.r));
  if (document.activeElement !== cpG) cpG.value = String(Math.round(rgb.g));
  if (document.activeElement !== cpB) cpB.value = String(Math.round(rgb.b));
  drawSV();
  markRecent();
}

function svPick(e: PointerEvent): void {
  const r = svCanvas.getBoundingClientRect();
  hsv = {
    h: hsv.h,
    s: clamp((e.clientX - r.left) / r.width, 0, 1),
    v: clamp(1 - (e.clientY - r.top) / r.height, 0, 1),
  };
  commitPickerHsv(false);
}

function wirePicker(): void {
  let svDrag = false;
  svCanvas.addEventListener('pointerdown', (e) => {
    svDrag = true;
    svCanvas.setPointerCapture(e.pointerId);
    svPick(e);
  });
  svCanvas.addEventListener('pointermove', (e) => {
    if (svDrag) svPick(e);
  });
  const release = (): void => {
    if (!svDrag) return;
    svDrag = false;
    commitPickerHsv(true); // only the finished colour earns a place in Recent
  };
  svCanvas.addEventListener('pointerup', release);
  svCanvas.addEventListener('pointercancel', release);

  hueInput.addEventListener('input', () => {
    hsv = { ...hsv, h: Number(hueInput.value) };
    commitPickerHsv(false);
  });
  hueInput.addEventListener('change', () => commitPickerHsv(true));

  cpHex.addEventListener('input', () => {
    const parsed = parseColor(cpHex.value);
    if (parsed) setColor(parsed);
  });
  cpHex.addEventListener('change', () => {
    const parsed = parseColor(cpHex.value);
    if (parsed) setColor(parsed, true);
    else syncPickerFields(); // put back what is really set rather than leave a typo
  });
  for (const field of [cpR, cpG, cpB]) {
    field.addEventListener('input', () => {
      const rgb = {
        r: Number(cpR.value),
        g: Number(cpG.value),
        b: Number(cpB.value),
      };
      if (![rgb.r, rgb.g, rgb.b].every((v) => Number.isFinite(v))) return;
      setColor(rgbToHex(rgb));
    });
    field.addEventListener('change', () => setColor(color, true));
  }
  // Typing in the picker must not reach the board's own shortcuts.
  for (const field of [cpHex, cpR, cpG, cpB]) {
    field.addEventListener('keydown', (e) => e.stopPropagation());
  }

  colorChip.addEventListener('click', () => togglePop(colorPop, colorChip));
  recentBtn.addEventListener('click', () => togglePop(recentPop, recentBtn));
  cpPick.addEventListener('click', () => {
    closePops();
    startPicking();
  });
  $('cp-recent-clear').addEventListener('click', () => {
    recent = [];
    renderRecents();
    savePrefs();
  });
}

// ---- recent colours -------------------------------------------------------

function renderRecents(): void {
  for (const host of [cpRecent, recentGrid]) {
    host.textContent = '';
    for (const c of recent) {
      const button = document.createElement('button');
      button.type = 'button';
      button.style.background = c;
      button.dataset.color = c;
      button.title = c.toUpperCase();
      button.addEventListener('click', () => {
        setColor(c, true);
        if (tool !== 'pen' && tool !== 'fill') setTool('pen');
      });
      host.appendChild(button);
    }
  }
  $('recent-empty').classList.toggle('hidden', recent.length > 0);
  markRecent();
}

function markRecent(): void {
  for (const host of [cpRecent, recentGrid]) {
    for (const el of host.children) {
      el.classList.toggle('active', (el as HTMLElement).dataset.color?.toLowerCase() === color.toLowerCase());
    }
  }
}

// ---- size popover and scratch pad -----------------------------------------

const PAD_W = 244;
const PAD_H = 118;
let padStrokes: Stroke[] = [];
let padLive: Stroke | null = null;

function paintPad(): void {
  const c = sizeCanvas(sizePad, PAD_W, PAD_H);
  c.fillStyle = THEMES[themeName].bg;
  c.fillRect(0, 0, PAD_W, PAD_H);
  const dpr = window.devicePixelRatio || 1;
  for (const s of [...padStrokes, ...(padLive ? [padLive] : [])]) {
    if (s.path) drawStroke(c, s, [dpr, 0, 0, dpr, 0, 0], dpr, s.path);
  }
}

// A miniature board, drawn with the live brush at its real size. It is the
// only honest answer to "how big is 12?", which no number and no dot can give.
function wireSizePad(): void {
  const padStroke = (e: PointerEvent): Stroke => {
    const s: Stroke = {
      id: uid(),
      seq: 0,
      color,
      size: size * BRUSHES[brush].sizeScale,
      pen: e.pointerType === 'pen',
      brush,
      seed: (Math.random() * 0xffffffff) >>> 0,
      layer: '',
      frame: '',
      ox: e.offsetX,
      oy: e.offsetY,
      pts: new Float32Array(96),
      n: 0,
      bbox: emptyBBox(),
    };
    appendPoint(s, e.offsetX, e.offsetY, pressureOf(e));
    return s;
  };

  sizePad.addEventListener('pointerdown', (e) => {
    padLive = padStroke(e);
    padLive.path = buildPath(padLive, true);
    sizePad.setPointerCapture(e.pointerId);
    paintPad();
  });
  sizePad.addEventListener('pointermove', (e) => {
    if (!padLive) return;
    for (const ev of e.getCoalescedEvents?.() ?? [e]) appendPoint(padLive, ev.offsetX, ev.offsetY, pressureOf(ev));
    padLive.path = buildPath(padLive, true);
    paintPad();
  });
  const finish = (): void => {
    if (!padLive) return;
    sealPoints(padLive);
    padLive.path = buildPath(padLive, false);
    padStrokes.push(padLive);
    if (padStrokes.length > 40) padStrokes.shift();
    padLive = null;
    paintPad();
  };
  sizePad.addEventListener('pointerup', finish);
  sizePad.addEventListener('pointercancel', finish);

  $('size-pad-clear').addEventListener('click', () => {
    padStrokes = [];
    padLive = null;
    paintPad();
  });

  sizeChip.addEventListener('click', () => {
    togglePop(sizePop, sizeChip);
    if (popOpen(sizePop)) paintPad();
  });
  sizeNumber.addEventListener('input', () => {
    const v = Math.round(Number(sizeNumber.value));
    if (!Number.isFinite(v)) return;
    setSize(clamp(v, 1, 28));
  });
  sizeNumber.addEventListener('keydown', (e) => e.stopPropagation());
}

// ---- colour picker tool: loupe and pick ------------------------------------

const LOUPE_SIZE = 120; // css px of the magnifier
const LOUPE_SPAN = 15; // css px of board shown across it — odd, so a pixel is dead centre

function pickerActive(): boolean {
  return tool === 'picker' || pickerHeld;
}

function startPicking(): void {
  if (tool === 'picker') return;
  pickedFrom = tool;
  setTool('picker');
}

function syncPicker(): void {
  const on = pickerActive();
  cpPick.classList.toggle('on', on);
  toolButtons.picker.classList.toggle('active', on);
  if (!on) {
    loupeEl.classList.add('hidden');
    return;
  }
  if (lastPointer) drawLoupe(lastPointer.x, lastPointer.y);
}

// Magnifies straight off the board canvas rather than re-rendering: what is on
// screen is exactly what a pick should return, grid dots and all. The colour is
// then read back out of the loupe, which is an ordinary canvas — the board's
// own is low-latency and not always safe to read from.
function drawLoupe(x: number, y: number): string | null {
  const dpr = window.devicePixelRatio || 1;
  const c = sizeCanvas(loupeCanvas, LOUPE_SIZE, LOUPE_SIZE);
  c.imageSmoothingEnabled = false;
  c.fillStyle = THEMES[themeName].bg;
  c.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
  c.drawImage(
    canvas,
    (x - LOUPE_SPAN / 2) * dpr,
    (y - LOUPE_SPAN / 2) * dpr,
    LOUPE_SPAN * dpr,
    LOUPE_SPAN * dpr,
    0,
    0,
    LOUPE_SIZE,
    LOUPE_SIZE
  );

  const mid = Math.round((LOUPE_SIZE / 2) * dpr);
  const px = c.getImageData(mid, mid, 1, 1).data;
  const hex = rgbToHex({ r: px[0], g: px[1], b: px[2] });

  // Grid and crosshair go on after the read, so they can never be the thing
  // that gets picked.
  const cell = LOUPE_SIZE / LOUPE_SPAN;
  c.strokeStyle = 'rgba(128,128,128,0.28)';
  c.lineWidth = 0.5;
  c.beginPath();
  for (let i = 1; i < LOUPE_SPAN; i++) {
    c.moveTo(i * cell, 0);
    c.lineTo(i * cell, LOUPE_SIZE);
    c.moveTo(0, i * cell);
    c.lineTo(LOUPE_SIZE, i * cell);
  }
  c.stroke();
  const half = Math.floor(LOUPE_SPAN / 2);
  c.lineWidth = 1.5;
  c.strokeStyle = '#000';
  c.strokeRect(half * cell - 0.5, half * cell - 0.5, cell + 1, cell + 1);
  c.strokeStyle = '#fff';
  c.lineWidth = 1;
  c.strokeRect(half * cell, half * cell, cell, cell);

  loupeSwatch.style.background = hex;
  loupeHex.textContent = hex.toUpperCase();
  loupeEl.classList.remove('hidden');

  // Follows the pointer, and hops to the other side rather than run off screen.
  const rect = canvas.getBoundingClientRect();
  const box = loupeEl.getBoundingClientRect();
  let left = rect.left + x + 20;
  let top = rect.top + y + 20;
  if (left + box.width > window.innerWidth - 8) left = rect.left + x - box.width - 20;
  if (top + box.height > window.innerHeight - 8) top = rect.top + y - box.height - 20;
  loupeEl.style.left = `${Math.max(8, left)}px`;
  loupeEl.style.top = `${Math.max(8, top)}px`;
  return hex;
}

function takeColorAt(x: number, y: number): void {
  const hex = drawLoupe(x, y);
  pickerHeld = false;
  if (!hex) {
    syncPicker();
    return;
  }
  setColor(hex, true);
  toast(`Picked ${hex.toUpperCase()}`);
  const back = pickedFrom;
  pickedFrom = null;
  if (tool === 'picker') setTool(back && back !== 'picker' ? back : 'pen');
  else {
    syncPicker();
    updateCursor();
  }
}

// ---- paint bucket ---------------------------------------------------------

// The working buffer is capped: the fill it produces is a picture stored in the
// board file, and a screenful at retina resolution is already generous.
const FILL_MAX_DIM = 3072;

function viewportBBox(): BBox {
  const b = emptyBBox();
  for (const [sx, sy] of [
    [0, 0],
    [cssWidth, 0],
    [0, cssHeight],
    [cssWidth, cssHeight],
  ]) {
    const w = toWorld(camera, sx, sy);
    growBBox(b, w.x, w.y, 0);
  }
  return b;
}

// Flood fill on a freshly rendered copy of the view — no grid, no marquee, no
// eraser ring, so only the drawing bounds the paint. The buffer is axis-aligned
// in world space rather than screen space, which is what lets the result be
// stored as an ordinary picture even when the board is turned.
function fillAt(e: PointerEvent): void {
  if (!canEditActive()) return;
  const view = viewportBBox();
  const layout = exportLayout(view, {
    pad: 0,
    maxDim: FILL_MAX_DIM,
    maxScale: camera.scale * Math.min(2, window.devicePixelRatio || 1),
  });
  const buffer = document.createElement('canvas');
  buffer.width = layout.width;
  buffer.height = layout.height;
  paintExport(buffer, board.visibleStrokesIn(board.activeFrame, view), board.visibleImages(), board.layers, THEMES[themeName], layout);

  const bctx = buffer.getContext('2d', { willReadFrequently: true })!;
  const pixels = bctx.getImageData(0, 0, buffer.width, buffer.height);
  const k = layout.transform[0];
  const tx = layout.transform[4];
  const ty = layout.transform[5];
  const world = toWorld(camera, e.offsetX, e.offsetY);
  const px = Math.round(world.x * k + tx);
  const py = Math.round(world.y * k + ty);
  if (px < 0 || py < 0 || px >= buffer.width || py >= buffer.height) return;

  let mask =
    fillMode === 'similar'
      ? similarSelect(pixels.data, buffer.width, buffer.height, px, py, fillTolerance)
      : floodSelect(pixels.data, buffer.width, buffer.height, px, py, fillTolerance);
  // One ring of growth pushes the paint under the anti-aliased edge of whatever
  // bounded it, so no pale seam is left between the fill and the line. More than
  // one starts eating the line itself: a buffer pixel is worth several world
  // units when the board is zoomed out, and thin ink disappears into it.
  mask = dilate(mask, buffer.width, buffer.height);
  const bounds = maskBounds(mask, buffer.width, buffer.height);
  if (!bounds) return;
  const open = maskTouchesBorder(mask, buffer.width, buffer.height);

  const w = bounds.maxX - bounds.minX + 1;
  const h = bounds.maxY - bounds.minY + 1;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  const shape = octx.createImageData(w, h);
  const rgb = hexToRgb(color) ?? { r: 255, g: 255, b: 255 };
  for (let y = 0; y < h; y++) {
    const row = (y + bounds.minY) * buffer.width + bounds.minX;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      const i = (y * w + x) * 4;
      shape.data[i] = rgb.r;
      shape.data[i + 1] = rgb.g;
      shape.data[i + 2] = rgb.b;
      shape.data[i + 3] = 255;
    }
  }
  octx.putImageData(shape, 0, 0);

  board.addImage({
    id: uid(),
    seq: board.takeSeq(),
    src: out.toDataURL('image/png'),
    x: (bounds.minX - tx) / k,
    y: (bounds.minY - ty) / k,
    width: w / k,
    height: h / k,
    layer: board.activeLayer,
    frame: board.activeFrame,
  });
  if (open && fillMode === 'region') {
    toast('That outline is not closed — filled as far as the view goes.');
  }
}

// ---- copy, paste, duplicate, stickers --------------------------------------

function selectedStrokes(): Stroke[] {
  const sel = selection;
  if (!sel) return [];
  const out: Stroke[] = [];
  for (const id of sel.ids) {
    const s = board.stroke(id);
    if (s) out.push(s);
  }
  return out;
}

function selectedImages(): BoardImage[] {
  const sel = selection;
  return sel ? board.images.filter((im) => sel.images.has(im.id)) : [];
}

// Where a clip lands when nothing said otherwise: centred on the pointer if it
// is over the board, otherwise in the middle of the view.
function dropPoint(clip: Clip): Point {
  const at = lastPointer ?? { x: cssWidth / 2, y: cssHeight / 2 };
  const centre = toWorld(camera, at.x, at.y);
  return { x: centre.x - clip.width / 2, y: centre.y - clip.height / 2 };
}

function pasteClip(clip: Clip, at?: Point): void {
  if (!canEditActive()) return;
  const { strokes, images } = placeClip(clip, at ?? dropPoint(clip), {
    layer: board.activeLayer,
    frame: board.activeFrame,
    takeSeq: () => board.takeSeq(),
  });
  board.addItems(strokes, images);
  selectPlaced(strokes, images);
}

// Whatever just arrived comes in selected, so it can be dragged into place
// without hunting for it first.
function selectPlaced(strokes: Stroke[], images: BoardImage[]): void {
  const box = board.contentBBox(strokes, images);
  if (!box) return;
  setTool('select');
  selection = {
    ids: new Set(strokes.map((s) => s.id)),
    images: new Set(images.map((im) => im.id)),
    poly: rectPoly(box),
  };
  moveX = 0;
  moveY = 0;
  syncAnts();
  requestRender();
}

async function copySelection(cut: boolean): Promise<void> {
  const strokes = selectedStrokes();
  const images = selectedImages();
  const clip = makeClip(strokes, images);
  const box = board.contentBBox(strokes, images);
  if (!clip || !box) {
    toast('Nothing selected — lasso something with the select tool (S).');
    return;
  }
  clipboard = clip;
  // A picture of the selection goes to the system clipboard as well, so it can
  // be pasted into anything else. Alongside it goes a one-line marker: paste
  // reads that back to tell "still our copy" from "someone copied something
  // else since", which no amount of comparing re-encoded pictures can do
  // reliably. It is written as text so it survives the round trip, and reads
  // as a sentence in whatever plain-text field it lands in.
  const marker = `BetterBoard clip · ${strokes.length + images.length} items · ${uid()}`;
  const png = renderExport(strokes, images, board.layers, box, THEMES[themeName], {
    pad: 8,
    maxScale: 2,
  }).toDataURL('image/png');
  // The cut happens here, before the clipboard write is awaited: what gets
  // deleted has to be what was copied, and the selection is free to change
  // while an IPC round trip is in the air.
  if (cut) {
    board.removeItems(new Set(strokes.map((s) => s.id)), new Set(images.map((im) => im.id)));
    clearSelection();
  }
  toast(cut ? 'Cut' : 'Copied');
  clipMark = marker;
  if (!(await window.betterboard.clipboardWriteImage(png, marker))) clipMark = null;
}

// A text field gets served by hand rather than through document.execCommand:
// the accelerator is consumed by the menu, so by the time the renderer hears
// about it there is no user gesture left and Chromium's own copy quietly does
// nothing at all.
function copyAction(cut: boolean): void {
  const focused = document.activeElement;
  if (isTextField(focused)) {
    const start = focused.selectionStart ?? 0;
    const end = focused.selectionEnd ?? 0;
    if (start === end) return;
    void window.betterboard.clipboardWriteText(focused.value.slice(start, end));
    if (cut) {
      focused.value = focused.value.slice(0, start) + focused.value.slice(end);
      focused.selectionStart = focused.selectionEnd = start;
      focused.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  void copySelection(cut);
}

function duplicateSelection(): boolean {
  const strokes = selectedStrokes();
  const images = selectedImages();
  const clip = makeClip(strokes, images);
  const box = board.contentBBox(strokes, images);
  if (!clip || !box) return false;
  const offset = toWorldDelta(camera, NUDGE, NUDGE);
  pasteClip(clip, { x: box.minX + offset.x, y: box.minY + offset.y });
  return true;
}

// One key for "make another one of this". What "this" is depends on what is in
// front of you: a selection if there is one, otherwise the frame — but only
// when the timeline is already open, because a duplicate should never be the
// reason a panel appears.
function duplicateAction(): void {
  if (duplicateSelection()) return;
  if (!timelineOpen) {
    toast('Nothing selected. Lasso something first, or open the timeline (T) to duplicate frames.');
    return;
  }
  stopPlayback();
  clearSelection();
  board.addFrame(true);
  scrollFrameIntoView();
}

function selectAll(): void {
  const focused = document.activeElement;
  if (isTextField(focused)) {
    focused.select();
    return;
  }
  const strokes = board.cellStrokes(board.activeFrame, board.activeLayer);
  const images = [...board.cellImages(board.activeFrame, board.activeLayer)];
  const box = board.contentBBox(strokes, images);
  if (!box) return;
  setTool('select');
  const pad = 6 / camera.scale;
  selection = {
    ids: new Set(strokes.map((s) => s.id)),
    images: new Set(images.map((im) => im.id)),
    poly: rectPoly({
      minX: box.minX - pad,
      minY: box.minY - pad,
      maxX: box.maxX + pad,
      maxY: box.maxY + pad,
    }),
  };
  moveX = 0;
  moveY = 0;
  syncAnts();
  requestRender();
}

// The bar only says what is possible right now, and only when it is.
let selectionKey = '';
function syncSelectionBar(): void {
  const sel = selection;
  const key = sel ? `${sel.ids.size}:${sel.images.size}` : '';
  if (key === selectionKey) return;
  selectionKey = key;
  selActions.classList.toggle('hidden', !sel || drag?.kind === 'lasso');
  if (!sel) return;
  const parts: string[] = [];
  if (sel.ids.size) parts.push(`${sel.ids.size} stroke${sel.ids.size === 1 ? '' : 's'}`);
  if (sel.images.size) parts.push(`${sel.images.size} picture${sel.images.size === 1 ? '' : 's'}`);
  selHint.textContent = parts.join(' · ') || 'Selection';
}

// ---- stickers -------------------------------------------------------------

const STICKER_DRAG_TYPE = 'application/x-betterboard-sticker';

function setStickersOpen(open: boolean): void {
  stickersOpen = open;
  stickersPanel.classList.toggle('hidden', !open);
  stickersBtn.classList.toggle('active', open);
  stackRightPanels();
  savePrefs();
}

async function loadStickers(): Promise<void> {
  try {
    const raw = await window.betterboard.loadStickers();
    stickers = (Array.isArray(raw) ? raw : []).filter(isSticker).map(stickerFromJSON);
  } catch {
    stickers = [];
  }
  renderStickers();
}

function persistStickers(): void {
  void window.betterboard.saveStickers(stickers.map(stickerToJSON));
}

// A sticker keeps the strokes, not a picture of them: stamped back down it is
// live ink again, at whatever colour and pressure it was drawn with, so it can
// be erased, moved and drawn over like anything else on the board.
function saveSelectionAsSticker(): void {
  const strokes = selectedStrokes();
  const images = selectedImages();
  const clip = makeClip(strokes, images);
  const box = board.contentBBox(strokes, images);
  if (!clip || !box) {
    toast('Select something first — lasso it with the select tool (S).');
    return;
  }
  const thumb = renderExport(strokes, images, board.layers, box, THEMES[themeName], {
    pad: 6,
    maxDim: 240,
    maxScale: 1.5,
    background: null, // a sticker has to sit on whichever board colour is up
  }).toDataURL('image/png');
  stickers.unshift({ id: uid(), name: stickerName(stickers), thumb, clip, createdAt: Date.now() });
  if (stickers.length > MAX_STICKERS) stickers.length = MAX_STICKERS;
  persistStickers();
  renderStickers();
  setStickersOpen(true);
  toast('Kept as a sticker');
}

let renamingSticker: string | null = null;

function renderStickers(): void {
  if (renamingSticker) return;
  stickerList.textContent = '';
  stickersEmpty.classList.toggle('hidden', stickers.length > 0);
  for (const sticker of stickers) {
    const cell = document.createElement('div');
    cell.className = 'sticker';
    cell.title = `${sticker.name} — click to stamp, or drag it onto the board`;
    cell.draggable = true;

    const img = document.createElement('img');
    img.src = sticker.thumb;
    img.alt = sticker.name;

    const name = document.createElement('span');
    name.className = 'sticker-name';
    name.textContent = sticker.name;

    const del = document.createElement('button');
    del.className = 'sticker-del';
    del.title = 'Forget this sticker';
    del.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      stickers = stickers.filter((s) => s.id !== sticker.id);
      persistStickers();
      renderStickers();
    });

    cell.addEventListener('click', () => {
      const centre = toWorld(camera, cssWidth / 2, cssHeight / 2);
      pasteClip(sticker.clip, {
        x: centre.x - sticker.clip.width / 2,
        y: centre.y - sticker.clip.height / 2,
      });
    });
    cell.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(STICKER_DRAG_TYPE, sticker.id);
      e.dataTransfer?.setDragImage(img, img.width / 2, img.height / 2);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    });
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renameSticker(cell, name, sticker);
    });

    cell.append(img, name, del);
    stickerList.appendChild(cell);
  }
}

function renameSticker(cell: HTMLElement, label: HTMLElement, sticker: Sticker): void {
  const input = document.createElement('input');
  input.className = 'sticker-name';
  input.value = sticker.name;
  renamingSticker = sticker.id;
  cell.replaceChild(input, label);
  input.focus();
  input.select();
  const commit = (save: boolean): void => {
    if (renamingSticker !== sticker.id) return;
    renamingSticker = null;
    if (save) {
      sticker.name = input.value.trim().slice(0, 40) || sticker.name;
      persistStickers();
    }
    renderStickers();
  };
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
    e.stopPropagation();
  });
}

// ---- init -------------------------------------------------------------------

async function main(): Promise<void> {
  document.body.classList.toggle('mac', window.betterboard.platform === 'darwin');
  loadPrefs();
  applyTheme();
  setupDock();
  wireSliders();
  wirePicker();
  wireSizePad();
  setEraserMode(eraserMode);
  setWandMode(wandMode);
  setFillMode(fillMode);
  wandToleranceInput.value = String(wandTolerance);
  $('wand-tolerance-val').textContent = String(wandTolerance);
  fillToleranceInput.value = String(fillTolerance);
  $('fill-tolerance-val').textContent = String(fillTolerance);
  setTool(tool);
  syncBrushButtons();
  renderRecents();
  setColor(color);
  sizeInput.value = String(size);
  setSize(size);
  paintPad();
  setStickersOpen(stickersOpen);
  void loadStickers();
  gridBtn.classList.toggle('active', grid);

  // Decoding is asynchronous and is not an edit, so it gets its own hook: a
  // pasted picture or a fresh bucket fill has nothing to show until its bitmap
  // lands, and without this it waits for whatever happens to redraw next.
  board.onRedraw = requestRender;
  // Edits reach the tile cache as they happen: a region to repaint, a stroke
  // to paint straight on top, or everything at once.
  board.onDirty = (frame, layer, box) => {
    compositor.invalidate(frame, layer, box);
    requestRender();
  };
  board.onAppend = (stroke) => {
    compositor.append(stroke);
    requestRender();
  };
  board.whenReset(() => {
    compositor.reset();
    requestRender();
  });
  board.onChange = () => {
    refreshGhosts();
    requestRender();
    scheduleAutosave();
    updateUndoButtons();
    renderLayers();
    renderTimeline();
  };
  updateUndoButtons();
  setLayersOpen(layersOpen);
  setTimelineOpen(timelineOpen);
  syncOnionPanel();
  applyDockPads();

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // The window asks for one last save on its way closed.
  window.betterboard.onFlush(() => {
    void autosave.flush().finally(() => window.betterboard.flushed());
  });

  // A big board takes a moment to read back; say so rather than sit blank.
  const slow = window.setTimeout(() => toast('Loading your board…'), 400);
  let restored = false;
  try {
    const cam = await autosave.load();
    if (cam) {
      camera.x = cam.x;
      camera.y = cam.y;
      camera.scale = cam.scale;
      camera.rotation = cam.rotation;
      restored = true;
    }
  } catch (err) {
    console.error('could not restore the autosave:', err);
    await autosave.quarantine();
    toast('The last session could not be read. It was set aside and a fresh board started.');
  }
  clearTimeout(slow);
  if (!restored) {
    camera.x = -cssWidth / 2;
    camera.y = -cssHeight / 2;
    camera.scale = 1;
  }
  updateWheel();
  updateZoomLabel();
  renderLayers();
  renderTimeline();
  syncOnionPanel();
  refreshGhosts();
  requestRender();
  performance.mark('bb:ready');
  if (window.betterboard.bench) {
    Object.assign(window, {
      __bb: {
        board,
        camera,
        ctx,
        canvas,
        drawFrame,
        requestRender,
        compositor,
        autosave,
        get state() {
          return {
            tool,
            drag: drag?.kind ?? null,
            lasso: lasso?.length ?? null,
            selection: selection ? { ids: selection.ids.size, images: selection.images.size, poly: selection.poly.length } : null,
            lifted: lifted ? { tiles: lifted.tiles, items: lifted.items.length } : null,
          };
        },
      },
    });
  }

  // First launch: ask what kind of work this board is for, so the layout
  // starts out shaped for it. Answered (or skipped) exactly once.
  if (!localStorage.getItem('bb:persona')) welcomeEl.classList.remove('hidden');
}

void main();
