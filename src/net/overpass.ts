/**
 * Map data via the Overpass API.
 *
 * The query asks for geometry inline (`out geom`), so ways and relation
 * members arrive with their coordinates already attached and no second pass is
 * needed to resolve node references.
 */

import { cacheKey, envVar, DAY_MS, type CacheLike } from './cache.js';
import { request, HttpError } from './http.js';
import { bboxAreaKm2, formatBBox, type BBox } from '../geo/project.js';
import { isOverpassResponse, type OverpassResponse } from '../osm/types.js';

/**
 * Tried in order; a mirror having a bad day should not break a render.
 *
 * These are separate backends of the overpass-api.de project, so failing over
 * spreads load inside that project rather than pushing it onto a smaller
 * volunteer instance. All answer CORS preflights, which the browser build
 * depends on.
 *
 * Two kinds of instance are deliberately absent, both because they fail in
 * ways that are worse than an error:
 *
 * - Ones that accept the connection and then never reply, burning the entire
 *   timeout before failover instead of erroring quickly.
 * - Region-limited ones, which answer 200 with zero elements for anywhere
 *   outside their extract. That renders as a blank image rather than a
 *   failure, which is the worst possible outcome.
 */
export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];

export interface OverpassOptions {
  /** Overrides the mirror list with a single endpoint. */
  url?: string;
  urls?: string[];
  userAgent?: string;
  timeoutMs?: number;
  cache?: CacheLike;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export class OverpassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverpassError';
  }
}

const LANDUSE_GREEN =
  'grass|forest|meadow|village_green|recreation_ground|allotments|orchard|vineyard|farmland|farmyard|cemetery|greenfield|flowerbed';
const LANDUSE_BUILT = 'residential|industrial|commercial|retail|railway|port|reservoir|basin';
const LEISURE_GREEN =
  'park|garden|playground|pitch|golf_course|recreation_ground|common|dog_park|nature_reserve';
const NATURAL_AREAS = 'water|wood|scrub|grassland|heath|sand|beach|shingle';
const RAILWAYS = 'rail|light_rail|subway|tram|narrow_gauge|monorail|funicular';

/**
 * Server-side limits, scaled to how much ground the query actually covers.
 *
 * Overpass hands out slots by requested memory. Asking for half a gigabyte to
 * draw four city blocks means waiting behind every other large job on a busy
 * instance, and that queue is where 504s come from — so a small query asks
 * for a small slot and gets served promptly.
 */
export function queryLimitsFor(areaKm2: number): { timeoutSeconds: number; maxSize: number } {
  const MB = 1024 * 1024;
  if (areaKm2 <= 2) return { timeoutSeconds: 60, maxSize: 32 * MB };
  if (areaKm2 <= 10) return { timeoutSeconds: 90, maxSize: 96 * MB };
  if (areaKm2 <= 50) return { timeoutSeconds: 150, maxSize: 256 * MB };
  return { timeoutSeconds: 240, maxSize: 512 * MB };
}

/**
 * Builds the Overpass QL query for one bounding box.
 *
 * `timeout` is in seconds and `maxsize` in bytes; both default to limits
 * derived from the area covered — see {@link queryLimitsFor}.
 */
export function buildQuery(bbox: BBox, options: { timeoutSeconds?: number; maxSize?: number } = {}): string {
  const box = formatBBox(bbox);
  const limits = queryLimitsFor(bboxAreaKm2(bbox));
  const timeout = options.timeoutSeconds ?? limits.timeoutSeconds;
  const maxSize = options.maxSize ?? limits.maxSize;

  return `[out:json][timeout:${timeout}][maxsize:${maxSize}];
(
  way["building"](${box});
  relation["building"]["type"="multipolygon"](${box});
  way["highway"](${box});
  way["railway"~"^(${RAILWAYS})$"](${box});
  way["natural"~"^(${NATURAL_AREAS})$"](${box});
  relation["natural"="water"]["type"="multipolygon"](${box});
  way["waterway"~"^(riverbank|dock)$"](${box});
  way["landuse"~"^(${LANDUSE_GREEN}|${LANDUSE_BUILT})$"](${box});
  relation["landuse"~"^(${LANDUSE_GREEN})$"]["type"="multipolygon"](${box});
  way["leisure"~"^(${LEISURE_GREEN})$"](${box});
  relation["leisure"~"^(${LEISURE_GREEN})$"]["type"="multipolygon"](${box});
  way["amenity"="parking"](${box});
  node["natural"="tree"](${box});
);
out geom;`;
}

