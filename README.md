<div align="center">

<img src="assets/betterboard.svg" alt="betterboard" width="330" />

# betterboard

**An infinite whiteboard desktop app built for pen displays.**<br>
*Pressure-sensitive ink, endless canvas, zero friction.*

</div>

---

betterboard is a desktop whiteboard for macOS and Linux (x64 and arm64), designed around drawing tablets like the Huion Kamvas Pro. Strokes are stored as vectors — pressure-weighted centerlines rendered with [perfect-freehand](https://github.com/steveruizok/perfect-freehand) — so the canvas is truly infinite, zooming is lossless, and erasing can remove whole strokes or only what sits under the eraser — ink and image pixels alike.

## Features

- **Four brushes** — **pen** (pressure-tapered ink), **pixel** (snaps to a shared world grid, so separate strokes and separate sessions line up — real pixel art), **marker** (flat chisel tip, translucent, builds up where strokes cross) and **paint** (a dry bristle brush with a solid body and frayed edges). Stroke width follows stylus pressure via Chromium pointer events; mouse strokes fall back to velocity-simulated pressure
- **Infinite canvas** — pan, zoom, and rotate freely, with an adaptive dot grid that follows the view
- **Stylus-native gestures** — the pen's eraser end erases, the barrel button pans, touch pans
- **Two eraser modes** — remove whole strokes, or sweep the eraser circle to remove whatever sits under it: ink is clipped, and pictures get their pixels carved out directly, with no separate image-editing mode. Either way a gesture is one undo step
- **Lasso select** — loop your pen around anything to select it, then drag the marching-ants outline to move it; `⌫` deletes the selection, `Esc` drops it
- **Layers** — add, delete, rename, reorder by dragging, hide, and dim. Opacity composites the finished layer rather than each stroke, so overlaps never show seams — drop a sketch to 30% and ink over it cleanly. Drawing, erasing and selecting stay on the active layer, so what's underneath is safe
- **Animation** — a timeline of frames, each with the full layer stack. Add, duplicate, delete and drag frames into order, set the frame rate, and play the loop back. Onion skinning ghosts the frames either side, tinted red behind and teal ahead, with adjustable reach and strength
- **Images** — paste from the clipboard, drop files onto the board, or insert from disk. They land on the active layer and frame, interleaved with your ink in the order you made things, so you can draw over a reference or paste a screenshot on top of notes. Drag to move, drag a corner to scale, `⌫` to delete
- **Magic wand** — click a picture to select a contiguous color region, Photoshop-style, with an adjustable tolerance; **Background** mode selects the whole border-connected backdrop with one click anywhere on the picture. Then **Erase selected** cuts those pixels to transparency (background removal in two clicks) or **Keep only** discards everything else. Both are single undo steps
- **Workspace picker** — the first launch asks whether you're here as a student, artist, animator, or photo editor and arranges the starting layout to match, or **Anything** for the plain default setup with nothing assumed. Every tool stays available whichever you pick, and View → Choose Workspace reopens the choice any time — picking Anything again is also how you put a layout you have wandered away from back to standard
- **Ask / Draw through Yagami** — box any part of the board to discuss it or ask the model to circle, connect, annotate, and sketch directly into the selected region. Model drawings are ordinary vector strokes with one-step undo. Use the signed-in coding-agent binaries on this computer directly, or connect to a remote personal Yagami server
- **Normalize zoom** — one press rebases the current view as the new 100%, restoring the full zoom range without moving a pixel; when you hit the zoom-out floor, the button pulses to offer it
- **Undo / redo**, dark & light board themes, autosave and session restore
- **Export** — the current frame's visible layers as a PNG, or the whole timeline as an **MP4**, **WebM** or **animated GIF**. Every frame renders into one canvas sized to fit the whole animation, so nothing shifts between frames; pick the frame rate and the size, and watch it encode
- **Save / open** boards as JSON

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

The renderer is plain TypeScript on a 2D canvas (no framework), bundled with `bun build`. The Electron main process lives in `src/main`, the renderer in `src/renderer`. Animation export encodes in the renderer — video through the browser's own WebCodecs encoders, muxed by [mediabunny](https://mediabunny.dev), and GIF through [gifenc](https://github.com/mattdesl/gifenc) — and hands the finished bytes to the main process, which only picks the file and writes it.

## Controls

| Action | Input |
|---|---|
| Draw | Pen or left mouse drag |
| Erase | `E`, the stylus eraser end, or eraser tool; choose **Stroke** or **Area** beside the active eraser |
| Select an area | `S`, then loop the pen around it (tap a stroke to select just that one) |
| Move a selection | Drag from inside the outline |
| Delete / drop a selection | `⌫` / `Esc` |
| Magic wand | `W`, then click a picture; **Point** selects the color region under the click, **Background** the whole backdrop, and the slider sets tolerance |
| Apply a wand selection | **Erase selected** (or `⌫`) cuts it to transparency · **Keep only** cuts everything else |
| Erase pixels from a picture | The **Area** eraser, swept straight across it |
| Pan | Space + drag, `H`, middle/right drag, pen barrel button, touch, or two-finger scroll |
| Zoom | Pinch, `⌘` + scroll, `⌘+` / `⌘−` / `⌘0`, or the zoom pill |
| Zoom to fit | `⌘1` |
| Normalize zoom | `⇧⌘N` or the ⤢ button in the zoom pill |
| Rotate | hold `R` and drag the dial — snaps near 45° steps; double-click the dial to reset, `⌘1` also squares the view |
| Brushes | `1` pen · `2` pixel · `3` marker · `4` paint |
| Tools | `B`/`P` draw · `E` toggles eraser/pen · `S` toggles lasso/pen · `W` toggles wand/pen · `H` hand |
| Ask or draw with AI in a region | `A`, then drag a box (or `⌥⌘A`) |
| Send · newline · new thread | `Enter` · `⇧Enter` · `+` in the panel |
| Paste / insert an image | `⌘V` (Edit ▸ Paste), drop a file on the board, or `⇧⌘I` |
| Move / scale / delete an image | Drag it · drag a corner grip · `⌫` |
| Timeline | `T` or `⌘T` |
| Play / pause | `Enter` (or `⌘↩`) |
| Previous / next frame | `←` / `→` |
| New / duplicate / delete frame | `⌥⌘F` / `⌘D`, or `+` ⧉ 🗑 in the timeline |
| Reorder frames | Drag a frame cell |
| Frame rate · onion skin | The fps field · the ◐ button (`⌥⌘O`), then its sliders |
| Layers panel | `L` or `⌘L` |
| New / delete layer | `⌥⌘N` / `⌥⌘⌫`, or `+` and 🗑 in the panel |
| Hide / show a layer | The eye on its row, or `⌥⌘H` for the active one |
| Layer opacity · rename · reorder | The panel slider · double-click its name · drag its row |
| Stroke size | `[` and `]` or the slider |
| Undo / redo | `⌘Z` / `⇧⌘Z` |
| New / open / save | `⌘N` / `⌘O` / `⌘S` |
| Export PNG · export animation | `⌘E` · `⇧⌘E`, or ⤓ in the timeline |
| Dot grid · board theme | `⌘G` · `⇧⌘L` |
| Choose workspace | View → Choose Workspace… |
| Clear frame | `⌘⌫` |

## Asking and drawing with AI

The Ask tool boxes a region, re-renders just that area as a PNG, and sends it with your question through [Yagami](https://github.com/justin06lee/yagami). Replies appear in the side panel. Ask the model to draw, circle, underline, connect, or annotate and it can add bounded vector commands to the current layer and frame. Those strokes remain editable board content and undo together in one step.

Open **File → Yagami Connections…** and choose one of two modes:

- **This computer — installed CLIs** embeds Yagami in BetterBoard. It automatically discovers the Claude Code, Codex, OpenCode, Gemini, or other supported coding-agent binaries already installed and signed in on this machine. No URL or personal API key is involved.
- **Remote Yagami server** accepts the URL of an existing Yagami server. A personal `ygm_…` key is available but optional, for servers that require one.

The optional harness/model field follows Yagami routing in either mode: `claude`, `codex`, `codex:gpt-5.6-sol`, `opencode:provider/model`, and so on. Leave it blank to use Yagami's detected/default provider.

It is entirely opt-in. Worth knowing before you turn it on:

- Optional personal Yagami keys are written to `settings.json` in the app's user-data directory with `0600` permissions. They never enter the renderer — requests are made from the main process — and only the last four characters are returned for display.
- Nothing is sent to a coding-agent harness or remote Yagami server unless you press Ask. It receives the cropped image and thread messages needed for the request. No other frames, layers, or board contents are sent.
- Conversations are held in memory for the session only. They are not written into board files, so a `.betterboard.json` you share carries no chat history.
- Any model drawing is validated and limited to simple geometry inside the boxed region; model output cannot execute code or address arbitrary board objects.

## File format

Boards are JSON (version 5): lists of frames and of layers (`name`, `opacity`, `visible`, bottom-first), the frame rate and onion-skin settings, a list of strokes — each carrying its `color`, `size`, `brush`, a `seed` (so brushes with any randomness redraw identically), its owning `layer` and `frame`, and `[x, y, pressure]` points in world coordinates — and a list of images, embedded as data URLs so a board stays one portable file. Strokes and images share a running `seq`, which is what puts them back in the order you made them. Imports over 1600px on the long side are scaled down on the way in, since a few full-resolution screenshots would otherwise dwarf the drawing they annotate. Plus the camera. Frames and layers form a grid and every stroke sits in one cell of it. Older files still open, each filling in what it predates: version 4 has no images, version 3 no brushes (its strokes load as pen), version 2 no animation (it lands on a single frame), version 1 no layers either. Autosaves go to the app's user-data directory; `⌘S` exports a portable `.betterboard.json`.

## Roadmap

- Custom app icon
- Scale and rotate a selection, copy/paste between boards and frames
- Shapes and text
- Pen tilt support
