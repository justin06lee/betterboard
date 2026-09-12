<div align="center">

<img src="assets/betterboard.svg" alt="betterboard" width="330" />

# betterboard

**An infinite whiteboard desktop app built for pen displays.**<br>
*Pressure-sensitive ink, endless canvas, zero friction.*

</div>

---

betterboard is a desktop whiteboard for macOS and Linux (x64 and arm64), designed around drawing tablets like the Huion Kamvas Pro. Strokes are stored as vectors — pressure-weighted centerlines rendered with [perfect-freehand](https://github.com/steveruizok/perfect-freehand) — so the canvas is truly infinite, zooming is lossless, and erasing can remove whole strokes or only what sits under the eraser — ink and image pixels alike.

## Features

- **Six brushes** — **pen** (pressure-tapered ink), **pixel** (snaps to a shared world grid, so separate strokes and separate sessions line up — real pixel art), **marker** (flat chisel tip, translucent, builds up where strokes cross), **paint** (a dry bristle brush with a solid body and frayed edges), **chalk** (dry, grainy powder with dusty edges — the grain is real gaps in the mark, so it stays grainy at any size and any zoom) and **liner** (one even width from end to end, pressure ignored on purpose — for lettering, ruling boxes, and tracing to a set weight). Stroke width follows stylus pressure via Chromium pointer events; mouse strokes fall back to velocity-simulated pressure
- **Infinite canvas** — pan, zoom, and rotate freely, with an adaptive dot grid that follows the view
- **Boards of any size** — a board of a million strokes draws, pans, zooms, erases and saves as smoothly as an empty one. It is painted once into cached tiles and only what is moving is drawn each frame; ink too small on screen to show its shape is drawn as the speck or hairline it amounts to; every stroke is packed, indexed by where it sits and found without searching the rest; and an edit costs the same whatever else is on the board. See [Performance](#performance)
- **Flip the canvas** — `M` mirrors the view left to right (`⇧M` top to bottom), the check artists make to catch what their eye has stopped seeing. It only changes how you look at the board: you can keep drawing while flipped, and strokes, exports and saved files all stay the right way round. A **Flipped** tag sits in the zoom pill until you flip back
- **Stylus-native gestures** — the pen's eraser end erases, the barrel button pans, touch pans
- **Two eraser modes** — remove whole strokes, or sweep the eraser circle to remove whatever sits under it: ink is clipped, and pictures get their pixels carved out directly, with no separate image-editing mode. Either way a gesture is one undo step
- **Lasso select** — loop your pen around anything to select it, then drag the marching-ants outline to move it; `⌫` deletes the selection, `Esc` drops it. `⌘A` takes everything on the layer
- **Resize and stretch a selection** — every selection, your own strokes included, gets grips on its box: drag a corner to scale it (`⇧` frees the proportions, `⌥` scales about the middle) or an edge to stretch it wider or taller. Ink and pictures reshape together and undo in one step. A stretched stroke is drawn again along its new path rather than smeared, so it stays a clean line; its width follows the geometric mean of the stretch — the rule vector editors use — so an even scale is exact and a one-way stretch thickens the line only a little
- **Copy, paste and duplicate a selection** — `⌘C`/`⌘X`/`⌘V` and `⌘D` on whatever you lassoed, or the bar that appears under it. What comes back is live ink, not a picture of it: the same strokes, the same brushes, the same seeds. A picture of the selection goes to the system clipboard at the same time, so the drawing pastes into any other app, and a marker written beside it is how paste tells "still my copy" from "someone copied something else since". `⌘D` duplicates the selection first and only falls through to duplicating the frame when the timeline is already open — it never opens the timeline itself
- **Stickers** — keep any selection as a reusable cut-out. Stickers live outside the board file, so they are there for every board you open afterwards: click one to stamp it into the middle of the view, or drag it out of the tray to place it. Stamped down it is ordinary ink again — erasable, movable, drawable over
- **Paint bucket** — `F`, then click. **Area** floods the closed shape under the pointer at an adjustable tolerance; **Similar** recolours every matching pixel in view at once. The fill is worked out from a fresh render of what is actually on screen — no grid, no marquee — so ink and photographs bound it the same way, and it tucks itself under anti-aliased edges instead of leaving a pale seam. An outline that is not closed says so rather than quietly filling the screen
- **Colour picker** — a proper one: saturation/value square, hue slider, hex and RGB fields, and the colours you reached for lately. It is a toggle, over a scrim that eats the click which closes it, so putting it away never leaves a dot on the board
- **Take a colour off the board** — `I`, or hold `I` and let go over what you want. A magnifier follows the pointer showing the pixel grid and the exact hex under the crosshair, so picking one colour out of a hairline is aim, not luck
- **Layers** — add, delete, rename, reorder by dragging, hide, and dim. Opacity composites the finished layer rather than each stroke, so overlaps never show seams — drop a sketch to 30% and ink over it cleanly. Drawing, erasing and selecting stay on the active layer, so what's underneath is safe
- **Animation** — a timeline of frames, each with the full layer stack. Add, duplicate, delete and drag frames into order, set the frame rate, and play the loop back. Onion skinning ghosts the frames either side, tinted red behind and teal ahead, with adjustable reach and strength
- **Images** — paste from the clipboard, drop files onto the board, or insert from disk. They land on the active layer and frame, interleaved with your ink in the order you made things, so you can draw over a reference or paste a screenshot on top of notes. Drag to move, drag a corner to scale (`⇧` stretches freely), drag an edge to stretch one axis, `⌫` to delete
- **Magic wand** — click a picture to select a contiguous color region, Photoshop-style, with an adjustable tolerance; **Background** mode selects the whole border-connected backdrop with one click anywhere on the picture. Then **Erase selected** cuts those pixels to transparency (background removal in two clicks) or **Keep only** discards everything else. Both are single undo steps
- **Workspace picker** — the first launch asks whether you're here as a student, artist, animator, or photo editor and arranges the starting layout to match, or **Anything** for the plain default setup with nothing assumed. Every tool stays available whichever you pick, and View → Choose Workspace reopens the choice any time — picking Anything again is also how you put a layout you have wandered away from back to standard
- **Ask / Draw through Yagami** — box any part of the board to discuss it or ask the model to circle, connect, annotate, and sketch directly into the selected region. Model drawings are ordinary vector strokes with one-step undo. Use the signed-in coding-agent binaries on this computer directly, or connect to a remote personal Yagami server
- **Normalize zoom** — one press rebases the current view as the new 100%, restoring the full zoom range without moving a pixel; when you hit the zoom-out floor, the button pulses to offer it
- **A toolbar that goes where you want it** — a floating bubble you can drag to any edge, sliding rather than snapping into place; it turns into a slim column on the sides. When it stops fitting it hands whole sections to a ⋯ menu, named, rather than shrinking what is left — everything stays reachable, some of it one click further away, right down to a 720×480 window. Every panel on the board keeps clear of whichever edge it is on
- **Undo / redo**, dark & light board themes, and an autosave that writes only what an edit changed — session restore included, and closing the window waits for the last save
- **Export** — the current frame's visible layers as a PNG, or the whole timeline as an **MP4**, **WebM** or **animated GIF**. Every frame renders into one canvas sized to fit the whole animation, so nothing shifts between frames; pick the frame rate and the size, and watch it encode
- **Save / open** boards as JSON, written and read in pieces, so a board of any size fits in a file and opens again

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
bun run build   # typecheck + test + bundle (production build)
```

The renderer is plain TypeScript on a 2D canvas (no framework), bundled with `bun build`. The Electron main process lives in `src/main`, the renderer in `src/renderer`. The board reaches the screen through a tile cache (`tiles.ts`), strokes live in an indexed store (`store.ts`, `spatial.ts`, `points.ts`), and boards go to and from disk through `codec.ts` and `persist.ts`. Animation export encodes in the renderer — video through the browser's own WebCodecs encoders, muxed by [mediabunny](https://mediabunny.dev), and GIF through [gifenc](https://github.com/mattdesl/gifenc) — and hands the finished bytes to the main process, which only picks the file and writes it.

To try the app at scale, `scripts/heavy-board.js` writes a synthetic board of handwriting-like strokes, and `BETTERBOARD_USER_DATA` opens it in a scratch profile that never touches your real autosave:

```sh
bun scripts/heavy-board.js 1000000 /tmp/bb-heavy/autosave.json
BETTERBOARD_USER_DATA=/tmp/bb-heavy bunx electron .
```

The first launch carries that file into the autosave folder; later launches read the folder. Adding `BETTERBOARD_BENCH=1` exposes the board's internals on `window.__bb` for measuring. Time frames by the gap between animation frames, not by reading pixels back from the board: Chromium takes a canvas off the GPU once it has been read from a few times, and every number after that is wrong.

## Controls

| Action | Input |
|---|---|
| Draw | Pen or left mouse drag |
| Erase | `E`, the stylus eraser end, or eraser tool; choose **Stroke** or **Area** beside the active eraser |
| Select an area | `S`, then loop the pen around it (tap a stroke to select just that one) |
| Move a selection | Drag from inside the outline |
| Resize / stretch a selection | Drag a corner grip to scale (`⇧` frees the proportions, `⌥` scales about the middle) · drag an edge grip to stretch one way |
| Delete / drop a selection | `⌫` / `Esc` |
| Magic wand | `W`, then click a picture; **Point** selects the color region under the click, **Background** the whole backdrop, and the slider sets tolerance |
| Apply a wand selection | **Erase selected** (or `⌫`) cuts it to transparency · **Keep only** cuts everything else |
| Erase pixels from a picture | The **Area** eraser, swept straight across it |
| Pan | Space + drag, `H`, middle/right drag, pen barrel button, touch, or two-finger scroll |
| Zoom | Pinch, `⌘` + scroll, `⌘+` / `⌘−` / `⌘0`, or the zoom pill |
| Zoom to fit | `⌘1` |
| Normalize zoom | `⇧⌘N` or the ⤢ button in the zoom pill |
| Rotate | hold `R` and drag the dial — snaps near 45° steps; double-click the dial to reset, `⌘1` also squares the view |
| Flip the canvas | `M` left to right · `⇧M` top to bottom, the flip button in the toolbar, or View → Flip Canvas |
| Brushes | `1` pen · `2` pixel · `3` marker · `4` paint · `5` chalk · `6` liner |
| Tools | `B`/`P` draw · `E` eraser · `F` fill · `S` lasso · `W` wand · `I` colour picker · `H` hand (each toggles back to the pen) |
| Fill a shape | `F`, then click; **Area** or **Similar** and the tolerance slider sit beside the toolbar |
| Take a colour off the board | `I` to toggle, or hold `I` and release over the colour you want |
| Select everything on the layer | `⌘A` |
| Copy · cut · paste · duplicate | `⌘C` · `⌘X` · `⌘V` · `⌘D` |
| Keep a selection as a sticker | `⇧⌘D`, or **Save sticker** in the selection bar |
| Stickers tray | `⌥⌘S`; click a sticker to stamp it, or drag it onto the board |
| Move the toolbar | Drag its grip to any edge, or View → Toolbar Position |
| Ask or draw with AI in a region | `A`, then drag a box (or `⌥⌘A`) |
| Send · newline · new thread | `Enter` · `⇧Enter` · `+` in the panel |
| Paste / insert an image | `⌘V` (Edit ▸ Paste), drop a file on the board, or `⇧⌘I` |
| Move / scale / stretch / delete an image | Drag it · corner grip scales (`⇧` stretches freely) · edge grip stretches one axis · `⌫` |
| Timeline | `T` or `⌘T` |
| Play / pause | `Enter` (or `⌘↩`) |
| Previous / next frame | `←` / `→` |
| New / duplicate / delete frame | `⌥⌘F` / `⌘D` while the timeline is open, or `+` ⧉ 🗑 in it |
| Reorder frames | Drag a frame cell |
| Frame rate · onion skin | The fps field · the ◐ button (`⌥⌘O`), then its sliders |
| Layers panel | `L` or `⌘L` |
| New / delete layer | `⌥⌘N` / `⌥⌘⌫`, or `+` and 🗑 in the panel |
| Hide / show a layer | The eye on its row, or `⌥⌘H` for the active one |
| Layer opacity · rename · reorder | The panel slider · double-click its name · drag its row |
| Stroke size | `[` and `]`, or the size chip — it opens the slider and a scratch pad that draws at the real size |
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

## Performance

A board of a million strokes is the design target. Measured on the heavy-board generator's handwriting (about 42 points a stroke), driving the pen, the wheel and the lasso through Chromium's own event loop, against the version before this work:

| | 20,000 strokes | 100,000 strokes | 1,000,000 strokes |
|---|---|---|---|
| Launch, restoring the board | 0.4 s (was 1.1 s) | 0.6 s (was 3.2 s) | 4.9 s (could not open it) |
| JavaScript heap | 30 MB (was 330 MB) | 170 MB (was 1.7 GB) | 1.0 GB |
| Typical frame — drawing, panning, zooming, erasing, dragging | 16.7 ms (zooming was 60–90 ms) | 16.7 ms (was 25–175 ms) | 16.7 ms |
| Worst frame | 36 ms (was 192 ms) | 37 ms (was 1.1 s) | 42 ms |
| Main-thread stalls over 50 ms, whole run | none (was 81, 8.5 s) | none (was 91, 31 s) | none |
| Committing an edit — stroke, erase, move, delete, undo | about 1 ms | about 1 ms | 0.2–4 ms |
| Autosave after an edit | 26 ms, off the main thread (was 220 ms, on it) | same (was 1.3 s, on it) | 18 ms |

16.7 ms is a frame every refresh on a 60 Hz display. The version before could not open the million-stroke board at all: its autosave was one JSON string, and 1.3 GB is past the longest string JavaScript can hold, so it started empty — and its next autosave would have written the empty board over the real one.

What makes the difference:

- **Tiles.** The board is painted into 512-pixel tiles per frame and layer, in the camera's scale and rotation but not its position, so panning slides them and a frame is a few dozen tile copies plus whatever is moving — the live stroke, a dragged selection, the marching ants. A finished stroke is painted straight onto the tiles it touches; an erase or undo repaints only the region it changed. A zoom keeps the old tiles on screen, stretched, while new ones are painted a few milliseconds at a time, nearest the middle first.
- **Level of detail.** Ink a couple of pixels across is drawn as the speck or hairline it amounts to, at the width and coverage the real stroke averages, and its outline is never built at all. Outlines that are built are cached up to a budget and dropped oldest first.
- **Packed, indexed strokes.** A stroke's points are one `Float32Array` measured from its own origin — exact anywhere on an infinite board, and invisible to the garbage collector. Strokes never change once made: a move or reshape swaps in a copy that shares its points. Each cell of the frame × layer grid keeps a layered spatial index, so the eraser, the lasso and every tile find what is near them without looking at anything else, and the board itself is a map by id, so no edit or undo ever walks the whole board.
- **Incremental saves.** See [File format](#file-format).

## File format

Boards are JSON (version 6), written a line at a time so a board of any size fits. The first line holds the camera — always written the right way round, even while the view is flipped — the lists of frames and of layers (`name`, `opacity`, `visible`, bottom-first), and the frame rate and onion-skin settings. Then comes one line per image, embedded as a data URL so a board stays one portable file, and then the strokes, a few megabytes to a line, each line a base64 chunk of packed binary records. A record carries a stroke's `id`, `seq`, `color`, `size`, `brush`, a `seed` (so brushes with any randomness redraw identically), its owning `layer` and `frame`, its bounds, and its points as float32 `[x, y, pressure]` triples measured from the stroke's own origin. Strokes and images share a running `seq`, which is what puts them back in the order you made them. Imports over 1600px on the long side are scaled down on the way in, since a few full-resolution screenshots would otherwise dwarf the drawing they annotate. Frames and layers form a grid and every stroke sits in one cell of it. Older files still open: version 5 and earlier spell every point out as JSON numbers, and each fills in what it predates — version 4 has no images, version 3 no brushes (its strokes load as pen), version 2 no animation (it lands on a single frame), version 1 no layers either. `⌘S` exports a portable `.betterboard.json`.

The autosave is not one file but a folder in the app's user-data directory: a small manifest, stroke buckets — the same binary records, sorted into files by a hash of each stroke's id — and one file per distinct picture, named for its contents. An edit rewrites only the buckets holding what it touched. A save writes its new files first and switches over by renaming the manifest into place, so a crash mid-save leaves the previous save whole, and closing the window waits a few seconds for the last one. The single `autosave.json` that earlier versions wrote is carried into the folder on first launch and kept beside it as `autosave.pre-v6.json`. Stickers live beside the autosave in `stickers.json` rather than in any board, since the point of one is to outlive the board it was cut from.

## Roadmap

- Custom app icon
- Rotate and mirror a selection
- Shapes and text
- Pen tilt support
