/**
 * iso-cities — turn a city or postal code into an isometric pixel-art city.
 *
 * ```ts
 * import { renderCity } from 'iso-cities';
 * import { writeFile } from 'node:fs/promises';
 *
 * const result = await renderCity({ postcode: '10115', country: 'DE' });
 * await writeFile('berlin.png', result.png);
 * ```
 *
 * Map data comes from OpenStreetMap and is licensed under the ODbL. Any image
 * you publish must credit "© OpenStreetMap contributors" — the renderer draws
 * that credit by default. See ATTRIBUTION.md.
 */

import { encodePng, type EncodePngOptions } from './image/png.js';
import { ResponseCache, type CacheOptions } from './net/cache.js';
import { describeQuery, geocode, type GeocodeOptions, type PlaceQuery } from './net/nominatim.js';
import { fetchOsmData, type OverpassOptions } from './net/overpass.js';
import {
  boundaryArea,
  boundaryVertexCount,
  projectBoundary,
  type Boundary,
} from './geo/boundary.js';
import type { Bounds } from './geo/polygon.js';
import { bboxAround, toLatLon, toLocal, type BBox, type LatLon } from './geo/project.js';
import { buildScene, OSM_ATTRIBUTION, type BuildSceneOptions } from './scene/build.js';
import { renderScene, type RenderOptions, type RenderedImage } from './render/render.js';
import type { Place, Scene } from './types.js';
import { PROJECT_URL, VERSION } from './version.js';

export const DEFAULT_RADIUS_METRES = 400;
export const MIN_RADIUS_METRES = 40;
export const MAX_RADIUS_METRES = 4000;

/** Above this the free Overpass API starts to struggle; we warn rather than refuse. */
export const LARGE_REGION_KM2 = 25;

