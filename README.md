<div align="center">

<img src="assets/betterboard.svg" alt="betterboard" width="330" />

# betterboard

**An infinite whiteboard desktop app built for pen displays.**<br>
*Pressure-sensitive ink, endless canvas, zero friction.*

</div>

---

betterboard is a desktop whiteboard for macOS and Linux (x64 and arm64), designed around drawing tablets like the Huion Kamvas Pro. Strokes are stored as vectors — pressure-weighted centerlines rendered with [perfect-freehand](https://github.com/steveruizok/perfect-freehand) — so the canvas is truly infinite, zooming is lossless, and erasing works per stroke.

## Features

- **Pressure-sensitive pen** — stroke width follows stylus pressure via Chromium pointer events; mouse strokes fall back to velocity-simulated pressure
- **Infinite canvas** — pan, zoom, and rotate freely, with an adaptive dot grid that follows the view
- **Stylus-native gestures** — the pen's eraser end erases, the barrel button pans, touch pans
- **Stroke eraser** — removes whole strokes, one undo step per gesture
- **Lasso select** — loop your pen around anything to select it, then drag the marching-ants outline to move it; `⌫` deletes the selection, `Esc` drops it
- **Normalize zoom** — one press rebases the current view as the new 100%, restoring the full zoom range without moving a pixel; when you hit the zoom-out floor, the button pulses to offer it
- **Undo / redo**, dark & light board themes, autosave and session restore
- **Save / open** boards as JSON, **export** the whole drawing as PNG

## Install

```sh
make
```

One command on either platform; `make update` rebuilds and reinstalls in one step.

- **macOS** — installs `BetterBoard.app` into `/Applications` and launches it.
- **Linux (incl. arm64 Ubuntu)** — installs to `~/.local/opt/betterboard` with a `betterboard` command on your PATH, a desktop entry, and an icon. On Ubuntu 24.04+ the install asks for sudo once to setuid Electron's `chrome-sandbox` (the kernel restricts unprivileged user namespaces there).

Keyboard shortcuts below are written with macOS keys; on Linux read `⌘` as `Ctrl`.

## Develop

```sh
bun install     # dependencies
bun run dev     # build renderer + launch Electron
bun run build   # typecheck + bundle (production build)
```

The renderer is plain TypeScript on a 2D canvas (no framework), bundled with `bun build`. The Electron main process lives in `src/main`, the renderer in `src/renderer`.

## Controls

| Action | Input |
|---|---|
| Draw | Pen or left mouse drag |
| Erase | `E`, the stylus eraser end, or eraser tool |
| Select an area | `S`, then loop the pen around it (tap a stroke to select just that one) |
| Move a selection | Drag from inside the outline |
| Delete / drop a selection | `⌫` / `Esc` |
| Pan | Space + drag, `H`, middle/right drag, pen barrel button, touch, or two-finger scroll |
| Zoom | Pinch, `⌘` + scroll, `⌘+` / `⌘−` / `⌘0`, or the zoom pill |
| Zoom to fit | `⌘1` |
| Normalize zoom | `⇧⌘N` or the ⤢ button in the zoom pill |
| Rotate | hold `R` and drag the dial — snaps near 45° steps; double-click the dial to reset, `⌘1` also squares the view |
| Tools | `B`/`P` pen · `E` toggles eraser/pen · `S` toggles lasso/pen · `H` hand |
| Stroke size | `[` and `]` or the slider |
| Undo / redo | `⌘Z` / `⇧⌘Z` |
| New / open / save / export | `⌘N` / `⌘O` / `⌘S` / `⌘E` |
| Dot grid · board theme | `⌘G` · `⇧⌘L` |
| Clear board | `⌘⌫` |

## File format

Boards are JSON: a list of strokes (`color`, `size`, and `[x, y, pressure]` points in world coordinates) plus the camera. Autosaves land in the app's user-data directory; `⌘S` exports a portable `.betterboard.json`.

## Roadmap

- Custom app icon
- Scale and rotate a selection, copy/paste between boards
- Shapes and text
- Pen tilt support
