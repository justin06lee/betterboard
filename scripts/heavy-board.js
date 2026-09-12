#!/usr/bin/env node
// Writes a synthetic board with as many strokes as you ask for, laid out like
// pages of handwriting, so performance work has something heavy to chew on:
//
//   bun scripts/heavy-board.js 100000 /tmp/bb-heavy/autosave.json
//
// The output is an ordinary version 5 board — one stroke per line, which is
// still valid JSON, and which the streaming loader can read without ever
// holding the whole file as one string. Point it at a scratch profile's
// autosave (launch with BETTERBOARD_USER_DATA) or open it with File ▸ Open.
// The same count always produces the same board.

const fs = require('fs');
const path = require('path');

const count = Math.max(1, Math.floor(Number(process.argv[2]) || 10000));
const out = process.argv[3] || `heavy-${count}.betterboard.json`;

let seed = 0x9e3779b9 ^ count;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const BRUSHES = [
  ['pen', 0.84, 1],
  ['marker', 0.05, 1.7],
  ['liner', 0.04, 1.15],
  ['paint', 0.03, 1.9],
  ['chalk', 0.02, 1.8],
  ['pixel', 0.02, 1],
];
const COLORS = ['#e8eaed', '#e8eaed', '#e8eaed', '#ef476f', '#ffb703', '#06d6a0', '#4cc9f0', '#a78bfa'];

function pickBrush() {
  let r = rand();
  for (const [id, weight, scale] of BRUSHES) {
    if ((r -= weight) <= 0) return { id, scale };
  }
  return { id: 'pen', scale: 1 };
}

const r4 = (v) => Math.round(v * 10000) / 10000;
const r3 = (v) => Math.round(v * 1000) / 1000;

// Handwriting density: a stroke every ~22 units along a line, lines 48 units
// apart, pages 1600 units wide with a gutter between them.
const STEP = 22;
const LINE = 48;
const PAGE_W = 1600;
const PAGE_LINES = 40;
const PAGE_H = PAGE_LINES * LINE;
const perLine = Math.floor(PAGE_W / STEP);
const perPage = perLine * PAGE_LINES;
const pagesAcross = Math.max(1, Math.ceil(Math.sqrt(count / perPage)));

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const fd = fs.openSync(out, 'w');
let buffer = '';
const flush = (force) => {
  if (buffer.length > (force ? 0 : 1 << 22)) {
    fs.writeSync(fd, buffer);
    buffer = '';
  }
};

const layer = 'heavy-layer';
const frame = 'heavy-frame';
buffer +=
  '{"app":"betterboard","version":5,"camera":{"x":-200,"y":-200,"scale":1,"rotation":0},' +
  `"layers":[{"id":"${layer}","name":"Layer 1","opacity":1,"visible":true}],"activeLayer":"${layer}",` +
  `"frames":[{"id":"${frame}"}],"activeFrame":"${frame}","fps":12,` +
  '"onion":{"enabled":false,"before":1,"after":1,"opacity":0.35,"tint":true},"images":[],"strokes":[\n';

let points = 0;
for (let i = 0; i < count; i++) {
  const page = Math.floor(i / perPage);
  const within = i % perPage;
  const px = (page % pagesAcross) * (PAGE_W + 200);
  const py = Math.floor(page / pagesAcross) * (PAGE_H + 200);
  const x0 = px + (within % perLine) * STEP + rand() * 6;
  const y0 = py + Math.floor(within / perLine) * LINE + rand() * 8;

  const brush = pickBrush();
  const size = (2 + rand() * 6) * brush.scale;
  const n = 18 + Math.floor(rand() * 50);
  let x = x0;
  let y = y0;
  let heading = rand() * Math.PI * 2;
  let turn = (rand() - 0.5) * 0.4;
  let p = 0.35 + rand() * 0.3;
  const pts = [];
  for (let k = 0; k < n; k++) {
    pts.push(`[${r4(x)},${r4(y)},${r3(p)}]`);
    turn += (rand() - 0.5) * 0.12;
    turn = Math.max(-0.35, Math.min(0.35, turn));
    heading += turn;
    const step = 0.9 + rand() * 0.9;
    x += Math.cos(heading) * step;
    y += Math.sin(heading) * step;
    p = Math.max(0.1, Math.min(1, p + (rand() - 0.5) * 0.08));
  }
  points += n;
  const stroke = {
    id: `h${i.toString(36)}`,
    seq: i,
    color: COLORS[Math.floor(rand() * COLORS.length)],
    size: r4(size),
    pen: true,
    brush: brush.id,
    seed: Math.floor(rand() * 0xffffffff) >>> 0,
    layer,
    frame,
  };
  const json = JSON.stringify(stroke);
  buffer += `${json.slice(0, -1)},"points":[${pts.join(',')}]}${i + 1 < count ? ',' : ''}\n`;
  flush(false);
}
buffer += ']}\n';
flush(true);
fs.closeSync(fd);

const bytes = fs.statSync(out).size;
console.log(`${count} strokes, ${points} points, ${(bytes / 1048576).toFixed(1)} MB -> ${out}`);
