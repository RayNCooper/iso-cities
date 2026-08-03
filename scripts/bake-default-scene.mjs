#!/usr/bin/env node
/**
 * Bakes the demo page's opening view into a static file.
 *
 * Without this, every single visit to the demo fires a geocode and an Overpass
 * query just to draw the first picture — which is rude to volunteer-run
 * infrastructure and slow for the visitor. The scene is fetched once here, at
 * build time, and committed; the page then draws it with no network at all.
 *
 * A built Scene is plain data, so it survives a JSON round trip and can be
 * handed straight to renderScene — which means the theme picker works on the
 * default view too, still without a request.
 *
 * Run deliberately (`npm run bake`), not as part of the normal build: it needs
 * the network, and CI must not.
 */

import { writeFile } from 'node:fs/promises';

import {
  ASCENDER_ROWS,
  GLYPH_HEIGHT,
  Raster,
  bboxAround,
  buildScene,
  drawText,
  encodePng,
  fetchOsmData,
  geocode,
  hex,
  measureText,
  renderScene,
  ResponseCache,
} from '../dist/index.js';

const QUERY = { q: 'Reichstag, Berlin' };
const RADIUS = 400;
const OUT = 'web/default-scene.json';

/** Coordinate precision. 0.1 m is far finer than any pixel this renders to. */
const round = (n, places) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/**
 * Shrinks the scene for shipping. Full float precision on every vertex roughly
 * doubles the file for detail that is thousands of times smaller than a pixel.
 */
function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (typeof v === 'number') {
        if (key === 'lat' || key === 'lon') out[key] = round(v, 6);
        else if (key === 'x' || key === 'y') out[key] = round(v, 1);
        else if (key === 'area') out[key] = round(v, 0);
        else out[key] = round(v, 2);
      } else {
        out[key] = compact(v);
      }
    }
    return out;
  }
  return value;
}

const log = (m) => process.stderr.write(`${m}\n`);
const cache = new ResponseCache();

const place = await geocode(QUERY, { cache, onProgress: log });
log(`Resolved to ${place.displayName}`);

const data = await fetchOsmData(bboxAround(place.centre, RADIUS), { cache, onProgress: log });
const scene = buildScene(data, { place, radius: RADIUS, seed: 0 });

log(
  `Scene: ${scene.stats.buildings} buildings, ${scene.stats.roads} roads, ` +
    `${scene.stats.areas} areas, ${scene.stats.trees} trees`,
);

const payload = {
  // Recorded so the page can tell the user what it is showing, and so a stale
  // bake is obvious in a diff.
  bakedFrom: { query: QUERY, radius: RADIUS },
  scene: compact(scene),
};

const json = JSON.stringify(payload);
await writeFile(OUT, json);
log(`Wrote ${OUT} — ${(json.length / 1024).toFixed(0)} kB (before transfer compression)`);

/* -------------------------------------------------------------------------- */
/* Social card                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The share image is a real render with the title set in the project's own
 * bitmap font — so the card is a genuine sample of the output rather than a
 * mockup of it, and it cannot go stale as the renderer changes.
 */
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

const card = renderScene(scene, {
  theme: 'daylight',
  width: OG_WIDTH,
  height: OG_HEIGHT,
  scale: 1,
  // The card carries its own wording; the in-image labels would collide.
  title: false,
  subtitle: false,
  attribution: false,
});

const raster = card.raster;
const ink = card.theme.text;
const paper = card.theme.textShadow ?? undefined;

const TITLE_SCALE = 7;
const SUB_SCALE = 3;
const FOOT_SCALE = 2;
const pad = 52;

const LINES = [
  { text: 'iso-cities', scale: TITLE_SCALE, gap: 18 },
  { text: 'any city as isometric pixel art', scale: SUB_SCALE, gap: 10 },
  { text: 'from real OpenStreetMap data', scale: SUB_SCALE, gap: 0 },
];

const blockWidth = Math.max(...LINES.map((l) => measureText(l.text, { scale: l.scale }).width));
const blockHeight = LINES.reduce((h, l) => h + GLYPH_HEIGHT * l.scale + l.gap, 0);

/**
 * A flat panel behind the wording. Without it the smaller lines cross into the
 * rooftops and stop being readable — and a share card that cannot be read at
 * thumbnail size is not doing its job.
 */
const inset = 22;
const panel = {
  x0: pad - inset,
  y0: pad - inset,
  x1: pad + blockWidth + inset,
  y1: pad + blockHeight + inset,
};
for (let py = panel.y0; py <= panel.y1; py++) {
  for (let px = panel.x0; px <= panel.x1; px++) {
    const edge =
      px === panel.x0 || px === panel.x1 || py === panel.y0 || py === panel.y1;
    raster.blend(px, py, edge ? ink : (paper ?? [255, 255, 255]), edge ? 0.9 : 0.9);
  }
}

let y = pad + ASCENDER_ROWS * TITLE_SCALE;
for (const line of LINES) {
  drawText(raster, line.text, pad, y, ink, { scale: line.scale });
  y += GLYPH_HEIGHT * line.scale + line.gap;
}

const footer = '© OpenStreetMap contributors';
drawText(
  raster,
  footer,
  pad,
  OG_HEIGHT - pad - GLYPH_HEIGHT * FOOT_SCALE,
  ink,
  { scale: FOOT_SCALE, shadow: paper },
);

await writeFile('web/og.png', encodePng(raster.data, raster.width, raster.height, { alpha: false }));
log(`Wrote web/og.png — ${OG_WIDTH}x${OG_HEIGHT} (title width ${measureText('iso-cities', { scale: TITLE_SCALE }).width}px)`);

/* -------------------------------------------------------------------------- */
/* Touch icon                                                                 */
/* -------------------------------------------------------------------------- */

/** One isometric block in Olio's indigo, drawn with the same rasteriser. */
function drawIcon(size) {
  const icon = new Raster(size, size, hex('#4f46e5'));
  const cx = size / 2;
  const cy = size * 0.46;
  const w = size * 0.27;
  const h = size * 0.24;
  const top = hex('#e0e7ff');
  const left = hex('#8b93f0');
  const right = hex('#6d76e8');

  const poly = (points, color) => icon.fillPath([points], () => color);
  poly(
    [
      { x: cx, y: cy - w / 2 },
      { x: cx + w, y: cy },
      { x: cx, y: cy + w / 2 },
      { x: cx - w, y: cy },
    ],
    top,
  );
  poly(
    [
      { x: cx - w, y: cy },
      { x: cx, y: cy + w / 2 },
      { x: cx, y: cy + w / 2 + h },
      { x: cx - w, y: cy + h },
    ],
    left,
  );
  poly(
    [
      { x: cx + w, y: cy },
      { x: cx, y: cy + w / 2 },
      { x: cx, y: cy + w / 2 + h },
      { x: cx + w, y: cy + h },
    ],
    right,
  );
  return icon;
}

const icon = drawIcon(180);
await writeFile(
  'web/apple-touch-icon.png',
  encodePng(icon.data, icon.width, icon.height, { alpha: false }),
);
log('Wrote web/apple-touch-icon.png — 180x180');
