import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { main, slugify } from '../src/cli.js';
import { clampRadius, DEFAULT_RADIUS_METRES, MAX_RADIUS_METRES, MIN_RADIUS_METRES } from '../src/index.js';
import { VERSION } from '../src/version.js';
import { buildQuery, OVERPASS_MIRRORS } from '../src/net/overpass.js';
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
  const result = await run(['Berlin', '--theme', 'sepia']);
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

test('--region and --highlight appear in the help', async () => {
  const help = await run(['--help']);
  assert.match(help.stdout, /--region/);
  assert.match(help.stdout, /--highlight <addr>/);
  assert.match(help.stdout, /--no-desaturate/);
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

test('several Overpass mirrors are configured', () => {
  assert.ok(OVERPASS_MIRRORS.length >= 2);
  for (const url of OVERPASS_MIRRORS) {
    assert.doesNotThrow(() => new URL(url));
  }
});

test('describeQuery renders each query shape', () => {
  assert.equal(describeQuery({ q: 'Berlin' }), 'Berlin');
  assert.equal(describeQuery({ postcode: '10115', country: 'DE' }), '10115, DE');
  assert.equal(describeQuery({ lat: 52.52, lon: 13.405 }), '52.52000, 13.40500');
});
