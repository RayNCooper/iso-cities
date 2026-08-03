/**
 * Domain types shared across fetching, scene building and rendering.
 */

import type { LatLon, Point } from './geo/project.js';
import type { Ring } from './geo/polygon.js';

export type RoadClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'service'
  | 'pedestrian'
  | 'cycleway'
  | 'footway'
  | 'track'
  | 'steps';

export type GreenKind = 'park' | 'forest' | 'grass' | 'farmland' | 'cemetery' | 'pitch' | 'garden';

export type AreaKind =
  | 'water'
  | 'green'
  | 'sand'
  | 'residential'
  | 'industrial'
  | 'commercial'
  | 'parking';

/** A resolved place, as returned by geocoding. */
export interface Place {
  /** Human-readable label used for the on-image title. */
  name: string;
  /** Full display name from the geocoder. */
  displayName: string;
  centre: LatLon;
  /** OSM type/id of the matched object, when the geocoder provided one. */
  osmType?: string;
  osmId?: number;
  /** Geocoder's classification, e.g. `place`/`city` or `place`/`postcode`. */
  category?: string;
  type?: string;
  countryCode?: string;
}

export interface BuildingFeature {
  id: string;
  /** Outer ring first (counter-clockwise), then holes. Local metres. */
  rings: Ring[];
  /** Metres above ground. */
  height: number;
  /** Building tag value, e.g. `apartments`. */
  kind: string;
  /** Churches, towers, stations and the like get accent colouring. */
  landmark: boolean;
  name?: string;
  centroid: Point;
  /** Footprint area in square metres. */
  area: number;
}

export interface AreaFeature {
  id: string;
  kind: AreaKind;
  /** Finer classification, e.g. the {@link GreenKind} for green areas. */
  sub: string;
  rings: Ring[];
  area: number;
}

export interface RoadFeature {
  id: string;
  roadClass: RoadClass;
  /** Carriageway width in metres. */
  width: number;
  lines: Point[][];
  bridge: boolean;
  tunnel: boolean;
  layer: number;
}

export interface RailFeature {
  id: string;
  lines: Point[][];
  tunnel: boolean;
}

export interface TreeFeature {
  id: string;
  position: Point;
  /** Canopy radius in metres. */
  size: number;
}

export interface SceneStats {
  buildings: number;
  areas: number;
  roads: number;
  rails: number;
  trees: number;
  elements: number;
  /** Tallest building in metres, used to reserve vertical headroom. */
  maxHeight: number;
}

export interface Scene {
  place: Place;
  origin: LatLon;
  /** Half-width of the rendered square, in metres. */
  radius: number;
  buildings: BuildingFeature[];
  areas: AreaFeature[];
  roads: RoadFeature[];
  rails: RailFeature[];
  trees: TreeFeature[];
  stats: SceneStats;
  /** Attribution string that must accompany any published render. */
  attribution: string;
}
