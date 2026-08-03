import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ADDRESS_MIN_PLACE_RANK,
  AUTO_REGION_MAX_KM2,
  REGION_MAX_PLACE_RANK,
  placeScale,
} from '../src/pipeline.js';
import { bboxAreaKm2 } from '../src/geo/project.js';
import type { Place } from '../src/types.js';

function place(placeRank?: number): Place {
  const p: Place = {
    name: 'Somewhere',
    displayName: 'Somewhere',
    centre: { lat: 52, lon: 13 },
  };
  if (placeRank !== undefined) p.placeRank = placeRank;
  return p;
}

test('anything bigger than a city reads as a region', () => {
  // Nominatim ranks: 2 continent, 4 country, 8 state, 10 region, 12 county.
  for (const rank of [2, 4, 8, 10, 12]) {
    assert.equal(placeScale(place(rank)), 'region', `rank ${rank} should be a region`);
  }
});

test('cities, towns and districts read as settlements', () => {
  // 14 municipality, 16 city, 17 town, 18 village, 19 suburb, 20 neighbourhood.
  for (const rank of [14, 16, 17, 18, 19, 20, 22]) {
    assert.equal(placeScale(place(rank)), 'settlement', `rank ${rank} should be a settlement`);
  }
});

test('streets sit with settlements, single buildings do not', () => {
  // A street is not one building, so highlighting it would pick an arbitrary
  // neighbour; it gets a plain centred view instead.
  assert.equal(placeScale(place(26)), 'settlement');
  assert.equal(placeScale(place(30)), 'address');
});

test('addresses and POIs read as addresses', () => {
  for (const rank of [ADDRESS_MIN_PLACE_RANK, 29, 30]) {
    assert.equal(placeScale(place(rank)), 'address', `rank ${rank} should be an address`);
  }
});

test('a match with no rank falls back to the least surprising case', () => {
  assert.equal(placeScale(place(undefined)), 'settlement');
});

test('the rank thresholds do not overlap', () => {
  assert.ok(
    REGION_MAX_PLACE_RANK < ADDRESS_MIN_PLACE_RANK,
    'a rank cannot be both a region and an address',
  );
  // Every rank in between must land on exactly one scale.
  for (let rank = 0; rank <= 30; rank++) {
    const scale = placeScale(place(rank));
    assert.ok(['region', 'settlement', 'address'].includes(scale), `rank ${rank} -> ${scale}`);
  }
});

test('the auto-region cap sits between a district and a county', () => {
  // Real districts must fit; real counties must not.
  const postcodeDistrict = bboxAreaKm2({ south: 51.2, west: 6.42, north: 51.23, east: 6.47 });
  assert.ok(
    postcodeDistrict < AUTO_REGION_MAX_KM2,
    `a postcode district (${postcodeDistrict.toFixed(0)} km²) must be drawable as a region`,
  );

  // North Rhine-Westphalia, roughly.
  const state = bboxAreaKm2({ south: 50.3, west: 5.8, north: 52.6, east: 9.5 });
  assert.ok(
    state > AUTO_REGION_MAX_KM2,
    `a state (${state.toFixed(0)} km²) must not be attempted as a region`,
  );
});
