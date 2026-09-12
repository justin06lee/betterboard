// Pixel-mask math behind the magic wand and background removal. A mask is one
// byte per pixel (1 = selected) over the same grid as the RGBA buffer, so
// everything here runs — and is tested — without a canvas.

export interface MaskBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Squared RGBA distance against a squared budget. Alpha takes part so a
// transparent pixel never matches an opaque one that happens to share its RGB.
function within(
  data: Uint8ClampedArray,
  i: number,
  r: number,
  g: number,
  b: number,
  a: number,
  tolSq: number
): boolean {
  const dr = data[i] - r;
  const dg = data[i + 1] - g;
  const db = data[i + 2] - b;
  const da = data[i + 3] - a;
  return dr * dr + dg * dg + db * db + da * da <= tolSq;
}

// Tolerance reads like Photoshop's 0–255 wand setting: it is a per-channel
// allowance, so the squared budget spreads it across the four channels.
function budget(tolerance: number): number {
  const t = Math.max(0, tolerance);
  return t * t * 4;
}

// Classic magic wand: the region of pixels connected to the seed whose color
// stays within tolerance of the seed's color. 4-connected, so the selection
// cannot leak through a diagonal checkerboard boundary.
export function floodSelect(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  tolerance: number
): Uint8Array {
  const mask = new Uint8Array(width * height);
  if (x < 0 || y < 0 || x >= width || y >= height) return mask;
  const seed = y * width + x;
  const i0 = seed * 4;
  const r = data[i0];
  const g = data[i0 + 1];
  const b = data[i0 + 2];
  const a = data[i0 + 3];
  const tolSq = budget(tolerance);
  const stack = [seed];
  mask[seed] = 1;
  grow(stack, mask, data, width, height, r, g, b, a, tolSq);
  return mask;
}

// Every pixel within tolerance of the seed's colour, connected or not — the
// paint bucket's "similar" mode, and the reason recolouring every occurrence
// of one shade does not mean clicking each of them in turn.
export function similarSelect(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  tolerance: number
): Uint8Array {
  const mask = new Uint8Array(width * height);
  if (x < 0 || y < 0 || x >= width || y >= height) return mask;
  const i0 = (y * width + x) * 4;
  const r = data[i0];
  const g = data[i0 + 1];
  const b = data[i0 + 2];
  const a = data[i0 + 3];
  const tolSq = budget(tolerance);
  for (let p = 0; p < mask.length; p++) {
    if (within(data, p * 4, r, g, b, a, tolSq)) mask[p] = 1;
  }
  return mask;
}

// Selects the backdrop of a picture: everything connected to the border that
// matches the border's dominant color. A subject touching the edge survives as
// long as its color differs; a background-colored hole *inside* the subject is
// left alone because it does not reach the border.
export function backgroundSelect(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance: number
): Uint8Array {
  const mask = new Uint8Array(width * height);
  if (width === 0 || height === 0) return mask;
  const [r, g, b, a] = dominantBorderColor(data, width, height);
  const tolSq = budget(tolerance);
  const stack: number[] = [];
  const trySeed = (p: number) => {
    if (!mask[p] && within(data, p * 4, r, g, b, a, tolSq)) {
      mask[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < width; x++) {
    trySeed(x);
    trySeed((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    trySeed(y * width);
    trySeed(y * width + width - 1);
  }
  grow(stack, mask, data, width, height, r, g, b, a, tolSq);
  return mask;
}

function grow(
  stack: number[],
  mask: Uint8Array,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a: number,
  tolSq: number
): void {
  while (stack.length > 0) {
    const p = stack.pop()!;
    const px = p % width;
    const py = (p - px) / width;
    if (px > 0) visit(p - 1);
    if (px < width - 1) visit(p + 1);
    if (py > 0) visit(p - width);
    if (py < height - 1) visit(p + width);
  }
  function visit(q: number): void {
    if (!mask[q] && within(data, q * 4, r, g, b, a, tolSq)) {
      mask[q] = 1;
      stack.push(q);
    }
  }
}

// The most common coarsely-bucketed border color, averaged over its bucket so
// anti-aliased edge pixels pull the reference toward the true backdrop rather
// than electing a blend color of their own.
function dominantBorderColor(
  data: Uint8ClampedArray,
  width: number,
  height: number
): [number, number, number, number] {
  const buckets = new Map<number, [number, number, number, number, number]>();
  const tally = (p: number) => {
    const i = p * 4;
    const key =
      ((data[i] >> 4) << 12) | ((data[i + 1] >> 4) << 8) | ((data[i + 2] >> 4) << 4) | (data[i + 3] >> 4);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [0, 0, 0, 0, 0];
      buckets.set(key, bucket);
    }
    bucket[0] += data[i];
    bucket[1] += data[i + 1];
    bucket[2] += data[i + 2];
    bucket[3] += data[i + 3];
    bucket[4]++;
  };
  for (let x = 0; x < width; x++) {
    tally(x);
    if (height > 1) tally((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    tally(y * width);
    if (width > 1) tally(y * width + width - 1);
  }
  let best: [number, number, number, number, number] | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket[4] > best[4]) best = bucket;
  }
  if (!best) return [0, 0, 0, 0];
  return [best[0] / best[4], best[1] / best[4], best[2] / best[4], best[3] / best[4]];
}

// Grows a mask by one 4-connected ring. Cutting a background away with a mask
// dilated once eats a pixel into the subject's fringe, which removes the halo
// that anti-aliased edges would otherwise leave behind.
export function dilate(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      if (mask[p]) continue;
      if (
        (x > 0 && mask[p - 1]) ||
        (x < width - 1 && mask[p + 1]) ||
        (y > 0 && mask[p - width]) ||
        (y < height - 1 && mask[p + width])
      ) {
        out[p] = 1;
      }
    }
  }
  return out;
}

// True if the region ran off the edge of the buffer it was flooded in. The
// paint bucket asks this to tell a closed shape from an open one: a fill that
// reaches the border was never enclosed, it just ran out of picture.
export function maskTouchesBorder(mask: Uint8Array, width: number, height: number): boolean {
  if (width === 0 || height === 0) return false;
  for (let x = 0; x < width; x++) {
    if (mask[x] || mask[(height - 1) * width + x]) return true;
  }
  for (let y = 0; y < height; y++) {
    if (mask[y * width] || mask[y * width + width - 1]) return true;
  }
  return false;
}

export function maskBounds(mask: Uint8Array, width: number, height: number): MaskBounds | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}
