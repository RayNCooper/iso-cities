/**
 * Turns a raw Overpass response into a renderable scene.
 *
 * Everything is projected into local metres, clipped to the square the
 * renderer draws, classified, and — for green space — populated with a
 * deterministic scatter of trees.
 */

import {
  assembleRings,
  area as ringArea,
  boundsOf,
  centroid,
  clipPolyline,
  clipRing,
  openRing,
  pointInRing,
  polylineLength,
  toCounterClockwise,
  type Bounds,
  type Ring,
} from '../geo/polygon.js';
import { toLocal, type LatLon, type Point } from '../geo/project.js';
import {
  TREE_DENSITY,
  classifyArea,
  classifyBuilding,
  classifyRail,
  classifyRoad,
} from '../osm/classify.js';
import type { OverpassElement, OverpassLatLon, OverpassResponse, OsmTags } from '../osm/types.js';
import type {
  AreaFeature,
  BuildingFeature,
  GreenKind,
  Place,
  RailFeature,
  RoadFeature,
  Scene,
  TreeFeature,
} from '../types.js';
import { stableUnit } from '../util/rand.js';

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** Upper bound on scattered trees, so a big forest cannot stall a render. */
const MAX_TREES = 9000;
/** Footprints smaller than this are dropped; they render as noise anyway. */
const MIN_BUILDING_AREA_M2 = 6;
const MIN_AREA_M2 = 20;

export interface BuildSceneOptions {
  place: Place;
  radius: number;
  seed?: number;
  /** Feature toggles, all on by default. */
  buildings?: boolean;
  roads?: boolean;
  water?: boolean;
  greenery?: boolean;
  trees?: boolean;
  rails?: boolean;
}

export function buildScene(data: OverpassResponse, options: BuildSceneOptions): Scene {
  const {
    place,
    radius,
    seed = 0,
    buildings: wantBuildings = true,
    roads: wantRoads = true,
    water: wantWater = true,
    greenery: wantGreenery = true,
    trees: wantTrees = true,
    rails: wantRails = true,
  } = options;

  const origin = place.centre;
  const bounds: Bounds = { minX: -radius, minY: -radius, maxX: radius, maxY: radius };

  const buildings: BuildingFeature[] = [];
  const areas: AreaFeature[] = [];
  const roads: RoadFeature[] = [];
  const rails: RailFeature[] = [];
  const trees: TreeFeature[] = [];

  for (const element of data.elements) {
    const tags = element.tags;

    if (element.type === 'node') {
      if (wantTrees && tags?.['natural'] === 'tree') {
        const point = nodePoint(origin, element);
        if (point && inBounds(point, bounds)) {
          trees.push({
            id: `n${element.id}`,
            position: point,
            size: 2.4 + stableUnit(element.id, seed, 'tree') * 2.2,
          });
        }
      }
      continue;
    }

    const polygons = element.type === 'way' ? wayRings(origin, element) : relationRings(origin, element);
    const lines = element.type === 'way' ? wayLine(origin, element) : [];

    // Buildings.
    if (wantBuildings) {
      const info = classifyBuilding(tags);
      if (info && polygons.length > 0) {
        for (const rings of polygons) {
          const clipped = clipRings(rings, bounds);
          if (!clipped) continue;
          const footprint = ringArea(clipped[0]!);
          if (footprint < MIN_BUILDING_AREA_M2) continue;
          const feature: BuildingFeature = {
            id: `${element.type[0]}${element.id}`,
            rings: clipped,
            height: info.height,
            kind: info.kind,
            landmark: info.landmark,
            centroid: centroid(clipped[0]!),
            area: footprint,
          };
          if (info.name) feature.name = info.name;
          buildings.push(feature);
        }
        continue;
      }
    }

    // Roads and paths.
    if (wantRoads && lines.length > 0) {
      const road = classifyRoad(tags);
      if (road) {
        const clipped = clipPolyline(lines, bounds);
        const usable = clipped.filter((line) => polylineLength(line) > 0.5);
        if (usable.length > 0) {
          roads.push({
            id: `${element.type[0]}${element.id}`,
            roadClass: road.roadClass,
            width: road.width,
            lines: usable,
            bridge: road.bridge,
            tunnel: road.tunnel,
            layer: road.layer,
          });
        }
        continue;
      }
    }

    // Railways.
    if (wantRails && lines.length > 0) {
      const rail = classifyRail(tags);
      if (rail) {
        const clipped = clipPolyline(lines, bounds).filter((line) => polylineLength(line) > 1);
        if (clipped.length > 0) {
          rails.push({ id: `${element.type[0]}${element.id}`, lines: clipped, tunnel: rail.tunnel });
        }
        continue;
      }
    }

    // Ground cover.
    const areaInfo = classifyArea(tags);
    if (areaInfo && polygons.length > 0) {
      if (areaInfo.kind === 'water' && !wantWater) continue;
      if (areaInfo.kind === 'green' && !wantGreenery) continue;
      for (const rings of polygons) {
        const clipped = clipRings(rings, bounds);
        if (!clipped) continue;
        const size = ringArea(clipped[0]!);
        if (size < MIN_AREA_M2) continue;
        areas.push({
          id: `${element.type[0]}${element.id}`,
          kind: areaInfo.kind,
          sub: areaInfo.sub,
          rings: clipped,
          area: size,
        });
      }
    }
  }

  // Large areas first, so a park drawn on top of a residential block wins.
  areas.sort((a, b) => b.area - a.area);

  if (wantTrees && wantGreenery) {
    scatterTrees(areas, trees, seed, bounds);
  }

  let maxHeight = 0;
  for (const building of buildings) {
    if (building.height > maxHeight) maxHeight = building.height;
  }

  return {
    place,
    origin,
    radius,
    buildings,
    areas,
    roads,
    rails,
    trees,
    attribution: OSM_ATTRIBUTION,
    stats: {
      buildings: buildings.length,
      areas: areas.length,
      roads: roads.length,
      rails: rails.length,
      trees: trees.length,
      elements: data.elements.length,
      maxHeight,
    },
  };
}

