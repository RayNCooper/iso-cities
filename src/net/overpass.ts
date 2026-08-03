/**
 * Map data via the Overpass API.
 *
 * The query asks for geometry inline (`out geom`), so ways and relation
 * members arrive with their coordinates already attached and no second pass is
 * needed to resolve node references.
 */

import { ResponseCache, cacheKey, DAY_MS } from './cache.js';
import { request, HttpError } from './http.js';
import { formatBBox, type BBox } from '../geo/project.js';
import { isOverpassResponse, type OverpassResponse } from '../osm/types.js';

/** Tried in order; a mirror having a bad day should not break a render. */
export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export interface OverpassOptions {
  /** Overrides the mirror list with a single endpoint. */
  url?: string;
  urls?: string[];
  userAgent?: string;
  timeoutMs?: number;
  cache?: ResponseCache;
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
 * Builds the Overpass QL query for one bounding box.
 *
 * `timeout` is in seconds and `maxsize` in bytes; both are set generously
 * because dense city centres genuinely need the room.
 */
export function buildQuery(bbox: BBox, options: { timeoutSeconds?: number; maxSize?: number } = {}): string {
  const box = formatBBox(bbox);
  const timeout = options.timeoutSeconds ?? 120;
  const maxSize = options.maxSize ?? 536_870_912;

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
        // A single mirror gets one retry; the mirror loop provides the rest.
        retries: 1,
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

      onProgress?.(`Received ${parsed.elements.length} map elements`);
      await cache?.set(key, body);
      return parsed;
    } catch (error) {
      if (signal?.aborted) throw error;
      const host = new URL(endpoint).host;
      failures.push(`${host}: ${errorText(error)}`);
      if (i === endpoints.length - 1) {
        throw new OverpassError(
          `Could not fetch map data. Tried ${endpoints.length} endpoint(s):\n  ` +
            failures.join('\n  ') +
            '\nIf this persists, the area may be too large — try a smaller --radius.',
        );
      }
    }
  }

  throw new OverpassError('No Overpass endpoints configured.');
}

function envMirrors(): string[] | null {
  const value = process.env['ISO_CITIES_OVERPASS_URL'];
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
