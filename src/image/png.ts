/**
 * A minimal PNG encoder built on node:zlib.
 *
 * Writing this by hand (rather than pulling in a canvas binding) keeps the
 * package dependency-free and native-build-free, which matters a lot for a
 * CLI people install with `npx`.
 */

import { deflateSync } from 'node:zlib';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Applies PNG filters row by row, picking the candidate with the lowest sum
 * of absolute differences. Flat pixel-art regions filter down to long runs of
 * zeroes, which deflate then collapses — typically a 3-5x saving over
 * unfiltered output for the images this tool produces.
 */
function filterScanlines(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array((stride + 1) * height);
  const candidate = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  let previous = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    let bestType = 0;
    let bestScore = Infinity;

    for (let type = 0; type <= 4; type++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const raw = row[i]!;
        const left = i >= channels ? row[i - channels]! : 0;
        const up = previous[i]!;
        const upLeft = i >= channels ? previous[i - channels]! : 0;
        let value: number;
        switch (type) {
          case 0:
            value = raw;
            break;
          case 1:
            value = raw - left;
            break;
          case 2:
            value = raw - up;
            break;
          case 3:
            value = raw - ((left + up) >> 1);
            break;
          default:
            value = raw - paeth(left, up, upLeft);
            break;
        }
        value &= 0xff;
        candidate[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best.set(candidate);
      }
    }

    out[y * (stride + 1)] = bestType;
    out.set(best, y * (stride + 1) + 1);
    previous = Uint8Array.prototype.slice.call(row);
  }
  return out;
}

export interface EncodePngOptions {
  /** 8 = RGBA (colour type 6), 4 = RGB (colour type 2). Defaults to RGBA. */
  alpha?: boolean;
  /** zlib compression level, 0-9. Defaults to 9. */
  level?: number;
  /** Optional text chunks written as tEXt (e.g. Source, Comment). */
  text?: Record<string, string>;
}

/**
 * Encodes an RGBA pixel buffer (4 bytes per pixel, row-major) as a PNG.
 */
export function encodePng(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: EncodePngOptions = {},
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodePng: invalid dimensions ${width}x${height}`);
  }
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`encodePng: expected ${expected} bytes for ${width}x${height}, got ${rgba.length}`);
  }

  const alpha = options.alpha ?? true;
  const channels = alpha ? 4 : 3;
  const source = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length);

  let pixels: Uint8Array;
  if (alpha) {
    pixels = source;
  } else {
    pixels = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < source.length; i += 4, j += 3) {
      pixels[j] = source[i]!;
      pixels[j + 1] = source[i + 1]!;
      pixels[j + 2] = source[i + 2]!;
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // colour type
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const filtered = filterScanlines(pixels, width, height, channels);
  const compressed = deflateSync(filtered, { level: options.level ?? 9 });

  const chunks: Uint8Array[] = [SIGNATURE, chunk('IHDR', ihdr)];
  for (const [keyword, value] of Object.entries(options.text ?? {})) {
    chunks.push(chunk('tEXt', encodeText(keyword, value)));
  }
  chunks.push(chunk('IDAT', new Uint8Array(compressed)));
  chunks.push(chunk('IEND', new Uint8Array(0)));

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** tEXt payload: latin-1 keyword, NUL, latin-1 text. */
function encodeText(keyword: string, text: string): Uint8Array {
  const toLatin1 = (s: string) => {
    const bytes: number[] = [];
    for (const ch of s) {
      const code = ch.codePointAt(0)!;
      bytes.push(code <= 0xff ? code : 0x3f); // '?' for anything out of range
    }
    return bytes;
  };
  const k = toLatin1(keyword.slice(0, 79));
  const t = toLatin1(text);
  return Uint8Array.from([...k, 0, ...t]);
}
