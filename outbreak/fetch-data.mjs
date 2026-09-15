#!/usr/bin/env node
/**
 * Freezes everything the outbreak simulation needs from the outside world:
 *
 *   - The outlines of the three Regierungsbezirke that make up the Rheinland
 *     and the Ruhr: Düsseldorf and Köln (the Rheinland) and Arnsberg (the
 *     Ruhr and the Sauerland). Testing a unit's centroid against these real
 *     polygons is what keeps Belgium, the Netherlands, Hessen and
 *     Rheinland-Pfalz out of a bbox that unavoidably straddles them.
 *   - Every Kreis and kreisfreie Stadt inside it (admin_level=6) with full
 *     geometry.
 *   - Every Gemeinde inside it (admin_level=8), used as the sub-unit a Kreis's
 *     outbreak is distributed over.
 *   - Population for each unit from Wikidata's P1082, the latest statement per
 *     unit (populations fall as well as rise, so "the largest" is wrong).
 *
 * All three Overpass answers are cached to disk, so re-running this is free.
 * Everything downstream reads `data/region.json` and never touches the network.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA = join(import.meta.dirname, 'data');
const USER_AGENT = 'iso-cities-outbreak/0.1 (https://github.com/RayNCooper/iso-cities)';

/** Tried in order. Verified live during recon; dead mirrors fail fast. */
const MIRRORS = [
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];

/**
 * The Rheinland and the Ruhr, as OSM relations. Together these three
 * Regierungsbezirke are the whole of the western Ruhr and the Rhineland:
 * Düsseldorf (Niederrhein, Wuppertal, Mönchengladbach), Köln (Köln, Bonn,
 * Aachen) and Arnsberg (Dortmund, Essen, Bochum and the Sauerland).
 */
const BEZIRKE = [
  { id: 63306, name: 'Regierungsbezirk Düsseldorf' },
  { id: 72022, name: 'Regierungsbezirk Köln' },
  { id: 73340, name: 'Regierungsbezirk Arnsberg' },
];

const log = (m) => process.stderr.write(`${m}\n`);

async function cached(name, produce) {
  const file = join(DATA, name);
  if (existsSync(file)) {
    log(`  ${name}: cached`);
    return JSON.parse(await readFile(file, 'utf8'));
  }
  const value = await produce();
  await writeFile(file, JSON.stringify(value));
  log(`  ${name}: ${(JSON.stringify(value).length / 1024 / 1024).toFixed(1)} MB`);
  return value;
}

/** One Overpass query, failed over across mirrors. */
async function overpass(label, query, timeoutSeconds = 300) {
  const failures = [];
  for (const endpoint of MIRRORS) {
    const host = new URL(endpoint).host;
    try {
      log(`  ${label}: asking ${host}`);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed.elements)) throw new Error('no elements array');
      if (parsed.remark && /timed out|out of memory/i.test(parsed.remark)) {
        throw new Error(parsed.remark);
      }
      log(`  ${label}: ${parsed.elements.length} elements from ${host}`);
      return parsed;
    } catch (error) {
      failures.push(`${host}: ${error.message}`);
    }
  }
  throw new Error(`${label} failed on every mirror:\n  ${failures.join('\n  ')}`);
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Relation members arrive as loose way fragments carrying their own
 * coordinates. Only outer members form the silhouette; inner members are
 * genuine holes (a Kreis wrapped around a kreisfreie Stadt, for instance), so
 * they are kept so point-in-polygon testing stays honest.
 */
function memberLines(element) {
  const outer = [];
  const inner = [];
  for (const member of element.members ?? []) {
    const line = (member.geometry ?? [])
      .filter(Boolean)
      .map((p) => [p.lon, p.lat]);
    if (line.length < 2) continue;
    if (member.role === 'inner') inner.push(line);
    else if (member.role === 'outer' || member.role === '') outer.push(line);
  }
  return { outer, inner };
}

