/**
 * Polygon and polyline helpers operating on local metric coordinates.
 */

import type { Point } from './project.js';

export type Ring = Point[];

/**
 * Signed area of a ring, using the shoelace formula.
 *
 * Coordinates are (east, south) — i.e. y grows downward — so a *positive*
 * result means the ring is counter-clockwise when the axes are read as a
 * standard right-handed pair. Wall-facing tests downstream rely on this.
 */
export function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function area(ring: Ring): number {
  return Math.abs(signedArea(ring));
}

/** Returns the ring wound counter-clockwise (positive signed area). */
export function toCounterClockwise(ring: Ring): Ring {
  return signedArea(ring) < 0 ? [...ring].reverse() : ring;
}

/** Area-weighted centroid; falls back to the vertex mean for degenerate rings. */
export function centroid(ring: Ring): Point {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const p of ring) {
      sx += p.x;
      sy += p.y;
    }
    const n = Math.max(1, ring.length);
    return { x: sx / n, y: sy / n };
  }
  a *= 3;
  return { x: cx / a, y: cy / a };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(points: Point[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** True if `p` is inside `ring`, using the even-odd (crossing number) rule. */
export function pointInRing(ring: Ring, p: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y) {
      const t = (p.y - a.y) / (b.y - a.y);
      if (p.x < a.x + t * (b.x - a.x)) inside = !inside;
    }
  }
  return inside;
}

/** True if `p` is inside `outer` and outside every hole. */
export function pointInPolygon(rings: Ring[], p: Point): boolean {
  let inside = false;
  for (const ring of rings) {
    if (pointInRing(ring, p)) inside = !inside;
  }
  return inside;
}

/** Drops a closing vertex that duplicates the first one. */
export function openRing(ring: Ring): Ring {
  if (ring.length > 1) {
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
      return ring.slice(0, -1);
    }
  }
  return ring;
}

type Side = 'minX' | 'maxX' | 'minY' | 'maxY';

function inside(p: Point, side: Side, b: Bounds): boolean {
  switch (side) {
    case 'minX':
      return p.x >= b.minX;
    case 'maxX':
      return p.x <= b.maxX;
    case 'minY':
      return p.y >= b.minY;
    case 'maxY':
      return p.y <= b.maxY;
  }
}

function intersect(a: Point, b: Point, side: Side, bounds: Bounds): Point {
  switch (side) {
    case 'minX': {
      const t = (bounds.minX - a.x) / (b.x - a.x);
      return { x: bounds.minX, y: a.y + t * (b.y - a.y) };
    }
    case 'maxX': {
      const t = (bounds.maxX - a.x) / (b.x - a.x);
      return { x: bounds.maxX, y: a.y + t * (b.y - a.y) };
    }
    case 'minY': {
      const t = (bounds.minY - a.y) / (b.y - a.y);
      return { x: a.x + t * (b.x - a.x), y: bounds.minY };
    }
    case 'maxY': {
      const t = (bounds.maxY - a.y) / (b.y - a.y);
      return { x: a.x + t * (b.x - a.x), y: bounds.maxY };
    }
  }
}

const SIDES: Side[] = ['minX', 'maxX', 'minY', 'maxY'];

/**
 * Sutherland–Hodgman clip of a ring against an axis-aligned rectangle.
 * Returns an empty ring when nothing survives.
 */
export function clipRing(ring: Ring, bounds: Bounds): Ring {
  let output = openRing(ring);
  for (const side of SIDES) {
    if (output.length === 0) return [];
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i]!;
      const previous = input[(i + input.length - 1) % input.length]!;
      const currentIn = inside(current, side, bounds);
      const previousIn = inside(previous, side, bounds);
      if (currentIn) {
        if (!previousIn) output.push(intersect(previous, current, side, bounds));
        output.push(current);
      } else if (previousIn) {
        output.push(intersect(previous, current, side, bounds));
      }
    }
  }
  return output;
}

/**
 * Clips an open polyline against a rectangle, returning the surviving
 * segments as separate polylines.
 */
export function clipPolyline(line: Point[], bounds: Bounds): Point[][] {
  const out: Point[][] = [];
  let current: Point[] = [];
  const within = (p: Point) =>
    p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY;

  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const seg = clipSegment(a, b, bounds);
    if (!seg) {
      if (current.length > 1) out.push(current);
      current = [];
      continue;
    }
    const [ca, cb] = seg;
    if (current.length === 0) {
      current.push(ca, cb);
    } else {
      const last = current[current.length - 1]!;
      if (Math.abs(last.x - ca.x) < 1e-6 && Math.abs(last.y - ca.y) < 1e-6) {
        current.push(cb);
      } else {
        if (current.length > 1) out.push(current);
        current = [ca, cb];
      }
    }
    // A segment that leaves the box ends the current run.
    if (!within(b)) {
      if (current.length > 1) out.push(current);
      current = [];
    }
  }
  if (current.length > 1) out.push(current);
  return out;
}

/** Liang–Barsky segment clip. Returns null when the segment misses the box. */
export function clipSegment(a: Point, b: Point, bounds: Bounds): [Point, Point] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const tests: Array<[number, number]> = [
    [-dx, a.x - bounds.minX],
    [dx, bounds.maxX - a.x],
    [-dy, a.y - bounds.minY],
    [dy, bounds.maxY - a.y],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [
    { x: a.x + t0 * dx, y: a.y + t0 * dy },
    { x: a.x + t1 * dx, y: a.y + t1 * dy },
  ];
}

/**
 * Stitches unordered way fragments into closed rings by matching endpoints.
 * Overpass returns multipolygon relation members as separate pieces, so this
 * is what turns a lake or a courtyard building into usable geometry.
 */
export function assembleRings(fragments: Point[][], tolerance = 0.5): Ring[] {
  const pool = fragments.filter((f) => f.length >= 2).map((f) => [...f]);
  const rings: Ring[] = [];
  const near = (a: Point, b: Point) =>
    Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;

  while (pool.length > 0) {
    let current = pool.shift()!;
    let extended = true;
    while (extended) {
      extended = false;
      const head = current[0]!;
      const tail = current[current.length - 1]!;
      if (near(head, tail)) break;
      for (let i = 0; i < pool.length; i++) {
        const piece = pool[i]!;
        const pHead = piece[0]!;
        const pTail = piece[piece.length - 1]!;
        if (near(tail, pHead)) {
          current = current.concat(piece.slice(1));
        } else if (near(tail, pTail)) {
          current = current.concat([...piece].reverse().slice(1));
        } else if (near(head, pTail)) {
          current = piece.slice(0, -1).concat(current);
        } else if (near(head, pHead)) {
          current = [...piece].reverse().slice(0, -1).concat(current);
        } else {
          continue;
        }
        pool.splice(i, 1);
        extended = true;
        break;
      }
    }
    const ring = openRing(current);
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Length of a polyline in metres. */
export function polylineLength(line: Point[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}
