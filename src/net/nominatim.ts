/**
 * Geocoding via Nominatim.
 *
 * Supports free-form queries ("Kreuzberg, Berlin"), structured queries
 * (postcode + country), and raw coordinates. Structured queries are preferred
 * for postcodes because free-form search often resolves a bare postcode to the
 * wrong country.
 */

import { ResponseCache, cacheKey, DAY_MS } from './cache.js';
import { request } from './http.js';
import type { Place } from '../types.js';

export const DEFAULT_NOMINATIM_URL = 'https://nominatim.openstreetmap.org';

export interface PlaceQuery {
  /** Free-form search string. Mutually exclusive with the structured fields. */
  q?: string;
  city?: string;
  postcode?: string;
  county?: string;
  state?: string;
  /** Country name or ISO 3166-1 alpha-2 code. */
  country?: string;
  /** Explicit coordinates, which skip forward geocoding entirely. */
  lat?: number;
  lon?: number;
  /** Overrides the label drawn on the image. */
  name?: string;
}

export interface GeocodeOptions {
  url?: string;
  userAgent?: string;
  timeoutMs?: number;
  cache?: ResponseCache;
  signal?: AbortSignal;
  /** Preferred language for returned names, e.g. `en` or `de`. */
  language?: string;
  onProgress?: (message: string) => void;
}

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  hamlet?: string;
  suburb?: string;
  neighbourhood?: string;
  city_district?: string;
  borough?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
  road?: string;
}

interface NominatimResult {
  place_id?: number;
  osm_type?: string;
  osm_id?: number;
  lat: string;
  lon: string;
  category?: string;
  type?: string;
  addresstype?: string;
  name?: string;
  display_name?: string;
  address?: NominatimAddress;
}

export class GeocodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeocodeError';
  }
}

function hasStructuredFields(query: PlaceQuery): boolean {
  return Boolean(query.city || query.postcode || query.county || query.state || query.country);
}

export function describeQuery(query: PlaceQuery): string {
  if (query.lat !== undefined && query.lon !== undefined) {
    return `${query.lat.toFixed(5)}, ${query.lon.toFixed(5)}`;
  }
  if (query.q) return query.q;
  const parts = [query.postcode, query.city, query.county, query.state, query.country].filter(
    (p): p is string => Boolean(p),
  );
  return parts.join(', ');
}

/** Builds a compact human label, e.g. `10115 Berlin` or `Porto`. */
function labelFor(result: NominatimResult, query: PlaceQuery): string {
  if (query.name) return query.name;
  const address = result.address ?? {};
  const settlement =
    address.city ??
    address.town ??
    address.village ??
    address.municipality ??
    address.hamlet ??
    address.suburb ??
    address.city_district ??
    address.borough ??
    address.county;

  // A postcode query should show the postcode; anything else reads oddly.
  const isPostcode = result.type === 'postcode' || result.addresstype === 'postcode' || Boolean(query.postcode);
  const postcode = query.postcode ?? address.postcode;

  if (isPostcode && postcode) {
    return settlement ? `${postcode} ${settlement}` : postcode;
  }
  if (result.name && result.name.length > 0) return result.name;
  if (settlement) return settlement;
  return (result.display_name ?? 'Unknown').split(',')[0]!.trim();
}