function inBounds(p: Point, bounds: Bounds): boolean {
  return p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY;
}

function nodePoint(origin: LatLon, element: OverpassElement): Point | null {
  if (element.lat === undefined || element.lon === undefined) return null;
  return toLocal(origin, element.lat, element.lon);
}

function toPoints(origin: LatLon, geometry: OverpassLatLon[] | undefined): Point[] {
  if (!geometry) return [];
  const out: Point[] = [];
  for (const g of geometry) {
    // Overpass emits nulls for nodes it could not resolve; skip them.
    if (g === null || typeof g.lat !== 'number' || typeof g.lon !== 'number') continue;
    out.push(toLocal(origin, g.lat, g.lon));
  }
  return out;
}

function isClosed(points: Point[]): boolean {
  if (points.length < 4) return false;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return Math.abs(first.x - last.x) < 0.5 && Math.abs(first.y - last.y) < 0.5;
}

/** A closed way becomes a single-ring polygon; anything else has no area. */
function wayRings(origin: LatLon, element: OverpassElement): Ring[][] {
  const points = toPoints(origin, element.geometry);
  if (!isClosed(points)) return [];
  const ring = openRing(points);
  if (ring.length < 3) return [];
  return [[ring]];
}

function wayLine(origin: LatLon, element: OverpassElement): Point[] {
  const points = toPoints(origin, element.geometry);
  return points.length >= 2 ? points : [];
}

/**
 * Assembles a multipolygon relation. Member ways arrive as loose fragments, so
 * outers and inners are stitched separately and then matched by containment.
 */
function relationRings(origin: LatLon, element: OverpassElement): Ring[][] {
  const members = element.members;
  if (!members) return [];

  const outerFragments: Point[][] = [];
  const innerFragments: Point[][] = [];
  for (const member of members) {
    if (member.type !== 'way' || !member.geometry) continue;
    const points = toPoints(origin, member.geometry);
    if (points.length < 2) continue;
    if (member.role === 'inner') innerFragments.push(points);
    else outerFragments.push(points);
  }

  const outers = assembleRings(outerFragments);
  const inners = assembleRings(innerFragments);
  if (outers.length === 0) return [];

  return outers.map((outer) => {
    const holes = inners.filter((inner) => {
      const probe = inner[0];
      return probe !== undefined && pointInRing(outer, probe);
    });
    return [outer, ...holes];
  });
}

/**
 * Clips a polygon-with-holes to the render square. Returns null when the
 * outer ring is clipped away entirely.
 */
function clipRings(rings: Ring[], bounds: Bounds): Ring[] | null {
  const outerRaw = rings[0];
  if (!outerRaw) return null;
  const outer = clipRing(outerRaw, bounds);
  if (outer.length < 3) return null;

  const out: Ring[] = [toCounterClockwise(outer)];
  for (let i = 1; i < rings.length; i++) {
    const hole = clipRing(rings[i]!, bounds);
    if (hole.length >= 3) out.push(hole);
  }
  return out;
}

/**
 * Scatters trees across green areas on a jittered grid.
 *
 * The grid spacing comes from a per-type density, and both the jitter and the
 * canopy size are derived from the area id plus the global seed, so a given
 * query always produces the same wood.
 */
function scatterTrees(areas: AreaFeature[], trees: TreeFeature[], seed: number, bounds: Bounds): void {
  for (const area of areas) {
    if (trees.length >= MAX_TREES) return;
    if (area.kind !== 'green') continue;
    const density = TREE_DENSITY[area.sub as GreenKind];
    if (!density || density <= 0) continue;

    const spacing = Math.sqrt(10_000 / density);
    const box = boundsOf(area.rings[0]!);
    const outer = area.rings[0]!;
    const holes = area.rings.slice(1);

    let index = 0;
    for (let y = Math.ceil(box.minY / spacing) * spacing; y <= box.maxY; y += spacing) {
      for (let x = Math.ceil(box.minX / spacing) * spacing; x <= box.maxX; x += spacing) {
        if (trees.length >= MAX_TREES) return;
        index++;
        const jx = (stableUnit(area.id, seed, `jx${index}`) - 0.5) * spacing * 0.85;
        const jy = (stableUnit(area.id, seed, `jy${index}`) - 0.5) * spacing * 0.85;
        const point = { x: x + jx, y: y + jy };
        if (!inBounds(point, bounds)) continue;
        if (!pointInRing(outer, point)) continue;
        if (holes.some((hole) => pointInRing(hole, point))) continue;
        // Thin the grid slightly so rows do not read as an orchard.
        if (stableUnit(area.id, seed, `keep${index}`) < 0.18) continue;
        trees.push({
          id: `${area.id}:${index}`,
          position: point,
          size: 2 + stableUnit(area.id, seed, `size${index}`) * 2.6,
        });
      }
    }
  }
}

/** Exposed for tests: the tag sets that decide what gets drawn. */
export function summariseTags(tags: OsmTags | undefined): string {
  if (!tags) return '';
  return Object.entries(tags)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join(',');
}
