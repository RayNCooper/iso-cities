/**
 * The render pipeline: query -> place -> map data -> scene -> pixels.
 *
 * Deliberately free of Node built-ins. Everything platform-specific — PNG
 * encoding, the disk cache, the filesystem — lives in the entry points that
 * wrap this (`index.ts` for Node, `browser.ts` for the web).
 */

import {
  boundaryArea,
  boundaryVertexCount,
  projectBoundary,
  type Boundary,
} from './geo/boundary.js';
import type { Bounds } from './geo/polygon.js';
import {
  bboxAreaKm2,
  bboxAround,
  toLatLon,
  toLocal,
  type BBox,
  type LatLon,
  type Point,
} from './geo/project.js';
import type { CacheLike } from './net/cache.js';
import { describeQuery, geocode, type GeocodeOptions, type PlaceQuery } from './net/nominatim.js';
import { fetchOsmData, type OverpassOptions } from './net/overpass.js';
import { renderScene, type RenderOptions, type RenderedImage } from './render/render.js';
import { buildScene, type BuildSceneOptions } from './scene/build.js';
import type { Place, Scene } from './types.js';

export const DEFAULT_RADIUS_METRES = 400;
export const MIN_RADIUS_METRES = 40;
export const MAX_RADIUS_METRES = 4000;

/** Above this the free Overpass API starts to struggle; we warn rather than refuse. */
export const LARGE_REGION_KM2 = 25;

/** place_rank at or below which a match is bigger than a city. */
export const REGION_MAX_PLACE_RANK = 12;
/** place_rank at or above which a match is one address, building or POI. */
export const ADDRESS_MIN_PLACE_RANK = 28;
/**
 * The largest area `auto` will try to draw as a whole region.
 *
 * A county is already thousands of square kilometres and a country is
 * hundreds of thousands — far more building data than the public Overpass API
 * will ever serve. Past this, `auto` falls back to the centre and says so.
 */
export const AUTO_REGION_MAX_KM2 = 250;

/**
 * How much slack to allow when judging size from a bounding box alone.
 *
 * A box around a diagonal or coastal shape overstates it badly — Monaco's box
 * is 262 km² for a country of about 2 — so the cheap pre-check is deliberately
 * generous, and the real area is measured once the outline is in hand.
 */
export const BBOX_OVERESTIMATE_ALLOWANCE = 4;

export type PlaceScale = 'region' | 'settlement' | 'address';

/**
 * How big a thing the geocoder matched, from its place_rank.
 *
 * Nominatim ranks results down a hierarchy — roughly 4 for a country, 8 for a
 * state, 16 for a city, 26 for a street, 30 for a single building — which is
 * exactly the signal needed to decide whether to draw an outline or a radius.
 */
export function placeScale(place: Place): PlaceScale {
  // A match with no rank is treated as a settlement: the middle case, and the
  // one whose framing is least surprising when the guess is wrong.
  const rank = place.placeRank ?? 20;
  if (rank <= REGION_MAX_PLACE_RANK) return 'region';
  if (rank >= ADDRESS_MIN_PLACE_RANK) return 'address';
  return 'settlement';
}

