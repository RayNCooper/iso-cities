/**
 * Browser entry point.
 *
 * The renderer core never touched Node in the first place — only PNG encoding,
 * the disk cache and the CLI did. So the web build needs no bundler, no
 * polyfills and no shims: it drops the disk cache for an in-memory one, and
 * hands back the raw RGBA buffer, which is exactly what `ImageData` wants.
 *
 * ```js
 * import { renderCityToImageData, MemoryCache } from 'iso-cities/browser';
 *
 * const cache = new MemoryCache();
 * const { imageData } = await renderCityToImageData({ q: 'Porto' }, { cache });
 * canvas.width = imageData.width;
 * canvas.height = imageData.height;
 * canvas.getContext('2d').putImageData(imageData, 0, 0);
 * ```
 *
 * Both Nominatim and Overpass send `Access-Control-Allow-Origin: *`, so this
 * runs entirely client-side with no proxy. Browsers forbid setting a custom
 * User-Agent, so identification falls to the Referer header your page sends —
 * see ATTRIBUTION.md before deploying this anywhere busy.
 */

import type { PlaceQuery } from './net/nominatim.js';
import { renderCityScene, type PipelineOptions, type PipelineResult } from './pipeline.js';

export interface BrowserRenderResult extends PipelineResult {
  /** Ready to hand to `CanvasRenderingContext2D.putImageData`. */
  imageData: ImageData;
}

/**
 * Runs the pipeline and returns an `ImageData` alongside the scene.
 *
 * No PNG encoding happens here — for a download, let the canvas do it with
 * `canvas.toBlob()`, which is both faster and smaller than shipping a deflate
 * implementation to the browser.
 */
export async function renderCityToImageData(
  query: PlaceQuery,
  options: PipelineOptions = {},
): Promise<BrowserRenderResult> {
  const result = await renderCityScene(query, options);
  const { raster, width, height } = result.image;
  // The raster is already RGBA in exactly ImageData's layout, so this is a
  // straight memcpy. Allocating through ImageData rather than casting the
  // raster's buffer keeps it honest about ArrayBuffer vs SharedArrayBuffer.
  const imageData = new ImageData(width, height);
  imageData.data.set(raster.data);
  return { ...result, imageData };
}

export { renderCityScene, clampRadius, DEFAULT_RADIUS_METRES, MIN_RADIUS_METRES, MAX_RADIUS_METRES, LARGE_REGION_KM2 } from './pipeline.js';
export type { PipelineOptions, PipelineResult } from './pipeline.js';
export { MemoryCache, cacheKey, type CacheLike } from './net/cache.js';
export { geocode, describeQuery, GeocodeError, type PlaceQuery, type GeocodeOptions } from './net/nominatim.js';
export { fetchOsmData, buildQuery, OVERPASS_MIRRORS, OverpassError, type OverpassOptions } from './net/overpass.js';
export { buildScene, OSM_ATTRIBUTION, type BuildSceneOptions } from './scene/build.js';
export { renderScene, DEFAULT_HIGHLIGHT_COLOR, type RenderOptions, type RenderedImage } from './render/render.js';
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
export {
  drawText,
  measureText,
  glyphCoverage,
  GLYPH_WIDTH,
  GLYPH_HEIGHT,
  ASCENDER_ROWS,
  type TextOptions,
} from './render/font.js';
export { hex, toHex, mix, shade, lighten, darken, luminance, type RGB } from './render/color.js';

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
