import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryCache, cacheKey, envVar, DAY_MS } from '../src/net/cache.js';

test('cacheKey is deterministic and fixed width', () => {
  const key = cacheKey('overpass', 'some query');
  assert.equal(key, cacheKey('overpass', 'some query'));
  assert.equal(key.length, 32);
  assert.match(key, /^[0-9a-f]{32}$/);
});

test('cacheKey separates inputs that differ anywhere', () => {
  const keys = new Set([
    cacheKey('a'),
    cacheKey('b'),
    cacheKey('a', 'b'),
    cacheKey('ab'),
    cacheKey('overpass', 'query one'),
    cacheKey('overpass', 'query two'),
    cacheKey('nominatim', 'query one'),
    // A single character deep inside a long string must still change the key.
    cacheKey('x'.repeat(500) + 'a'),
    cacheKey('x'.repeat(500) + 'b'),
  ]);
  assert.equal(keys.size, 9, 'expected every input to produce a distinct key');
});

test('cacheKey handles non-ASCII without throwing or colliding', () => {
  assert.notEqual(cacheKey('Köln'), cacheKey('Koln'));
  assert.notEqual(cacheKey('東京'), cacheKey('Tokyo'));
  assert.match(cacheKey('Zürich'), /^[0-9a-f]{32}$/);
});

test('MemoryCache stores and returns values', async () => {
  const cache = new MemoryCache();
  assert.equal(await cache.get('missing'), null);

  await cache.set('a', 'value-a');
  assert.equal(await cache.get('a'), 'value-a');
  assert.equal(cache.size, 1);
});

test('MemoryCache expires entries past their age', async () => {
  let now = 1_000_000;
  const cache = new MemoryCache({ maxAgeMs: 1000, now: () => now });

  await cache.set('a', 'value-a');
  assert.equal(await cache.get('a'), 'value-a');

  now += 1500;
  assert.equal(await cache.get('a'), null, 'stale entries read as missing');
  assert.equal(cache.size, 0, 'and are dropped');
});

test('MemoryCache honours a per-call max age', async () => {
  let now = 0;
  const cache = new MemoryCache({ maxAgeMs: 30 * DAY_MS, now: () => now });
  await cache.set('a', 'value-a');

  now += 2 * DAY_MS;
  assert.equal(await cache.get('a', DAY_MS), null, 'a tighter limit wins');
  assert.equal(await cache.get('a', 7 * DAY_MS), 'value-a', 'a looser one still hits');
});

test('MemoryCache evicts the least recently used entry', async () => {
  const cache = new MemoryCache({ maxEntries: 3 });
  await cache.set('a', '1');
  await cache.set('b', '2');
  await cache.set('c', '3');

  // Touch 'a' so 'b' becomes the least recently used.
  await cache.get('a');
  await cache.set('d', '4');

  assert.equal(cache.size, 3);
  assert.equal(await cache.get('b'), null, 'b should have been evicted');
  assert.equal(await cache.get('a'), '1');
  assert.equal(await cache.get('c'), '3');
  assert.equal(await cache.get('d'), '4');
});

test('MemoryCache overwrites rather than duplicating a key', async () => {
  const cache = new MemoryCache();
  await cache.set('a', 'first');
  await cache.set('a', 'second');
  assert.equal(cache.size, 1);
  assert.equal(await cache.get('a'), 'second');
});

test('MemoryCache clears', async () => {
  const cache = new MemoryCache();
  await cache.set('a', '1');
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(await cache.get('a'), null);
});

test('envVar reads the environment where there is one', () => {
  process.env['ISO_CITIES_TEST_VALUE'] = 'present';
  assert.equal(envVar('ISO_CITIES_TEST_VALUE'), 'present');
  assert.equal(envVar('ISO_CITIES_DEFINITELY_UNSET'), undefined);
  delete process.env['ISO_CITIES_TEST_VALUE'];
});
