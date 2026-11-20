/* The PNG reader, tested against bytes built here: `decodePng` is the piece
 * that turns a screenshot into a grid, so a wrong pixel order would quietly
 * give every later reading the wrong colours. Nothing about it is exercised by
 * the other suites, and it is the only decoder this package ships.
 */

import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { decodePng, toGrid } from "../packages/browser-control/src/png.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, body.length);
  const typed = new Uint8Array(4 + body.length);
  for (let index = 0; index < 4; index += 1)
    typed[index] = type.charCodeAt(index);
  typed.set(body, 4);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, crc32(typed));
  return Uint8Array.from([...head, ...typed, ...tail]);
}

/** A PNG of one colour, in one of the two shapes the decoder accepts. */
function pngOf(
  width: number,
  height: number,
  colourType: number,
  pixel: (x: number, y: number) => number[],
  overrides: { depth?: number; interlace?: number } = {},
): Uint8Array {
  const channels = colourType === 2 ? 3 : 4;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = overrides.depth ?? 8;
  header[9] = colourType;
  header[10] = 0;
  header[11] = 0;
  header[12] = overrides.interlace ?? 0;
  const stride = 1 + width * channels;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    /* Filter type 0: the bytes are stored as they are. */
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const values = pixel(x, y);
      const at = y * stride + 1 + x * channels;
      for (let channel = 0; channel < channels; channel += 1)
        raw[at + channel] = values[channel] ?? 0;
    }
  }
  return Uint8Array.from([
    ...SIGNATURE,
    ...chunk("IHDR", header),
    ...chunk("IDAT", Uint8Array.from(deflateSync(raw))),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
}

describe("decoding a PNG", () => {
  it("reads the pixels of a small RGBA image in row order", () => {
    const png = pngOf(3, 2, 6, (x, y) => [x * 10, y * 20, 7, 255]);
    const bitmap = decodePng(png);
    expect(bitmap.width).toBe(3);
    expect(bitmap.height).toBe(2);
    expect(bitmap.rgba).toHaveLength(3 * 2 * 4);
    /* The second pixel of the second row: x = 1, y = 1. */
    const at = (1 * 3 + 1) * 4;
    expect([...bitmap.rgba.slice(at, at + 4)]).toEqual([10, 20, 7, 255]);
  });

  it("fills in an opaque alpha for an RGB image", () => {
    const png = pngOf(2, 2, 2, () => [1, 2, 3]);
    const bitmap = decodePng(png);
    expect([...bitmap.rgba.slice(0, 4)]).toEqual([1, 2, 3, 255]);
    expect(bitmap.rgba).toHaveLength(2 * 2 * 4);
  });

  it("rejects bytes that are not a PNG at all", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(
      "not a PNG: the signature does not match",
    );
  });

  it("rejects an empty image", () => {
    expect(() => decodePng(pngOf(0, 0, 6, () => [0, 0, 0, 0]))).toThrow(
      "PNG has no pixels",
    );
  });

  it("rejects a bit depth it cannot read", () => {
    expect(() =>
      decodePng(pngOf(2, 2, 6, () => [0, 0, 0, 0], { depth: 16 })),
    ).toThrow("PNG bit depth 16 is not supported (8 only)");
  });

  it("rejects an interlaced image", () => {
    expect(() =>
      decodePng(pngOf(2, 2, 6, () => [0, 0, 0, 0], { interlace: 1 })),
    ).toThrow("interlaced PNG is not supported");
  });

  it("rejects a colour type it cannot read", () => {
    expect(() => decodePng(pngOf(2, 2, 0, () => [0]))).toThrow(
      "PNG colour type 0 is not supported (RGB, RGBA)",
    );
  });
});

describe("turning a picture into a grid", () => {
  it("keeps a solid picture one letter across every cell", () => {
    const grid = toGrid(
      decodePng(pngOf(4, 4, 6, () => [200, 50, 50, 255])),
      4,
      4,
    );
    expect(grid).toHaveLength(4);
    expect(grid[0]).toHaveLength(4);
    const first = grid[0]?.[0];
    expect(first).toBeDefined();
    for (const cell of grid.flat()) expect(cell).toBe(first);
  });

  it("tells two halves of a picture apart", () => {
    const png = pngOf(8, 4, 6, (x) =>
      x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255],
    );
    const grid = toGrid(decodePng(png), 2, 2);
    expect(grid[0]?.[0]).not.toBe(grid[0]?.[1]);
    for (const row of grid) expect(row[0]).toBe(grid[0]?.[0]);
  });

  it("clamps a grid that asks for more cells than the picture has", () => {
    const grid = toGrid(decodePng(pngOf(2, 2, 6, () => [9, 9, 9, 255])), 1, 1);
    expect(grid).toHaveLength(2);
    expect(grid[0]).toHaveLength(2);
    expect(
      toGrid(decodePng(pngOf(2, 2, 6, () => [0, 0, 0, 255])), 500, 500),
    ).toHaveLength(96);
  });
});
