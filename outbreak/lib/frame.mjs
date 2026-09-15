/**
 * Frame composition: map crop + HUD + timeline.
 *
 * Split from the map painter because the two have completely different costs.
 * The map is rasterised once and then only repainted where a district changed;
 * a frame here is a crop plus a few hundred glyph blits, which is cheap enough
 * to do 30 times a second.
 */

import { drawText, measureText, ASCENDER_ROWS } from '../../dist/index.js';
import { STATES, THEME, cropTo, screenOf, viewport, projectWithViewport } from './paint.mjs';

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

export const LAYOUT = {
  width: 1280,
  height: 720,
  /** Height of the top band carrying the day counter and the totals. */
  headerH: 86,
  /** Height of the bottom band carrying the timeline and the legend. */
  footerH: 96,
};

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

function fillRect(raster, x, y, w, h, color) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(raster.width, Math.ceil(x + w));
  const y1 = Math.min(raster.height, Math.ceil(y + h));
  const data = raster.data;
  for (let py = y0; py < y1; py++) {
    let p = (py * raster.width + x0) * 4;
    for (let px = x0; px < x1; px++) {
      data[p] = color[0];
      data[p + 1] = color[1];
      data[p + 2] = color[2];
      data[p + 3] = 255;
      p += 4;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Text helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Text with the ascender rows reserved above the glyph box. */
function labelTop(raster, text, x, y, color, scale = 2, shadow = [0, 0, 0]) {
  drawText(raster, text, x, y + ASCENDER_ROWS * scale, color, { scale, shadow });
}

function rightAligned(raster, text, right, y, color, scale = 2, shadow = [0, 0, 0]) {
  const { width } = measureText(text, { scale });
  drawText(raster, text, right - width, y + ASCENDER_ROWS * scale, color, { scale, shadow });
}

/** Thousands separators, because 10,000,000 is unreadable at a glance. */
export function thousands(n) {
  const rounded = Math.round(n);
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Day N as a date, counted from a fixed start so the run is reproducible. */
export function dateFor(day, start = new Date(Date.UTC(2026, 8, 14))) {
  const d = new Date(start.getTime() + day * 86_400_000);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/* -------------------------------------------------------------------------- */
/* Frame                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Composites one frame.
 *
 * `view` is the camera: where to look and how far in. The crop is taken from
 * the map raster, so a zoom never invalidates the per-district pixel lists.
 */
export function composeFrame(map, context) {
  const {
    view,
    day,
    stats,
    headline,
    focus,
    legend = true,
    timeline,
    subtitle,
    maxDays,
  } = context;

  const { width, height, headerH, footerH } = LAYOUT;

  const raster = cropTo(map, {
    ...view,
    outWidth: width,
    outHeight: height,
    // Centre the map in the band between the header and the footer, not in
    // the frame — otherwise the region's top and bottom disappear under them.
    atY: headerH + (height - headerH - footerH) / 2,
  });

  /* --- Vignette ---------------------------------------------------------- */
  //
  // Darkens the four edges without touching the centre. Cheap, and it stops
  // the corners of a mostly-empty map reading as dead space.
  for (let y = 0; y < height; y++) {
    const dy = Math.abs(y / height - 0.5) * 2;
    for (let x = 0; x < width; x++) {
      const dx = Math.abs(x / width - 0.5) * 2;
      const edge = Math.max(dx, dy);
      if (edge < 0.55) continue;
      const alpha = (edge - 0.55) / 0.45 * 0.55;
      const p = (y * width + x) * 4;
      raster.data[p] *= 1 - alpha;
      raster.data[p + 1] *= 1 - alpha;
      raster.data[p + 2] *= 1 - alpha;
    }
  }

  /* --- Header ------------------------------------------------------------ */

  fillRect(raster, 0, 0, width, headerH, THEME.void);
  fillRect(raster, 0, headerH, width, 1, [46, 60, 88]);

  const pad = 22;
  labelTop(raster, `DAY ${day}`, pad, 14, THEME.ink, 4);
  labelTop(raster, dateFor(day), pad + measureText(`DAY ${day}`, { scale: 4 }).width + 18, 22, THEME.dim, 2);

  // The three numbers that matter, right-aligned in a fixed grid so they do
  // not jitter as the digits change. The column is sized from the widest
  // value it will ever hold — "12,733,998" is ten glyphs — not from a guess.
  const columns = [
    { caption: 'POPULATION LOST', value: `${(stats.prevalence * 100).toFixed(1)}%`, color: THEME.accent },
    { caption: 'TURNED', value: thousands(stats.turned), color: THEME.ink },
    { caption: 'DISTRICTS LOST', value: `${stats.collapsed} / ${stats.total}`, color: THEME.dim },
  ];
  const columnWidth = measureText('12,733,998', { scale: 3 }).width + 46;
  let cx = width - pad - columnWidth * columns.length;
  for (const column of columns) {
    labelTop(raster, column.caption, cx, 22, THEME.dim, 2);
    rightAligned(raster, column.value, cx + columnWidth - 22, 44, column.color, 3);
    cx += columnWidth;
  }

  /* --- Headline ---------------------------------------------------------- */

  if (headline) {
    fillRect(raster, pad, headerH + 16, measureText(headline, { scale: 3 }).width + 28, 40, THEME.void);
    labelTop(raster, headline, pad + 14, headerH + 28, THEME.ink, 3);
  }

  /* --- Focus marker ------------------------------------------------------ */

  if (focus) {
    const [fx, fy] = screenOf(map, focus.lon, focus.lat);
    const frameView = {
      ...view,
      outWidth: width,
      outHeight: height,
      atY: headerH + (height - headerH - footerH) / 2,
    };
    const [sx, sy] = projectWithViewport(viewport(map, frameView), fx, fy);
    if (sx > -20 && sx < width + 20 && sy > headerH && sy < height - footerH) {
      drawMarker(raster, sx, sy, focus.color ?? THEME.seed, focus.label);
    }
  }

  /* --- Footer ------------------------------------------------------------ */

  fillRect(raster, 0, height - footerH, width, footerH, THEME.void);
  fillRect(raster, 0, height - footerH, width, 1, [46, 60, 88]);

  if (timeline) {
    drawTimeline(raster, timeline, maxDays, pad, height - footerH + 10, width - pad * 2, 32);
  }

  if (legend) drawLegend(raster, pad, height - 42);

  labelTop(raster, subtitle ?? 'OpenStreetMap boundary data · Wikidata populations', pad, height - 24, [88, 104, 134], 1);

  return raster;
}

/**
 * A crosshair over the epicentre. Drawn as four detached arms rather than a
 * circle so it reads as a sight on a moving map and never hides the district
 * underneath it.
 */
function drawMarker(raster, x, y, color, text) {
  const gap = 9;
  const arm = 13;
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    const x0 = Math.round(x + dx * gap);
    const y0 = Math.round(y + dy * gap);
    fillRect(raster, Math.min(x0, x0 + dx * arm), Math.min(y0, y0 + dy * arm), dx ? arm : 2, dy ? arm : 2, color);
  }
  fillRect(raster, Math.round(x) - 1, Math.round(y) - 1, 3, 3, color);
  if (text) {
    const w = measureText(text, { scale: 2 }).width;
    fillRect(raster, x - w / 2 - 7, y - 44, w + 14, 26, [6, 9, 18], 0.82);
    labelTop(raster, text, x - w / 2, y - 40, color, 2);
  }
}

/**
 * The outbreak curve over the run so far, with the full run behind it as a
 * faint ghost.
 *
 * Two series rather than one: the ghost shows where this is going, which is
 * what makes the early days — where the line is flat and nothing appears to be
 * happening — legible as a story rather than as a still image. Both are scaled
 * to the same vertical extent, so the gap between them is the remaining
 * outbreak and shrinks to nothing by the end.
 */
function drawTimeline(raster, series, maxDays, x, y, width, height) {
  const n = series.live?.length ?? 0;
  if (n < 2) return;
  const step = width / Math.max(1, maxDays - 1);
  const baseline = y + height;

  // The ghost of the whole run, drawn first so the live curve covers it.
  if (series.ghost) {
    const ghost = series.ghost;
    const ghostStep = width / Math.max(1, ghost.length - 1);
    for (let i = 0; i < ghost.length; i++) {
      const h = Math.min(1, ghost[i]) * height;
      if (h < 1) continue;
      fillRect(raster, x + Math.round(i * ghostStep), baseline - h, 1, h, [34, 44, 66]);
    }
  }

  const live = series.live ?? [];
  for (let i = 0; i < live.length; i++) {
    const value = Math.min(1, live[i]);
    const h = Math.max(0, value) * height;
    const w = Math.max(1, Math.ceil(step));
    const color =
      value > 0.9 ? STATES.dead.fill : value > 0.5 ? STATES.collapsed.fill : STATES.infected.fill;
    fillRect(raster, x + Math.round(i * step), baseline - h, w, h, color);
  }

  fillRect(raster, x, baseline, width, 1, [70, 84, 112]);
}

function drawLegend(raster, x, y) {
  let cx = x;
  for (const state of Object.values(STATES)) {
    fillRect(raster, cx, y, 10, 10, state.fill);
    fillRect(raster, cx, y, 10, 1, [10, 14, 24]);
    labelTop(raster, state.label, cx + 15, y - 1, THEME.dim, 1);
    cx += 15 + measureText(state.label, { scale: 1 }).width + 18;
  }
}
