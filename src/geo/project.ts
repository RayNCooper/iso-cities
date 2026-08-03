/**
 * Geographic -> local metric projection.
 *
 * At the scale this tool renders (a few hundred metres across) a local
 * equirectangular approximation around the query centre is accurate to well
 * under a pixel, and it keeps the maths trivial and inspectable.
 *
 * Local coordinate convention used everywhere downstream:
 *   x = metres east of centre
 *   y = metres *south* of centre  (y grows downward, matching screen space)
 */

export interface LatLon {
  lat: number;
  lon: number;
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface Point {
  x: number;
  y: number;
}

const METRES_PER_DEGREE_LAT = 111_320;

/** Metres per degree of longitude at a given latitude. */
export function metresPerDegreeLon(lat: number): number {
  return METRES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Projects a lat/lon into local metres (east, south) around `origin`. */
export function toLocal(origin: LatLon, lat: number, lon: number): Point {
  return {
    x: (lon - origin.lon) * metresPerDegreeLon(origin.lat),
    y: -(lat - origin.lat) * METRES_PER_DEGREE_LAT,
  };
}

/** Inverse of {@link toLocal}. */
export function toLatLon(origin: LatLon, p: Point): LatLon {
  return {
    lat: origin.lat - p.y / METRES_PER_DEGREE_LAT,
    lon: origin.lon + p.x / metresPerDegreeLon(origin.lat),
  };
}

/**
 * A lat/lon bounding box covering a square of `radius` metres around `centre`.
 * `padding` (a multiplier) widens the box so features that straddle the edge
 * are still fetched whole and can be clipped cleanly.
 */
export function bboxAround(centre: LatLon, radius: number, padding = 1.15): BBox {
  const r = radius * padding;
  const dLat = r / METRES_PER_DEGREE_LAT;
  const dLon = r / metresPerDegreeLon(centre.lat);
  return {
    south: centre.lat - dLat,
    west: centre.lon - dLon,
    north: centre.lat + dLat,
    east: centre.lon + dLon,
  };
}

/** Overpass wants bounding boxes as `south,west,north,east`. */
export function formatBBox(b: BBox): string {
  const f = (n: number) => n.toFixed(7);
  return `${f(b.south)},${f(b.west)},${f(b.north)},${f(b.east)}`;
}

/**
 * Approximate area of a bounding box in square kilometres.
 *
 * Used to size the Overpass request: asking a busy server for far more memory
 * than the query needs is a good way to be queued and then time out.
 */
export function bboxAreaKm2(box: BBox): number {
  const midLat = ((box.north + box.south) / 2) * (Math.PI / 180);
  const height = (box.north - box.south) * 111.32;
  const width = (box.east - box.west) * 111.32 * Math.cos(midLat);
  return Math.max(0, height * width);
}

/** Great-circle distance in metres (haversine). Used for sanity checks. */
export function haversine(a: LatLon, b: LatLon): number {
  const R = 6_371_008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
