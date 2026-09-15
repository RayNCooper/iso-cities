#!/usr/bin/env node
/**
 * Renders the outbreak film.
 *
 *   data/region.json  ->  outbreak.json (the simulation)  ->  PNG frames  ->  MP4
 *
 * The simulation is computed first and in full, so the frame renderer is a
 * pure function of (day, camera). That means a change to the camera or the HUD
 * never re-runs the model, and the same seed always gives the same film.
 *
 * Usage:
 *   node outbreak/render.mjs --sim-only          # just recompute the model
 *   node outbreak/render.mjs --frames 0,100      # a few stills, for checking
 *   node outbreak/render.mjs                     # the whole film
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { encodePng } from '../dist/index.js';
import { buildModel, roadGraph, simulate, fallOrder, unitTimeline } from './lib/sim.mjs';
import { buildMap, paintStates, statesFor } from './lib/paint.mjs';
import { composeFrame, thousands, LAYOUT } from './lib/frame.mjs';

const HERE = import.meta.dirname;
const DATA = join(HERE, 'data');
const OUT = join(HERE, 'out');

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = args[at + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};

const SIM_ONLY = Boolean(flag('sim-only', false));
const FRAMES = flag('frames', null);
const FPS = Number(flag('fps', 30));
const SEED = Number(flag('seed', 20260914));
/**
 * Days of outbreak per second of footage. At 30 fps and 2.2 days/s a full
 * collapse runs about two minutes, which is the right length for a piece whose
 * whole content is the shape of the front.
 */
const DAYS_PER_SECOND = Number(flag('speed', 2.2));
const MAX_DAYS = 420;

const log = (m) => process.stderr.write(`${m}\n`);

/* -------------------------------------------------------------------------- */
/* Load                                                                       */
/* -------------------------------------------------------------------------- */

const region = JSON.parse(await readFile(join(DATA, 'region.json'), 'utf8'));
log(
  `Region: ${region.region.name} — ${region.units.length} Kreise, ` +
    `${region.units.reduce((n, u) => n + u.children.length, 0)} districts, ` +
    `${region.roads.length} roads`,
);

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

const model = buildModel(region, { seed: SEED });
/**
 * The model's own compartment count, not the geometry's child count: two
 * kreisfreie Städte have no districts in OSM and enter the model as a single
 * compartment each, so the two numbers legitimately differ by two.
 */
const cellCount = model.cells.length;
log(`Building model: ${cellCount} compartments, ${thousands(model.totalPopulation)} people`);

const frame = {
  lat: model.origin.lat,
  lon: model.origin.lon,
  kx: model.origin.kx,
  ky: model.origin.ky,
};
const roads = roadGraph(region.roads, model.cells, frame);
log(`  ${roads.size} road corridors linking districts`);

/* Where patient zero is: Eicken, in Mönchengladbach. */
const seedCell = model.cells.find((cell) => cell.name === 'Eicken');
if (!seedCell) throw new Error('Seed district "Eicken" not found in the model');
log(`  patient zero: ${seedCell.name}, ${seedCell.parentName} (${thousands(seedCell.population)} people)`);

const result = simulate(model, {
  seedCellId: seedCell.id,
  days: MAX_DAYS,
  reportEvery: 2,
  onProgress: (day, prevalence) => {
    if (day % 40 === 0) log(`  day ${String(day).padStart(3)} — ${(prevalence * 100).toFixed(1)}% turned`);
  },
});

const final = result.snapshots[result.snapshots.length - 1];
log(
  `Outbreak: ${result.days} days, ${thousands(final.turned)} turned ` +
    `(${(final.prevalence * 100).toFixed(1)}%), ${final.collapsed} districts overrun`,
);

const order = fallOrder(result, { count: 12 });
log('  first to fall:');
for (const entry of order) {
  log(`    day ${String(entry.day).padStart(3)}  ${entry.cell.name} (${entry.cell.parentName})`);
}
const units = unitTimeline(result).filter((u) => Number.isFinite(u.firstDay));
log(`  days until every Kreis was reached: last at day ${units[units.length - 1]?.firstDay}`);

/* -------------------------------------------------------------------------- */
/* Simulation artefact                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The compact simulation record. Written for two audiences: the frame renderer
 * below, and anyone who wants to check the numbers without re-running the
 * model or owning the geometry.
 */
