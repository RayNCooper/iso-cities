import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { main, slugify } from '../src/cli.js';
import { clampRadius, DEFAULT_RADIUS_METRES, MAX_RADIUS_METRES, MIN_RADIUS_METRES } from '../src/index.js';
import { VERSION } from '../src/version.js';
import { buildQuery, queryLimitsFor, OVERPASS_MIRRORS } from '../src/net/overpass.js';
import { bboxAreaKm2 } from '../src/geo/project.js';
import { describeQuery } from '../src/net/nominatim.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/** Runs the CLI with stdout/stderr captured, so tests stay quiet. */
async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;

  try {
    const code = await main(args);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test('VERSION matches package.json', async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
  assert.equal(
    VERSION,
    pkg.version,
    'src/version.ts drifted from package.json — update both when releasing',
  );
});

test('--help and --version succeed', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /USAGE/);
  assert.match(help.stdout, /--postcode/);

  const version = await run(['--version']);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), VERSION);
});

test('--themes lists every theme', async () => {
  const result = await run(['--themes']);
  assert.equal(result.code, 0);
  for (const name of ['daylight', 'dusk', 'night', 'noir', 'gameboy', 'candy']) {
    assert.match(result.stdout, new RegExp(name));
  }
});

test('a bare postcode is rejected as ambiguous', async () => {
  const result = await run(['--postcode', '10115']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /ambiguous/);
  assert.match(result.stderr, /--country/);
});

test('no place at all is rejected', async () => {
  const result = await run([]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /No place given/);
});

test('--lat without --lon is rejected', async () => {
  const result = await run(['--lat', '52.5']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /must be given together/);
});

test('non-numeric coordinates are rejected', async () => {
  const result = await run(['--lat', 'north', '--lon', '13']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /must be numbers/);
});

test('an unknown theme is rejected before any network call', async () => {
  const result = await run(['Berlin', '--theme', 'definitely-not-a-theme']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown theme/);
});

test('an unknown flag is rejected with usage guidance', async () => {
  const result = await run(['Berlin', '--nope']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--help/);
});

test('--highlight-lat without --highlight-lon is rejected', async () => {
  const result = await run(['Berlin', '--highlight-lat', '52.5']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /must be given together/);
});

test('non-numeric highlight coordinates are rejected', async () => {
  const result = await run(['Berlin', '--highlight-lat', 'here', '--highlight-lon', '13']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /must be numbers/);
});

test('an empty --highlight is rejected', async () => {
  const result = await run(['Berlin', '--highlight', '   ']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /needs an address/);
});

test('highlight styling flags without a highlight are rejected', async () => {
  const result = await run(['Berlin', '--highlight-color', '#ff0000']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /need --highlight/);
});

test('--center-on-highlight without a highlight is rejected', async () => {
  const result = await run(['Berlin', '--center-on-highlight']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /needs --highlight/);
});

test('both spellings of --cent(er|re)-on-highlight are accepted', async () => {
  for (const flag of ['--center-on-highlight', '--centre-on-highlight']) {
    const result = await run(['Berlin', flag]);
    // Reaches the highlight validation rather than "unknown option".
    assert.equal(result.code, 2, `${flag} should parse`);
    assert.match(result.stderr, /needs --highlight/, `${flag} should be a known flag`);
  }
});

test('--region and --highlight appear in the help', async () => {
  const help = await run(['--help']);
  assert.match(help.stdout, /--region/);
  assert.match(help.stdout, /--highlight <addr>/);
  assert.match(help.stdout, /--desaturate/);
});

test('slugify produces safe, readable filenames', () => {
  assert.equal(slugify('Berlin'), 'berlin');
  assert.equal(slugify('10115 Berlin'), '10115-berlin');
  assert.equal(slugify('Köln'), 'koln');
  assert.equal(slugify('São Paulo'), 'sao-paulo');
  assert.equal(slugify("St. John's"), 'st-john-s');
  assert.equal(slugify('東京'), 'city', 'unrenderable names still yield a filename');
  assert.equal(slugify('   '), 'city');
  assert.ok(slugify('x'.repeat(200)).length <= 60);
});

test('clampRadius keeps the radius in range', () => {
  assert.equal(clampRadius(400), 400);
  assert.equal(clampRadius(1), MIN_RADIUS_METRES);
  assert.equal(clampRadius(1_000_000), MAX_RADIUS_METRES);
  assert.equal(clampRadius(Number.NaN), DEFAULT_RADIUS_METRES);
  assert.equal(clampRadius(400.4), 400);
});

