/**
 * Turns OSM tags into the handful of categories the renderer understands.
 *
 * OSM tagging is famously open-ended; this module deliberately keeps only
 * what changes a pixel, and falls back to sensible defaults for everything
 * else rather than dropping features.
 */

import type { AreaKind, GreenKind, RoadClass } from '../types.js';
import type { OsmTags } from './types.js';

const METRES_PER_LEVEL = 3.2;
const ROOF_ALLOWANCE = 1.2;

/** Buildings that should read as civic landmarks rather than housing stock. */
const LANDMARK_BUILDINGS = new Set([
  'cathedral',
  'chapel',
  'church',
  'mosque',
  'synagogue',
  'temple',
  'shrine',
  'monastery',
  'castle',
  'tower',
  'monument',
  'civic',
  'public',
  'government',
  'city_hall',
  'train_station',
  'transportation',
  'stadium',
  'museum',
  'university',
]);

/** Default heights in metres when a building carries no height information. */
const DEFAULT_HEIGHTS: Record<string, number> = {
  yes: 9,
  house: 6.5,
  detached: 6.5,
  semidetached_house: 7,
  bungalow: 4.5,
  cabin: 4,
  hut: 3,
  static_caravan: 3,
  terrace: 8.5,
  residential: 13,
  apartments: 16,
  dormitory: 15,
  hotel: 18,
  commercial: 17,
  office: 20,
  retail: 9,
  supermarket: 8,
  kiosk: 3.5,
  industrial: 11,
  warehouse: 11,
  manufacture: 12,
  hangar: 12,
  factory: 12,
  garage: 3,
  garages: 3,
  carport: 2.6,
  shed: 3,
  roof: 3.2,
  greenhouse: 4,
  barn: 7,
  farm: 7,
  farm_auxiliary: 5,
  service: 4,
  school: 12,
  university: 16,
  college: 15,
  kindergarten: 7,
  hospital: 18,
  civic: 14,
  public: 14,
  government: 16,
  train_station: 14,
  transportation: 12,
  church: 18,
  cathedral: 30,
  chapel: 11,
  mosque: 18,
  synagogue: 16,
  temple: 16,
  castle: 24,
  tower: 34,
  water_tower: 28,
  stadium: 22,
  museum: 16,
  hotel_tower: 40,
  skyscraper: 70,
};

/**
 * Parses an OSM height value into metres. Handles bare numbers, explicit
 * units, comma decimals and imperial feet/inches (`40'`, `12'6"`).
 */
export function parseHeight(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase().replace(',', '.');
  if (value.length === 0) return null;

  const feetInches = /^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/.exec(value);
  if (feetInches) {
    const feet = Number(feetInches[1]);
    const inches = feetInches[2] ? Number(feetInches[2]) : 0;
    const metres = feet * 0.3048 + inches * 0.0254;
    return Number.isFinite(metres) && metres > 0 ? metres : null;
  }

  const match = /^(-?\d+(?:\.\d+)?)\s*(m|metre|metres|meter|meters|ft|feet|')?$/.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2];
  if (unit === 'ft' || unit === 'feet' || unit === "'") return n * 0.3048;
  return n;
}

function parseLevels(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 200) return null;
  return n;
}

export interface BuildingInfo {
  kind: string;
  height: number;
  landmark: boolean;
  name?: string;
}

/**
 * Derives a building's height, preferring explicit tags over levels over a
 * per-type default. Returns null when the tags do not describe a building.
 */
export function classifyBuilding(tags: OsmTags | undefined): BuildingInfo | null {
  if (!tags) return null;
  const kindRaw = tags['building'];
  if (!kindRaw || kindRaw === 'no') return null;
  const kind = kindRaw.toLowerCase();

  let height = parseHeight(tags['height']) ?? parseHeight(tags['building:height']);

  if (height === null) {
    const levels = parseLevels(tags['building:levels']) ?? parseLevels(tags['levels']);
    if (levels !== null) {
      const roofLevels = parseLevels(tags['roof:levels']) ?? 0;
      height = levels * METRES_PER_LEVEL + roofLevels * 2 + ROOF_ALLOWANCE;
    }
  }

  if (height === null) {
    height = DEFAULT_HEIGHTS[kind] ?? (kind === 'yes' ? 9 : 9);
  }

  // Guard against mis-tagged data producing absurd towers.
  height = Math.min(400, Math.max(2, height));

  const landmark =
    LANDMARK_BUILDINGS.has(kind) ||
    tags['amenity'] === 'place_of_worship' ||
    tags['historic'] === 'castle' ||
    tags['tourism'] === 'museum';

  const info: BuildingInfo = { kind, height, landmark };
  const name = tags['name'];
  if (name) info.name = name;
  return info;
}

const ROAD_CLASSES: Record<string, RoadClass> = {
  motorway: 'motorway',
  motorway_link: 'motorway',
  trunk: 'trunk',
  trunk_link: 'trunk',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  unclassified: 'residential',
  residential: 'residential',
  living_street: 'residential',
  service: 'service',
  pedestrian: 'pedestrian',
  footway: 'footway',
  path: 'footway',
  bridleway: 'footway',
  cycleway: 'cycleway',
  track: 'track',
  steps: 'steps',
};