export async function fetchOsmData(bbox: BBox, options: OverpassOptions = {}): Promise<OverpassResponse> {
  const { cache, onProgress, signal } = options;
  const query = buildQuery(bbox);

  const key = cacheKey('overpass', query);
  const hit = await cache?.get(key, 7 * DAY_MS);
  if (hit) {
    try {
      const parsed = JSON.parse(hit) as unknown;
      if (isOverpassResponse(parsed)) {
        onProgress?.(`Using cached map data (${parsed.elements.length} elements)`);
        return parsed;
      }
    } catch {
      // Fall through and refetch.
    }
  }

  const endpoints = options.url
    ? [options.url]
    : (options.urls ?? envMirrors() ?? OVERPASS_MIRRORS);

  const failures: string[] = [];
  /**
   * An empty answer we are not yet willing to trust. A region-limited instance
   * reports 200 with zero elements outside its extract, which would render as
   * a blank image — so an empty result is treated as suspicious and another
   * mirror is asked. If they all agree the area is empty, it really is.
   */
  let emptyBody: string | null = null;
  let emptyResult: OverpassResponse | null = null;

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i]!;
    try {
      onProgress?.(
        endpoints.length > 1 && i > 0
          ? `Retrying with mirror ${new URL(endpoint).host}`
          : `Fetching map data from ${new URL(endpoint).host}`,
      );

      const requestOptions: Parameters<typeof request>[1] = {
        method: 'POST',
        body: new URLSearchParams({ data: query }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        // One attempt per mirror: the mirror list is the redundancy. Retrying
        // an instance that just returned 504 mostly means waiting for the same
        // overloaded queue twice, when a sibling backend is free right now.
        retries: 0,
      };
      if (options.userAgent) requestOptions.userAgent = options.userAgent;
      if (options.timeoutMs !== undefined) requestOptions.timeoutMs = options.timeoutMs;
      if (signal) requestOptions.signal = signal;

      const body = await request(endpoint, requestOptions);
      const parsed = JSON.parse(body) as unknown;

      if (!isOverpassResponse(parsed)) {
        throw new OverpassError('Response did not contain an elements array.');
      }
      if (parsed.remark && /timed out|out of memory|runtime error/i.test(parsed.remark)) {
        throw new OverpassError(`Overpass reported: ${parsed.remark}`);
      }

      if (parsed.elements.length === 0 && i < endpoints.length - 1) {
        const host = new URL(endpoint).host;
        onProgress?.(`${host} returned no data for this area; checking another mirror`);
        failures.push(`${host}: returned 0 elements`);
        emptyBody = body;
        emptyResult = parsed;
        continue;
      }

      onProgress?.(`Received ${parsed.elements.length} map elements`);
      await cache?.set(key, body);
      return parsed;
    } catch (error) {
      if (signal?.aborted) throw error;
      const host = new URL(endpoint).host;
      failures.push(`${host}: ${errorText(error)}`);
      if (i === endpoints.length - 1) {
        // Every mirror agreed there is nothing here, so believe them.
        if (emptyResult && emptyBody) {
          onProgress?.('No map data in this area on any mirror');
          await cache?.set(key, emptyBody);
          return emptyResult;
        }
        // 504 means the public instances are busy, not that the query is
        // wrong — saying "try a smaller area" there sends people chasing the
        // wrong fix.
        const allBusy = failures.every((f) => /50[34]|rate limited/.test(f));
        const advice = allBusy
          ? '\nEvery instance is busy right now. This is usually transient — ' +
            'wait a minute and try again. Large areas make it far more likely.'
          : '\nIf this persists, the area may be too large — try a smaller radius.';
        throw new OverpassError(
          `Could not fetch map data. Tried ${endpoints.length} endpoint(s):\n  ` +
            failures.join('\n  ') +
            advice,
        );
      }
    }
  }

  throw new OverpassError('No Overpass endpoints configured.');
}

function envMirrors(): string[] | null {
  const value = envVar('ISO_CITIES_OVERPASS_URL');
  if (!value) return null;
  const list = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

function errorText(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 429) return 'rate limited (429)';
    if (error.status === 504) return 'gateway timeout (504) — area may be too large';
    return `HTTP ${error.status}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
