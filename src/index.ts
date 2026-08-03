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
 * This is the Node entry point. For the browser, import `iso-cities/browser`,
 * which swaps the disk cache for an in-memory one and hands back a raw pixel
 * buffer you can put straight onto a canvas.
 *
 * Map data comes from OpenStreetMap and is licensed under the ODbL. Any image
 * you publish must credit "© OpenStreetMap contributors" — the renderer draws
 * that credit by default. See ATTRIBUTION.md.
 */

import { encodePng, type EncodePngOptions } from './image/png.js';
import { ResponseCache, type CacheOptions } from './net/cache-node.js';
import type { PlaceQuery } from './net/nominatim.js';
import { renderCityScene, type PipelineOptions, type PipelineResult } from './pipeline.js';
import { OSM_ATTRIBUTION } from './scene/build.js';
import { PROJECT_URL, VERSION } from './version.js';

export interface IsoCityOptions extends Omit<PipelineOptions, 'cache'> {
  /** Disable or redirect the on-disk response cache. */
  cache?: CacheOptions | false;
  /** PNG encoding options. */
  png?: EncodePngOptions;
}

export interface IsoCityResult extends PipelineResult {
  /** Encoded PNG bytes, ready to write to disk. */
  png: Uint8Array;
  width: number;
  height: number;
  /** Credit line that must accompany the image if published. */
  attribution: string;
}

/**
 * Geocodes a place, fetches its map data, renders it, and encodes a PNG.
 *
 * This is the one-call entry point. The individual steps are exported too, so
 * you can cache a {@link Scene} and re-render it in several themes without
 * hitting the network again.
 */
export async function renderCity(
  query: PlaceQuery,
  options: IsoCityOptions = {},
): Promise<IsoCityResult> {
  // `cache` and `png` are this entry point's own concern; everything else is
  // passed through to the shared pipeline untouched.
  const { cache: cacheOption, png: pngOptions, ...pipelineOptions } = options;
  const cache = cacheOption === false ? undefined : new ResponseCache(cacheOption ?? {});

  const result = await renderCityScene(query, {
    ...pipelineOptions,
    ...(cache ? { cache } : {}),
  });

  const png = encodePng(result.image.raster.data, result.image.width, result.image.height, {
    text: {
      Software: `iso-cities ${VERSION} (${PROJECT_URL})`,
      Source: OSM_ATTRIBUTION,
      Comment: `${result.place.displayName} — ${Math.round(Math.sqrt(result.areaM2))} m across`,
    },
    ...pngOptions,
  });

  return {
    ...result,
    png,
    width: result.image.width,
    height: result.image.height,
    attribution: OSM_ATTRIBUTION,
  };
}

// The pipeline, its options and its constants.
export {
  renderCityScene,
  clampRadius,
  bboxFromBounds,
  DEFAULT_RADIUS_METRES,
  MIN_RADIUS_METRES,
  MAX_RADIUS_METRES,
  LARGE_REGION_KM2,
  type PipelineOptions,
  type PipelineResult,
} from './pipeline.js';

// Re-exports so consumers can drive the pipeline step by step.
export { geocode, describeQuery, type PlaceQuery, type GeocodeOptions, GeocodeError } from './net/nominatim.js';
export {
  fetchOsmData,
  buildQuery,
  OVERPASS_MIRRORS,
  OverpassError,
  type OverpassOptions,
} from './net/overpass.js';
export { buildScene, OSM_ATTRIBUTION, type BuildSceneOptions } from './scene/build.js';
export { renderScene, DEFAULT_HIGHLIGHT_COLOR, type RenderOptions, type RenderedImage } from './render/render.js';
export { encodePng, type EncodePngOptions } from './image/png.js';
export { ResponseCache, defaultCacheDir, type CacheOptions } from './net/cache-node.js';
export { MemoryCache, cacheKey, type CacheLike } from './net/cache.js';
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
export { Raster, rasterizeMask, type ScreenPoint, type Shader } from './render/raster.js';
export { createProjector, layoutFor, squareExtent, type Projector } from './render/iso.js';
export {
  bboxAround,
  toLocal,
  toLatLon,
  haversine,
  type BBox,
  type LatLon,
  type Point,
} from './geo/project.js';
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