/** Default carriageway widths in metres, including a small verge. */
const ROAD_WIDTHS: Record<RoadClass, number> = {
  motorway: 17,
  trunk: 14,
  primary: 12,
  secondary: 10.5,
  tertiary: 9,
  residential: 7.5,
  service: 4.5,
  pedestrian: 6,
  cycleway: 2.6,
  footway: 2.2,
  track: 3.2,
  steps: 2.4,
};

/** Painting order: lower numbers are drawn first, so trunk roads sit on top. */
export const ROAD_PRIORITY: Record<RoadClass, number> = {
  steps: 0,
  footway: 1,
  cycleway: 2,
  track: 3,
  service: 4,
  pedestrian: 5,
  residential: 6,
  tertiary: 7,
  secondary: 8,
  primary: 9,
  trunk: 10,
  motorway: 11,
};

export interface RoadInfo {
  roadClass: RoadClass;
  width: number;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
}

export function classifyRoad(tags: OsmTags | undefined): RoadInfo | null {
  if (!tags) return null;
  const highway = tags['highway'];
  if (!highway) return null;
  const roadClass = ROAD_CLASSES[highway];
  if (!roadClass) return null;

  let width = ROAD_WIDTHS[roadClass];
  const explicit = parseHeight(tags['width']);
  if (explicit !== null && explicit > 1 && explicit < 60) {
    width = explicit + 1;
  } else {
    const lanes = Number(tags['lanes']);
    if (Number.isFinite(lanes) && lanes >= 1 && lanes <= 12) {
      width = Math.max(width, lanes * 3.2 + 1.4);
    }
  }

  const layerValue = Number(tags['layer']);
  return {
    roadClass,
    width,
    bridge: tags['bridge'] !== undefined && tags['bridge'] !== 'no',
    tunnel: tags['tunnel'] !== undefined && tags['tunnel'] !== 'no',
    layer: Number.isFinite(layerValue) ? layerValue : 0,
  };
}

const RAIL_KINDS = new Set(['rail', 'light_rail', 'subway', 'tram', 'narrow_gauge', 'monorail', 'funicular']);

export function classifyRail(tags: OsmTags | undefined): { tunnel: boolean } | null {
  if (!tags) return null;
  const railway = tags['railway'];
  if (!railway || !RAIL_KINDS.has(railway)) return null;
  return { tunnel: tags['tunnel'] !== undefined && tags['tunnel'] !== 'no' };
}

const GREEN_BY_LEISURE: Record<string, GreenKind> = {
  park: 'park',
  garden: 'garden',
  playground: 'park',
  pitch: 'pitch',
  golf_course: 'grass',
  recreation_ground: 'grass',
  common: 'grass',
  dog_park: 'grass',
  nature_reserve: 'forest',
};

const GREEN_BY_LANDUSE: Record<string, GreenKind> = {
  grass: 'grass',
  forest: 'forest',
  meadow: 'grass',
  village_green: 'grass',
  recreation_ground: 'grass',
  allotments: 'farmland',
  orchard: 'farmland',
  vineyard: 'farmland',
  farmland: 'farmland',
  farmyard: 'farmland',
  cemetery: 'cemetery',
  greenfield: 'grass',
  flowerbed: 'garden',
};

const GREEN_BY_NATURAL: Record<string, GreenKind> = {
  wood: 'forest',
  scrub: 'grass',
  grassland: 'grass',
  heath: 'grass',
  tree_row: 'forest',
};

export interface AreaInfo {
  kind: AreaKind;
  sub: string;
}

/**
 * Classifies an area feature. Returns null for anything that should not be
 * painted on the ground plane.
 */
export function classifyArea(tags: OsmTags | undefined): AreaInfo | null {
  if (!tags) return null;

  if (
    tags['natural'] === 'water' ||
    tags['waterway'] === 'riverbank' ||
    tags['waterway'] === 'dock' ||
    tags['landuse'] === 'reservoir' ||
    tags['landuse'] === 'basin' ||
    tags['water'] !== undefined
  ) {
    return { kind: 'water', sub: tags['water'] ?? 'water' };
  }

  const natural = tags['natural'];
  if (natural === 'sand' || natural === 'beach' || natural === 'shingle') {
    return { kind: 'sand', sub: natural };
  }

  const leisure = tags['leisure'];
  if (leisure && GREEN_BY_LEISURE[leisure]) {
    return { kind: 'green', sub: GREEN_BY_LEISURE[leisure]! };
  }

  const landuse = tags['landuse'];
  if (landuse && GREEN_BY_LANDUSE[landuse]) {
    return { kind: 'green', sub: GREEN_BY_LANDUSE[landuse]! };
  }

  if (natural && GREEN_BY_NATURAL[natural]) {
    return { kind: 'green', sub: GREEN_BY_NATURAL[natural]! };
  }

  if (tags['amenity'] === 'parking' || tags['amenity'] === 'parking_space') {
    return { kind: 'parking', sub: 'parking' };
  }

  switch (landuse) {
    case 'residential':
      return { kind: 'residential', sub: 'residential' };
    case 'industrial':
    case 'railway':
    case 'port':
      return { kind: 'industrial', sub: landuse };
    case 'commercial':
    case 'retail':
      return { kind: 'commercial', sub: landuse };
    default:
      return null;
  }
}

/** Trees per hectare, by green-area type. Drives the scattered canopy layer. */
export const TREE_DENSITY: Record<GreenKind, number> = {
  forest: 260,
  park: 70,
  garden: 45,
  cemetery: 40,
  grass: 12,
  farmland: 3,
  pitch: 0,
};
