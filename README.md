<div align="center">

<img src="assets/betterboard.svg" alt="betterboard" width="330" />

# betterboard

**An infinite whiteboard desktop app built for pen displays.**<br>
*Pressure-sensitive ink, endless canvas, zero friction.*

</div>

---

betterboard is a macOS desktop whiteboard designed around drawing tablets like the Huion Kamvas Pro. Strokes are stored as vectors — pressure-weighted centerlines rendered with [perfect-freehand](https://github.com/steveruizok/perfect-freehand) — so the canvas is truly infinite, zooming is lossless, and erasing works per stroke.

## Features

- **Pressure-sensitive pen** — stroke width follows stylus pressure via Chromium pointer events; mouse strokes fall back to velocity-simulated pressure
- **Infinite canvas** — pan and zoom without bounds, with an adaptive dot grid
- **Stylus-native gestures** — the pen's eraser end erases, the barrel button pans, touch pans
- **Stroke eraser** — removes whole strokes, one undo step per gesture
- **Undo / redo**, dark & light board themes, autosave and session restore
- **Save / open** boards as JSON, **export** the whole drawing as PNG

## Install

```sh
make
```

That builds the app, installs `BetterBoard.app` into `/Applications`, and launches it. Later, `make update` rebuilds and reinstalls in one step.

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
| Pan | Space + drag, `H`, middle/right drag, pen barrel button, touch, or two-finger scroll |
| Zoom | Pinch, `⌘` + scroll, `⌘+` / `⌘−` / `⌘0`, or the zoom pill |
| Zoom to fit | `⌘1` |
| Tools | `B`/`P` pen · `E` eraser · `H` hand |
| Stroke size | `[` and `]` or the slider |
| Undo / redo | `⌘Z` / `⇧⌘Z` |
| New / open / save / export | `⌘N` / `⌘O` / `⌘S` / `⌘E` |
| Dot grid · board theme | `⌘G` · `⇧⌘L` |
| Clear board | `⌘⌫` |

## File format

Boards are JSON: a list of strokes (`color`, `size`, and `[x, y, pressure]` points in world coordinates) plus the camera. Autosaves land in the app's user-data directory; `⌘S` exports a portable `.betterboard.json`.

## Roadmap

- Custom app icon
- Selection tool (move / delete groups of strokes)
- Shapes and text
- Pen tilt support
