import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildScene } from '../src/scene/build.js';
import type { OverpassElement, OverpassResponse } from '../src/osm/types.js';
import type { Place } from '../src/types.js';

const METRES_PER_DEGREE = 111_320;

const PLACE: Place = {
  name: 'Testville',
  displayName: 'Testville, Nowhere',
  // The equator keeps metres-per-degree identical on both axes, so the
  // fixtures below can be written directly in metres.
  centre: { lat: 0, lon: 0 },
};

/** Local metres (east, south) -> lat/lon around the origin. */
function ll(x: number, y: number): { lat: number; lon: number } {
  return { lat: -y / METRES_PER_DEGREE, lon: x / METRES_PER_DEGREE };
}

function closedWay(id: number, tags: Record<string, string>, corners: Array<[number, number]>): OverpassElement {
  const geometry = corners.map(([x, y]) => ll(x, y));
  return { type: 'way', id, tags, geometry: [...geometry, geometry[0]!] };
}

function openWay(id: number, tags: Record<string, string>, points: Array<[number, number]>): OverpassElement {
  return { type: 'way', id, tags, geometry: points.map(([x, y]) => ll(x, y)) };
}

function box(cx: number, cy: number, half: number): Array<[number, number]> {
  return [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
  ];
}

function response(elements: OverpassElement[]): OverpassResponse {
  return { elements };
}

test('extracts buildings with heights and footprints', () => {
  const scene = buildScene(
    response([closedWay(1, { building: 'apartments', 'building:levels': '4' }, box(0, 0, 10))]),
    { place: PLACE, radius: 200 },
  );

  assert.equal(scene.buildings.length, 1);
  const building = scene.buildings[0]!;
  assert.equal(building.kind, 'apartments');
  assert.ok(Math.abs(building.height - (4 * 3.2 + 1.2)) < 1e-6);
  assert.ok(Math.abs(building.area - 400) < 1, `expected ~400 m², got ${building.area}`);
  assert.ok(Math.abs(building.centroid.x) < 0.5 && Math.abs(building.centroid.y) < 0.5);
  assert.equal(scene.stats.maxHeight, building.height);
});

test('building rings come out counter-clockwise regardless of input winding', () => {
  const clockwise = box(0, 0, 10).reverse() as Array<[number, number]>;
  const scene = buildScene(response([closedWay(1, { building: 'yes' }, clockwise)]), {
    place: PLACE,
    radius: 200,
  });
  const ring = scene.buildings[0]!.rings[0]!;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  assert.ok(sum > 0, 'wall-facing tests depend on counter-clockwise rings');
});

test('extracts roads, water, greenery and trees', () => {
  const scene = buildScene(
    response([
      openWay(2, { highway: 'residential' }, [
        [-100, 0],
        [100, 0],
      ]),
      closedWay(3, { natural: 'water' }, box(50, 50, 20)),
      closedWay(4, { leisure: 'park' }, box(-50, -50, 30)),
      { type: 'node', id: 5, tags: { natural: 'tree' }, ...ll(10, 10) },
    ]),
    { place: PLACE, radius: 200, seed: 1 },
  );

  assert.equal(scene.roads.length, 1);
  assert.equal(scene.roads[0]!.roadClass, 'residential');
  assert.equal(scene.areas.filter((a) => a.kind === 'water').length, 1);
  assert.equal(scene.areas.filter((a) => a.kind === 'green').length, 1);
  // One tagged tree plus the scatter inside the park.
  assert.ok(scene.trees.length > 1, `expected scattered trees, got ${scene.trees.length}`);
  assert.ok(scene.trees.some((t) => t.id === 'n5'));
});

test('clips features to the render square and drops those fully outside', () => {
  const scene = buildScene(
    response([
      // Straddles the eastern edge at x = 100.
      closedWay(1, { building: 'yes' }, box(95, 0, 20)),
      // Entirely outside.
      closedWay(2, { building: 'yes' }, box(500, 500, 20)),
      // Runs well past both edges.
      openWay(3, { highway: 'primary' }, [
        [-400, 10],
        [400, 10],
      ]),
    ]),
    { place: PLACE, radius: 100 },
  );

  assert.equal(scene.buildings.length, 1, 'the far building should be dropped');
  for (const point of scene.buildings[0]!.rings[0]!) {
    assert.ok(point.x <= 100.001 && point.x >= -100.001, `x=${point.x} escaped the square`);
  }
  assert.equal(scene.roads.length, 1);
  for (const line of scene.roads[0]!.lines) {
    for (const point of line) {
      assert.ok(point.x <= 100.001 && point.x >= -100.001, `x=${point.x} escaped the square`);
    }
  }
});

