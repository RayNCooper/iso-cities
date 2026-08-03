/**
 * Shape of the Overpass API JSON response, for the subset we request.
 *
 * Queries use `out geom;`, so ways and relation members carry their
 * coordinates inline and no separate node resolution pass is needed.
 */

export type OsmTags = Record<string, string>;

export interface OverpassLatLon {
  lat: number;
  lon: number;
}

export interface OverpassMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  geometry?: OverpassLatLon[];
  lat?: number;
  lon?: number;
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: OsmTags;
  lat?: number;
  lon?: number;
  geometry?: OverpassLatLon[];
  members?: OverpassMember[];
}

export interface OverpassResponse {
  version?: number;
  generator?: string;
  elements: OverpassElement[];
  remark?: string;
}

export function isOverpassResponse(value: unknown): value is OverpassResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { elements?: unknown }).elements)
  );
}
