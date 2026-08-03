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

export function layoutFor(options: {
  radius: number;
  width: number;
  margin: number;
  maxHeight: number;
  verticalExaggeration: number;
  height?: number;
}): Layout {
  const { radius, width, margin, maxHeight, verticalExaggeration } = options;
  const usable = Math.max(16, width - margin * 2);
  const scale = usable / (4 * radius);
  const diamondHeight = usable / 2;
  const headroom = Math.ceil(maxHeight * scale * verticalExaggeration);
  const height = options.height ?? Math.ceil(diamondHeight + headroom + margin * 2);
  return {
    width: Math.round(width),
    height: Math.round(height),
    scale,
    // Centre of the world square sits horizontally centred, and vertically
    // just below the headroom reserved for tall buildings.
    originX: Math.round(width / 2),
    originY: Math.round(margin + headroom + diamondHeight / 2),
  };
}
