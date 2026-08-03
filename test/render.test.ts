import assert from 'node:assert/strict';
import { test } from 'node:test';

import { geometryToPolygons, projectBoundary } from '../src/geo/boundary.js';
import { createProjector, layoutFor } from '../src/render/iso.js';
import {
  THEMES,
  THEME_NAMES,
  desaturateTheme,
  getTheme,
  mapThemeColors,
} from '../src/render/palette.js';
import { Raster, rasterizeMask, solid } from '../src/render/raster.js';
import { renderScene } from '../src/render/render.js';
import { bayer4, hex, mix, quantiseFactor, shade, toHex } from '../src/render/color.js';
import type { Scene } from '../src/types.js';

/* -------------------------------------------------------------------------- */
/* Colour                                                                     */
/* -------------------------------------------------------------------------- */

test('hex parses both short and long forms', () => {
  assert.deepEqual(hex('#f00'), [255, 0, 0]);
  assert.deepEqual(hex('00ff00'), [0, 255, 0]);
  assert.equal(toHex([18, 52, 86]), '#123456');
  assert.throws(() => hex('#12345'), /Invalid hex/);
  assert.throws(() => hex('nope'), /Invalid hex/);
});

test('shade and mix stay inside the byte range', () => {
  assert.deepEqual(shade([200, 200, 200], 2), [255, 255, 255]);
  assert.deepEqual(shade([200, 200, 200], 0), [0, 0, 0]);
  assert.deepEqual(mix([0, 0, 0], [100, 100, 100], 0.5), [50, 50, 50]);
  assert.deepEqual(mix([0, 0, 0], [100, 100, 100], 5), [100, 100, 100]);
});

test('quantiseFactor produces exactly the requested number of levels', () => {
  const levels = new Set<number>();
  for (let i = 0; i <= 100; i++) levels.add(quantiseFactor(i / 100, 4, 0.5, 1));
  assert.equal(levels.size, 4);
  assert.ok(Math.min(...levels) >= 0.5);
  assert.ok(Math.max(...levels) <= 1);
});

test('bayer4 tiles over a 4x4 grid', () => {
  assert.equal(bayer4(0, 0), bayer4(4, 4));
  assert.equal(bayer4(-1, -1), bayer4(3, 3));
});

/* -------------------------------------------------------------------------- */
/* Raster                                                                     */
/* -------------------------------------------------------------------------- */

test('fillPath fills a rectangle exactly, with no bleed', () => {
  const raster = new Raster(10, 10, [0, 0, 0]);
  raster.fillPath(
    [
      [
        { x: 2, y: 2 },
        { x: 6, y: 2 },
        { x: 6, y: 6 },
        { x: 2, y: 6 },
      ],
    ],
    solid([255, 0, 0]),
  );

  let filled = 0;
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const inside = x >= 2 && x < 6 && y >= 2 && y < 6;
      const isRed = raster.get(x, y)[0] === 255;
      assert.equal(isRed, inside, `pixel ${x},${y} should be ${inside ? 'red' : 'black'}`);
      if (isRed) filled++;
    }
  }
  assert.equal(filled, 16);
});

test('fillPath punches holes using the even-odd rule', () => {
  const raster = new Raster(12, 12, [0, 0, 0]);
  raster.fillPath(
    [
      [
        { x: 1, y: 1 },
        { x: 11, y: 1 },
        { x: 11, y: 11 },
        { x: 1, y: 11 },
      ],
      [
        { x: 4, y: 4 },
        { x: 8, y: 4 },
        { x: 8, y: 8 },
        { x: 4, y: 8 },
      ],
    ],
    solid([255, 255, 255]),
  );
  assert.equal(raster.get(2, 2)[0], 255, 'outer ring is filled');
  assert.equal(raster.get(6, 6)[0], 0, 'hole is left empty');
});