export async function geocode(query: PlaceQuery, options: GeocodeOptions = {}): Promise<Place> {
  const {
    url = process.env['ISO_CITIES_NOMINATIM_URL'] ?? DEFAULT_NOMINATIM_URL,
    language = 'en',
    cache,
    signal,
    onProgress,
  } = options;

  if (query.lat !== undefined && query.lon !== undefined) {
    if (!Number.isFinite(query.lat) || Math.abs(query.lat) > 90) {
      throw new GeocodeError(`Latitude out of range: ${query.lat}`);
    }
    if (!Number.isFinite(query.lon) || Math.abs(query.lon) > 180) {
      throw new GeocodeError(`Longitude out of range: ${query.lon}`);
    }
    return reverseGeocode({ lat: query.lat, lon: query.lon }, query, options);
  }

  if (!query.q && !hasStructuredFields(query)) {
    throw new GeocodeError(
      'Nothing to geocode: provide a place name, a postcode with a country, or --lat/--lon.',
    );
  }

  const params = new URLSearchParams({
    format: 'jsonv2',
    limit: '1',
    addressdetails: '1',
    'accept-language': language,
  });

  if (query.q && !hasStructuredFields(query)) {
    params.set('q', query.q);
  } else {
    // Nominatim rejects `q` combined with structured parameters.
    if (query.q) params.set('city', query.q);
    if (query.city) params.set('city', query.city);
    if (query.postcode) params.set('postalcode', query.postcode);
    if (query.county) params.set('county', query.county);
    if (query.state) params.set('state', query.state);
    if (query.country) params.set('country', query.country);
  }

  const endpoint = `${url.replace(/\/$/, '')}/search?${params.toString()}`;
  onProgress?.(`Geocoding ${describeQuery(query)}`);
  const body = await cachedRequest(endpoint, cache, 30 * DAY_MS, options);

  let results: NominatimResult[];
  try {
    results = JSON.parse(body) as NominatimResult[];
  } catch {
    throw new GeocodeError(`Geocoder returned malformed JSON for "${describeQuery(query)}".`);
  }

  const first = Array.isArray(results) ? results[0] : undefined;
  if (!first) {
    throw new GeocodeError(
      `No match for "${describeQuery(query)}". Try adding a country, ` +
        'or pass explicit coordinates with --lat/--lon.',
    );
  }

  return toPlace(first, query);
}

async function reverseGeocode(
  point: { lat: number; lon: number },
  query: PlaceQuery,
  options: GeocodeOptions,
): Promise<Place> {
  const {
    url = process.env['ISO_CITIES_NOMINATIM_URL'] ?? DEFAULT_NOMINATIM_URL,
    language = 'en',
    cache,
    onProgress,
  } = options;

  const fallback: Place = {
    name: query.name ?? `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`,
    displayName: `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`,
    centre: point,
  };

  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: String(point.lat),
    lon: String(point.lon),
    zoom: '14',
    addressdetails: '1',
    'accept-language': language,
  });
  const endpoint = `${url.replace(/\/$/, '')}/reverse?${params.toString()}`;

  try {
    onProgress?.(`Looking up ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`);
    const body = await cachedRequest(endpoint, cache, 30 * DAY_MS, options);
    const result = JSON.parse(body) as NominatimResult;
    if (!result || !result.display_name) return fallback;
    // Keep the caller's exact coordinates; only borrow the naming.
    const place = toPlace(result, query);
    return { ...place, centre: point };
  } catch {
    // A failed reverse lookup only costs us a nice label.
    return fallback;
  }
}

function toPlace(result: NominatimResult, query: PlaceQuery): Place {
  const lat = Number(result.lat);
  const lon = Number(result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new GeocodeError('Geocoder returned a result without usable coordinates.');
  }
  const place: Place = {
    name: labelFor(result, query),
    displayName: result.display_name ?? labelFor(result, query),
    centre: { lat, lon },
  };
  if (result.osm_type) place.osmType = result.osm_type;
  if (result.osm_id !== undefined) place.osmId = result.osm_id;
  if (result.category) place.category = result.category;
  if (result.type) place.type = result.type;
  const code = result.address?.country_code;
  if (code) place.countryCode = code.toUpperCase();
  return place;
}

async function cachedRequest(
  endpoint: string,
  cache: ResponseCache | undefined,
  maxAgeMs: number,
  options: GeocodeOptions,
): Promise<string> {
  const key = cacheKey('nominatim', endpoint);
  const hit = await cache?.get(key, maxAgeMs);
  if (hit !== null && hit !== undefined) return hit;

  const requestOptions: Parameters<typeof request>[1] = {};
  if (options.userAgent) requestOptions.userAgent = options.userAgent;
  if (options.timeoutMs !== undefined) requestOptions.timeoutMs = options.timeoutMs;
  if (options.signal) requestOptions.signal = options.signal;

  const body = await request(endpoint, requestOptions);
  await cache?.set(key, body);
  return body;
}