test('the Overpass query covers the feature classes the renderer draws', () => {
  const query = buildQuery({ south: 0, west: 0, north: 1, east: 1 });
  for (const fragment of ['"building"', '"highway"', '"railway"', '"natural"', '"landuse"', '"leisure"']) {
    assert.ok(query.includes(fragment), `query is missing ${fragment}`);
  }
  assert.match(query, /\[out:json\]/);
  assert.match(query, /out geom;$/);
  // Bounding boxes are south,west,north,east.
  assert.ok(query.includes('0.0000000,0.0000000,1.0000000,1.0000000'));
});

test('several Overpass mirrors are configured, over distinct hosts', () => {
  assert.ok(OVERPASS_MIRRORS.length >= 2);
  const hosts = new Set<string>();
  for (const url of OVERPASS_MIRRORS) {
    assert.doesNotThrow(() => new URL(url), `${url} is not a valid URL`);
    const { protocol, host } = new URL(url);
    assert.equal(protocol, 'https:', `${url} must be https`);
    hosts.add(host);
  }
  // Failover is pointless if two entries resolve to the same host.
  assert.equal(hosts.size, OVERPASS_MIRRORS.length, 'mirror hosts must be distinct');
});

test('mirrors that fail badly are kept out of the list', () => {
  // Two failure modes that are worse than an error, both observed in the wild:
  // instances that accept the connection and never reply (burning the whole
  // timeout before failover), and region-limited extracts that answer 200 with
  // zero elements outside their coverage (rendering as a blank image).
  const unresponsive = ['overpass.kumi.systems', 'overpass.private.coffee', 'overpass.monicz.dev'];
  const regionLimited = ['overpass.osm.ch'];

  for (const url of OVERPASS_MIRRORS) {
    const { host } = new URL(url);
    assert.ok(!unresponsive.includes(host), `${host} hangs instead of failing; not a usable mirror`);
    assert.ok(!regionLimited.includes(host), `${host} is a regional extract, not planet-wide`);
  }
});

test('query limits scale with the area covered', () => {
  const small = queryLimitsFor(1);
  const medium = queryLimitsFor(8);
  const large = queryLimitsFor(40);
  const huge = queryLimitsFor(500);

  for (const [a, b] of [
    [small, medium],
    [medium, large],
    [large, huge],
  ] as const) {
    assert.ok(b.maxSize > a.maxSize, 'maxsize must grow with area');
    assert.ok(b.timeoutSeconds > a.timeoutSeconds, 'timeout must grow with area');
  }

  // A neighbourhood must not ask a busy server for a half-gigabyte slot.
  assert.ok(small.maxSize <= 64 * 1024 * 1024, `small query asked for ${small.maxSize} bytes`);
  assert.equal(huge.maxSize, 512 * 1024 * 1024);
});

test('a small bbox produces a modest Overpass request', () => {
  // Roughly 800 m square — the CLI default.
  const query = buildQuery({ south: 51.0, west: 3.72, north: 51.0072, east: 3.7314 });
  const maxsize = Number(/maxsize:(\d+)/.exec(query)?.[1]);
  const timeout = Number(/timeout:(\d+)/.exec(query)?.[1]);
  assert.ok(maxsize <= 64 * 1024 * 1024, `asked for ${maxsize} bytes for a neighbourhood`);
  assert.ok(timeout <= 90, `asked for ${timeout}s for a neighbourhood`);
});

test('a large bbox still gets the headroom it needs', () => {
  // Roughly 170 km², the scale of a whole municipality.
  const query = buildQuery({ south: 51.08, west: 6.29, north: 51.25, east: 6.54 });
  const maxsize = Number(/maxsize:(\d+)/.exec(query)?.[1]);
  assert.equal(maxsize, 512 * 1024 * 1024);
});

test('bboxAreaKm2 measures a known box', () => {
  // One degree of latitude is ~111.32 km; at the equator so is one of longitude.
  const area = bboxAreaKm2({ south: 0, west: 0, north: 1, east: 1 });
  assert.ok(Math.abs(area - 111.32 * 111.32) / area < 0.01, `got ${area} km²`);
  // The same box near the pole covers far less ground.
  assert.ok(bboxAreaKm2({ south: 60, west: 0, north: 61, east: 1 }) < area / 1.5);
});

test('describeQuery renders each query shape', () => {
  assert.equal(describeQuery({ q: 'Berlin' }), 'Berlin');
  assert.equal(describeQuery({ postcode: '10115', country: 'DE' }), '10115, DE');
  assert.equal(describeQuery({ lat: 52.52, lon: 13.405 }), '52.52000, 13.40500');
});
