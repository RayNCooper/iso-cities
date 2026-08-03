// Demo page wiring. The library does the work; this file collects input,
// reports progress, and puts the finished pixels on a canvas.
//
// The one idea worth knowing: fetching map data and drawing it are separate
// steps, so the built scene is kept in memory. Changing the theme, the size or
// the shadows re-runs only the draw — instantly, with no network at all.

import {
  MemoryCache,
  THEMES,
  THEME_NAMES,
  DEFAULT_THEME,
  renderCityToImageData,
  renderScene,
} from './dist/browser.js';

const $ = (id) => document.getElementById(id);

const els = {
  form: $('controls'),
  query: $('query'),
  themeGrid: $('themeGrid'),
  radius: $('radius'),
  radiusOut: $('radiusOut'),
  width: $('width'),
  widthOut: $('widthOut'),
  region: $('region'),
  trees: $('trees'),
  shadows: $('shadows'),
  advanced: $('advanced'),
  highlight: $('highlight'),
  center: $('center'),
  centerRow: $('centerRow'),
  stage: $('stage'),
  loaderText: $('loaderText'),
  render: $('render'),
  download: $('download'),
  status: $('status'),
  stats: $('stats'),
  canvas: $('canvas'),
};

// One cache for the session, so a repeated query costs nothing.
const cache = new MemoryCache({ maxEntries: 24 });
const ctx = els.canvas.getContext('2d');

let inFlight = null;
let lastPlaceName = 'city';
let theme = DEFAULT_THEME;
/** The most recent built scene, and the inputs that produced it. */
let scene = null;
let sceneKey = null;

/* --------------------------------------------------------------- theme grid */

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const shaded = (c, f) => `rgb(${c.map((v) => Math.round(Math.min(255, v * f))).join(',')})`;

/** One isometric block, as three SVG polygons. */
function cube(cx, cy, h, w, roof, wall, ink) {
  const top = `${cx},${cy - w / 2} ${cx + w},${cy} ${cx},${cy + w / 2} ${cx - w},${cy}`;
  const left = `${cx - w},${cy} ${cx},${cy + w / 2} ${cx},${cy + w / 2 + h} ${cx - w},${cy + h}`;
  const right = `${cx + w},${cy} ${cx},${cy + w / 2} ${cx},${cy + w / 2 + h} ${cx + w},${cy + h}`;
  return (
    `<polygon points="${left}" fill="${shaded(wall, 0.72)}" stroke="${ink}" stroke-width=".5"/>` +
    `<polygon points="${right}" fill="${shaded(wall, 0.9)}" stroke="${ink}" stroke-width=".5"/>` +
    `<polygon points="${top}" fill="${rgb(roof)}" stroke="${ink}" stroke-width=".5"/>`
  );
}

/**
 * A miniature of what the theme actually produces, drawn from its real
 * colours — so the swatch cannot drift from the renderer.
 */
function swatch(t) {
  const ink = rgb(t.outline);
  const ground = rgb(t.ground[0]);
  const green = rgb(t.green.park[0]);
  return `
    <svg viewBox="0 0 64 42" aria-hidden="true">
      <rect width="64" height="42" fill="${rgb(t.sky)}"/>
      <polygon points="32,6 62,21 32,36 2,21" fill="${ground}"/>
      <polygon points="14,24 24,29 14,34 4,29" fill="${green}"/>
      ${cube(24, 16, 9, 8, t.roofs[0], t.walls[0], ink)}
      ${cube(40, 20, 6, 8, t.roofs[2], t.walls[2], ink)}
      ${cube(32, 26, 8, 8, t.roofs[5], t.walls[5], ink)}
    </svg>`;
}

function buildThemeGrid() {
  els.themeGrid.innerHTML = '';
  for (const name of THEME_NAMES) {
    const t = THEMES[name];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card';
    card.dataset.theme = name;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(name === theme));
    card.title = t.description;
    card.innerHTML = `${swatch(t)}<span class="theme-name">${name}</span>`;
    card.addEventListener('click', () => selectTheme(name));
    els.themeGrid.append(card);
  }
}