test('drawing outside the canvas is clipped, not an error', () => {
  const raster = new Raster(4, 4, [0, 0, 0]);
  raster.fillPath(
    [
      [
        { x: -50, y: -50 },
        { x: 50, y: -50 },
        { x: 50, y: 50 },
        { x: -50, y: 50 },
      ],
    ],
    solid([9, 9, 9]),
  );
  raster.set(100, 100, [1, 2, 3]);
  raster.line(-20, -20, 40, 40, [4, 5, 6]);

  // The oversized polygon covered the canvas...
  assert.equal(raster.get(3, 0)[0], 9);
  // ...and the line that started off-canvas still drew its visible part.
  assert.equal(raster.get(0, 0)[0], 4);
});

test('scaleUp is nearest-neighbour', () => {
  const raster = new Raster(2, 2, [0, 0, 0]);
  raster.set(0, 0, [255, 0, 0]);
  const scaled = raster.scaleUp(3);
  assert.equal(scaled.width, 6);
  assert.equal(scaled.height, 6);
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      assert.equal(scaled.get(x, y)[0], 255, `block pixel ${x},${y}`);
    }
  }
  assert.equal(scaled.get(3, 0)[0], 0, 'no interpolation across the block edge');
});

test('scaleUp by one returns the same raster', () => {
  const raster = new Raster(3, 3);
  assert.equal(raster.scaleUp(1), raster);
});

/* -------------------------------------------------------------------------- */
/* Projection                                                                 */
/* -------------------------------------------------------------------------- */

test('the isometric projection is 2:1 and lifts height upward', () => {
  const p = createProjector({ scale: 4, verticalExaggeration: 1, originX: 0, originY: 0 });
  assert.deepEqual(p.project(0, 0, 0), { x: 0, y: 0 });
  // One metre east: right by `scale`, down by half.
  assert.deepEqual(p.project(1, 0, 0), { x: 4, y: 2 });
  // One metre south: left by `scale`, down by half.
  assert.deepEqual(p.project(0, 1, 0), { x: -4, y: 2 });
  // Height moves straight up the screen.
  assert.deepEqual(p.project(0, 0, 1), { x: 0, y: -4 });
});

test('depth increases toward the viewer', () => {
  const p = createProjector({ scale: 1, verticalExaggeration: 1, originX: 0, originY: 0 });
  assert.ok(p.depth(10, 10) > p.depth(-10, -10));
});

test('vertical exaggeration only affects height', () => {
  const p = createProjector({ scale: 2, verticalExaggeration: 3, originX: 0, originY: 0 });
  assert.equal(p.verticalScale, 6);
  assert.equal(p.project(0, 0, 1).y, -6);
  assert.equal(p.project(1, 0, 0).y, 1);
});

test('layoutFor fits the world square inside the requested width', () => {
  const layout = layoutFor({
    radius: 400,
    width: 1000,
    margin: 10,
    maxHeight: 20,
    verticalExaggeration: 1,
  });
  assert.equal(layout.width, 1000);
  // The diamond spans 4 * radius * scale horizontally.
  assert.ok(Math.abs(4 * 400 * layout.scale - 980) < 1e-6);
  assert.ok(layout.height > layout.width / 2, 'height leaves room for buildings');

  const projector = createProjector({
    scale: layout.scale,
    verticalExaggeration: 1,
    originX: layout.originX,
    originY: layout.originY,
  });
  for (const corner of [
    { x: -400, y: -400 },
    { x: 400, y: -400 },
    { x: 400, y: 400 },
    { x: -400, y: 400 },
  ]) {
    const p = projector.project(corner.x, corner.y, 0);
    assert.ok(p.x >= -0.001 && p.x <= 1000.001, `corner x out of frame: ${p.x}`);
    assert.ok(p.y >= -0.001 && p.y <= layout.height + 0.001, `corner y out of frame: ${p.y}`);
  }
});

test('an explicit height overrides the derived one', () => {
  const layout = layoutFor({
    radius: 100,
    width: 400,
    margin: 4,
    maxHeight: 50,
    verticalExaggeration: 2,
    height: 333,
  });
  assert.equal(layout.height, 333);
});

/* -------------------------------------------------------------------------- */
/* Themes                                                                     */
/* -------------------------------------------------------------------------- */