const summary = {
  generated: new Date().toISOString(),
  seed: SEED,
  region: region.region.name,
  attribution: region.attribution,
  patientZero: {
    district: seedCell.name,
    city: seedCell.parentName,
    population: seedCell.population,
  },
  totals: {
    population: result.totalPopulation,
    districts: cellCount,
    areas: region.units.length,
  },
  duration: result.days,
  final: {
    turned: Math.round(final.turned),
    turnedShare: final.prevalence,
    collapsedDistricts: final.collapsed,
  },
  timeline: result.snapshots
    .filter((s) => s.day % 7 === 0)
    .map((s) => ({ day: s.day, turned: Math.round(s.turned), affected: s.affected, collapsed: s.collapsed })),
  kreise: unitTimeline(result).map((u) => ({
    name: u.name,
    population: u.population,
    firstDay: Number.isFinite(u.firstDay) ? u.firstDay : null,
    fallenSubUnits: u.fallenSubUnits,
    subUnits: u.subUnits,
  })),
  firstToFall: order.map((e) => ({
    district: e.cell.name,
    area: e.cell.parentName,
    day: e.day,
    population: e.population,
  })),
};

await mkdir(DATA, { recursive: true });
await writeFile(join(DATA, 'outbreak.json'), JSON.stringify(summary, null, 2));
log(`Wrote data/outbreak.json`);

if (SIM_ONLY) process.exit(0);

/* -------------------------------------------------------------------------- */
/* Map and frames                                                             */
/* -------------------------------------------------------------------------- */

log('Rasterising the map …');
const map = buildMap(region);
log(`  map raster: ${map.width}×${map.height}px at ${map.scale} px/m`);

/** Links each drawn district back to its simulation cell. */
for (const shape of map.shapes) {
  const cell = model.cells.find((c) => c.id === shape.id);
  shape.cellIndex = cell ? model.cellIndex.get(cell.id) : -1;
}
const unmatched = map.shapes.filter((s) => s.cellIndex < 0).length;
if (unmatched > 0) log(`  ${unmatched} drawn districts have no simulation cell`);

const totalDistricts = map.shapes.length;

/* --- Camera ----------------------------------------------------------------- */

const seedCellRef = model.cells[model.cellIndex.get(seedCell.id)];
/** Where Eicken sits in map-raster pixels — the point the film opens on. */
const seedScreen = map.toScreen(
  (seedCellRef.lon - frame.lon) * frame.kx,
  -(seedCellRef.lat - frame.lat) * frame.ky,
);

/**
 * The camera.
 *
 * The map raster is authored so the whole region is exactly `map.width` wide,
 * which makes the minimum zoom — the value that fits the region into the
 * frame's usable band, between the header and the footer — the region view.
 * Everything above it is a magnification, so pixel art is only ever upscaled.
 *
 * The film opens tight on Eicken, holds there through the city's collapse,
 * then pulls back to the region. The pull-back *is* the story: it is the
 * moment the outbreak stops being a Mönchengladbach problem.
 */
const USABLE_HEIGHT = LAYOUT.height - LAYOUT.headerH - LAYOUT.footerH;
const MIN_ZOOM = Math.min(LAYOUT.width / map.width, USABLE_HEIGHT / map.height);
const SEED_ZOOM = MIN_ZOOM * 7;

function cameraFor(day, totalDays) {
  const t = day / Math.max(1, totalDays);
  const ease = (u) => u * u * (3 - 2 * u);

  const from = seedScreen;
  const to = [map.width / 2, map.height / 2];

  let zoom;
  if (t < 0.12) {
    zoom = SEED_ZOOM;
  } else if (t < 0.32) {
    zoom = SEED_ZOOM + (MIN_ZOOM * 1.9 - SEED_ZOOM) * ease((t - 0.12) / 0.2);
  } else if (t < 0.9) {
    // A slow drift inward across the region to keep the composition alive.
    zoom = MIN_ZOOM * (1.9 + (1.25 - 1.9) * ease((t - 0.32) / 0.58));
  } else {
    zoom = MIN_ZOOM * (1.25 + (1 - 1.25) * ease((t - 0.9) / 0.1));
  }

  let cx;
  let cy;
  if (t < 0.12) {
    cx = from[0];
    cy = from[1];
  } else if (t < 0.32) {
    const u = ease((t - 0.12) / 0.2);
    cx = from[0] + (to[0] - from[0]) * u;
    cy = from[1] + (to[1] - from[1]) * u;
  } else {
    // Drifting centre, so the finished map is not a static rectangle.
    const u = (t - 0.32) / 0.68;
    cx = to[0] + Math.sin(u * Math.PI * 0.8) * map.width * 0.04;
    cy = to[1] + (u - 0.5) * map.height * 0.08;
  }

  return { x: cx, y: cy, zoom: Math.max(MIN_ZOOM, zoom) };
}

/* --- Frame loop -------------------------------------------------------------- */

