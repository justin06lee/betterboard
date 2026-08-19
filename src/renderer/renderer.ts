import { buildPath, strokeHit } from './ink';
import type { Ghost } from './render';
import type { Rect } from './store';
import { HANDLE, render, renderExport, renderRegion } from './render';
import { Board } from './store';
import type { BoardImage, BrushId, Camera, Point, Stroke } from './types';
import {
  BRUSHES,
  BRUSH_ORDER,
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
  toWorldDelta,
  uid,
} from './types';

type Tool = 'pen' | 'eraser' | 'select' | 'ask' | 'hand';
type ThemeName = 'dark' | 'light';

const ERASER_RADIUS = 16; // screen px
const MIN_DIST = 0.75; // screen px between recorded points
const LASSO_MIN_DIST = 2.5; // screen px between recorded lasso points
const TAP_SLOP = 6; // screen px: a lasso smaller than this counts as a tap
const ENCLOSED = 0.7; // fraction of a stroke's points that must fall inside the lasso
const SWATCHES = ['#e8eaed', '#1e1e24', '#ef476f', '#ffb703', '#06d6a0', '#4cc9f0', '#a78bfa'];
const EMPTY_BOARD = '{"app":"betterboard","version":1,"strokes":[]}';

// ---- state ----------------------------------------------------------------

const board = new Board();
const camera: Camera = { x: 0, y: 0, scale: 1, rotation: 0 };
let tool: Tool = 'pen';
let color = SWATCHES[0];
let brush: BrushId = 'pen';
let size = 6;
let themeName: ThemeName = 'dark';
let grid = true;
let layersOpen = true;
let timelineOpen = false;
let playing = false;
let loop = true;

let live: Stroke | null = null;
let spaceHeld = false;
let eraserCursor: { x: number; y: number } | null = null;
const erasePending = new Set<string>();

// The lasso path while it is being drawn, then the committed selection it
// produced. Both live in world coordinates, so they stay put under pan, zoom
// and rotation without any bookkeeping.
let lasso: Point[] | null = null;
let selection: { ids: Set<string>; images: Set<string>; poly: Point[] } | null = null;
let moveX = 0;
let moveY = 0;
let hoverInSelection = false;
let hoverHandle = false;
let dashOffset = 0;
let antsTimer: number | undefined;

type Drag =
  | { kind: 'draw' }
  | { kind: 'erase' }
  | { kind: 'lasso' }
  | { kind: 'move'; startX: number; startY: number }
  | { kind: 'region'; x0: number; y0: number }
  | { kind: 'resize'; id: string; anchor: Point; from: Rect }
  | { kind: 'pan'; startX: number; startY: number; camX: number; camY: number };
let drag: Drag | null = null;
let activePointer: number | null = null;

let cssWidth = 0;
let cssHeight = 0;

// ---- dom ------------------------------------------------------------------

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { desynchronized: true, alpha: false })!;
const $ = (id: string) => document.getElementById(id)!;
// 'pen' is not here: the draw tool is represented by whichever brush button is
// lit, so it is tracked separately.
const toolButtons: Record<Exclude<Tool, 'pen'>, HTMLElement> = {
  eraser: $('tool-eraser'),
  select: $('tool-select'),
  ask: $('tool-ask'),
  hand: $('tool-hand'),
};
const brushButtons: Record<BrushId, HTMLElement> = {
  pen: $('tool-pen'),
  pixel: $('brush-pixel'),
  marker: $('brush-marker'),
  paint: $('brush-paint'),
};
const swatchesEl = $('swatches');
const colorInput = $('color-input') as HTMLInputElement;
const sizeInput = $('size-input') as HTMLInputElement;
const sizeDot = $('size-dot');
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
    const frame = board.activeFrame;
    const strokes = board.strokes.filter(
      (s) => s.frame === frame && !erasePending.has(s.id)
    );
    render(ctx, canvas, camera, strokes, {
      theme: THEMES[themeName],
      grid,
      live,
      eraser:
        tool === 'eraser' && eraserCursor
          ? { x: eraserCursor.x, y: eraserCursor.y, radius: ERASER_RADIUS }
          : null,
      marquee: lasso
        ? { poly: lasso, ids: null, dx: 0, dy: 0, dashOffset }
        : selection
          ? {
            poly: selection.poly,
            ids: selection.ids,
            imageIds: selection.images,
            grips: selectionGrips(),
            dx: moveX,
            dy: moveY,
            dashOffset,
          }
          : null,
      layers: board.layers,
      activeLayer: board.activeLayer,
      images: board.images.filter((im) => im.frame === frame),
      ghosts: playing ? [] : ghostCache,
      region: regionDrag ?? region?.quad ?? null,
    });
  });
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