export interface IsoCityOptions extends RenderOptions {
  /** Half-width of the square area to render, in metres. Ignored when `region` wins. */
  radius?: number;
  /**
   * Render the matched place's real outline — a postcode district, a city
   * boundary — instead of a square. Falls back to `radius` with a warning when
   * the geocoder has no outline for the match (a street address, say).
   */
  region?: boolean;
  /**
   * An address to single out. Everything else is drawn in grey, and a pin is
   * placed on the building this resolves to.
   */
  highlight?: PlaceQuery;
  /** Overrides the label drawn for the highlight. Defaults to the query text. */
  highlightLabel?: string;
  /** Disable or redirect the on-disk response cache. */
  cache?: CacheOptions | false;
  /** Overrides for the geocoding request. */
  geocode?: Omit<GeocodeOptions, 'cache' | 'signal'>;
  /** Overrides for the Overpass request. */
  overpass?: Omit<OverpassOptions, 'cache' | 'signal'>;
  /** Layer toggles passed through to the scene builder. */
  layers?: Omit<BuildSceneOptions, 'place' | 'radius' | 'seed'>;
  /** PNG encoding options. */
  png?: EncodePngOptions;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface IsoCityResult {
  /** Encoded PNG bytes, ready to write to disk. */
  png: Uint8Array;
  width: number;
  height: number;
  place: Place;
  scene: Scene;
  image: RenderedImage;
  /** Credit line that must accompany the image if published. */
  attribution: string;
}

/**
 * Geocodes a place, fetches its map data, and renders it.
 *
 * This is the one-call entry point. The individual steps are exported too, so
 * you can cache a {@link Scene} and re-render it in several themes without
 * hitting the network again.
 */
export async function renderCity(
  query: PlaceQuery,
  options: IsoCityOptions = {},
): Promise<IsoCityResult> {
  const radius = clampRadius(options.radius ?? DEFAULT_RADIUS_METRES);
  const cache = options.cache === false ? undefined : new ResponseCache(options.cache ?? {});
  const onProgress = options.onProgress;
  const signal = options.signal;

  const place = await geocode(query, {
    ...options.geocode,
    ...(options.region ? { boundary: true } : {}),
    ...(cache ? { cache } : {}),
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
  onProgress?.(`Resolved to ${place.displayName}`);

  let boundary: Boundary | undefined;
  if (options.region) {
    boundary = (place.boundary && projectBoundary(place.centre, place.boundary)) || undefined;
    if (boundary) {
      const km2 = boundaryArea(boundary) / 1_000_000;
      onProgress?.(
        `Region outline: ${boundaryVertexCount(boundary)} vertices, ${km2.toFixed(1)} km²`,
      );
      if (km2 > LARGE_REGION_KM2) {
        onProgress?.(
          `Warning: ${km2.toFixed(0)} km² is a large area for the public Overpass API. ` +
            'Expect a slow query; --no-trees and a smaller --width help.',
        );
      }
    } else {
      onProgress?.(
        'Warning: the geocoder returned no outline for this match, ' +
          `falling back to a ${radius} m square.`,
      );
    }
  }

  const bbox = boundary ? bboxFromBounds(place.centre, boundary.bounds) : bboxAround(place.centre, radius);
  const data = await fetchOsmData(bbox, {
    ...options.overpass,
    ...(cache ? { cache } : {}),
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
  });

  let highlight: { position: { x: number; y: number }; label?: string } | undefined;
  if (options.highlight) {
    const target = await geocode(options.highlight, {
      ...options.geocode,
      ...(cache ? { cache } : {}),
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress } : {}),
    });
    const label = options.highlightLabel ?? describeQuery(options.highlight);
    highlight = { position: toLocal(place.centre, target.centre.lat, target.centre.lon), label };
    onProgress?.(`Highlighting ${label} at ${target.centre.lat.toFixed(5)}, ${target.centre.lon.toFixed(5)}`);
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

  const png = encodePng(image.raster.data, image.width, image.height, {
    text: {
      Software: `iso-cities ${VERSION} (${PROJECT_URL})`,
      Source: OSM_ATTRIBUTION,
      Comment: `${place.displayName} — ${radius} m radius`,
    },
    ...options.png,
  });

  return {
    png,
    width: image.width,
    height: image.height,
    place,
    scene,
    image,
    attribution: OSM_ATTRIBUTION,
  };
}

/**
 * Lat/lon box covering a local metric bounding box, plus a small pad so
 * features straddling the edge arrive whole and can be clipped cleanly.
 *
 * Local y is metres *south*, so the minimum y is the northern edge.
 */
function bboxFromBounds(origin: LatLon, bounds: Bounds, padMetres = 60): BBox {
  const northWest = toLatLon(origin, { x: bounds.minX - padMetres, y: bounds.minY - padMetres });
  const southEast = toLatLon(origin, { x: bounds.maxX + padMetres, y: bounds.maxY + padMetres });
  return {
    south: southEast.lat,
    west: northWest.lon,
    north: northWest.lat,
    east: southEast.lon,
  };
}

export function clampRadius(radius: number): number {
  if (!Number.isFinite(radius)) return DEFAULT_RADIUS_METRES;
  return Math.min(MAX_RADIUS_METRES, Math.max(MIN_RADIUS_METRES, Math.round(radius)));
}

// Re-exports so consumers can drive the pipeline step by step.
export { geocode, type PlaceQuery, type GeocodeOptions, GeocodeError } from './net/nominatim.js';
export { fetchOsmData, buildQuery, OVERPASS_MIRRORS, OverpassError, type OverpassOptions } from './net/overpass.js';
export { buildScene, OSM_ATTRIBUTION, type BuildSceneOptions } from './scene/build.js';
export { renderScene, type RenderOptions, type RenderedImage } from './render/render.js';
export { encodePng, type EncodePngOptions } from './image/png.js';
export { ResponseCache, defaultCacheDir, type CacheOptions } from './net/cache.js';
export {
  THEMES,
  THEME_NAMES,
  DEFAULT_THEME,
  getTheme,
  desaturateTheme,
  mapThemeColors,
  type Theme,
} from './render/palette.js';
export {
  geometryToPolygons,
  projectBoundary,
  boundaryContains,
  boundaryArea,
  boundaryOutline,
  type Boundary,
} from './geo/boundary.js';
export { Raster, type ScreenPoint, type Shader } from './render/raster.js';
export { createProjector, layoutFor, squareExtent, type Projector } from './render/iso.js';
export { bboxAround, toLocal, toLatLon, haversine, type BBox, type LatLon, type Point } from './geo/project.js';
export { VERSION } from './version.js';
export type {
  Place,
  Scene,
  SceneStats,
  SceneHighlight,
  BuildingFeature,
  AreaFeature,
  RoadFeature,
  RailFeature,
  TreeFeature,
  RoadClass,
  GreenKind,
  AreaKind,
} from './types.js';