test('every theme defines every colour the renderer asks for', () => {
  const roadClasses = [
    'motorway',
    'trunk',
    'primary',
    'secondary',
    'tertiary',
    'residential',
    'service',
    'pedestrian',
    'cycleway',
    'footway',
    'track',
    'steps',
  ] as const;
  const greenKinds = ['park', 'forest', 'grass', 'farmland', 'cemetery', 'pitch', 'garden'] as const;

  for (const name of THEME_NAMES) {
    const theme = getTheme(name);
    assert.ok(theme.roofs.length > 0, `${name} has no roof colours`);
    assert.equal(theme.roofs.length, theme.walls.length, `${name} roof/wall counts differ`);
    for (const cls of roadClasses) {
      assert.ok(theme.road[cls], `${name} is missing road colour ${cls}`);
    }
    for (const kind of greenKinds) {
      assert.ok(theme.green[kind], `${name} is missing green colour ${kind}`);
    }
    for (const channel of [...theme.sky, ...theme.outline, ...theme.text]) {
      assert.ok(channel >= 0 && channel <= 255, `${name} has an out-of-range channel`);
    }
  }
});

test('the gameboy theme uses exactly the four DMG tones', () => {
  const theme = THEMES['gameboy']!;
  const allowed = new Set(['#0f380f', '#306230', '#8bac0f', '#9bbc0f']);
  const seen = new Set<string>();
  const collect = (c: readonly [number, number, number]) => seen.add(toHex(c));

  collect(theme.sky);
  collect(theme.outline);
  collect(theme.roadCasing);
  theme.ground.forEach(collect);
  theme.water.forEach(collect);
  theme.roofs.forEach(collect);
  theme.walls.forEach(collect);
  Object.values(theme.road).forEach(collect);
  Object.values(theme.green).forEach((pair) => pair.forEach(collect));

  for (const colour of seen) {
    assert.ok(allowed.has(colour), `${colour} is not a DMG tone`);
  }
});