let autosaveTimer: number | undefined;
function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    void window.betterboard.autosave(board.serialize(camera));
  }, 800);
}

function savePrefs(): void {
  localStorage.setItem('bb:prefs', JSON.stringify({ tool, brush, color, size, themeName, grid, layersOpen, timelineOpen, loop }));
}

function loadPrefs(): void {
  try {
    const p = JSON.parse(localStorage.getItem('bb:prefs') ?? '{}');
    if (['pen', 'eraser', 'select', 'ask', 'hand'].includes(p.tool)) tool = p.tool;
    if (isBrush(p.brush)) brush = p.brush;
    if (typeof p.color === 'string') color = p.color;
    if (Number.isFinite(p.size)) size = Math.min(28, Math.max(1, p.size));
    if (p.themeName === 'light' || p.themeName === 'dark') themeName = p.themeName;
    if (typeof p.grid === 'boolean') grid = p.grid;
    if (typeof p.layersOpen === 'boolean') layersOpen = p.layersOpen;
    if (typeof p.timelineOpen === 'boolean') timelineOpen = p.timelineOpen;
    if (typeof p.loop === 'boolean') loop = p.loop;
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
  if (!b) {
    camera.scale = 1;
    camera.x = -cssWidth / 2;
    camera.y = -cssHeight / 2;
  } else {
    const pad = 80;
    const w = Math.max(b.maxX - b.minX, 1);
    const h = Math.max(b.maxY - b.minY, 1);
    camera.scale = clampScale(
      Math.min((cssWidth - pad * 2) / w, (cssHeight - pad * 2) / h, 4)
    );
    camera.x = (b.minX + b.maxX) / 2 - cssWidth / (2 * camera.scale);
    camera.y = (b.minY + b.maxY) / 2 - cssHeight / (2 * camera.scale);
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
  const sel = selection;
  if (!sel) return;
  if (moved && moved.ids.length === sel.ids.size && moved.ids.every((id) => sel.ids.has(id))) {
    sel.poly = sel.poly.map((p) => ({ x: p.x + moved.dx, y: p.y + moved.dy }));
    requestRender();
    return;
  }
  // Undoing a resize leaves the picture selected — only its rectangle changed,
  // so the outline is re-derived rather than thrown away.
  if (kind === 'image-resize' && sel.images.size === 1 && sel.ids.size === 0) {
    const image = board.images.find((im) => im.id === [...sel.images][0]);
    if (image) {
      sel.poly = rectPoly(imageBBox(image));
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

// ---- ui sync --------------------------------------------------------------

function setTool(t: Tool): void {
  tool = t;
  for (const [name, el] of Object.entries(toolButtons)) {
    el.classList.toggle('active', name === t);
  }
  syncBrushButtons();
  if (t !== 'eraser') eraserCursor = null;
  if (t !== 'select') clearSelection();
  updateCursor();
  savePrefs();
  requestRender();
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

function setColor(c: string): void {
  color = c;
  colorInput.value = c;
  for (const el of swatchesEl.children) {
    el.classList.toggle('active', (el as HTMLElement).dataset.color === c);
  }
  savePrefs();
}

function setSize(v: number): void {
  size = v;
  const d = Math.min(18, Math.max(3, v * BRUSHES[brush].sizeScale * 0.75));
  sizeDot.style.width = `${d}px`;
  sizeDot.style.height = `${d}px`;
  sizeDot.style.borderRadius = brush === 'pixel' ? '2px' : '50%';
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
  else if (drag?.kind === 'resize') canvas.style.cursor = 'nwse-resize';
  else if (tool === 'select' && hoverHandle) canvas.style.cursor = 'nwse-resize';
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
  const last = live.points[live.points.length - 1];
  if (last) {
    const dx = (w.x - last.x) * camera.scale;
    const dy = (w.y - last.y) * camera.scale;
    if (dx * dx + dy * dy < MIN_DIST * MIN_DIST) {
      // Keep pressure fresh even when the pen barely moves.
      last.p = Math.max(last.p, p);
      return false;
    }
  }
  live.points.push({ x: w.x, y: w.y, p });
  growBBox(live.bbox, w.x, w.y, live.size + 2);
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
    points: [{ x: w.x, y: w.y, p: pressureOf(e) }],
    bbox: emptyBBox(),
  };
  growBBox(live.bbox, w.x, w.y, live.size + 2);
  live.path = buildPath(live, true);
  requestRender();
}

function finishStroke(): void {
  if (!live) return;
  live.path = buildPath(live, false);
  board.addStroke(live);
  live = null;
}

// Every edit is confined to the active cell of the frame x layer grid — that
// is what layers are for, and it keeps a traced-over sketch safe underneath.
function editable(s: Stroke): boolean {
  return s.frame === board.activeFrame && s.layer === board.activeLayer;
}

function eraseAt(e: PointerEvent): void {
  const w = toWorld(camera, e.offsetX, e.offsetY);
  const radius = ERASER_RADIUS / camera.scale;
  for (const s of board.strokes) {
    if (!editable(s)) continue;
    if (!erasePending.has(s.id) && strokeHit(s, w.x, w.y, radius)) {
      erasePending.add(s.id);
    }
  }
}

// ---- animation ------------------------------------------------------------

// Ghost frames are rebuilt on board changes rather than per render, so drawing
// a stroke does not re-filter every neighbouring frame sixty times a second.
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
      strokes: board.visibleStrokes(board.frames[i].id),
      images: board.visibleImages(board.frames[i].id),
      alpha: o.opacity * Math.pow(0.55, distance - 1),
      tint: o.tint ? (direction < 0 ? ONION_BEFORE : ONION_AFTER) : null,
    });
  };
  for (let d = o.before; d >= 1; d--) push(d, -1);
  for (let d = o.after; d >= 1; d--) push(d, 1);
  ghostCache = out;
}

function renderTimeline(): void {
  if (frameDrag?.moved) return;
  const n = board.frames.length;
  const here = board.frameIndex;
  frameLabel.textContent = `${here + 1} / ${n}`;

  const filled = new Set(board.strokes.map((s) => s.frame));
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

function renderLayers(): void {
  if (layerDrag?.moved || renamingId) return; // never yank the DOM out from under an interaction
  layerList.textContent = '';
  const counts = new Map<string, number>();
  for (const s of board.strokes) {
    if (s.frame === board.activeFrame) counts.set(s.layer, (counts.get(s.layer) ?? 0) + 1);
  }

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
  layerDeleteBtn.disabled = board.layers.length <= 1;
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
  renderLayers();
}

layerList.addEventListener('pointerup', endLayerDrag);
layerList.addEventListener('pointercancel', endLayerDrag);

function setLayersOpen(open: boolean): void {
  layersOpen = open;
  layersPanel.classList.toggle('hidden', !open);
  layersBtn.classList.toggle('active', open);
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

// ---- ask claude -----------------------------------------------------------

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
const askModel = $('ask-model') as HTMLSelectElement;
const askKeyBlock = $('ask-key');
const askKeyInput = $('ask-key-input') as HTMLInputElement;
const askKeyNote = $('ask-key-note');

// The boxed region, kept as a world-space quad so it stays pinned to the
// drawing while you pan and zoom, plus the crop that was captured from it.
let region: { quad: Point[]; dataURL: string; base64: string } | null = null;
let regionDrag: Point[] | null = null; // live rubber band, also world space
let thread: AskMessage[] = [];
let pendingImage: string | null = null;
let streamEl: HTMLElement | null = null;
let streaming = false;
let keyIsSet = false;

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
  if (open) void refreshKeyStatus();
}

async function refreshKeyStatus(): Promise<void> {
  const status = await window.betterboard.aiKeyStatus();
  keyIsSet = status.set;
  askKeyBlock.classList.toggle('hidden', status.set);
  askKeyNote.textContent = status.set ? `Saved key ends in ${status.hint}.` : '';
  askSend.disabled = streaming ? false : !status.set;
}

function captureRegion(x0: number, y0: number, x1: number, y1: number): void {
  const rect = {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
  if (rect.width < 12 || rect.height < 12) return; // a stray tap, not a box
  const canvasEl = renderRegion(
    board.visibleStrokes(),
    board.visibleImages(),
    board.layers,
    camera,
    rect,
    THEMES[themeName]
  );
  const dataURL = canvasEl.toDataURL('image/png');
  region = {
    quad: quadFromScreenRect(x0, y0, x1, y1),
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
  streaming = false;
  streamEl = null;
  thread = [];
  pendingImage = region?.base64 ?? null;
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
      'Pick the <b>Ask</b> tool and drag a box around part of your board, then ask a question about it.';
    askThreadEl.appendChild(hint);
  }
  for (const m of thread) {
    const el = document.createElement('div');
    el.className = `ask-msg ${m.role === 'user' ? 'user' : 'claude'}${m.error ? ' error' : ''}`;
    el.textContent = m.text;
    askThreadEl.appendChild(el);
  }
  askThreadEl.scrollTop = askThreadEl.scrollHeight;
}

function setStreamingUi(on: boolean): void {
  streaming = on;
  askSend.textContent = on ? 'Stop' : 'Ask';
  askSend.disabled = on ? false : !keyIsSet;
}

async function sendAsk(): Promise<void> {
  if (streaming) {
    void window.betterboard.aiCancel();
    return;
  }
  const text = askInput.value.trim();
  if (!text || !keyIsSet) return;

  const message: AskMessage = { role: 'user', text };
  if (pendingImage) {
    message.image = pendingImage;
    pendingImage = null;
  }
  thread.push(message);
  askInput.value = '';
  renderThread();

  // Built before the placeholder is added, so the empty reply is not sent back.
  const messages = thread
    .filter((m) => !m.error)
    .map((m) => {
      if (m.role === 'assistant') return { role: 'assistant' as const, content: m.text };
      if (!m.image) return { role: 'user' as const, content: m.text };
      return {
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: m.image } },
          { type: 'text' as const, text: m.text },
        ],
      };
    });

  setStreamingUi(true);
  streamEl = document.createElement('div');
  streamEl.className = 'ask-msg claude streaming';
  askThreadEl.appendChild(streamEl);
  askThreadEl.scrollTop = askThreadEl.scrollHeight;

  await window.betterboard.aiAsk({ model: askModel.value, messages });
}

