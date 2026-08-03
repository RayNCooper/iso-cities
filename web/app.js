// Demo page wiring. The library does the work; this file only collects input,
// reports progress and puts the finished pixels on a canvas.

import {
  MemoryCache,
  THEMES,
  THEME_NAMES,
  DEFAULT_THEME,
  renderCityToImageData,
} from './dist/browser.js';

const $ = (id) => document.getElementById(id);

const els = {
  form: $('controls'),
  query: $('query'),
  theme: $('theme'),
  radius: $('radius'),
  radiusOut: $('radiusOut'),
  width: $('width'),
  widthOut: $('widthOut'),
  region: $('region'),
  trees: $('trees'),
  shadows: $('shadows'),
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

// One cache for the session, so switching themes or nudging the radius does
// not re-query Overpass for map data we already hold.
const cache = new MemoryCache({ maxEntries: 24 });
const ctx = els.canvas.getContext('2d');

let inFlight = null;
let lastPlaceName = 'city';

for (const name of THEME_NAMES) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = `${name} — ${THEMES[name].description}`;
  option.selected = name === DEFAULT_THEME;
  els.theme.append(option);
}

const syncOutputs = () => {
  els.radiusOut.textContent = els.radius.value;
  els.widthOut.textContent = els.width.value;
};
els.radius.addEventListener('input', syncOutputs);
els.width.addEventListener('input', syncOutputs);
syncOutputs();

// A region render is framed by its boundary, so both the radius and the
// centring option stop meaning anything. Show that rather than leaving
// live-looking controls that quietly do nothing.
const syncRegion = () => {
  const disabled = els.region.checked;
  els.radius.disabled = disabled;
  els.radius.closest('label').classList.toggle('is-disabled', disabled);
  els.center.disabled = disabled;
  els.centerRow.classList.toggle('is-disabled', disabled);
};
els.region.addEventListener('change', syncRegion);
syncRegion();

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

/** Reads the form into the two argument objects the library expects. */
function readForm() {
  const query = { q: els.query.value.trim() };
  const highlightText = els.highlight.value.trim();

  const options = {
    cache,
    theme: els.theme.value,
    radius: Number(els.radius.value),
    width: Number(els.width.value),
    scale: 1,
    region: els.region.checked,
    shadows: els.shadows.checked,
    layers: { trees: els.trees.checked },
  };
  if (highlightText) {
    options.highlight = { q: highlightText };
    options.centerOnHighlight = els.center.checked;
  }
  return { query, options, highlightText };
}

/** Keeps the address bar shareable without touching history on every render. */
function updateHash(query, highlightText) {
  const params = new URLSearchParams({ q: query.q });
  if (els.region.checked) params.set('region', '1');
  if (els.theme.value !== DEFAULT_THEME) params.set('theme', els.theme.value);
  if (!els.region.checked) params.set('r', els.radius.value);
  if (highlightText) params.set('at', highlightText);
  if (highlightText && els.center.checked) params.set('center', '1');
  history.replaceState(null, '', `#${params.toString()}`);
}

function applyHash() {
  if (!location.hash.length) return;
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get('q')) els.query.value = params.get('q');
  if (params.get('at')) els.highlight.value = params.get('at');
  els.center.checked = params.get('center') === '1';
  if (params.get('theme') && THEME_NAMES.includes(params.get('theme'))) {
    els.theme.value = params.get('theme');
  }
  if (params.get('r')) els.radius.value = params.get('r');
  els.region.checked = params.get('region') === '1';
  syncOutputs();
  syncRegion();
}

async function render(event) {
  event?.preventDefault();
  if (inFlight) inFlight.abort();

  const controller = new AbortController();
  inFlight = controller;

  const { query, options, highlightText } = readForm();
  if (!query.q) {
    setStatus('Type a place first.', true);
    return;
  }

  els.render.disabled = true;
  els.download.disabled = true;
  els.stats.textContent = '';
  startLoading();
  setStatus('Starting…');
  updateHash(query, highlightText);

  try {
    const result = await renderCityToImageData(query, {
      ...options,
      signal: controller.signal,
      onProgress: (message) => {
        if (!controller.signal.aborted) setStatus(message);
      },
    });
    if (controller.signal.aborted) return;

    els.canvas.width = result.imageData.width;
    els.canvas.height = result.imageData.height;
    ctx.putImageData(result.imageData, 0, 0);

    lastPlaceName = result.place.name;
    const { buildings, roads, areas, trees } = result.scene.stats;
    els.stats.textContent =
      `${result.imageData.width}x${result.imageData.height} · ` +
      `${buildings.toLocaleString()} buildings · ${roads.toLocaleString()} roads · ` +
      `${areas.toLocaleString()} areas · ${trees.toLocaleString()} trees`;
    setStatus(`Done — ${result.place.displayName}`);
    els.download.disabled = false;
  } catch (error) {
    if (controller.signal.aborted) return;
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
    return 'The public Overpass servers are busy right now (they queue by memory, so big areas wait longest). Try again in a moment, or reduce the radius.';
  }
  if (/Could not fetch map data|Overpass/i.test(message)) {
    return 'Overpass could not serve that area. Try a smaller radius, or again in a moment.';
  }
  if (/Failed to fetch|NetworkError/i.test(message)) {
    return 'Network request failed — the public API may be rate limiting. Wait a few seconds and retry.';
  }
  return message;
}

// Let the canvas encode the PNG: it is faster than shipping a deflate
// implementation to the browser, and the bytes are smaller too.
els.download.addEventListener('click', () => {
  els.canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${slugify(lastPlaceName)}.png`;
    link.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
});

els.form.addEventListener('submit', render);

// A hash-only navigation does not reload the document, so without this the
// back button and pasted share links would silently do nothing. Our own
// updateHash() uses replaceState, which deliberately does not fire this.
window.addEventListener('hashchange', () => {
  applyHash();
  render();
});

applyHash();
render();
