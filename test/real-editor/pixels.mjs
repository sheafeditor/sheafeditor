// Read the colour of a pixel out of a PNG screenshot, with no dependencies.
//
// A scenario that judges what is drawn by reading `getComputedStyle` can be fooled twice over: a colour
// moved to a pseudo-element reads as transparent though it is painted, and a colour painted under an
// opaque neighbour reads as set though nobody can see it. The screen is the only place both questions
// have one answer, so these read the screenshot the driver already takes.
//
//   const shot = await S.shot('block');
//   const img = readPng(shot);
//   img.at(x, y)            // { r, g, b, a } in device pixels
//   img.atCss(x, y, ratio)  // same, from CSS coordinates
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** The PNG's chunks, in order, as { type, data }. */
function chunks(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const out = [];
  let at = 8;
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    out.push({ type, data: buf.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

/** Undo one scanline's filter, in place, given the line above. `bpp` is bytes per pixel. */
function unfilter(type, line, prev, bpp) {
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = i >= bpp && prev ? prev[i - bpp] : 0;
    if (type === 1) line[i] = (line[i] + a) & 0xff;
    else if (type === 2) line[i] = (line[i] + b) & 0xff;
    else if (type === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
    else if (type === 4) line[i] = (line[i] + paeth(a, b, c)) & 0xff;
  }
  return line;
}

/**
 * Read a PNG written by the driver's `shot()`: 8-bit RGB or RGBA, no interlacing, which is what
 * Chromium writes. Anything else throws rather than returning a wrong colour.
 */
export function readPng(path) {
  const parts = chunks(readFileSync(path));
  const ihdr = parts.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colour = ihdr[9];
  const interlace = ihdr[12];
  if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
    throw new Error(`unsupported PNG: depth ${depth}, colour type ${colour}, interlace ${interlace}`);
  }
  const bpp = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(parts.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  let prev = null;
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const line = Buffer.from(raw.subarray(at + 1, at + 1 + stride));
    unfilter(raw[at], line, prev, bpp);
    line.copy(pixels, y * stride);
    prev = line;
  }
  const at = (x, y) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= width || py >= height) throw new Error(`pixel ${px},${py} is outside the ${width}x${height} image`);
    const i = py * stride + px * bpp;
    return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2], a: bpp === 4 ? pixels[i + 3] : 255 };
  };
  return {
    width,
    height,
    at,
    /** The same pixel named in CSS coordinates, for a screenshot taken at `ratio` device pixels per CSS pixel. */
    atCss: (x, y, ratio = width > 1600 ? 2 : 1) => at(x * ratio, y * ratio),
  };
}

/** How far apart two colours are, as the largest difference across the three channels. */
export const apart = (a, b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
export const show = (c) => `rgb(${c.r},${c.g},${c.b})`;