const frameDir = join(OUT, 'frames');
if (FRAMES) {
  await mkdir(frameDir, { recursive: true });
  const days = String(FRAMES).split(',').map(Number);
  for (const day of days) {
    const snapshot = result.snapshots.find((s) => s.day === day);
    if (!snapshot) {
      log(`  no snapshot at day ${day}; have ${result.snapshots.length}`);
      continue;
    }
    const state = statesFor(snapshot, model);
    paintStates(map, state, null);
    const image = composeFrame(map, {
      view: cameraFor(day, result.days),
      day,
      stats: statsFor(snapshot),
      headline: headlineFor(snapshot, model),
      focus: { lon: seedCell.lon, lat: seedCell.lat },
      timeline: {
        live: result.snapshots.filter((s) => s.day <= day).map((s) => s.prevalence),
        ghost: result.snapshots.map((s) => s.prevalence),
      },
      maxDays: result.snapshots.length,
      subtitle: 'OpenStreetMap boundary data · Wikidata populations',
    });
    const file = join(frameDir, `day-${String(day).padStart(4, '0')}.png`);
    await writeFile(file, encodePng(image.data, image.width, image.height, { alpha: false }));
    log(`  wrote ${file}`);
  }
  process.exit(0);
}

/** Everything the HUD reports, derived from the snapshot rather than tracked. */
function statsFor(snapshot) {
  return {
    turned: snapshot.turned,
    prevalence: snapshot.prevalence,
    collapsed: snapshot.collapsed,
    total: totalDistricts,
    affected: snapshot.affected,
  };
}

/** A one-line summary of what the outbreak is doing right now. */
function headlineFor(snapshot, model) {
  const day = snapshot.day;
  if (day < 2) return `PATIENT ZERO — ${seedCell.name.toUpperCase()}, ${seedCell.parentName.toUpperCase()}`;
  const fresh = [];
  for (let i = 0; i < model.cells.length; i++) {
    if (snapshot.cells.firstCaseDay[i] === day || snapshot.cells.firstCaseDay[i] === day - 1) {
      fresh.push(model.cells[i]);
    }
  }
  if (fresh.length === 0) return null;
  fresh.sort((a, b) => b.population - a.population);
  const biggest = fresh[0];
  const extra = fresh.length > 1 ? `  (+${fresh.length - 1} more)` : '';
  return `NEW FOCUS: ${biggest.name.toUpperCase()}, ${biggest.parentName.toUpperCase()}${extra}`;
}

await mkdir(frameDir, { recursive: true });

const totalFrames = Math.ceil(result.days / DAYS_PER_SECOND * FPS);
const daysPerFrame = DAYS_PER_SECOND / FPS;
const reportEvery = result.snapshots[1].day - result.snapshots[0].day;
/** The whole run's curve, drawn behind the live one as a faint ghost. */
const ghost = result.snapshots.map((s) => s.prevalence);
/** Snapshot index for a day, so the loop is not a linear scan per frame. */
const snapshotForDay = (day) =>
  result.snapshots[Math.min(result.snapshots.length - 1, Math.floor(day / reportEvery))];
log(`Rendering ${totalFrames} frames at ${FPS}fps (${DAYS_PER_SECOND} days/s) …`);

let previousState = null;
let written = 0;
for (let f = 0; f < totalFrames; f++) {
  const day = Math.min(result.days - 1, Math.round(f * daysPerFrame));
  const snapshot = snapshotForDay(day);
  const state = statesFor(snapshot, model);
  paintStates(map, state, previousState);
  previousState = state;

  const upTo = {
    live: result.snapshots.filter((s) => s.day <= snapshot.day).map((s) => s.prevalence),
    ghost,
  };
  const image = composeFrame(map, {
    view: cameraFor(day, result.days),
    day,
    stats: statsFor(snapshot),
    headline: headlineFor(snapshot, model),
    focus: { lon: seedCell.lon, lat: seedCell.lat },
    timeline: upTo,
    maxDays: result.snapshots.length,
  });

  const file = join(frameDir, `frame-${String(f).padStart(5, '0')}.png`);
  await writeFile(file, encodePng(image.data, image.width, image.height, { alpha: false }));
  written++;
  if (f % 120 === 0) log(`  frame ${f}/${totalFrames} — day ${day}`);
}

log(`Wrote ${written} frames to ${frameDir}`);

/* -------------------------------------------------------------------------- */
/* Encode                                                                     */
/* -------------------------------------------------------------------------- */

const mp4 = join(OUT, 'outbreak-rheinland-ruhr.mp4');
log('Encoding …');
const ffmpeg = spawnSync(
  'ffmpeg',
  [
    '-y',
    '-framerate', String(FPS),
    '-i', join(frameDir, 'frame-%05d.png'),
    '-vf', 'scale=1280:720:flags=neighbor',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    mp4,
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
if (ffmpeg.status !== 0) throw new Error(`ffmpeg failed with status ${ffmpeg.status}`);

log(`Wrote ${mp4}`);
const { size } = await stat(mp4);
log(`  ${(size / 1024 / 1024).toFixed(1)} MB`);