test('assembles multipolygon relations with holes', () => {
  const outer = box(0, 0, 40).map(([x, y]) => ll(x, y));
  const inner = box(0, 0, 10).map(([x, y]) => ll(x, y));
  const scene = buildScene(
    response([
      {
        type: 'relation',
        id: 9,
        tags: { building: 'yes', type: 'multipolygon' },
        members: [
          // Outer supplied as two separate fragments, as Overpass does.
          { type: 'way', ref: 1, role: 'outer', geometry: [outer[0]!, outer[1]!, outer[2]!] },
          { type: 'way', ref: 2, role: 'outer', geometry: [outer[2]!, outer[3]!, outer[0]!] },
          { type: 'way', ref: 3, role: 'inner', geometry: [...inner, inner[0]!] },
        ],
      },
    ]),
    { place: PLACE, radius: 200 },
  );

  assert.equal(scene.buildings.length, 1);
  const building = scene.buildings[0]!;
  assert.equal(building.rings.length, 2, 'expected an outer ring and one hole');
  assert.ok(Math.abs(building.area - 6400) < 20, `outer area was ${building.area}`);
});

test('layer toggles suppress whole feature classes', () => {
  const elements = [
    closedWay(1, { building: 'yes' }, box(0, 0, 10)),
    openWay(2, { highway: 'residential' }, [
      [-50, 0],
      [50, 0],
    ]),
    closedWay(3, { natural: 'water' }, box(40, 40, 15)),
    closedWay(4, { landuse: 'forest' }, box(-40, -40, 30)),
    openWay(5, { railway: 'tram' }, [
      [-50, 20],
      [50, 20],
    ]),
  ];

  const all = buildScene(response(elements), { place: PLACE, radius: 200 });
  assert.ok(all.buildings.length > 0 && all.roads.length > 0 && all.rails.length > 0);
  assert.ok(all.trees.length > 0);

  const none = buildScene(response(elements), {
    place: PLACE,
    radius: 200,
    buildings: false,
    roads: false,
    water: false,
    greenery: false,
    trees: false,
    rails: false,
  });
  assert.equal(none.buildings.length, 0);
  assert.equal(none.roads.length, 0);
  assert.equal(none.rails.length, 0);
  assert.equal(none.trees.length, 0);
  assert.equal(none.areas.length, 0);
});

test('tree scatter is deterministic per seed and varies between seeds', () => {
  const forest = response([closedWay(1, { landuse: 'forest' }, box(0, 0, 60))]);
  const build = (seed: number) => buildScene(forest, { place: PLACE, radius: 200, seed }).trees;

  const a = build(3);
  const b = build(3);
  const c = build(4);

  assert.ok(a.length > 20, `expected a dense wood, got ${a.length} trees`);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('scattered trees stay inside their polygon', () => {
  const scene = buildScene(response([closedWay(1, { leisure: 'park' }, box(0, 0, 40))]), {
    place: PLACE,
    radius: 200,
    seed: 5,
  });
  assert.ok(scene.trees.length > 0);
  for (const tree of scene.trees) {
    assert.ok(Math.abs(tree.position.x) <= 40.001, `tree at x=${tree.position.x}`);
    assert.ok(Math.abs(tree.position.y) <= 40.001, `tree at y=${tree.position.y}`);
  }
});

test('discards degenerate and untagged geometry without throwing', () => {
  const scene = buildScene(
    response([
      // Unclosed "building".
      openWay(1, { building: 'yes' }, [
        [0, 0],
        [10, 0],
      ]),
      // Below the minimum footprint.
      closedWay(2, { building: 'yes' }, box(0, 0, 0.5)),
      // No tags at all.
      closedWay(3, {}, box(20, 20, 10)),
      // A relation with no usable members.
      { type: 'relation', id: 4, tags: { building: 'yes', type: 'multipolygon' }, members: [] },
      // A node with no coordinates.
      { type: 'node', id: 5, tags: { natural: 'tree' } },
    ]),
    { place: PLACE, radius: 200 },
  );

  assert.equal(scene.buildings.length, 0);
  assert.equal(scene.areas.length, 0);
  assert.equal(scene.trees.length, 0);
  assert.equal(scene.stats.elements, 5);
});

test('areas are ordered largest first so small parks land on top', () => {
  const scene = buildScene(
    response([
      closedWay(1, { landuse: 'residential' }, box(0, 0, 80)),
      closedWay(2, { leisure: 'park' }, box(0, 0, 20)),
    ]),
    { place: PLACE, radius: 200 },
  );
  assert.equal(scene.areas.length, 2);
  assert.ok(scene.areas[0]!.area > scene.areas[1]!.area);
  assert.equal(scene.areas[1]!.sub, 'park');
});

test('the scene carries the required OpenStreetMap attribution', () => {
  const scene = buildScene(response([]), { place: PLACE, radius: 100 });
  assert.match(scene.attribution, /OpenStreetMap contributors/);
});
