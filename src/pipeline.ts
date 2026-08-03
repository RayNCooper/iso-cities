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
import { bboxAround, toLatLon, toLocal, type BBox, type LatLon, type Point } from './geo/project.js';
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
   * An address to single out. Everything else is drawn in grey, and a pin is
   * placed on the building this resolves to.
   */
  highlight?: PlaceQuery;
  /** Overrides the label drawn for the highlight. Defaults to the query text. */
  highlightLabel?: string;
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
  if (options.highlight) {
    const target = await geocode(options.highlight, {
      ...options.geocode,
      ...(cache ? { cache } : {}),
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress } : {}),
    });
    const label = options.highlightLabel ?? describeQuery(options.highlight);
    highlight = { position: toLocal(place.centre, target.centre.lat, target.centre.lon), label };
    onProgress?.(
      `Highlighting ${label} at ${target.centre.lat.toFixed(5)}, ${target.centre.lon.toFixed(5)}`,
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