test('label colour contrasts with the sky in every theme', () => {
  for (const name of THEME_NAMES) {
    const theme = getTheme(name);
    const lum = (c: readonly [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const delta = Math.abs(lum(theme.text) - lum(theme.sky));
    assert.ok(delta > 40, `${name}: text/sky contrast is only ${delta.toFixed(0)}`);
  }
});

test('getTheme rejects unknown names with a helpful message', () => {
  assert.throws(() => getTheme('sepia'), /Unknown theme "sepia"\. Available: /);
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function testScene(overrides: Partial<Scene> = {}): Scene {
  const square = (cx: number, cy: number, size: number) => [
    { x: cx - size, y: cy - size },
    { x: cx + size, y: cy - size },
    { x: cx + size, y: cy + size },
    { x: cx - size, y: cy + size },
  ];

  return {
    place: {
      name: 'Testville',
      displayName: 'Testville, Nowhere',
      centre: { lat: 52, lon: 13 },
    },
    origin: { lat: 52, lon: 13 },
    radius: 100,
    buildings: [
      {
        id: 'w1',
        rings: [square(-30, -20, 14)],
        height: 18,
        kind: 'apartments',
        landmark: false,
        centroid: { x: -30, y: -20 },
        area: 784,
      },
      {
        id: 'w2',
        rings: [square(25, 30, 10)],
        height: 9,
        kind: 'church',
        landmark: true,
        centroid: { x: 25, y: 30 },
        area: 400,
      },
    ],
    areas: [
      { id: 'w3', kind: 'green', sub: 'park', rings: [square(40, -40, 25)], area: 2500 },
      { id: 'w4', kind: 'water', sub: 'water', rings: [square(-50, 50, 20)], area: 1600 },
    ],
    roads: [
      {
        id: 'w5',
        roadClass: 'residential',
        width: 8,
        lines: [
          [
            { x: -90, y: 0 },
            { x: 90, y: 5 },
          ],
        ],
        bridge: false,
        tunnel: false,
        layer: 0,
      },
    ],
    rails: [],
    trees: [{ id: 't1', position: { x: 40, y: -40 }, size: 4 }],
    attribution: '© OpenStreetMap contributors',
    stats: {
      buildings: 2,
      areas: 2,
      roads: 1,
      rails: 0,
      trees: 1,
      elements: 6,
      maxHeight: 18,
    },
    ...overrides,
  };
}

test('renderScene produces an image of the requested size', () => {
  const image = renderScene(testScene(), { width: 320, scale: 1 });
  assert.equal(image.width, 320);
  assert.ok(image.height > 0);
  assert.equal(image.raster.data.length, image.width * image.height * 4);
  assert.ok(image.metresToPixels > 0);
});

test('upscaling multiplies both dimensions', () => {
  const single = renderScene(testScene(), { width: 200, scale: 1 });
  const triple = renderScene(testScene(), { width: 200, scale: 3 });
  assert.equal(triple.width, single.width * 3);
  assert.equal(triple.height, single.height * 3);
});

test('renders are deterministic for a given seed', () => {
  const a = renderScene(testScene(), { width: 240, scale: 1, seed: 7 });
  const b = renderScene(testScene(), { width: 240, scale: 1, seed: 7 });
  assert.deepEqual([...a.raster.data], [...b.raster.data]);
});

test('a different seed changes the image', () => {
  const a = renderScene(testScene(), { width: 240, scale: 1, seed: 1 });
  const b = renderScene(testScene(), { width: 240, scale: 1, seed: 2 });
  assert.notDeepEqual([...a.raster.data], [...b.raster.data]);
});

test('every theme renders without throwing and paints something', () => {
  for (const name of THEME_NAMES) {
    const image = renderScene(testScene(), { width: 200, scale: 1, theme: name });
    const distinct = new Set<string>();
    for (let i = 0; i < image.raster.data.length; i += 4) {
      distinct.add(`${image.raster.data[i]},${image.raster.data[i + 1]},${image.raster.data[i + 2]}`);
    }
    assert.ok(distinct.size > 3, `${name} produced a near-blank image (${distinct.size} colours)`);
  }
});

test('an empty scene still renders the ground plane', () => {
  const empty = testScene({
    buildings: [],
    areas: [],
    roads: [],
    trees: [],
    stats: { buildings: 0, areas: 0, roads: 0, rails: 0, trees: 0, elements: 0, maxHeight: 0 },
  });
  const image = renderScene(empty, { width: 200, scale: 1 });
  assert.ok(image.height > 0);
});

test('layer toggles change the output', () => {
  const withOutlines = renderScene(testScene(), { width: 240, scale: 1, outlines: true });
  const without = renderScene(testScene(), { width: 240, scale: 1, outlines: false });
  assert.notDeepEqual([...withOutlines.raster.data], [...without.raster.data]);

  const noShadows = renderScene(testScene(), { width: 240, scale: 1, shadows: false });
  assert.notDeepEqual([...withOutlines.raster.data], [...noShadows.raster.data]);
});

/* -------------------------------------------------------------------------- */
/* Clip mask, regions and highlights                                          */
/* -------------------------------------------------------------------------- */

test('rasterizeMask marks exactly the covered pixels', () => {
  const mask = rasterizeMask(
    [
      [
        { x: 2, y: 2 },
        { x: 6, y: 2 },
        { x: 6, y: 6 },
        { x: 2, y: 6 },
      ],
    ],
    10,
    10,
  );
  assert.equal(mask.length, 100);
  let covered = 0;
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const inside = x >= 2 && x < 6 && y >= 2 && y < 6;
      assert.equal(mask[y * 10 + x] === 1, inside, `mask at ${x},${y}`);
      if (mask[y * 10 + x]) covered++;
    }
  }
  assert.equal(covered, 16);
});

test('a mask and a fill of the same path agree pixel for pixel', () => {
  const ring = [
    { x: 1.3, y: 0.7 },
    { x: 8.9, y: 2.2 },
    { x: 5.1, y: 9.4 },
  ];
  const raster = new Raster(12, 12, [0, 0, 0]);
  raster.fillPath([ring], solid([255, 255, 255]));
  const mask = rasterizeMask([ring], 12, 12);

  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      assert.equal(raster.get(x, y)[0] === 255, mask[y * 12 + x] === 1, `disagreement at ${x},${y}`);
    }
  }
});

