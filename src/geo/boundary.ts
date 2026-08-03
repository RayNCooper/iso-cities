/**
 * Administrative and postal boundaries.
 *
 * Nominatim can return the matched object's own geometry, which is what lets
 * a render take the real shape of a postcode district or a city instead of an
 * arbitrary square. This module turns that GeoJSON into local metric polygons
 * and answers containment queries against them.
 */

import { boundsOf, openRing, pointInRing, type Bounds, type Ring } from './polygon.js';
import { toLocal, type LatLon, type Point } from './project.js';

/** One polygon: outer ring first, then any holes. */
export type Polygon = Ring[];

export interface Boundary {
  polygons: Polygon[];
  /** Bounding box across every polygon, in local metres. */
  bounds: Bounds;
  /** Per-polygon bounds, used to reject containment tests cheaply. */
  polygonBounds: Bounds[];
}

/** The GeoJSON subset Nominatim returns for a boundary. */
export interface GeoJsonGeometry {
  type: string;
  coordinates?: unknown;
}

/** Polygon rings as lat/lon, before projection. */
export type LatLonPolygons = LatLon[][][];

function isPositionArray(value: unknown): value is number[][] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    Array.isArray(value[0]) &&
    typeof (value[0] as unknown[])[0] === 'number'
  );
}

function toRing(positions: number[][]): LatLon[] {
  const ring: LatLon[] = [];
  for (const position of positions) {
    // GeoJSON is [longitude, latitude].
    const lon = position[0];
    const lat = position[1];
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;
    ring.push({ lat, lon });
  }
  return ring;
}

/**
 * Extracts polygon rings from a GeoJSON geometry. Returns null for geometry
 * that has no area — a Point or LineString means the geocoder matched
 * something without a boundary, and the caller should fall back to a radius.
 */
export function geometryToPolygons(geometry: GeoJsonGeometry | undefined): LatLonPolygons | null {
  if (!geometry || !geometry.coordinates) return null;
  const { type, coordinates } = geometry;

  if (type === 'Polygon') {
    if (!Array.isArray(coordinates)) return null;
    const rings = (coordinates as unknown[]).filter(isPositionArray).map(toRing);
    return rings.length > 0 ? [rings] : null;
  }

  if (type === 'MultiPolygon') {
    if (!Array.isArray(coordinates)) return null;
    const polygons: LatLonPolygons = [];
    for (const polygon of coordinates as unknown[]) {
      if (!Array.isArray(polygon)) continue;
      const rings = (polygon as unknown[]).filter(isPositionArray).map(toRing);
      if (rings.length > 0) polygons.push(rings);
    }
    return polygons.length > 0 ? polygons : null;
  }

  return null;
}

/** Projects lat/lon polygons into local metres around `origin`. */
export function projectBoundary(origin: LatLon, polygons: LatLonPolygons): Boundary | null {
  const projected: Polygon[] = [];

  for (const rings of polygons) {
    const localRings: Ring[] = [];
    for (const ring of rings) {
      const points = openRing(ring.map((p) => toLocal(origin, p.lat, p.lon)));
      if (points.length >= 3) localRings.push(points);
    }
    if (localRings.length > 0) projected.push(localRings);
  }

  if (projected.length === 0) return null;

  const polygonBounds = projected.map((rings) => boundsOf(rings[0]!));
  const bounds: Bounds = {
    minX: Math.min(...polygonBounds.map((b) => b.minX)),
    minY: Math.min(...polygonBounds.map((b) => b.minY)),
    maxX: Math.max(...polygonBounds.map((b) => b.maxX)),
    maxY: Math.max(...polygonBounds.map((b) => b.maxY)),
  };

  return { polygons: projected, bounds, polygonBounds };
}

/**
 * True if the point lies inside any polygon and outside that polygon's holes.
 * The per-polygon bounding box makes the common "nowhere near it" case cheap.
 */
export function boundaryContains(boundary: Boundary, point: Point): boolean {
  for (let i = 0; i < boundary.polygons.length; i++) {
    const box = boundary.polygonBounds[i]!;
    if (point.x < box.minX || point.x > box.maxX || point.y < box.minY || point.y > box.maxY) {
      continue;
    }
    let inside = false;
    for (const ring of boundary.polygons[i]!) {
      if (pointInRing(ring, point)) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/** Every vertex of every outer ring — what the layout has to fit on screen. */
export function boundaryOutline(boundary: Boundary): Point[] {
  const points: Point[] = [];
  for (const rings of boundary.polygons) {
    const outer = rings[0];
    if (outer) points.push(...outer);
  }
  return points;
}

/** Total area in square metres, holes subtracted. */
export function boundaryArea(boundary: Boundary): number {
  let total = 0;
  for (const rings of boundary.polygons) {
    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i]!;
      let sum = 0;
      for (let j = 0, n = ring.length; j < n; j++) {
        const a = ring[j]!;
        const b = ring[(j + 1) % n]!;
        sum += a.x * b.y - b.x * a.y;
      }
      total += (i === 0 ? 1 : -1) * Math.abs(sum / 2);
    }
  }
  return Math.max(0, total);
}

/** Number of vertices across the whole boundary, for progress reporting. */
export function boundaryVertexCount(boundary: Boundary): number {
  let n = 0;
  for (const rings of boundary.polygons) {
    for (const ring of rings) n += ring.length;
  }
  return n;
}
