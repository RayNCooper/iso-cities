/**
 * Domain types shared across fetching, scene building and rendering.
 */

import type { Boundary, LatLonPolygons } from './geo/boundary.js';
import type { BBox, LatLon, Point } from './geo/project.js';
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
  /**
   * Nominatim's place_rank: how far down the hierarchy the match sits.
   * Roughly 4 = country, 8 = state, 12 = county, 16 = city, 19 = suburb,
   * 26 = street, 30 = a single building. Used to infer framing.
   */
  placeRank?: number;
  /** The match's extent, as reported by the geocoder. */
  boundingBox?: BBox;
  /**
   * The matched object's own outline, as lat/lon rings, when the geocoder
   * returned one. A city or postcode district has this; a street address or a
   * bare coordinate does not.
   */
  boundary?: LatLonPolygons;
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
  /** Set on the building a highlight resolved to; drawn in full colour. */
  highlighted?: boolean;
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

/** A single address or point singled out in an otherwise desaturated render. */
export interface SceneHighlight {
  position: Point;
  label?: string;
  /** Id of the building the point resolved to, if it landed on one. */
  buildingId?: string;
  /** Metres from the requested point to that building, for reporting. */
  distance?: number;
}

export interface Scene {
  place: Place;
  origin: LatLon;
  /** Half-width of the rendered square, in metres. Ignored when `boundary` is set. */
  radius: number;
  /**
   * When present, the render is clipped to this shape instead of a square and
   * the ground plane takes its outline.
   */
  boundary?: Boundary;
  highlight?: SceneHighlight;
  buildings: BuildingFeature[];
  areas: AreaFeature[];
  roads: RoadFeature[];
  rails: RailFeature[];
  trees: TreeFeature[];
  stats: SceneStats;
  /** Attribution string that must accompany any published render. */
  attribution: string;
}