/** Stitches way fragments into closed lon/lat rings. */
function assembleRings(fragments, toleranceDeg = 5e-6) {
  const pool = fragments.map((f) => f.slice());
  const rings = [];
  const near = (a, b) => Math.abs(a[0] - b[0]) <= toleranceDeg && Math.abs(a[1] - b[1]) <= toleranceDeg;
  while (pool.length > 0) {
    let current = pool.shift();
    let extended = true;
    while (extended) {
      extended = false;
      const head = current[0];
      const tail = current[current.length - 1];
      if (near(head, tail)) break;
      for (let i = 0; i < pool.length; i++) {
        const candidate = pool[i];
        const cHead = candidate[0];
        const cTail = candidate[candidate.length - 1];
        if (near(tail, cHead)) {
          current = current.concat(candidate.slice(1));
        } else if (near(tail, cTail)) {
          current = current.concat(candidate.slice().reverse().slice(1));
        } else if (near(head, cTail)) {
          current = candidate.slice(0, -1).concat(current);
        } else if (near(head, cHead)) {
          current = candidate.slice().reverse().slice(0, -1).concat(current);
        } else {
          continue;
        }
        pool.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (current.length >= 4) {
      const head = current[0];
      const tail = current[current.length - 1];
      if (near(head, tail)) current[current.length - 1] = head.slice();
      rings.push(current);
    }
  }
  return rings;
}

/** Shoelace area in square metres, on an equirectangular local frame. */
function ringAreaM2(ring) {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111320;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a[0] * kx * (b[1] * ky) - b[0] * kx * (a[1] * ky);
  }
  return Math.abs(sum / 2);
}

function ringCentroid(ring) {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111320;
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const cross = p[0] * kx * (q[1] * ky) - q[0] * kx * (p[1] * ky);
    a += cross;
    cx += (p[0] * kx + q[0] * kx) * cross;
    cy += (p[1] * ky + q[1] * ky) * cross;
  }
  if (Math.abs(a) < 1e-9) return [ring[0][0], ring[0][1]];
  return [cx / (3 * a) / kx, cy / (3 * a) / ky];
}

function pointInRing(ring, p) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** `south,west,north,east` for an Overpass bounding-box filter. */
function boundsOfRing(ring) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLat, minLon, maxLat, maxLon].map((n) => n.toFixed(4)).join(',');
}

/** Inside any outer ring, and outside that ring's holes. */
function pointInPolygons(polygons, p) {
  for (const { outer, inner } of polygons) {
    if (!pointInRing(outer, p)) continue;
    if (inner.some((ring) => pointInRing(ring, p))) continue;
    return true;
  }
  return false;
}

/**
 * Douglas–Peucker. At the ~6 m/pixel the video renders at, sub-decimetre
 * survey vertices are pure file size; a 25 m tolerance is an eighth of a pixel.
 */
function simplify(ring, toleranceM) {
  if (ring.length < 8) return ring;
  const lat0 = ring[1] !== undefined ? ring[0][1] : 51;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111320;
  const pts = ring.map((p) => [p[0] * kx, p[1] * ky]);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let maxDist = -1;
    let index = -1;
    const [ax, ay] = pts[first];
    const [bx, by] = pts[last];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    for (let i = first + 1; i < last; i++) {
      const [px, py] = pts[i];
      const dist =
        len < 1e-9
          ? Math.hypot(px - ax, py - ay)
          : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }
    if (maxDist > toleranceM && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out = [];
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i]);
  return out.length >= 4 ? out : ring;
}

function compact(polygons, toleranceM) {
  return polygons.map(({ outer, inner }) => ({
    outer: simplify(outer, toleranceM),
    inner: inner.map((ring) => simplify(ring, toleranceM)),
  }));
}

/** Area in km², holes subtracted. */
function polygonsAreaKm2(polygons) {
  let m2 = 0;
  for (const { outer, inner } of polygons) {
    m2 += ringAreaM2(outer);
    for (const ring of inner) m2 -= ringAreaM2(ring);
  }
  return m2 / 1e6;
}

/* -------------------------------------------------------------------------- */
/* Wikidata                                                                   */
/* -------------------------------------------------------------------------- */

const SPARQL = 'https://query.wikidata.org/sparql';

/**
 * Latest population per entity. P1082 is a statement with a point-in-time
 * qualifier; taking the maximum would report a city's 1970 peak or its
 * pre-merger size. Where no qualifier exists there is usually one value.
 */