function finishStream(): void {
  if (streamEl) {
    const text = streamEl.textContent ?? '';
    streamEl.classList.remove('streaming');
    if (text.trim()) thread.push({ role: 'assistant', text });
    else streamEl.remove();
  }
  streamEl = null;
  setStreamingUi(false);
}

window.betterboard.onAiDelta((text) => {
  if (!streamEl) return;
  streamEl.textContent = (streamEl.textContent ?? '') + text;
  askThreadEl.scrollTop = askThreadEl.scrollHeight;
});

window.betterboard.onAiDone(finishStream);

window.betterboard.onAiError((message) => {
  streamEl?.remove();
  streamEl = null;
  setStreamingUi(false);
  thread.push({ role: 'assistant', text: message, error: true });
  renderThread();
  void refreshKeyStatus();
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
$('ask-close').addEventListener('click', () => setAskOpen(false));
$('ask-key-save').addEventListener('click', () => {
  void (async () => {
    const status = await window.betterboard.aiSetKey(askKeyInput.value);
    askKeyInput.value = '';
    keyIsSet = status.set;
    askKeyBlock.classList.toggle('hidden', status.set);
    askKeyNote.textContent = status.set ? `Saved key ends in ${status.hint}.` : 'That did not look like a key.';
    askSend.disabled = !status.set;
  })();
});
askKeyInput.addEventListener('keydown', (e) => e.stopPropagation());

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

// The four corners of the selected picture, when a single one is selected on
// its own. Null the rest of the time, including when ink is in the selection.
function selectionGrips(): Point[] | null {
  const sel = selection;
  if (!sel || sel.ids.size > 0 || sel.images.size !== 1) return null;
  const image = board.images.find((im) => im.id === [...sel.images][0]);
  return image ? rectPoly(imageBBox(image)) : null;
}

// Which corner grip, if any, is under a screen point. Returns the opposite
// corner, since that is the one a resize pivots around.
function handleAt(sx: number, sy: number): { image: BoardImage; anchor: Point } | null {
  if (!selection || selection.images.size !== 1 || selection.ids.size > 0) return null;
  const image = board.images.find((im) => im.id === [...selection!.images][0]);
  if (!image) return null;
  const corners = rectPoly(imageBBox(image));
  for (let i = 0; i < corners.length; i++) {
    const p = toScreen(camera, corners[i].x, corners[i].y);
    if (Math.abs(p.x - sx) <= HANDLE && Math.abs(p.y - sy) <= HANDLE) {
      return { image, anchor: corners[(i + 2) % 4] };
    }
  }
  return null;
}

const MIN_IMAGE = 8; // world units

// Scales about the anchored corner, keeping the picture's proportions.
function resizeRect(from: Rect, anchor: Point, w: Point): Rect {
  const dx = w.x - anchor.x;
  const dy = w.y - anchor.y;
  const k = Math.max(Math.abs(dx) / from.width, Math.abs(dy) / from.height);
  const width = Math.max(MIN_IMAGE, from.width * k);
  const height = Math.max(MIN_IMAGE, from.height * k);
  return {
    x: dx < 0 ? anchor.x - width : anchor.x,
    y: dy < 0 ? anchor.y - height : anchor.y,
    width,
    height,
  };
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
async function pasteFromClipboard(): Promise<void> {
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

  const src = await window.betterboard.clipboardImage();
  if (!src) return;
  await placeImage(src);
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
    if (Date.now() - lastPasteAt < 300) return;
    lastPasteAt = Date.now();
    void blobToDataURL(blob).then((src) => placeImage(src));
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

// Dropping onto the canvas places the picture where it landed.
canvas.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});

canvas.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (files.length === 0) return;
  e.preventDefault();
  const at = toWorld(camera, e.offsetX, e.offsetY);
  void (async () => {
    for (const file of files) await placeImage(await blobToDataURL(file), at);
  })();
});

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
  if (!selection && !lasso) return;
  selection = null;
  lasso = null;
  moveX = 0;
  moveY = 0;
  hoverInSelection = false;
  hoverHandle = false;
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
  const box = polygonBBox(poly);
  for (const s of board.strokes) {
    if (!editable(s) || !bboxIntersects(s.bbox, box)) continue;
    let hits = 0;
    for (const pt of s.points) {
      if (pointInPolygon(poly, pt.x, pt.y)) hits++;
    }
    if (hits / s.points.length >= ENCLOSED) ids.add(s.id);
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
  for (let i = board.strokes.length - 1; i >= 0; i--) {
    const s = board.strokes[i];
    if (!editable(s) || !strokeHit(s, w.x, w.y, radius)) continue;
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
  selection = ids.size > 0 || pics.size > 0 ? { ids, images: pics, poly } : null;
}

function deleteSelection(): void {
  if (!selection) return;
  board.removeStrokes(selection.ids);
  board.removeImages(selection.images);
  clearSelection();
}

// ---- pointer input --------------------------------------------------------

canvas.addEventListener('pointerdown', (e) => {
  if (drag) return; // ignore extra pointers mid-gesture
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
    eraserCursor = { x: e.offsetX, y: e.offsetY };
    eraseAt(e);
    requestRender();
  } else if (tool === 'ask' && e.button === 0) {
    drag = { kind: 'region', x0: e.offsetX, y0: e.offsetY };
    regionDrag = quadFromScreenRect(e.offsetX, e.offsetY, e.offsetX, e.offsetY);
    requestRender();
  } else if (tool === 'select' && e.button === 0) {
    const w = toWorld(camera, e.offsetX, e.offsetY);
    const grip = handleAt(e.offsetX, e.offsetY);
    if (grip) {
      drag = {
        kind: 'resize',
        id: grip.image.id,
        anchor: grip.anchor,
        from: { x: grip.image.x, y: grip.image.y, width: grip.image.width, height: grip.image.height },
      };
    } else if (selection && pointInPolygon(selection.poly, w.x, w.y)) {
      // Press inside the outline picks the selection up instead of redrawing it.
      drag = { kind: 'move', startX: e.clientX, startY: e.clientY };
      moveX = 0;
      moveY = 0;
    } else {
      selection = null;
      hoverInSelection = false;
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
  if (drag === null || e.pointerId !== activePointer) {
    if (tool === 'eraser') {
      eraserCursor = { x: e.offsetX, y: e.offsetY };
      requestRender();
    } else if (tool === 'select' && selection) {
      const w = toWorld(camera, e.offsetX, e.offsetY);
      const inside = pointInPolygon(selection.poly, w.x, w.y);
      const onGrip = handleAt(e.offsetX, e.offsetY) !== null;
      if (inside !== hoverInSelection || onGrip !== hoverHandle) {
        hoverInSelection = inside;
        hoverHandle = onGrip;
        updateCursor();
      }
    }
    return;
  }
  if (drag.kind === 'resize') {
    const resize = drag;
    const image = board.images.find((im) => im.id === resize.id);
    if (image) {
      const r = resizeRect(resize.from, resize.anchor, toWorld(camera, e.offsetX, e.offsetY));
      image.x = r.x;
      image.y = r.y;
      image.width = r.width;
      image.height = r.height;
      if (selection) selection.poly = rectPoly(imageBBox(image));
      requestRender();
    }
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
    const cos = Math.cos(camera.rotation);
    const sin = Math.sin(camera.rotation);
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    camera.x = drag.camX - (dx * cos + dy * sin) / camera.scale;
    camera.y = drag.camY - (-dx * sin + dy * cos) / camera.scale;
    requestRender();
    scheduleAutosave();
    return;
  }
  const events = e.getCoalescedEvents?.() ?? [e];
  if (drag.kind === 'draw') {
    let added = false;
    for (const ev of events) added = addLivePoint(ev) || added;
    if (added && live) {
      live.path = buildPath(live, true);
      requestRender();
    }
  } else {
    for (const ev of events) eraseAt(ev);
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
    board.removeStrokes(new Set(erasePending));
    erasePending.clear();
  } else if (drag.kind === 'lasso') {
    addLassoPoint(e);
    commitLasso();
    syncAnts();
  } else if (drag.kind === 'resize') {
    const resize = drag;
    const image = board.images.find((im) => im.id === resize.id);
    if (image) {
      const to = { x: image.x, y: image.y, width: image.width, height: image.height };
      Object.assign(image, resize.from); // rewind the preview so the op records both ends
      board.resizeImage(resize.id, to);
      if (selection) selection.poly = rectPoly(imageBBox(image));
    }
  } else if (drag.kind === 'region') {
    regionDrag = null;
    captureRegion(drag.x0, drag.y0, e.offsetX, e.offsetY);
  } else if (drag.kind === 'move' && selection) {
    // Commit once, as a single undo step, and carry the outline along with it.
    board.moveItems(selection.ids, selection.images, moveX, moveY);
    selection.poly = selection.poly.map((p) => ({ x: p.x + moveX, y: p.y + moveY }));
    moveX = 0;
    moveY = 0;
  }
  drag = null;
  activePointer = null;
  updateCursor();
  requestRender();
}

canvas.addEventListener('pointerup', endGesture);
canvas.addEventListener('pointercancel', endGesture);
canvas.addEventListener('pointerleave', () => {
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
      const cos = Math.cos(camera.rotation);
      const sin = Math.sin(camera.rotation);
      camera.x += (e.deltaX * cos + e.deltaY * sin) / camera.scale;
      camera.y += (-e.deltaX * sin + e.deltaY * cos) / camera.scale;
      requestRender();
      scheduleAutosave();
    }
  },
  { passive: false }
);

// ---- keyboard -------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
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
  if ((e.key === 'Backspace' || e.key === 'Delete') && selection) {
    deleteSelection();
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
      setBrush(BRUSH_ORDER[Number(e.key) - 1]);
      break;
    case 'e':
      setTool(tool === 'eraser' ? 'pen' : 'eraser');
      break;
    case 's':
      setTool(tool === 'select' ? 'pen' : 'select');
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
});

// A lost keyup (app switch mid-hold) must not leave the wheel stuck on screen.
window.addEventListener('blur', () => {
  rHeld = false;
  spaceHeld = false;
  updateWheel();
  updateCursor();
});

// ---- menu / file actions --------------------------------------------------

async function newBoard(): Promise<void> {
  if (board.strokes.length > 0) {
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
  updateWheel();
  updateZoomLabel();
  requestRender();
  scheduleAutosave();
}

async function openBoard(): Promise<void> {
  const json = await window.betterboard.openBoard();
  if (!json) return;
  try {
    clearSelection();
    const saved = board.deserialize(json);
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
    scheduleAutosave();
  } catch {
    await window.betterboard.confirm('Could not open file', 'It is not a BetterBoard board.');
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

window.betterboard.onMenu((action) => {
  switch (action) {
    case 'new':
      void newBoard();
      break;
    case 'open':
      void openBoard();
      break;
    case 'save':
      void window.betterboard.saveBoard(board.serialize(camera));
      break;
    case 'export':
      void exportPNG();
      break;
    case 'insert-image':
      void insertImageFile();
      break;
    case 'paste':
      void pasteFromClipboard();
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
        if (board.frameStrokes().length === 0) return;
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
    case 'toggle-theme':
      toggleTheme();
      break;
    case 'ai-key':
      setAskOpen(true);
      askKeyBlock.classList.remove('hidden');
      askKeyInput.focus();
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
for (const id of BRUSH_ORDER) {
  brushButtons[id].addEventListener('click', () => setBrush(id));
}
toolButtons.select.addEventListener('click', () => setTool('select'));
toolButtons.ask.addEventListener('click', () => setTool('ask'));
toolButtons.hand.addEventListener('click', () => setTool('hand'));

for (const c of SWATCHES) {
  const btn = document.createElement('button');
  btn.className = 'swatch';
  btn.dataset.color = c;
  btn.style.background = c;
  btn.title = c;
  btn.addEventListener('click', () => {
    setColor(c);
    if (tool !== 'pen') setTool('pen');
  });
  swatchesEl.appendChild(btn);
}

colorInput.addEventListener('input', () => {
  setColor(colorInput.value);
  if (tool !== 'pen') setTool('pen');
});

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

// ---- init -------------------------------------------------------------------

async function main(): Promise<void> {
  document.body.classList.toggle('mac', window.betterboard.platform === 'darwin');
  loadPrefs();
  applyTheme();
  setTool(tool);
  syncBrushButtons();
  setColor(color);
  sizeInput.value = String(size);
  setSize(size);
  gridBtn.classList.toggle('active', grid);

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

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  const saved = await window.betterboard.loadAutosave();
  let restored = false;
  if (saved) {
    try {
      const cam = board.deserialize(saved);
      if (cam) {
        camera.x = cam.x;
        camera.y = cam.y;
        camera.scale = cam.scale;
        camera.rotation = cam.rotation;
        restored = true;
      }
    } catch {}
  }
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
}

void main();