function selectTheme(name) {
  if (name === theme) return;
  theme = name;
  for (const card of els.themeGrid.children) {
    card.setAttribute('aria-checked', String(card.dataset.theme === name));
  }
  render();
}

/* ------------------------------------------------------------------ loading */

const LOADING_MESSAGES = [
  'Building your city…',
  'Extruding rooftops…',
  'Laying out streets…',
  'Planting trees…',
  'Placing every pixel…',
];
let messageTimer = null;

function startLoading() {
  els.stage.classList.add('is-loading');
  let i = 0;
  els.loaderText.textContent = LOADING_MESSAGES[0];
  clearInterval(messageTimer);
  messageTimer = setInterval(() => {
    i = (i + 1) % LOADING_MESSAGES.length;
    els.loaderText.textContent = LOADING_MESSAGES[i];
  }, 2200);
}

function stopLoading() {
  els.stage.classList.remove('is-loading');
  clearInterval(messageTimer);
  messageTimer = null;
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
}

/* -------------------------------------------------------------------- input */

const syncOutputs = () => {
  els.radiusOut.textContent = els.radius.value;
  els.widthOut.textContent = els.width.value;
};

// A region render is framed by its boundary, so the detail slider and the
// centring option stop meaning anything. Show that rather than leaving
// live-looking controls that quietly do nothing.
const syncRegion = () => {
  const off = els.region.checked;
  els.radius.disabled = off;
  els.radius.closest('label').classList.toggle('is-disabled', off);
  els.center.disabled = off;
  els.centerRow.classList.toggle('is-disabled', off);
};

/** Options that change the drawing but not the underlying map data. */
function renderOptions() {
  return {
    theme,
    width: Number(els.width.value),
    scale: 1,
    shadows: els.shadows.checked,
  };
}

/** Options that decide what gets fetched and built. */
function sceneOptions() {
  const highlightText = els.highlight.value.trim();
  const options = {
    cache,
    radius: Number(els.radius.value),
    region: els.region.checked,
    layers: { trees: els.trees.checked },
  };
  if (highlightText) {
    options.highlight = { q: highlightText };
    options.centerOnHighlight = els.center.checked;
  }
  return { options, highlightText };
}

/** Identity of the scene, so we know when a redraw is enough. */
function keyFor(query, options) {
  return JSON.stringify([
    query.q,
    options.radius,
    options.region,
    options.highlight?.q ?? null,
    options.centerOnHighlight ?? false,
    options.layers.trees,
  ]);
}

function paint(width, height, pixels) {
  els.canvas.width = width;
  els.canvas.height = height;
  const image = new ImageData(width, height);
  image.data.set(pixels);
  ctx.putImageData(image, 0, 0);
  els.download.disabled = false;
}

function slugify(name) {
  return (
    Array.from(name.normalize('NFD'))
      .filter((ch) => {
        const code = ch.codePointAt(0);
        return code < 0x0300 || code > 0x036f;
      })
      .join('')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'city'
  );
}

/* --------------------------------------------------------------------- hash */

function updateHash(query, highlightText) {
  const params = new URLSearchParams({ q: query.q });
  if (els.region.checked) params.set('region', '1');
  else params.set('r', els.radius.value);
  if (theme !== DEFAULT_THEME) params.set('theme', theme);
  if (highlightText) {
    params.set('at', highlightText);
    if (els.center.checked) params.set('center', '1');
  }
  history.replaceState(null, '', `#${params.toString()}`);
}

function applyHash() {
  if (!location.hash.length) return;
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get('q')) els.query.value = params.get('q');
  if (params.get('at')) {
    els.highlight.value = params.get('at');
    els.advanced.open = true;
  }
  els.center.checked = params.get('center') === '1';
  if (params.get('theme') && THEME_NAMES.includes(params.get('theme'))) theme = params.get('theme');
  if (params.get('r')) els.radius.value = params.get('r');
  els.region.checked = params.get('region') === '1';
  syncOutputs();
  syncRegion();
}

/* ------------------------------------------------------------------- render */

