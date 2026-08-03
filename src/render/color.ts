/**
 * Colour primitives.
 *
 * Everything is plain `[r, g, b]` triples in 0-255. There is deliberately no
 * anti-aliasing anywhere in the renderer — pixel art wants hard edges, so
 * colours are always chosen and then written verbatim.
 */

export type RGB = readonly [number, number, number];

/** Parses `#rgb`, `#rrggbb` (with or without the hash). */
export function hex(value: string): RGB {
  let s = value.trim().replace(/^#/, '');
  if (s.length === 3) s = s[0]! + s[0]! + s[1]! + s[1]! + s[2]! + s[2]!;
  if (s.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(s)) {
    throw new Error(`Invalid hex colour: ${value}`);
  }
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

export function toHex(c: RGB): string {
  const part = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
  return `#${part(c[0])}${part(c[1])}${part(c[2])}`;
}

export function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/** Multiplies brightness. `factor` < 1 darkens, > 1 lightens. */
export function shade(c: RGB, factor: number): RGB {
  return [clamp(c[0] * factor, 0, 255), clamp(c[1] * factor, 0, 255), clamp(c[2] * factor, 0, 255)];
}

/** Linear blend; `t` = 0 returns `a`, `t` = 1 returns `b`. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  const u = clamp(t, 0, 1);
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

export function lighten(c: RGB, amount: number): RGB {
  return mix(c, [255, 255, 255], amount);
}

export function darken(c: RGB, amount: number): RGB {
  return mix(c, [0, 0, 0], amount);
}

/** Perceptual-ish luminance in 0-255. */
export function luminance(c: RGB): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * Shifts a colour toward a hue-preserving tint, used to give every theme a
 * consistent atmospheric cast (warm daylight, blue dusk, and so on).
 */
export function tint(c: RGB, target: RGB, amount: number): RGB {
  return mix(c, target, amount);
}

/**
 * Snaps a continuous brightness factor to `steps` discrete levels between
 * `min` and `max`. Continuous shading looks muddy at pixel-art resolutions;
 * quantising keeps wall faces reading as flat planes.
 */
export function quantiseFactor(t: number, steps: number, min: number, max: number): number {
  const u = clamp(t, 0, 1);
  const level = Math.min(steps - 1, Math.floor(u * steps));
  return min + ((max - min) * level) / Math.max(1, steps - 1);
}

const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** Ordered-dither threshold in [0, 1) for a pixel position. */
export function bayer4(x: number, y: number): number {
  return BAYER_4[((y % 4) + 4) % 4]![((x % 4) + 4) % 4]! / 16;
}

const BAYER_8 = (() => {
  const m: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let v = 0;
      let mask = 4;
      let bit = 0;
      while (mask > 0) {
        const bx = (x & mask) ? 1 : 0;
        const by = (y & mask) ? 1 : 0;
        v |= ((bx ^ by) << (2 * bit + 1)) | (by << (2 * bit));
        mask >>= 1;
        bit++;
      }
      m[y]![x] = v;
    }
  }
  return m;
})();

export function bayer8(x: number, y: number): number {
  return BAYER_8[((y % 8) + 8) % 8]![((x % 8) + 8) % 8]! / 64;
}

/** Cheap deterministic value noise in [0, 1), used for ground speckle. */
export function pixelNoise(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