async function populations(qids) {
  const out = new Map();
  const CHUNK = 220;
  for (let i = 0; i < qids.length; i += CHUNK) {
    const chunk = qids.slice(i, i + CHUNK);
    const query = `SELECT ?item ?pop ?t WHERE {
  VALUES ?item { ${chunk.map((q) => `wd:${q}`).join(' ')} }
  ?item p:P1082 ?st .
  ?st ps:P1082 ?pop .
  OPTIONAL { ?st pq:P585 ?t }
}`;
    // Wikidata rate-limits by IP and occasionally drops the connection
    // outright; a run that dies 600 entities in because of one bad minute is
    // not acceptable, so this backs off and retries.
    let json = null;
    let lastError = null;
    for (let attempt = 0; attempt < 5 && !json; attempt++) {
      if (attempt > 0) {
        log(`  wikidata: retry ${attempt} after ${lastError}`);
        await new Promise((r) => setTimeout(r, 4000 * attempt));
      }
      try {
        const response = await fetch(SPARQL, {
          method: 'POST',
          headers: {
            Accept: 'application/sparql-results+json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: new URLSearchParams({ query }).toString(),
          signal: AbortSignal.timeout(180_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        json = await response.json();
      } catch (error) {
        lastError = error.message;
      }
    }
    if (!json) throw new Error(`Wikidata unavailable after 5 attempts: ${lastError}`);

    for (const row of json.results.bindings) {
      const qid = row.item.value.split('/').pop();
      const pop = Number(row.pop.value);
      const time = row.t ? Date.parse(row.t.value) : Number.NEGATIVE_INFINITY;
      const best = out.get(qid);
      if (!best || time > best.time || (time === best.time && pop > best.pop)) {
        out.set(qid, { pop, time });
      }
    }
    log(`  wikidata: ${out.size} populations (${i + chunk.length}/${qids.length} asked)`);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Build                                                                      */
/* -------------------------------------------------------------------------- */

await mkdir(DATA, { recursive: true });

log('Fetching the Regierungsbezirke (Rheinland + Ruhr) …');

/**
 * Overpass answers a level-5 relation by expanding every descendant member —
 * tens of thousands of ways, and a reliable 504. Nominatim returns the same
 * relation's own outline in under a second, so the boundary comes from there.
 */
async function bezirkOutline(bezirk) {
  const url =
    `https://nominatim.openstreetmap.org/lookup?osm_ids=R${bezirk.id}` +
    `&format=jsonv2&polygon_geojson=1`;
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${bezirk.name}: HTTP ${response.status}`);
  const [match] = await response.json();
  if (!match?.geojson) throw new Error(`${bezirk.name}: no polygon`);
  const { type, coordinates } = match.geojson;
  const raw = type === 'Polygon' ? [coordinates] : coordinates;
  const polygons = raw.map(([outer, ...inner]) => ({
    outer: outer.map(([lon, lat]) => [lon, lat]),
    inner: inner.map((ring) => ring.map(([lon, lat]) => [lon, lat])),
  }));
  return polygons;
}

const rawBezirke = await cached('raw-bezirke.json', async () => {
  const out = {};
  for (const bezirk of BEZIRKE) {
    out[bezirk.id] = await bezirkOutline(bezirk);
    log(`  ${bezirk.name}: ${out[bezirk.id].length} polygon(s)`);
    await new Promise((r) => setTimeout(r, 1200));
  }
  return out;
});

/** The three Bezirke merged: containment is "inside any of them". */
const regionPolygons = BEZIRKE.flatMap((bezirk) => rawBezirke[bezirk.id]);
const regionOutline = compact(regionPolygons, 25);
log(
  `  Rheinland + Ruhr: ${regionOutline.length} polygon(s), ` +
    `${regionOutline.reduce((n, p) => n + p.outer.length, 0)} vertices, ` +
    `${polygonsAreaKm2(regionOutline).toFixed(0)} km²`,
);

const lons = regionOutline.flatMap((p) => p.outer.map((v) => v[0]));
const lats = regionOutline.flatMap((p) => p.outer.map((v) => v[1]));
const bbox = [
  Math.min(...lats) - 0.05,
  Math.min(...lons) - 0.05,
  Math.max(...lats) + 0.05,
  Math.max(...lons) + 0.05,
];
const bboxText = bbox.map((n) => n.toFixed(3)).join(',');
log(`  bbox: ${bboxText}`);

log('Fetching Kreise and kreisfreie Städte (admin_level=6) …');
const l6 = await cached('raw-l6.json', () =>
  overpass(
    'level 6',
    `[out:json][timeout:300];
rel["boundary"="administrative"]["admin_level"="6"](${bboxText});
out geom;`,
  ),
);

log('Fetching Gemeinden (admin_level=8) …');
const l8 = await cached('raw-l8.json', () =>
  overpass(
    'level 8',
    `[out:json][timeout:300];
rel["boundary"="administrative"]["admin_level"="8"](${bboxText});
out geom;`,
  ),
);

/** Turns an Overpass relation into a unit, or null when it is unusable. */
function toUnit(element, toleranceM) {
  if (!element.tags?.name) return null;
  const { outer, inner } = memberLines(element);
  const outerRings = assembleRings(outer);
  if (outerRings.length === 0) return null;
  const big = outerRings.sort((a, b) => ringAreaM2(b) - ringAreaM2(a))[0];
  const polygons = [{ outer: big, inner: assembleRings(inner) }];
  const center = ringCentroid(big);
  return {
    id: `r${element.id}`,
    name: element.tags.name,
    wikidata: element.tags.wikidata ?? null,
    polygons: compact(polygons, toleranceM),
    center,
    areaKm2: polygonsAreaKm2(polygons),
    insideRegion: pointInPolygons(regionOutline, center),
    /** The raw Overpass element, so a caller can cache what it parsed. */
    source: element,
  };
}

const level6 = l6.elements.map((e) => toUnit(e, 25)).filter(Boolean);
const level8 = l8.elements.map((e) => toUnit(e, 40)).filter(Boolean);
log(`  parsable: ${level6.length} Kreise, ${level8.length} Gemeinden`);

/** Only the units actually inside the Rheinland and the Ruhr. */
const region = level6.filter((u) => u.insideRegion);
const unitPolygons = region.map((unit) => unit.polygons[0]);
const communities = level8.filter(
  (u) => pointInPolygons(regionOutline, u.center) && pointInPolygons(unitPolygons, u.center),
);

/**
 * A kreisfreie Stadt is its own level-8 unit and so has no Gemeinde children;
 * a Kreis is a union of them. That distinction is structural, not a size
 * heuristic — Leverkusen covers 79 km² and is a city, Kreis Mettmann covers
 * 407 km² and is a district, and an area threshold gets one of them wrong.
 */
const kreisfreie = region.filter(
  (unit) => !communities.some((community) => pointInPolygons(unit.polygons, community.center)),
);
const kreise = region.filter((unit) => !kreisfreie.includes(unit));
log(
  `  in region: ${region.length} units — ${kreisfreie.length} kreisfreie Städte, ${kreise.length} Kreise, ` +
    `${communities.length} Gemeinden`,
);

/**
 * Stadtteile (admin_level=10) for the kreisfreien Städte. Without this layer
 * Mönchengladbach, Köln and Essen would each be a single compartment, which is
 * far too coarse for an outbreak that has to look like it is moving through a
 * city rather than teleporting between them.
 *
 * Two strategies, because neither works everywhere. `map_to_area` is exact and
 * is what most cities answer to; a handful (Dortmund, Oberhausen, Mülheim,
 * Hamm, Remscheid) return zero elements or fail outright that way, and for
 * those a bounding-box query around the city works. The bbox answer also
 * contains neighbouring cities' districts, so it is filtered by containment in
 * the city's own polygon before being kept.
 *
 * Checkpointed after each city: Overpass 504s arrive per query, and losing
 * thirty answered queries to one unlucky thirty-first is not acceptable on a
 * service that is already busy.
 */
log('Fetching Stadtteile for the kreisfreien Städte (admin_level=10) …');
const districtFile = join(DATA, 'raw-l10.json');
const districtSource = existsSync(districtFile)
  ? (log('  raw-l10.json: cached'), JSON.parse(await readFile(districtFile, 'utf8')))
  : {};

/**
 * Districts inside a city.
 *
 * The bounding box is tried first. `map_to_area` is the more elegant query,
 * but Overpass's area index is incomplete for exactly the cities that matter
 * most here: Dortmund answers it with 3 districts against the 41 its own
 * outline contains, and Hamm, Remscheid, Mülheim and Oberhausen come back
 * empty or fail outright. The bbox answer also contains neighbouring cities'
 * districts, so it is filtered to those whose centre lies inside the city
 * before being kept — which makes it exact, just less tidy.
 *
 * `map_to_area` is still the fallback, for a city whose outline happens to be
 * unusable as a box.
 */
async function fetchDistricts(city, label) {
  const osmId = Number(city.id.slice(1));
  const box = boundsOfRing(city.polygons[0].outer);
  const usable = (elements) =>
    elements
      .map((element) => toUnit(element, 30))
      .filter((unit) => unit && pointInPolygons([city.polygons[0]], unit.center))
      .map((unit) => unit.source);

  try {
    const answer = await overpass(
      `${label} ${city.name} (bbox)`,
      `[out:json][timeout:180];
rel["boundary"="administrative"]["admin_level"="10"](${box});
out geom;`,
      200,
    );
    const kept = usable(answer.elements);
    if (kept.length > 0) return kept;
  } catch {
    // Fall through to the area query.
  }

  const answer = await overpass(
    `${label} ${city.name} (area)`,
    `[out:json][timeout:180];
rel(${osmId});map_to_area->.a;
rel["boundary"="administrative"]["admin_level"="10"](area.a);
out geom;`,
    200,
  );
  return usable(answer.elements);
}

for (let pass = 0; pass < 3; pass++) {
  const missing = kreisfreie.filter((city) => !districtSource[city.id]?.length);
  if (missing.length === 0) break;
  if (pass > 0) log(`  retrying ${missing.length} cities (pass ${pass + 1}) …`);
  for (const [n, city] of missing.entries()) {
    try {
      districtSource[city.id] = await fetchDistricts(
        city,
        `[${n + 1}/${missing.length}]`,
      );
      await writeFile(districtFile, JSON.stringify(districtSource));
    } catch (error) {
      log(`    ${city.name}: ${error.message.split('\n')[0]} — will retry`);
    }
    await new Promise((r) => setTimeout(r, 1100));
  }
}

/** Stadtteile per kreisfreie Stadt, minus any that are not really in-region. */
const cityDistricts = new Map();
for (const [cityId, elements] of Object.entries(districtSource)) {
  cityDistricts.set(
    cityId,
    elements
      .map((e) => toUnit(e, 30))
      .filter((u) => u && pointInPolygons(regionOutline, u.center)),
  );
}
log(
  `  ${[...cityDistricts.values()].reduce((n, d) => n + d.length, 0)} Stadtteile ` +
    `across ${cityDistricts.size} cities`,
);

/** Each sub-unit belongs to the Kreis whose polygon contains its centre. */
function attachParents(children) {
  for (const child of children) {
    child.parent = null;
    for (const unit of region) {
      if (pointInPolygons(unit.polygons, child.center)) {
        child.parent = unit.id;
        break;
      }
    }
  }
}
attachParents(communities);
for (const children of cityDistricts.values()) attachParents(children);

function summarise(unit) {
  const pop = unit.wikidata ? pops.get(unit.wikidata) : null;
  return {
    id: unit.id,
    name: unit.name,
    wikidata: unit.wikidata,
    population: pop ? pop.pop : null,
    populationAsOf:
      pop && Number.isFinite(pop.time) ? new Date(pop.time).toISOString().slice(0, 10) : null,
    center: [Number(unit.center[0].toFixed(5)), Number(unit.center[1].toFixed(5))],
    areaKm2: Number(unit.areaKm2.toFixed(2)),
    outer: unit.polygons[0].outer.map(([lon, lat]) => [
      Number(lon.toFixed(5)),
      Number(lat.toFixed(5)),
    ]),
  };
}

const entityQids = new Set();
const collectQid = (unit) => {
  if (unit.wikidata) entityQids.add(unit.wikidata);
};
region.forEach(collectQid);
communities.forEach(collectQid);
for (const children of cityDistricts.values()) children.forEach(collectQid);
log(`Fetching populations for ${entityQids.size} entities …`);
const pops = await populations([...entityQids]);

const missing = region.filter((u) => !u.wikidata || !pops.get(u.wikidata));
log(`  Kreise without a population: ${missing.map((u) => u.name).join(', ') || 'none'}`);

/**
 * Gives every sub-unit a population.
 *
 * A Stadtteil or Gemeinde with its own Wikidata figure uses it. The rest — the
 * 22 kreisfreien Städte have no published per-Stadtteil figures at all, and a
 * handful of Gemeinden are missing P1082 — split whatever is left of the
 * parent's population in proportion to area.
 *
 * Area is the only proxy available. It puts slightly more people in a city's
 * outer green-belt districts than real densities would, but every Kreis total
 * stays exactly right, and the Kreis total is what the regional spread is
 * actually driven by.
 */
function withPopulations(children, parent) {
  const known = children.filter((c) => c.wikidata && pops.get(c.wikidata));
  const knownTotal = known.reduce((n, c) => n + pops.get(c.wikidata).pop, 0);
  const unknown = children.filter((c) => !known.includes(c));
  const unknownAreaKm2 = unknown.reduce((n, c) => n + c.areaKm2, 0);
  const remainder = Math.max(0, (parent.population ?? knownTotal) - knownTotal);
  const perKm2 = unknownAreaKm2 > 0 ? remainder / unknownAreaKm2 : 0;

  return children.map((child) => {
    const own = child.wikidata ? pops.get(child.wikidata) : null;
    return {
      ...summarise(child),
      parent: parent.id,
      population: own ? own.pop : Math.max(0, Math.round(child.areaKm2 * perKm2)),
      populationSource: own ? 'wikidata' : 'area-weighted',
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Road network                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The motorway/trunk/primary network, used twice: the outbreak travels along
 * it (a corridor costs its real-world length, not the straight-line distance),
 * and it is drawn on the map as the spine of the region.
 */
log('Preparing the road network …');
const rawRoads = await cached('raw-roads.json', () =>
  overpass(
    'roads',
    `[out:json][timeout:600];
way["highway"~"^(motorway|trunk|primary)$"](${bboxText});
out geom;`,
    700,
  ),
);

const roads = [];
for (const way of rawRoads.elements) {
  if (!way.geometry || way.geometry.length < 2) continue;
  const line = way.geometry.filter(Boolean).map((p) => [p.lon, p.lat]);
  const simplified = simplify(line, 150);
  // Clip by the midpoint: a segment is kept when its middle is in-region, which
  // drops the motorways that only enter the bbox on their way somewhere else.
  if (!pointInPolygons(regionOutline, simplified[Math.floor(simplified.length / 2)])) continue;
  roads.push({
    class: way.tags.highway,
    ref: way.tags.ref ?? null,
    line: simplified.map(([lon, lat]) => [Number(lon.toFixed(4)), Number(lat.toFixed(4))]),
  });
}
log(`  ${roads.length} road segments, ${roads.reduce((n, r) => n + r.line.length, 0)} vertices`);

/* -------------------------------------------------------------------------- */
/* Payload                                                                    */
/* -------------------------------------------------------------------------- */

const payload = {
  generated: new Date().toISOString(),
  attribution:
    'Boundaries and roads © OpenStreetMap contributors (ODbL). Populations from Wikidata P1082.',
  region: {
    name: 'Rheinland + Ruhr',
    bezirke: BEZIRKE.map((b) => b.name),
    areaKm2: Number(polygonsAreaKm2(regionOutline).toFixed(1)),
    outline: regionOutline.map((p) => ({
      outer: p.outer.map(([lon, lat]) => [Number(lon.toFixed(5)), Number(lat.toFixed(5))]),
    })),
  },
  seed: { name: 'Eicken', city: 'Mönchengladbach', osmId: 13150850 },
  roads,
  units: region.map((unit) => {
    const own = communities.filter((c) => c.parent === unit.id);
    const districts = (cityDistricts.get(unit.id) ?? []).filter((c) => c.parent === unit.id);
    // A kreisfreie Stadt is itself the level-8 unit, so its children are its
    // Stadtteile; everywhere else the Gemeinden are the finer layer.
    const children = (
      own.length > 0 ? withPopulations(own, { ...summarise(unit) }) : withPopulations(districts, { ...summarise(unit) })
    ).sort((a, b) => b.population - a.population);
    return {
      ...summarise(unit),
      childLevel: own.length > 0 ? 8 : 10,
      children,
      childPopulation: children.reduce((n, c) => n + c.population, 0),
    };
  }),
};

const json = JSON.stringify(payload);
await writeFile(join(DATA, 'region.json'), json);
const subUnits = payload.units.reduce((n, u) => n + u.children.length, 0);
const vertices = payload.units.reduce(
  (n, u) => n + u.outer.length + u.children.reduce((m, c) => m + c.outer.length, 0),
  0,
);
log(
  `Wrote data/region.json — ${(json.length / 1024 / 1024).toFixed(1)} MB, ` +
    `${payload.units.length} units, ${subUnits} sub-units, ` +
    `${vertices} boundary vertices, ${roads.length} roads`,
);
log(
  `  ${(payload.units.reduce((n, u) => n + (u.population ?? 0), 0) / 1e6).toFixed(2)}M people in units, ` +
    `${(payload.units.reduce((n, u) => n + u.childPopulation, 0) / 1e6).toFixed(2)}M across sub-units`,
);
