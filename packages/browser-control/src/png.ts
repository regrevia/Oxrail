/* The smallest PNG reader that answers "what colour is this pixel".
 *
 * `browser_look` has to turn a screenshot into letters, and that means reading
 * pixels. Chrome hands back PNG, this package has no dependencies, and adding
 * one for a single tool would be the only third-party code in the route — so
 * the decoder lives here instead.
 *
 * It supports what `Page.captureScreenshot` actually produces: 8-bit RGB or
 * RGBA, no interlace. Anything else is reported as unsupported rather than
 * silently decoded into garbage, because a wrong grid of letters would look
 * exactly like a real one.
 */

import { inflateSync } from "node:zlib";

export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** Red, green, blue, alpha — four bytes per pixel, row-major. */
  readonly rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePng(data: Uint8Array): Bitmap {
  for (let index = 0; index < SIGNATURE.length; index += 1)
    if (data[index] !== SIGNATURE[index])
      throw new Error("not a PNG: the signature does not match");

  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const parts: Uint8Array[] = [];

  while (offset + 8 <= data.length) {
    const length = readUint32(data, offset);
    const type = String.fromCharCode(
      data[offset + 4] ?? 0,
      data[offset + 5] ?? 0,
      data[offset + 6] ?? 0,
      data[offset + 7] ?? 0,
    );
    const body = data.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + 4;
    if (type === "IHDR") {
      width = readUint32(body, 0);
      height = readUint32(body, 4);
      depth = body[8] ?? 0;
      colorType = body[9] ?? 0;
      interlace = body[12] ?? 0;
    } else if (type === "IDAT") parts.push(body);
    else if (type === "IEND") break;
  }

  if (width <= 0 || height <= 0) throw new Error("PNG has no pixels");
  if (depth !== 8)
    throw new Error(`PNG bit depth ${depth} is not supported (8 only)`);
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0)
    throw new Error(
      `PNG colour type ${colorType} is not supported (RGB, RGBA)`,
    );

  const joined = Buffer.concat(parts.map((part) => Buffer.from(part)));
  const raw = inflateSync(joined);
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);

  for (let row = 0; row < height; row += 1) {
    const start = row * (stride + 1);
    const filter = raw[start] ?? 0;
    const line = raw.subarray(start + 1, start + 1 + stride);
    const out = new Uint8Array(stride);
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? (out[index - channels] ?? 0) : 0;
      const up = previous[index] ?? 0;
      const upLeft = index >= channels ? (previous[index - channels] ?? 0) : 0;
      const value = line[index] ?? 0;
      let restored = value;
      if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + up;
      else if (filter === 3) restored = value + ((left + up) >> 1);
      else if (filter === 4) restored = value + paeth(left, up, upLeft);
      out[index] = restored & 0xff;
    }
    previous = out;
    for (let column = 0; column < width; column += 1) {
      const source = column * channels;
      const target = (row * width + column) * 4;
      rgba[target] = out[source] ?? 0;
      rgba[target + 1] = out[source + 1] ?? 0;
      rgba[target + 2] = out[source + 2] ?? 0;
      rgba[target + 3] = channels === 4 ? (out[source + 3] ?? 255) : 255;
    }
  }
  return { width, height, rgba };
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  if (toUp <= toUpLeft) return up;
  return upLeft;
}

function readUint32(data: Uint8Array, at: number): number {
  return (
    (((data[at] ?? 0) << 24) |
      ((data[at + 1] ?? 0) << 16) |
      ((data[at + 2] ?? 0) << 8) |
      (data[at + 3] ?? 0)) >>>
    0
  );
}

/** One letter per cell, so a picture can be read without image tokens.
 *
 * The letter is the cell's dominant hue family, not its exact colour: the point
 * is telling a red button from a blue one and seeing where a layout sits, not
 * reproducing the paint. Density is by darkness, so `#` is ink and a space is
 * paper. A column-first grid reads like the page; a caller that wants more
 * detail asks for more cells, which is the only budget knob.
 *
 * @param bitmap - the decoded image.
 * @param cols - cells across, clamped to 2..64.
 * @param rows - cells down, clamped to 2..96.
 * @returns rows of single-character cells, top to bottom.
 */
export function toGrid(bitmap: Bitmap, cols: number, rows: number): string[][] {
  const across = Math.max(2, Math.min(64, Math.trunc(cols)));
  const down = Math.max(2, Math.min(96, Math.trunc(rows)));
  const out: string[][] = [];
  const cellW = bitmap.width / across;
  const cellH = bitmap.height / down;
  for (let row = 0; row < down; row += 1) {
    const line: string[] = [];
    for (let col = 0; col < across; col += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      const x0 = Math.floor(col * cellW);
      const x1 = Math.min(
        bitmap.width,
        Math.max(x0 + 1, Math.floor((col + 1) * cellW)),
      );
      const y0 = Math.floor(row * cellH);
      const y1 = Math.min(
        bitmap.height,
        Math.max(y0 + 1, Math.floor((row + 1) * cellH)),
      );
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const at = (y * bitmap.width + x) * 4;
          const alpha = (bitmap.rgba[at + 3] ?? 255) / 255;
          /* Composite over white: a transparent cell is paper, not black. */
          r += (bitmap.rgba[at] ?? 0) * alpha + 255 * (1 - alpha);
          g += (bitmap.rgba[at + 1] ?? 0) * alpha + 255 * (1 - alpha);
          b += (bitmap.rgba[at + 2] ?? 0) * alpha + 255 * (1 - alpha);
          n += 1;
        }
      }
      if (n === 0) {
        line.push(" ");
        continue;
      }
      line.push(letterOf(r / n, g / n, b / n));
    }
    out.push(line);
  }
  return out;
}

/** The letter for one averaged colour. */
function letterOf(r: number, g: number, b: number): string {
  const light = (r * 299 + g * 587 + b * 114) / 1000;
  /* Paper keeps the widest band, because most of a page is paper and a grid
     that spends its letters on background hides the part that changed. */
  if (light > 235) return " ";
  if (light > 200) return ".";
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  /* Nearly grey: say how dark, not which hue — a grey has no hue to name. */
  if (spread < 28) {
    if (light < 60) return "#";
    if (light < 120) return "+";
    return "-";
  }
  if (r >= g && r >= b) return light < 150 ? "R" : "r";
  if (g >= r && g >= b) return light < 150 ? "G" : "g";
  return light < 150 ? "B" : "b";
}