test('the clip mask discards writes outside it', () => {
  const raster = new Raster(8, 8, [0, 0, 0]);
  const mask = new Uint8Array(64);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) mask[y * 8 + x] = 1;
  raster.clipMask = mask;

  raster.fillRect(0, 0, 8, 8, [255, 255, 255]);
  raster.set(7, 7, [255, 0, 0]);
  raster.blend(7, 0, [255, 0, 0], 0.5);

  assert.equal(raster.get(0, 0)[0], 255, 'inside the mask');
  assert.equal(raster.get(7, 7)[0], 0, 'set() outside the mask is discarded');
  assert.equal(raster.get(7, 0)[0], 0, 'blend() outside the mask is discarded');

  raster.clipMask = null;
  raster.set(7, 7, [255, 0, 0]);
  assert.equal(raster.get(7, 7)[0], 255, 'clearing the mask restores writing');
});

test('layoutFor frames an arbitrary extent as tightly as a square', () => {
  const layout = layoutFor({
    extent: [
      { x: -100, y: -50 },
      { x: 300, y: -50 },
      { x: 300, y: 150 },
      { x: -100, y: 150 },
    ],
    width: 800,
    margin: 10,
    maxHeight: 0,
    verticalExaggeration: 1,
  });

  const projector = createProjector({
    scale: layout.scale,
    verticalExaggeration: 1,
    originX: layout.originX,
    originY: layout.originY,
  });

  let minX = Infinity;
  let maxX = -Infinity;
  for (const corner of [
    { x: -100, y: -50 },
    { x: 300, y: -50 },
    { x: 300, y: 150 },
    { x: -100, y: 150 },
  ]) {
    const p = projector.project(corner.x, corner.y, 0);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    assert.ok(p.y >= -1 && p.y <= layout.height + 1, `y out of frame: ${p.y}`);
  }
  assert.ok(Math.abs(minX - 10) < 1.5, `left edge should sit on the margin, was ${minX}`);
  assert.ok(Math.abs(maxX - 790) < 1.5, `right edge should sit on the margin, was ${maxX}`);
});

test('desaturateTheme drains colour but keeps light and dark apart', () => {
  const theme = getTheme('daylight');
  const grey = desaturateTheme(theme);

  for (const colour of [grey.sky, grey.outline, ...grey.roofs, ...grey.walls]) {
    assert.equal(colour[0], colour[1], `expected neutral grey, got ${colour}`);
    assert.equal(colour[1], colour[2], `expected neutral grey, got ${colour}`);
  }
  const lum = (c: readonly [number, number, number]) => c[0];
  assert.ok(
    Math.abs(lum(grey.walls[0]!) - lum(grey.roofs[0]!)) > 20,
    'roofs and walls must stay distinguishable once the hue is gone',
  );
});

test('desaturateTheme at partial strength keeps some colour', () => {
  const theme = getTheme('daylight');
  const partial = desaturateTheme(theme, 0.5);
  const roof = partial.roofs[0]!;
  assert.notEqual(roof[0], roof[2], 'a half-strength desaturation is not neutral');
});

test('mapThemeColors reaches nested colours and leaves other fields alone', () => {
  const theme = getTheme('daylight');
  const black = mapThemeColors(theme, () => [0, 0, 0]);
  assert.deepEqual([...black.sky], [0, 0, 0]);
  assert.deepEqual([...black.green.park[0]!], [0, 0, 0]);
  assert.deepEqual([...black.road.motorway], [0, 0, 0]);
  assert.equal(black.name, theme.name, 'strings are untouched');
  assert.equal(black.shadowAlpha, theme.shadowAlpha, 'numbers are untouched');
  assert.equal(black.window.litChance, theme.window.litChance);
});