export interface PipelineOptions extends RenderOptions {
  /** Half-width of the square area to render, in metres. Ignored when `region` wins. */
  radius?: number;
  /**
   * Render the matched place's real outline — a postcode district, a municipal
   * boundary — instead of a square. Falls back to `radius` with a warning when
   * the geocoder has no outline for the match (a street address, say).
   */
  region?: boolean;
  /**
   * Let the match decide the framing, so one input covers every case:
   *
   * - bigger than a city (county, state, country) -> its whole outline
   * - a city, town, district or postcode -> a radius around its centre
   * - a street or an address -> a radius around it, with the building picked out
   *
   * `region` still wins if it is set explicitly.
   */
  auto?: boolean;
  /**
   * An address to single out. Everything else is drawn in grey, and a pin is
   * placed on the building this resolves to.
   */
  highlight?: PlaceQuery;
  /** Overrides the label drawn for the highlight. Defaults to the query text. */
  highlightLabel?: string;
  /**
   * Frame the render on the highlighted address rather than on the matched
   * place, keeping `radius` around it. Useful when the place query is a whole
   * city but you want the streets around one building.
   *
   * Has no effect with `region`, where the boundary decides the framing.
   */
  centerOnHighlight?: boolean;
  /** Response cache. Omit to make every run hit the network. */
  cache?: CacheLike;
  geocode?: Omit<GeocodeOptions, 'cache' | 'signal'>;
  overpass?: Omit<OverpassOptions, 'cache' | 'signal'>;
  layers?: Omit<BuildSceneOptions, 'place' | 'radius' | 'seed' | 'boundary' | 'highlight'>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface PipelineResult {
  place: Place;
  scene: Scene;
  image: RenderedImage;
  /** The area actually rendered, in square metres. */
  areaM2: number;
}

export function clampRadius(radius: number): number {
  if (!Number.isFinite(radius)) return DEFAULT_RADIUS_METRES;
  return Math.min(MAX_RADIUS_METRES, Math.max(MIN_RADIUS_METRES, Math.round(radius)));
}

/**
 * Lat/lon box covering a local metric bounding box, plus a small pad so
 * features straddling the edge arrive whole and can be clipped cleanly.
 *
 * Local y is metres *south*, so the minimum y is the northern edge.
 */
export function bboxFromBounds(origin: LatLon, bounds: Bounds, padMetres = 60): BBox {
  const northWest = toLatLon(origin, { x: bounds.minX - padMetres, y: bounds.minY - padMetres });
  const southEast = toLatLon(origin, { x: bounds.maxX + padMetres, y: bounds.maxY + padMetres });
  return {
    south: southEast.lat,
    west: northWest.lon,
    north: northWest.lat,
    east: southEast.lon,
  };
}

/**
 * Runs the whole pipeline and returns the rendered raster, without encoding it.
 */
export async function renderCityScene(
  query: PlaceQuery,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const radius = clampRadius(options.radius ?? DEFAULT_RADIUS_METRES);
  const { cache, signal, onProgress } = options;

  const geocodeOptions = {
    ...options.geocode,
    ...(cache ? { cache } : {}),
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
  };

  // The first lookup deliberately does not ask for an outline. It is the
  // cheap one, and its place_rank and bounding box are what decide whether an
  // outline is wanted at all — so a country's polygon, which can run to many
  // megabytes, is never downloaded just to be discarded.
  let matched = await geocode(query, {
    ...geocodeOptions,
    ...(options.region === true ? { boundary: true } : {}),
  });
  onProgress?.(`Resolved to ${matched.displayName}`);

  let wantRegion = options.region === true;
  let highlightSelf = false;

  if (options.auto && options.region !== true) {
    const scale = placeScale(matched);
    if (scale === 'region') {
      const boxKm2 = matched.boundingBox ? bboxAreaKm2(matched.boundingBox) : Infinity;
      if (boxKm2 <= AUTO_REGION_MAX_KM2 * BBOX_OVERESTIMATE_ALLOWANCE) {
        // Worth asking for the outline; its true area is checked below.
        wantRegion = true;
      } else {
        onProgress?.(
          `${matched.name} spans roughly ${Math.round(boxKm2).toLocaleString()} km² — far more ` +
            'building data than the public API will serve. Drawing its centre instead.',
        );
      }
    } else if (scale === 'address') {
      // An address is only worth drawing if you can see which building it is.
      highlightSelf = true;
    }
  }

  // Only now, knowing the outline is both wanted and a sane size, ask for it.
  if (wantRegion && !matched.boundary) {
    matched = await geocode(query, { ...geocodeOptions, boundary: true });
  }

  // The highlight is resolved before the map data is fetched, because it may
  // decide where the bounding box goes.
  let highlightTarget: Place | undefined;
  if (options.highlight) {
    highlightTarget = await geocode(options.highlight, {
      ...options.geocode,
      ...(cache ? { cache } : {}),
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress } : {}),
    });
  }

  let place = matched;
  if (options.centerOnHighlight) {
    if (!highlightTarget) {
      onProgress?.('Warning: nothing to centre on — pass a highlight as well.');
    } else if (options.region) {
      onProgress?.(
        'Warning: centring has no effect with a region render; the boundary sets the frame.',
      );
    } else {
      // Keep the matched place's naming, move its origin to the address.
      place = { ...matched, centre: highlightTarget.centre };
      onProgress?.(
        `Centred on ${highlightTarget.centre.lat.toFixed(5)}, ${highlightTarget.centre.lon.toFixed(5)}`,
      );
    }
  }

  let boundary: Boundary | undefined;
  if (wantRegion) {
    boundary = (place.boundary && projectBoundary(place.centre, place.boundary)) || undefined;
    if (boundary) {
      const km2 = boundaryArea(boundary) / 1_000_000;

      // The bounding-box check above was only a cheap filter. Now that the real
      // outline is here, measure it properly — a shape can be a small fraction
      // of the box that contains it.
      if (options.auto && options.region !== true && km2 > AUTO_REGION_MAX_KM2) {
        onProgress?.(
          `${place.name} covers ${Math.round(km2).toLocaleString()} km² — too much building ` +
            'data for the public API. Drawing its centre instead.',
        );
        boundary = undefined;
      }
    }
    if (boundary) {
      const km2 = boundaryArea(boundary) / 1_000_000;
      onProgress?.(`Region outline: ${boundaryVertexCount(boundary)} vertices, ${km2.toFixed(1)} km²`);
      if (km2 > LARGE_REGION_KM2) {
        onProgress?.(
          `Warning: ${km2.toFixed(0)} km² is a large area for the public Overpass API. ` +
            'Expect a slow query; turning trees off and using a smaller width help.',
        );
      }
    } else {
      onProgress?.(
        `Warning: the geocoder returned no outline for this match, falling back to a ${radius} m square.`,
      );
    }
  }

  const bbox = boundary
    ? bboxFromBounds(place.centre, boundary.bounds)
    : bboxAround(place.centre, radius);

  const data = await fetchOsmData(bbox, {
    ...options.overpass,
    ...(cache ? { cache } : {}),
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
  });

  let highlight: { position: Point; label?: string } | undefined;
  if (highlightSelf && !options.highlight && !boundary) {
    // The match *is* the centre, so its local position is the origin.
    highlight = { position: { x: 0, y: 0 }, label: matched.name };
    onProgress?.(`Picking out ${matched.name}`);
  }
  if (options.highlight && highlightTarget) {
    const label = options.highlightLabel ?? describeQuery(options.highlight);
    highlight = {
      position: toLocal(place.centre, highlightTarget.centre.lat, highlightTarget.centre.lon),
      label,
    };
    onProgress?.(
      `Highlighting ${label} at ${highlightTarget.centre.lat.toFixed(5)}, ` +
        `${highlightTarget.centre.lon.toFixed(5)}`,
    );
  }

  const scene = buildScene(data, {
    place,
    radius,
    seed: options.seed ?? 0,
    ...(boundary ? { boundary } : {}),
    ...(highlight ? { highlight } : {}),
    ...options.layers,
  });

  if (options.highlight) {
    const resolved = scene.highlight;
    if (resolved?.buildingId) {
      const how =
        resolved.distance && resolved.distance > 0
          ? `nearest building, ${resolved.distance.toFixed(0)} m away`
          : 'the building containing it';
      onProgress?.(`Highlight matched ${how} (${resolved.buildingId})`);
    } else {
      onProgress?.(
        'Warning: the highlighted point did not land on or near a building; ' +
          'only the marker will be drawn.',
      );
    }
  }

  onProgress?.(
    `Scene: ${scene.stats.buildings} buildings, ${scene.stats.roads} roads, ` +
      `${scene.stats.areas} areas, ${scene.stats.trees} trees`,
  );

  const image = renderScene(scene, options);
  onProgress?.(`Rendering ${image.width}x${image.height}`);

  return {
    place,
    scene,
    image,
    areaM2: boundary ? boundaryArea(boundary) : (radius * 2) ** 2,
  };
}
