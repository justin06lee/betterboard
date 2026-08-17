import { buildPath, strokeHit } from './ink';
import { render, renderExport } from './render';
import { Board } from './store';
import type { Camera, Stroke } from './types';
import { MIN_SCALE, THEMES, anchorCamera, clampScale, emptyBBox, growBBox, toWorld, uid } from './types';

type Tool = 'pen' | 'eraser' | 'hand';
type ThemeName = 'dark' | 'light';

const ERASER_RADIUS = 16; // screen px
const MIN_DIST = 0.75; // screen px between recorded points
const SWATCHES = ['#e8eaed', '#1e1e24', '#ef476f', '#ffb703', '#06d6a0', '#4cc9f0', '#a78bfa'];
const EMPTY_BOARD = '{"app":"betterboard","version":1,"strokes":[]}';

// ---- state ----------------------------------------------------------------

const board = new Board();
const camera: Camera = { x: 0, y: 0, scale: 1, rotation: 0 };
let tool: Tool = 'pen';
let color = SWATCHES[0];
let size = 6;
let themeName: ThemeName = 'dark';
let grid = true;

let live: Stroke | null = null;
let spaceHeld = false;
let eraserCursor: { x: number; y: number } | null = null;
const erasePending = new Set<string>();

type Drag =
  | { kind: 'draw' }
  | { kind: 'erase' }
  | { kind: 'pan'; startX: number; startY: number; camX: number; camY: number };
let drag: Drag | null = null;
let activePointer: number | null = null;

let cssWidth = 0;
let cssHeight = 0;

// ---- dom ------------------------------------------------------------------

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { desynchronized: true, alpha: false })!;
const $ = (id: string) => document.getElementById(id)!;
const toolButtons: Record<Tool, HTMLElement> = {
  pen: $('tool-pen'),
  eraser: $('tool-eraser'),
  hand: $('tool-hand'),
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

// ---- rendering loop -------------------------------------------------------

let dirty = false;
function requestRender(): void {
  if (dirty) return;
  dirty = true;
  requestAnimationFrame(() => {
    dirty = false;
    const strokes = erasePending.size
      ? board.strokes.filter((s) => !erasePending.has(s.id))
      : board.strokes;
    render(ctx, canvas, camera, strokes, {
      theme: THEMES[themeName],
      grid,
      live,
      eraser:
        tool === 'eraser' && eraserCursor
          ? { x: eraserCursor.x, y: eraserCursor.y, radius: ERASER_RADIUS }
          : null,
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
  localStorage.setItem('bb:prefs', JSON.stringify({ tool, color, size, themeName, grid }));
}

function loadPrefs(): void {
  try {
    const p = JSON.parse(localStorage.getItem('bb:prefs') ?? '{}');
    if (p.tool === 'pen' || p.tool === 'eraser' || p.tool === 'hand') tool = p.tool;
    if (typeof p.color === 'string') color = p.color;
    if (Number.isFinite(p.size)) size = Math.min(28, Math.max(1, p.size));
    if (p.themeName === 'light' || p.themeName === 'dark') themeName = p.themeName;
    if (typeof p.grid === 'boolean') grid = p.grid;
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
  const b = board.contentBBox();
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
  if (op?.type === 'scale') {
    camera.x /= op.factor;
    camera.y /= op.factor;
    camera.scale = clampScale(camera.scale * op.factor);
    updateZoomLabel();
    requestRender();
  }
}

function doRedo(): void {
  const op = board.redo();
  if (op?.type === 'scale') {
    camera.x *= op.factor;
    camera.y *= op.factor;
    camera.scale = clampScale(camera.scale / op.factor);
    updateZoomLabel();
    requestRender();
  }
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
  if (t !== 'eraser') eraserCursor = null;
  updateCursor();
  savePrefs();
  requestRender();
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
  const d = Math.min(18, Math.max(3, v * 0.75));
  sizeDot.style.width = `${d}px`;
  sizeDot.style.height = `${d}px`;
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
  else if (spaceHeld || tool === 'hand') canvas.style.cursor = 'grab';
  else if (tool === 'eraser') canvas.style.cursor = 'none';
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
    color,
    size,
    pen: e.pointerType === 'pen',
    points: [{ x: w.x, y: w.y, p: pressureOf(e) }],
    bbox: emptyBBox(),
  };
  growBBox(live.bbox, w.x, w.y, size + 2);
  live.path = buildPath(live, true);
  requestRender();
}

function finishStroke(): void {
  if (!live) return;
  live.path = buildPath(live, false);
  board.addStroke(live);
  live = null;
}

function eraseAt(e: PointerEvent): void {
  const w = toWorld(camera, e.offsetX, e.offsetY);
  const radius = ERASER_RADIUS / camera.scale;
  for (const s of board.strokes) {
    if (!erasePending.has(s.id) && strokeHit(s, w.x, w.y, radius)) {
      erasePending.add(s.id);
    }
  }
}

// ---- pointer input --------------------------------------------------------

canvas.addEventListener('pointerdown', (e) => {
  if (drag) return; // ignore extra pointers mid-gesture
  const panWanted =
    e.pointerType === 'touch' ||
    e.button === 1 ||
    (e.buttons & 2) !== 0 || // right mouse button / pen barrel button
    spaceHeld ||
    tool === 'hand';
  const eraseWanted =
    !panWanted && ((e.pointerType === 'pen' && (e.buttons & 32) !== 0) || tool === 'eraser');

  if (panWanted) {
    drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y };
  } else if (eraseWanted) {
    drag = { kind: 'erase' };
    eraserCursor = { x: e.offsetX, y: e.offsetY };
    eraseAt(e);
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
    }
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
  switch (e.key.toLowerCase()) {
    case 'b':
    case 'p':
      setTool('pen');
      break;
    case 'e':
      setTool(tool === 'eraser' ? 'pen' : 'eraser');
      break;
    case 'h':
      setTool('hand');
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
  const content = board.contentBBox();
  if (!content) return;
  const exportCanvas = renderExport(board.strokes, content, THEMES[themeName]);
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
        if (board.strokes.length === 0) return;
        if (await window.betterboard.confirm('Clear the board?', 'You can undo this.')) {
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
  }
});

// ---- toolbar wiring ---------------------------------------------------------

toolButtons.pen.addEventListener('click', () => setTool('pen'));
toolButtons.eraser.addEventListener('click', () => setTool('eraser'));
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
  loadPrefs();
  applyTheme();
  setTool(tool);
  setColor(color);
  sizeInput.value = String(size);
  setSize(size);
  gridBtn.classList.toggle('active', grid);

  board.onChange = () => {
    requestRender();
    scheduleAutosave();
    updateUndoButtons();
  };
  updateUndoButtons();

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
  requestRender();
}

void main();