/**
 * Redraws the scene already in memory. Synchronous and fast, so it only puts
 * the loader up for scenes big enough that the pause would be noticed.
 */
async function redraw() {
  const heavy = scene.stats.buildings > 15000;
  if (heavy) {
    startLoading();
    // Give the browser a frame to actually paint the loader before the
    // synchronous render takes the thread.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
  const image = renderScene(scene, renderOptions());
  paint(image.width, image.height, image.raster.data);
  setStatus(`${theme} — redrawn from map data already loaded`);
  if (heavy) stopLoading();
}

async function render(event) {
  event?.preventDefault();

  const query = { q: els.query.value.trim() };
  if (!query.q) {
    setStatus('Type a place first.', true);
    return;
  }
  const { options, highlightText } = sceneOptions();
  updateHash(query, highlightText);

  // Nothing about the map data changed — just draw it again.
  if (scene && keyFor(query, options) === sceneKey) {
    await redraw();
    return;
  }

  if (inFlight) inFlight.abort();
  const controller = new AbortController();
  inFlight = controller;

  els.render.disabled = true;
  els.download.disabled = true;
  els.stats.textContent = '';
  startLoading();
  setStatus('Starting…');

  try {
    const result = await renderCityToImageData(query, {
      ...options,
      ...renderOptions(),
      signal: controller.signal,
      onProgress: (message) => {
        if (!controller.signal.aborted) setStatus(message);
      },
    });
    if (controller.signal.aborted) return;

    scene = result.scene;
    sceneKey = keyFor(query, options);
    lastPlaceName = result.place.name;

    paint(result.imageData.width, result.imageData.height, result.imageData.data);

    const { buildings, roads, areas, trees } = result.scene.stats;
    els.stats.textContent =
      `${result.imageData.width}x${result.imageData.height} · ` +
      `${buildings.toLocaleString()} buildings · ${roads.toLocaleString()} roads · ` +
      `${areas.toLocaleString()} areas · ${trees.toLocaleString()} trees`;
    setStatus(`Done — ${result.place.displayName}`);
  } catch (error) {
    if (controller.signal.aborted) return;
    scene = null;
    sceneKey = null;
    setStatus(describe(error), true);
  } finally {
    if (inFlight === controller) {
      inFlight = null;
      els.render.disabled = false;
      stopLoading();
    }
  }
}

function describe(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/No match for/i.test(message)) return message;

  // A 504 from Overpass means its queue is full, not that anything is wrong
  // with the query — so say "busy, retry" rather than "make it smaller".
  if (/50[34]|busy|rate limited/i.test(message)) {
    return 'The public Overpass servers are busy right now (they queue by memory, so large areas wait longest). Try again in a moment, or reduce the detail.';
  }
  if (/Could not fetch map data|Overpass/i.test(message)) {
    return 'Overpass could not serve that area. Try less detail, or again in a moment.';
  }
  if (/Failed to fetch|NetworkError/i.test(message)) {
    return 'Network request failed — the public API may be rate limiting. Wait a few seconds and retry.';
  }
  return message;
}

/* -------------------------------------------------------------------- wiring */

// Let the canvas encode the PNG: faster than shipping a deflate implementation
// to the browser, and the bytes come out smaller too.
els.download.addEventListener('click', () => {
  els.canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${slugify(lastPlaceName)}-${theme}.png`;
    link.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
});

els.radius.addEventListener('input', syncOutputs);
els.width.addEventListener('input', syncOutputs);
els.region.addEventListener('change', syncRegion);

// Draw-only controls apply straight away; anything that needs new map data
// waits for the Render button, so dragging a slider cannot spam the API.
els.width.addEventListener('change', () => scene && render());
els.shadows.addEventListener('change', () => scene && render());

els.form.addEventListener('submit', render);

// A hash-only navigation does not reload the document, so without this the
// back button and pasted share links would silently do nothing. updateHash()
// uses replaceState, which deliberately does not fire this.
window.addEventListener('hashchange', () => {
  applyHash();
  buildThemeGrid();
  render();
});

applyHash();
buildThemeGrid();
syncOutputs();
syncRegion();
render();
