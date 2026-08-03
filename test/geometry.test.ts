import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assembleRings,
  area,
  boundsOf,
  centroid,
  clipPolyline,
  clipRing,
  clipSegment,
  openRing,
  pointInPolygon,
  pointInRing,
  polylineLength,
  signedArea,
  toCounterClockwise,
} from '../src/geo/polygon.js';
import { bboxAround, haversine, toLatLon, toLocal } from '../src/geo/project.js';

const SQUARE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

test('signedArea is positive for counter-clockwise rings', () => {
  assert.equal(signedArea(SQUARE), 100);
  assert.equal(signedArea([...SQUARE].reverse()), -100);
  assert.equal(area([...SQUARE].reverse()), 100);
});

test('toCounterClockwise normalises winding', () => {
  assert.ok(signedArea(toCounterClockwise([...SQUARE].reverse())) > 0);
  assert.ok(signedArea(toCounterClockwise(SQUARE)) > 0);
});

test('centroid finds the middle of a square', () => {
  const c = centroid(SQUARE);
  assert.ok(Math.abs(c.x - 5) < 1e-9);
  assert.ok(Math.abs(c.y - 5) < 1e-9);
});

test('centroid falls back to the vertex mean for degenerate rings', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 8, y: 0 },
  ];
  const c = centroid(line);
  assert.ok(Math.abs(c.x - 4) < 1e-9);
  assert.ok(Math.abs(c.y) < 1e-9);
});

test('openRing drops a duplicated closing vertex', () => {
  const closed = [...SQUARE, { x: 0, y: 0 }];
  assert.equal(openRing(closed).length, 4);
  assert.equal(openRing(SQUARE).length, 4);
});

test('pointInRing and pointInPolygon respect holes', () => {
  assert.ok(pointInRing(SQUARE, { x: 5, y: 5 }));
  assert.ok(!pointInRing(SQUARE, { x: 15, y: 5 }));

  const hole = [
    { x: 3, y: 3 },
    { x: 7, y: 3 },
    { x: 7, y: 7 },
    { x: 3, y: 7 },
  ];
  assert.ok(!pointInPolygon([SQUARE, hole], { x: 5, y: 5 }), 'inside the hole is outside');
  assert.ok(pointInPolygon([SQUARE, hole], { x: 1, y: 1 }));
});

test('boundsOf covers every vertex', () => {
  const b = boundsOf(SQUARE);
  assert.deepEqual(b, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
});

test('clipRing trims a polygon to the box', () => {
  const bounds = { minX: 0, minY: 0, maxX: 5, maxY: 5 };
  const clipped = clipRing(SQUARE, bounds);
  assert.ok(clipped.length >= 3);
  assert.ok(Math.abs(area(clipped) - 25) < 1e-6, `expected area 25, got ${area(clipped)}`);
});

test('clipRing returns nothing when the polygon is fully outside', () => {
  const bounds = { minX: 100, minY: 100, maxX: 200, maxY: 200 };
  assert.equal(clipRing(SQUARE, bounds).length, 0);
});

test('clipRing leaves a fully contained polygon alone', () => {
  const bounds = { minX: -50, minY: -50, maxX: 50, maxY: 50 };
  assert.ok(Math.abs(area(clipRing(SQUARE, bounds)) - 100) < 1e-6);
});

test('clipSegment trims to the box and rejects misses', () => {
  const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const hit = clipSegment({ x: -5, y: 5 }, { x: 15, y: 5 }, bounds);
  assert.ok(hit);
  assert.ok(Math.abs(hit[0].x - 0) < 1e-9);
  assert.ok(Math.abs(hit[1].x - 10) < 1e-9);

  assert.equal(clipSegment({ x: -5, y: -5 }, { x: -1, y: -1 }, bounds), null);
});

test('clipPolyline splits a line that leaves and re-enters the box', () => {
  const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  const line = [
    { x: 1, y: 5 },
    { x: 20, y: 5 },
    { x: 20, y: 8 },
    { x: 1, y: 8 },
  ];
  const parts = clipPolyline(line, bounds);
  assert.equal(parts.length, 2, 'expected two surviving runs');
  for (const part of parts) {
    for (const p of part) {
      assert.ok(p.x >= -1e-9 && p.x <= 10 + 1e-9);
    }
  }
});

test('polylineLength sums segment lengths', () => {
  assert.equal(
    polylineLength([
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 3, y: 8 },
    ]),
    9,
  );
});

test('assembleRings stitches fragments regardless of order or direction', () => {
  const fragments = [
    [
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    // Deliberately reversed, as Overpass often returns members.
    [
      { x: 0, y: 10 },
      { x: 10, y: 10 },
    ],
    [
      { x: 0, y: 10 },
      { x: 0, y: 0 },
    ],
  ];
  const rings = assembleRings(fragments);
  assert.equal(rings.length, 1);
  assert.ok(Math.abs(area(rings[0]!) - 100) < 1e-6, `expected area 100, got ${area(rings[0]!)}`);
});

test('assembleRings keeps separate loops separate', () => {
  const square = (ox: number) => [
    [
      { x: ox, y: 0 },
      { x: ox + 4, y: 0 },
    ],
    [
      { x: ox + 4, y: 0 },
      { x: ox + 4, y: 4 },
    ],
    [
      { x: ox + 4, y: 4 },
      { x: ox, y: 4 },
    ],
    [
      { x: ox, y: 4 },
      { x: ox, y: 0 },
    ],
  ];
  const rings = assembleRings([...square(0), ...square(100)]);
  assert.equal(rings.length, 2);
});

test('toLocal and toLatLon round-trip', () => {
  const origin = { lat: 52.52, lon: 13.405 };
  const point = toLocal(origin, 52.5245, 13.4102);
  const back = toLatLon(origin, point);
  assert.ok(Math.abs(back.lat - 52.5245) < 1e-9);
  assert.ok(Math.abs(back.lon - 13.4102) < 1e-9);
});

test('toLocal puts north above and east to the right', () => {
  const origin = { lat: 52.52, lon: 13.405 };
  // y is metres *south*, so a point to the north has negative y.
  assert.ok(toLocal(origin, 52.53, 13.405).y < 0);
  assert.ok(toLocal(origin, 52.52, 13.415).x > 0);
});

test('toLocal distances agree with haversine', () => {
  const origin = { lat: 48.8584, lon: 2.2945 };
  const target = { lat: 48.8606, lon: 2.3376 };
  const local = toLocal(origin, target.lat, target.lon);
  const planar = Math.hypot(local.x, local.y);
  const great = haversine(origin, target);
  assert.ok(Math.abs(planar - great) / great < 0.005, `planar=${planar} haversine=${great}`);
});

test('bboxAround covers at least the requested radius', () => {
  const centre = { lat: 41.9028, lon: 12.4964 };
  const box = bboxAround(centre, 500, 1);
  const north = haversine(centre, { lat: box.north, lon: centre.lon });
  const east = haversine(centre, { lat: centre.lat, lon: box.east });
  assert.ok(Math.abs(north - 500) < 5, `north offset ${north}`);
  assert.ok(Math.abs(east - 500) < 5, `east offset ${east}`);
  assert.ok(box.north > box.south && box.east > box.west);
});