test('a region render confines the ground to the boundary shape', () => {
  const boundary = projectBoundary(
    { lat: 0, lon: 0 },
    geometryToPolygons({
      type: 'Polygon',
      // A triangle, so a lot of the frame is legitimately outside it.
      coordinates: [
        [
          [0, 0],
          [0.0018, 0],
          [0, -0.0018],
          [0, 0],
        ],
      ],
    })!,
  )!;

  const scene = testScene({ boundary, radius: 200 });
  const image = renderScene(scene, { width: 300, scale: 1 });
  const theme = image.theme;

  const isSky = (x: number, y: number) => {
    const c = image.raster.get(x, y);
    return c[0] === theme.sky[0] && c[1] === theme.sky[1] && c[2] === theme.sky[2];
  };

  // The bottom-left corner falls well outside a triangle anchored top-left.
  assert.ok(isSky(2, image.height - 3), 'outside the boundary must stay sky');

  let painted = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) if (!isSky(x, y)) painted++;
  }
  const coverage = painted / (image.width * image.height);
  assert.ok(coverage > 0.05 && coverage < 0.75, `unexpected ground coverage: ${coverage.toFixed(2)}`);
});

test('a highlight turns the city grey and paints one building in the accent', () => {
  const scene = testScene();
  scene.buildings[0]!.highlighted = true;
  scene.highlight = { position: scene.buildings[0]!.centroid, buildingId: 'w1', distance: 0 };

  const image = renderScene(scene, { width: 320, scale: 1, highlightColor: '#ff0000' });

  let accentish = 0;
  let coloured = 0;
  for (let i = 0; i < image.raster.data.length; i += 4) {
    const r = image.raster.data[i]!;
    const g = image.raster.data[i + 1]!;
    const b = image.raster.data[i + 2]!;
    if (r > 150 && g < 110 && b < 110) accentish++;
    else if (Math.abs(r - g) > 12 || Math.abs(g - b) > 12) coloured++;
  }
  assert.ok(accentish > 20, `expected accent pixels, found ${accentish}`);
  assert.ok(coloured < accentish, `the rest of the scene should be grey, found ${coloured} colour pixels`);
});

test('--no-desaturate keeps the scene in colour alongside the accent', () => {
  const scene = testScene();
  scene.buildings[0]!.highlighted = true;
  scene.highlight = { position: scene.buildings[0]!.centroid, buildingId: 'w1', distance: 0 };

  const grey = renderScene(scene, { width: 320, scale: 1 });
  const colour = renderScene(scene, { width: 320, scale: 1, desaturate: false });
  assert.notDeepEqual([...grey.raster.data], [...colour.raster.data]);
});

test('the marker is drawn even when the highlight matched no building', () => {
  const scene = testScene();
  scene.highlight = { position: { x: 0, y: 0 } };

  const withMarker = renderScene(scene, { width: 320, scale: 1, highlightColor: '#ff0000' });
  const without = renderScene(scene, { width: 320, scale: 1, marker: false });
  assert.notDeepEqual([...withMarker.raster.data], [...without.raster.data]);

  let accent = 0;
  for (let i = 0; i < withMarker.raster.data.length; i += 4) {
    if (withMarker.raster.data[i]! > 150 && withMarker.raster.data[i + 1]! < 110) accent++;
  }
  assert.ok(accent > 10, `expected a visible pin, found ${accent} accent pixels`);
});

test('tall buildings do not overflow the top of the frame', () => {
  const tall = testScene();
  tall.buildings[0]!.height = 300;
  tall.stats.maxHeight = 300;
  const image = renderScene(tall, { width: 400, scale: 1, verticalExaggeration: 2 });

  // The topmost row should still be sky, i.e. nothing was clipped off.
  const theme = image.theme;
  for (let x = 0; x < image.width; x++) {
    const i = x * 4;
    const isSky =
      image.raster.data[i] === theme.sky[0] &&
      image.raster.data[i + 1] === theme.sky[1] &&
      image.raster.data[i + 2] === theme.sky[2];
    if (!isSky) {
      // Labels legitimately occupy the top-left corner.
      assert.ok(x < image.width * 0.5, `geometry reached the top edge at x=${x}`);
    }
  }
});
