import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  boundaryArea,
  boundaryContains,
  boundaryOutline,
  boundaryVertexCount,
  geometryToPolygons,
  projectBoundary,
  type LatLonPolygons,
} from '../src/geo/boundary.js';

const METRES_PER_DEGREE = 111_320;
const ORIGIN = { lat: 0, lon: 0 };

/** Local metres (east, south) -> lat/lon at the equator. */
function ll(x: number, y: number): { lat: number; lon: number } {
  return { lat: -y / METRES_PER_DEGREE, lon: x / METRES_PER_DEGREE };
}

/** GeoJSON position [lon, lat] for a point given in local metres. */
function pos(x: number, y: number): [number, number] {
  const p = ll(x, y);
  return [p.lon, p.lat];
}

function boxPositions(cx: number, cy: number, half: number): Array<[number, number]> {
  return [
    pos(cx - half, cy - half),
    pos(cx + half, cy - half),
    pos(cx + half, cy + half),
    pos(cx - half, cy + half),
    pos(cx - half, cy - half),
  ];
}

test('geometryToPolygons reads a Polygon with a hole', () => {
  const polygons = geometryToPolygons({
    type: 'Polygon',
    coordinates: [boxPositions(0, 0, 100), boxPositions(0, 0, 20)],
  });
  assert.ok(polygons);
  assert.equal(polygons.length, 1);
  assert.equal(polygons[0]!.length, 2, 'outer ring plus one hole');
});

test('geometryToPolygons reads a MultiPolygon', () => {
  const polygons = geometryToPolygons({
    type: 'MultiPolygon',
    coordinates: [[boxPositions(0, 0, 50)], [boxPositions(500, 0, 50)]],
  });
  assert.ok(polygons);
  assert.equal(polygons.length, 2);
});

test('geometryToPolygons rejects geometry with no area', () => {
  assert.equal(geometryToPolygons(undefined), null);
  assert.equal(geometryToPolygons({ type: 'Point', coordinates: [1, 2] }), null);
  assert.equal(
    geometryToPolygons({ type: 'LineString', coordinates: [[1, 2], [3, 4]] }),
    null,
    'a street match has no boundary and must fall back to a radius',
  );
  assert.equal(geometryToPolygons({ type: 'Polygon' }), null);
});

test('projectBoundary converts to local metres and measures area', () => {
  const polygons = geometryToPolygons({
    type: 'Polygon',
    coordinates: [boxPositions(0, 0, 100)],
  })!;
  const boundary = projectBoundary(ORIGIN, polygons)!;

  assert.ok(boundary);
  assert.equal(boundary.polygons.length, 1);
  // 200 m x 200 m.
  assert.ok(Math.abs(boundaryArea(boundary) - 40_000) < 100, `area was ${boundaryArea(boundary)}`);
  assert.ok(Math.abs(boundary.bounds.minX + 100) < 0.5);
  assert.ok(Math.abs(boundary.bounds.maxX - 100) < 0.5);
});

test('boundaryArea subtracts holes', () => {
  const polygons = geometryToPolygons({
    type: 'Polygon',
    coordinates: [boxPositions(0, 0, 100), boxPositions(0, 0, 50)],
  })!;
  const boundary = projectBoundary(ORIGIN, polygons)!;
  // 200x200 minus 100x100.
  assert.ok(Math.abs(boundaryArea(boundary) - 30_000) < 200, `area was ${boundaryArea(boundary)}`);
});

test('boundaryContains respects outers, holes and separate polygons', () => {
  const polygons = geometryToPolygons({
    type: 'MultiPolygon',
    coordinates: [
      [boxPositions(0, 0, 100), boxPositions(0, 0, 30)],
      [boxPositions(1000, 0, 50)],
    ],
  })!;
  const boundary = projectBoundary(ORIGIN, polygons)!;

  assert.ok(boundaryContains(boundary, { x: 60, y: 0 }), 'inside the first outer ring');
  assert.ok(!boundaryContains(boundary, { x: 0, y: 0 }), 'inside the hole is outside');
  assert.ok(!boundaryContains(boundary, { x: 400, y: 0 }), 'between the two polygons');
  assert.ok(boundaryContains(boundary, { x: 1000, y: 0 }), 'inside the second polygon');
  assert.ok(!boundaryContains(boundary, { x: 5000, y: 5000 }), 'far outside');
});

test('boundaryOutline returns the outer vertices for framing', () => {
  const polygons = geometryToPolygons({
    type: 'MultiPolygon',
    coordinates: [
      [boxPositions(0, 0, 100), boxPositions(0, 0, 30)],
      [boxPositions(1000, 0, 50)],
    ],
  })!;
  const boundary = projectBoundary(ORIGIN, polygons)!;

  const outline = boundaryOutline(boundary);
  // Four corners per outer ring, holes excluded.
  assert.equal(outline.length, 8);
  assert.equal(boundaryVertexCount(boundary), 12, 'holes count toward the total vertex count');
});

test('projectBoundary discards rings too small to be polygons', () => {
  const degenerate: LatLonPolygons = [[[ll(0, 0), ll(10, 0)]]];
  assert.equal(projectBoundary(ORIGIN, degenerate), null);
});

test('a real-world MultiPolygon shape survives the round trip', () => {
  // An L-shape, to confirm concave boundaries behave.
  const lShape: Array<[number, number]> = [
    pos(0, 0),
    pos(200, 0),
    pos(200, 100),
    pos(100, 100),
    pos(100, 200),
    pos(0, 200),
    pos(0, 0),
  ];
  const boundary = projectBoundary(ORIGIN, geometryToPolygons({ type: 'Polygon', coordinates: [lShape] })!)!;

  assert.ok(boundaryContains(boundary, { x: 50, y: 50 }), 'in the corner of the L');
  assert.ok(boundaryContains(boundary, { x: 150, y: 50 }), 'in the arm of the L');
  assert.ok(!boundaryContains(boundary, { x: 150, y: 150 }), 'in the notch, which is outside');
  assert.ok(Math.abs(boundaryArea(boundary) - 30_000) < 200);
});
