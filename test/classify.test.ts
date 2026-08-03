import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ROAD_PRIORITY,
  TREE_DENSITY,
  classifyArea,
  classifyBuilding,
  classifyRail,
  classifyRoad,
  parseHeight,
} from '../src/osm/classify.js';

test('parseHeight understands the formats OSM actually contains', () => {
  assert.equal(parseHeight('12'), 12);
  assert.equal(parseHeight('12 m'), 12);
  assert.equal(parseHeight('12m'), 12);
  assert.equal(parseHeight('12.5'), 12.5);
  assert.equal(parseHeight('12,5'), 12.5);
  assert.ok(Math.abs(parseHeight("40'")! - 12.192) < 1e-3);
  assert.ok(Math.abs(parseHeight('10 ft')! - 3.048) < 1e-3);
  // 12 ft + 6 in = 3.6576 + 0.1524 m
  assert.ok(Math.abs(parseHeight(`12' 6"`)! - 3.81) < 1e-3);
});

test('parseHeight rejects junk rather than guessing', () => {
  for (const value of [undefined, '', 'tall', '-3', '0', 'about 12', '12 storeys']) {
    assert.equal(parseHeight(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test('classifyBuilding prefers an explicit height', () => {
  const info = classifyBuilding({ building: 'house', height: '7.5' });
  assert.equal(info?.height, 7.5);
});

test('classifyBuilding falls back to levels, then to a per-type default', () => {
  const levels = classifyBuilding({ building: 'apartments', 'building:levels': '5' });
  assert.ok(levels);
  assert.ok(Math.abs(levels.height - (5 * 3.2 + 1.2)) < 1e-9);

  const fallback = classifyBuilding({ building: 'house' });
  assert.equal(fallback?.height, 6.5);

  const unknown = classifyBuilding({ building: 'something_new' });
  assert.equal(unknown?.height, 9, 'unknown types get the generic default');
});

test('classifyBuilding clamps absurd heights from bad data', () => {
  assert.equal(classifyBuilding({ building: 'yes', height: '99999' })?.height, 400);
  assert.equal(classifyBuilding({ building: 'yes', height: '0.1' })?.height, 2);
});

test('classifyBuilding ignores non-buildings', () => {
  assert.equal(classifyBuilding(undefined), null);
  assert.equal(classifyBuilding({}), null);
  assert.equal(classifyBuilding({ building: 'no' }), null);
});

test('classifyBuilding flags landmarks', () => {
  assert.equal(classifyBuilding({ building: 'church' })?.landmark, true);
  assert.equal(classifyBuilding({ building: 'yes', amenity: 'place_of_worship' })?.landmark, true);
  assert.equal(classifyBuilding({ building: 'house' })?.landmark, false);
});

test('classifyRoad maps link roads onto their parent class', () => {
  assert.equal(classifyRoad({ highway: 'motorway_link' })?.roadClass, 'motorway');
  assert.equal(classifyRoad({ highway: 'primary_link' })?.roadClass, 'primary');
  assert.equal(classifyRoad({ highway: 'living_street' })?.roadClass, 'residential');
});

test('classifyRoad widens for lane counts but ignores implausible ones', () => {
  const base = classifyRoad({ highway: 'residential' })!;
  const wide = classifyRoad({ highway: 'residential', lanes: '4' })!;
  assert.ok(wide.width > base.width);

  const silly = classifyRoad({ highway: 'residential', lanes: '400' })!;
  assert.equal(silly.width, base.width);
});

test('classifyRoad reads bridge, tunnel and layer', () => {
  const road = classifyRoad({ highway: 'primary', bridge: 'yes', layer: '2' })!;
  assert.equal(road.bridge, true);
  assert.equal(road.tunnel, false);
  assert.equal(road.layer, 2);

  assert.equal(classifyRoad({ highway: 'primary', bridge: 'no' })?.bridge, false);
});

test('classifyRoad ignores non-roads', () => {
  assert.equal(classifyRoad({ highway: 'bus_stop' }), null);
  assert.equal(classifyRoad({ building: 'yes' }), null);
});

test('every road class has a drawing priority and a positive width', () => {
  for (const highway of ['motorway', 'primary', 'residential', 'footway', 'steps', 'track']) {
    const road = classifyRoad({ highway })!;
    assert.ok(road.width > 0, `${highway} has no width`);
    assert.ok(ROAD_PRIORITY[road.roadClass] !== undefined, `${road.roadClass} has no priority`);
  }
});

test('classifyRail accepts real railways only', () => {
  assert.ok(classifyRail({ railway: 'tram' }));
  assert.ok(classifyRail({ railway: 'subway' }));
  assert.equal(classifyRail({ railway: 'platform' }), null);
  assert.equal(classifyRail({ railway: 'level_crossing' }), null);
});

test('classifyArea recognises water in its several taggings', () => {
  assert.equal(classifyArea({ natural: 'water' })?.kind, 'water');
  assert.equal(classifyArea({ waterway: 'riverbank' })?.kind, 'water');
  assert.equal(classifyArea({ landuse: 'reservoir' })?.kind, 'water');
});

test('classifyArea maps green space to a known green kind', () => {
  const park = classifyArea({ leisure: 'park' });
  assert.equal(park?.kind, 'green');
  assert.ok(TREE_DENSITY[park!.sub as keyof typeof TREE_DENSITY] !== undefined);

  const forest = classifyArea({ landuse: 'forest' });
  assert.equal(forest?.sub, 'forest');
  assert.equal(classifyArea({ natural: 'wood' })?.sub, 'forest');
});

test('classifyArea handles built land and parking', () => {
  assert.equal(classifyArea({ landuse: 'residential' })?.kind, 'residential');
  assert.equal(classifyArea({ landuse: 'industrial' })?.kind, 'industrial');
  assert.equal(classifyArea({ landuse: 'retail' })?.kind, 'commercial');
  assert.equal(classifyArea({ amenity: 'parking' })?.kind, 'parking');
});

test('classifyArea returns null for things that should not be painted', () => {
  assert.equal(classifyArea(undefined), null);
  assert.equal(classifyArea({ name: 'Somewhere' }), null);
  assert.equal(classifyArea({ highway: 'residential' }), null);
});

test('every green kind has a tree density', () => {
  for (const kind of ['park', 'forest', 'grass', 'farmland', 'cemetery', 'pitch', 'garden'] as const) {
    assert.ok(TREE_DENSITY[kind] !== undefined, `${kind} has no density`);
    assert.ok(TREE_DENSITY[kind] >= 0);
  }
});
