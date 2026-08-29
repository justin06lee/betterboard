import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
  type VideoCodec,
} from 'mediabunny';
import { exportLayout, paintExport, type ExportLayout } from './render';
import type { Board } from './store';
import type { BBox, Theme } from './types';

export type AnimFormat = 'mp4' | 'webm' | 'gif';

export interface AnimSettings {
  format: AnimFormat;
  fps: number;
  maxDim: number; // cap on the longest side of the output, in pixels
}

export interface AnimResult {
  bytes: Uint8Array;
  format: AnimFormat;
}

export interface AnimProgress {
  onFrame?: (done: number, total: number) => void;
  // Polled between frames. A long export is cancellable, and a half-written
  // file is never handed back — the caller gets null instead.
  cancelled?: () => boolean;
}

// Tighter than the still export's margin: a video is watched at its own size,
// where a wide border just shrinks the drawing.
const PAD = 40;

// Codecs in the order we would rather have them, per container. H.264 leads for
// MP4 because it is the one that plays everywhere without a second thought;
// the rest are there so a build without an H.264 encoder still produces a file.
const CODECS: Record<'mp4' | 'webm', VideoCodec[]> = {
  mp4: ['avc', 'hevc', 'vp9', 'av1'],
  webm: ['vp9', 'vp8', 'av1'],
};

export function animationLayout(content: BBox, settings: Pick<AnimSettings, 'format' | 'maxDim'>): ExportLayout {
  return exportLayout(content, {
    pad: PAD,
    maxDim: settings.maxDim,
    quantize: settings.format === 'gif' ? 1 : 2,
  });
}

// GIF holds each frame for a whole number of centiseconds, so a frame rate that
// does not divide 100 gets rounded — 12fps becomes 12.5. Report the delay we
// will actually write rather than the one that was asked for.
export function gifDelayMs(fps: number): number {
  return Math.max(20, Math.round(1000 / fps / 10) * 10);
}

// Renders every frame of the board's timeline and encodes them into one file.
// Returns null when the board is empty, or when the caller cancelled part way.
export async function exportAnimation(
  board: Board,
  theme: Theme,
  settings: AnimSettings,
  progress: AnimProgress = {}
): Promise<AnimResult | null> {
  const content = board.animationBBox();
  if (!content) return null;

  const layout = animationLayout(content, settings);
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;

  const frames = board.frames;
  const paint = (i: number): void => {
    const id = frames[i].id;
    paintExport(canvas, board.visibleStrokes(id), board.visibleImages(id), board.layers, theme, layout);
  };

  return settings.format === 'gif'
    ? encodeGif(canvas, paint, frames.length, settings.fps, progress)
    : encodeVideo(canvas, paint, frames.length, settings, progress);
}

async function encodeVideo(
  canvas: HTMLCanvasElement,
  paint: (i: number) => void,
  count: number,
  settings: AnimSettings,
  progress: AnimProgress
): Promise<AnimResult | null> {
  const format = settings.format as 'mp4' | 'webm';
  const codec = await getFirstEncodableVideoCodec(CODECS[format], {
    width: canvas.width,
    height: canvas.height,
    quality: QUALITY_HIGH,
  });
  if (!codec) {
    throw new Error(
      `No ${format === 'mp4' ? 'MP4' : 'WebM'} video encoder is available at ${canvas.width}×${canvas.height}. Try a smaller size, or export a GIF.`
    );
  }

  const output = new Output({
    // fastStart puts the index ahead of the media, so the file plays the moment
    // it opens instead of after the whole thing is read.
    format: format === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH, keyFrameInterval: 1 });
  output.addVideoTrack(source, { frameRate: settings.fps });
  await output.start();

  try {
    for (let i = 0; i < count; i++) {
      if (progress.cancelled?.()) {
        await output.cancel();
        return null;
      }
      paint(i);
      // Awaiting each frame respects encoder backpressure, and gives the
      // progress bar a turn to paint.
      await source.add(i / settings.fps, 1 / settings.fps);
      progress.onFrame?.(i + 1, count);
    }
    source.close();
    await output.finalize();
  } catch (err) {
    if (output.state !== 'canceled' && output.state !== 'finalized') await output.cancel().catch(() => {});
    throw err;
  }

  const buffer = output.target.buffer;
  if (!buffer) throw new Error('the encoder finished without producing a file');
  return { bytes: new Uint8Array(buffer), format };
}

async function encodeGif(
  canvas: HTMLCanvasElement,
  paint: (i: number) => void,
  count: number,
  fps: number,
  progress: AnimProgress
): Promise<AnimResult | null> {
  const ctx = canvas.getContext('2d')!;
  const gif = GIFEncoder();
  const delay = gifDelayMs(fps);

  for (let i = 0; i < count; i++) {
    if (progress.cancelled?.()) return null;
    paint(i);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // A palette per frame rather than one for the whole animation: a drawing
    // that changes colour part way through would otherwise be quantised against
    // colours it does not contain.
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, canvas.width, canvas.height, { palette, delay, repeat: 0 });
    progress.onFrame?.(i + 1, count);
    // Quantising is synchronous and slow enough to freeze the window; yield so
    // the progress bar actually moves.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  gif.finish();
  return { bytes: gif.bytes(), format: 'gif' };
}
