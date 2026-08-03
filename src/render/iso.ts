/**
 * Isometric projection.
 *
 * Uses the 2:1 dimetric projection that pixel art has settled on: one metre
 * east moves 1 unit right and 0.5 units down, one metre south moves 1 unit
 * left and 0.5 units down. Whole-number ratios mean tile edges land on exact
 * pixel diagonals rather than shimmering.
 *
 * World input is (x = metres east, y = metres south, z = metres up).
 */

import type { ScreenPoint } from './raster.js';
import type { Point } from '../geo/project.js';

export interface Projector {
  /** Horizontal pixels per metre. */
  readonly scale: number;
  /** Vertical pixels per metre (scale x exaggeration). */
  readonly verticalScale: number;
  readonly originX: number;
  readonly originY: number;
  project(x: number, y: number, z?: number): ScreenPoint;
  /** Painter's-algorithm depth. Larger = nearer the viewer = drawn later. */
  depth(x: number, y: number): number;
}

export interface ProjectorOptions {
  scale: number;
  verticalExaggeration?: number;
  originX: number;
  originY: number;
}

export function createProjector(options: ProjectorOptions): Projector {
  const { scale, originX, originY } = options;
  const verticalScale = scale * (options.verticalExaggeration ?? 1);
  return {
    scale,
    verticalScale,
    originX,
    originY,
    project(x: number, y: number, z = 0): ScreenPoint {
      return {
        x: originX + (x - y) * scale,
        y: originY + (x + y) * scale * 0.5 - z * verticalScale,
      };
    },
    depth(x: number, y: number): number {
      return x + y;
    },
  };
}

export function projectRing(projector: Projector, ring: Point[], z = 0): ScreenPoint[] {
  const out: ScreenPoint[] = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    out[i] = projector.project(p.x, p.y, z);
  }
  return out;
}

/**
 * Screen dimensions needed to fit a square world region of `radius` metres,
 * plus headroom for the tallest thing standing on it.
 *
 * The square projects to a diamond that is `4 * radius * scale` wide and half
 * that tall, so width alone fixes the horizontal scale.
 */
export interface Layout {
  width: number;
  height: number;
  scale: number;
  originX: number;
  originY: number;
}

/** The four corners of the square of `radius` metres around the origin. */
export function squareExtent(radius: number): Point[] {
  return [
    { x: -radius, y: -radius },
    { x: radius, y: -radius },
    { x: radius, y: radius },
    { x: -radius, y: radius },
  ];
}

/**
 * Screen dimensions and scale that fit a set of world points, plus headroom
 * above them for the tallest thing standing on the ground.
 *
 * Fitting arbitrary points rather than assuming a square is what lets a render
 * take the shape of a postcode district: an irregular outline gets framed just
 * as tightly, with no wasted margin.
 *
 * The scale is found by projecting at unit scale first, measuring the result,
 * then solving for the factor that makes it fill the requested width.
 */
export function layoutFor(options: {
  /** World points that must be visible. Defaults to the square for `radius`. */
  extent?: Point[];
  radius?: number;
  width: number;
  margin: number;
  maxHeight: number;
  verticalExaggeration: number;
  height?: number;
}): Layout {
  const { width, margin, maxHeight, verticalExaggeration } = options;
  const extent =
    options.extent && options.extent.length > 0 ? options.extent : squareExtent(options.radius ?? 400);

  let minSX = Infinity;
  let maxSX = -Infinity;
  let minSY = Infinity;
  let maxSY = -Infinity;
  for (const p of extent) {
    const sx = p.x - p.y;
    const sy = (p.x + p.y) * 0.5;
    if (sx < minSX) minSX = sx;
    if (sx > maxSX) maxSX = sx;
    if (sy < minSY) minSY = sy;
    if (sy > maxSY) maxSY = sy;
  }

  const rawWidth = Math.max(1e-6, maxSX - minSX);
  const rawHeight = Math.max(1e-6, maxSY - minSY);
  const usable = Math.max(16, width - margin * 2);
  const scale = usable / rawWidth;
  const headroom = Math.ceil(Math.max(0, maxHeight) * scale * verticalExaggeration);
  const height = options.height ?? Math.ceil(rawHeight * scale + headroom + margin * 2);

  return {
    width: Math.round(width),
    height: Math.round(height),
    scale,
    originX: Math.round(margin - minSX * scale),
    originY: Math.round(margin + headroom - minSY * scale),
  };
}
