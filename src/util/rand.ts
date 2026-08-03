/**
 * Deterministic hashing and pseudo-random numbers.
 *
 * Every visual variation in a render (roof colour, height jitter, tree
 * placement) is derived from a feature's OSM id plus the global seed, so the
 * same query always produces the same image.
 */

/** FNV-1a, 32-bit. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix two 32-bit values into one (used to fold a seed into a feature id). */
export function mix32(a: number, b: number): number {
  let h = (a ^ Math.imul(b, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Small, fast, seedable PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable float in [0, 1) for a given feature id + seed + channel name. */
export function stableUnit(id: string | number, seed: number, channel = ''): number {
  return mix32(hash32(`${id}:${channel}`), seed) / 4294967296;
}

/** A stable integer in [0, n) for a given feature id + seed + channel name. */
export function stableIndex(id: string | number, seed: number, n: number, channel = ''): number {
  if (n <= 0) return 0;
  return Math.min(n - 1, Math.floor(stableUnit(id, seed, channel) * n));
}
