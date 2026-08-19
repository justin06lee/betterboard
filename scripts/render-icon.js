// Rasterises an SVG at icon sizes using the Electron already in node_modules,
// so regenerating the mark needs no extra tooling.
//
//   bunx electron scripts/render-icon.js <svg> <outDir> <size>...
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const [, , src, outDir, ...sizes] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 1024;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(src, 'utf8');
  fs.mkdirSync(outDir, { recursive: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-icon-'));
  const page = path.join(tmp, 'icon.html');
  fs.writeFileSync(
    page,
    `<html><head><meta charset="utf-8"><style>
       html,body{margin:0;padding:0;background:transparent;overflow:hidden}
       svg{display:block;width:${BASE}px;height:${BASE}px}
     </style></head><body>${svg}</body></html>`
  );

  const win = new BrowserWindow({
    width: BASE,
    height: BASE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
  });
  await win.loadFile(page);
  await sleep(500); // let the gradients settle before grabbing the frame

  // capturePage hands back device pixels, so this is already 2x on a retina
  // display; every requested size is resized down from it.
  const shot = await win.webContents.capturePage();
  for (const raw of sizes) {
    const size = Number(raw);
    const out = shot.getSize().width === size ? shot : shot.resize({ width: size, height: size, quality: 'best' });
    fs.writeFileSync(path.join(outDir, `${size}.png`), out.toPNG());
  }
  console.log(`rendered ${src} at ${sizes.join(', ')}`);
  app.exit(0);
});
