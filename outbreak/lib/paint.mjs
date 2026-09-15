/**
 * The map painter.
 *
 * Renders the Rheinland and the Ruhr as an isometric pixel-art map in the
 * iso-cities idiom, with one filled shape per sub-unit coloured by its
 * outbreak state.
 *
 * The performance problem worth solving here is that there are ~1200
 * sub-units and ~600 frames. Scanline-filling every polygon every frame is
 * ~4M pixel operations per frame, which is 2.4 billion over the run. Instead
 * each sub-unit's screen pixels are collected *once* into an index list, and
 * a frame repaints only the sub-units whose state actually changed — which is
 * a handful, most days. Filling the whole region from scratch is then only
 * ever done once.
 *
 * Static line work (Kreis borders, the road network) is likewise rasterised
 * once into a sparse overlay of (pixel, colour) pairs that is blitted on top
 * of the fill layer.
 */

import { Raster } from '../../dist/index.js';

/* -------------------------------------------------------------------------- */
/* Palette                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Outbreak states, in the order a place moves through them. The ramp is
 * deliberate: untouched is a cold institutional slate, exposed is a dull
 * amber, active is the only saturated thing on the map, and collapsed decays
 * from crimson to something almost black as it cools.
 */
export const STATES = {
  untouched: { id: 0, fill: [44, 58, 82], label: 'Unaffected' },
  exposed: { id: 1, fill: [138, 106, 32], label: 'Incubating' },
  infected: { id: 2, fill: [255, 107, 31], label: 'Active outbreak' },
  collapsed: { id: 3, fill: [124, 18, 34], label: 'Overrun' },
  dead: { id: 4, fill: [56, 10, 20], label: 'No survivors' },
};

export const THEME = {
  background: [8, 11, 22],
  /** The opaque ground the HUD bands sit on. */
  void: [6, 9, 18],
  ground: [22, 28, 44],
  groundEdge: [96, 118, 158],
  unitBorder: [70, 88, 122],
  road: [58, 72, 100],
  motorway: [86, 104, 140],
  /** Highlight ring drawn around a sub-unit with an active outbreak. */
  activeEdge: [255, 158, 60],
  ink: [232, 238, 248],
  dim: [138, 154, 180],
  accent: [255, 74, 43],
  seed: [80, 255, 190],
  grid: [30, 38, 56],
};

/** States in id order, so a state id indexes straight into this. */
const STATE_LIST = Object.values(STATES);

/* -------------------------------------------------------------------------- */
/* Rasterising                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Walks a path with the even-odd rule, sampling at pixel centres, and reports
 * each filled span. Same maths as the package's internal `scanPath`, exposed
 * here as spans because this renderer wants pixel *indices*, not a shader.
 */
function eachSpan(rings, width, height, onSpan) {
  const edges = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    const n = ring.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      if (a[1] === b[1]) continue;
      edges.push([a[0], a[1], b[0], b[1]]);
      if (a[1] < minY) minY = a[1];
      if (a[1] > maxY) maxY = a[1];
    }
  }
  if (edges.length === 0) return;
  const yStart = Math.max(0, Math.floor(minY));
  const yEnd = Math.min(height - 1, Math.ceil(maxY));
  const crossings = [];
  for (let py = yStart; py <= yEnd; py++) {
    const sy = py + 0.5;
    crossings.length = 0;
    for (const [x0, y0, x1, y1] of edges) {
      if (sy >= y0 === sy >= y1) continue;
      crossings.push(x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0));
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const px0 = Math.max(0, Math.ceil(crossings[i] - 0.5));
      const px1 = Math.min(width - 1, Math.floor(crossings[i + 1] - 0.5));
      if (px1 >= px0) onSpan(py, px0, px1);
    }
  }
}

/** Every pixel inside `rings`, as row-major indices into the raster. */
function collectPixels(rings, width, height) {
  const chunks = [];
  let total = 0;
  eachSpan(rings, width, height, (y, x0, x1) => {
    const span = x1 - x0 + 1;
    chunks.push([y * width + x0, span]);
    total += span;
  });
  const pixels = new Int32Array(total);
  let at = 0;
  for (const [start, span] of chunks) {
    for (let i = 0; i < span; i++) pixels[at++] = start + i;
  }
  return pixels;
}

/** Sparse overlay: only the pixels a line actually touched. */
class Overlay {
  constructor() {
    this.index = [];
    this.red = [];
    this.green = [];
    this.blue = [];
  }

  add(pixel, [r, g, b]) {
    this.index.push(pixel);
    this.red.push(r);
    this.green.push(g);
    this.blue.push(b);
  }

  /** Blits, mixing toward the existing pixel for a soft line. */
  blit(data) {
    const { index, red, green, blue } = this;
    for (let i = 0; i < index.length; i++) {
      const p = index[i] * 4;
      data[p] = red[i];
      data[p + 1] = green[i];
      data[p + 2] = blue[i];
      data[p + 3] = 255;
    }
  }

  get length() {
    return this.index.length;
  }
}

/** Bresenham into an overlay, so line work is written only where it lands. */
function lineInto(overlay, x0, y0, x1, y1, color, width) {
  let ax = Math.round(x0);
  let ay = Math.round(y0);
  const bx = Math.round(x1);
  const by = Math.round(y1);
  const dx = Math.abs(bx - ax);
  const dy = -Math.abs(by - ay);
  const sx = ax < bx ? 1 : -1;
  const sy = ay < by ? 1 : -1;
  let err = dx + dy;
  const limit = dx - dy + 4;
  for (let guard = 0; guard <= limit; guard++) {
    if (width <= 1) {
      overlay.add(ay * overlay.width + ax, color);
    } else {
      const r = width >> 1;
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          const px = ax + ox;
          const py = ay + oy;
          if (px < 0 || py < 0 || px >= overlay.width || py >= overlay.height) continue;
          overlay.add(py * overlay.width + px, color);
        }
      }
    }
    if (ax === bx && ay === by) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      ax += sx;
    }
    if (e2 <= dx) {
      err += dx;
      ay += sy;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The map                                                                    */
/* -------------------------------------------------------------------------- */

/** The drawable sub-units of a unit: its children, or itself when it has none. */
export function shapesOf(unit) {
  return unit.children.length > 0
    ? unit.children
    : [
        {
          id: unit.id,
          name: unit.name,
          population: unit.population,
          outer: unit.outer,
          center: unit.center,
        },
      ];
}

/**
 * Builds every static thing about the map: the projection, each sub-unit's
 * screen rings and pixel list, and the overlay of borders and roads.
 *
 * `targetWidth` fixes the raster's width and derives the scale from it, rather
 * than the other way round. That matters because of how the camera works: the
 * film spends most of its length at the region level, and pixel art has to be
 * *upsampled* to zoom, never downsampled. So the region-wide view is authored
 * at 1:1 and every closer shot magnifies from there — crisp blocks rather than
 * a resampled mush.
 */
export function buildMap(region, options = {}) {
  const { targetWidth = 1152, margin = 0 } = options;

  /** A single equirectangular frame for the whole region. */
  const flat = region.units.flatMap((u) => u.outer);
  const originLat = 51.2;
  const originLon = 7.0;
  const ky = 111320;
  const kx = ky * Math.cos((originLat * Math.PI) / 180);
  const project = (lon, lat) => [(lon - originLon) * kx, -(lat - originLat) * ky];

  /** World-space -> isometric screen space, with an origin solved below. */
  const isoX = (x, y) => x - y;
  const isoY = (x, y) => (x + y) * 0.5;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const worldOutlines = [];
  for (const unit of region.units) {
    const ring = unit.outer.map(([lon, lat]) => project(lon, lat));
    worldOutlines.push({ unit, ring });
    for (const [x, y] of ring) {
      const sx = isoX(x, y);
      const sy = isoY(x, y);
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
  }

  // The scale that makes the region exactly `targetWidth` wide in the
  // isometric plane. Everything else follows from it.
  const scale = targetWidth / (maxX - minX);
  const width = Math.round((maxX - minX) * scale) + margin * 2;
  const height = Math.round((maxY - minY) * scale) + margin * 2;
  const originX = margin - minX * scale;
  const originY = margin - minY * scale;

  const toScreen = (x, y) => [originX + isoX(x, y) * scale, originY + isoY(x, y) * scale];

  /** The region silhouette, as one set of screen rings. */
  const regionRings = region.region.outline.map((polygon) =>
    polygon.outer.map(([lon, lat]) => toScreen(...project(lon, lat))),
  );

const raster = new Raster(width, height, THEME.background);

/* --- Ground -------------------------------------------------------------- */

  const groundPixels = [];
  eachSpan(regionRings, width, height, (y, x0, x1) => {
    groundPixels.push([y * width + x0, x1 - x0 + 1]);
  });
  for (const [start, span] of groundPixels) {
    for (let i = 0; i < span; i++) {
      const p = (start + i) * 4;
      raster.data[p] = THEME.ground[0];
      raster.data[p + 1] = THEME.ground[1];
      raster.data[p + 2] = THEME.ground[2];
      raster.data[p + 3] = 255;
    }
  }

  /* --- Sub-units --------------------------------------------------------- */

  const shapes = [];
  for (const unit of region.units) {
    for (const child of shapesOf(unit)) {
      const ring = child.outer.map(([lon, lat]) => toScreen(...project(lon, lat)));
      const pixels = collectPixels([ring], width, height);
      if (pixels.length === 0) continue;
      shapes.push({
        id: child.id,
        name: child.name,
        unitId: unit.id,
        unitName: unit.name,
        population: child.population,
        ring,
        pixels,
        cellIndex: -1,
        state: STATES.untouched.id,
        active: 0,
      });
    }
  }

  /* --- Overlay: Kreis borders, then the road network --------------------- */

  const overlay = new Overlay();
  overlay.width = width;
  overlay.height = height;

  for (const { ring } of worldOutlines) {
    const screen = ring.map(([x, y]) => toScreen(x, y));
    for (let i = 0; i < screen.length; i++) {
      const a = screen[i];
      const b = screen[(i + 1) % screen.length];
      lineInto(overlay, a[0], a[1], b[0], b[1], THEME.unitBorder, 1);
    }
  }

  let roadPixelsBefore = overlay.length;
  for (const road of region.roads) {
    // Motorways are drawn a pixel heavier so the Ruhr's spine reads at a glance.
    const heavy = road.class === 'motorway';
    const color = heavy ? THEME.motorway : THEME.road;
    let previous = null;
    for (const [lon, lat] of road.line) {
      const screen = toScreen(...project(lon, lat));
      if (previous) lineInto(overlay, previous[0], previous[1], screen[0], screen[1], color, heavy ? 2 : 1);
      previous = screen;
    }
  }
  const roadPixels = overlay.length - roadPixelsBefore;

  return {
    raster,
    width,
    height,
    scale,
    originX,
    originY,
    project,
    toScreen,
    regionRings,
    shapes,
    overlay,
    roadPixels,
    frame: { minX, minY, maxX, maxY },
  };
}

/* -------------------------------------------------------------------------- */
/* Painting a frame                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Paints one day's state over the map, repainting only what changed.
 *
 * `states` is a `Uint8Array` of state ids indexed the same way as the model's
 * cells; `shape.cellIndex` is the link between the two.
 */
export function paintStates(map, states, previousStates) {
  const { raster, shapes } = map;
  const data = raster.data;
  for (const shape of shapes) {
    const next = states[shape.cellIndex] ?? STATES.untouched.id;
    if (previousStates && previousStates[shape.cellIndex] === next) continue;
    const fill = STATE_LIST[next].fill;
    for (let i = 0; i < shape.pixels.length; i++) {
      const p = shape.pixels[i] * 4;
      data[p] = fill[0];
      data[p + 1] = fill[1];
      data[p + 2] = fill[2];
      data[p + 3] = 255;
    }
  }
  map.overlay.blit(data);
}

/**
 * State ids for every cell, from the simulation snapshot.
 *
 * The boundaries are deliberately conservative on `infected`: it is the only
 * saturated colour on the map, so a sub-unit only shows as actively burning
 * while it still has living people to infect.
 */
export function statesFor(snapshot, model) {
  const n = model.cells.length;
  const out = new Uint8Array(n);
  const turned = snapshot.cells.turned;
  const first = snapshot.cells.firstCaseDay;
  for (let i = 0; i < n; i++) {
    const population = model.cells[i].population;
    const share = population > 0 ? turned[i] / population : 0;
    if (share >= 0.97) out[i] = STATES.dead.id;
    else if (share >= 0.55) out[i] = STATES.collapsed.id;
    else if (turned[i] > 0 && share < 0.55) out[i] = STATES.infected.id;
    else if (first[i] >= 0) out[i] = STATES.exposed.id;
    else out[i] = STATES.untouched.id;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Camera                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A viewport onto the map raster.
 *
 * `view.zoom` is output pixels per source pixel: 1 is 1:1, below 1 downsamples
 * to fit more of the region in, above 1 magnifies with nearest-neighbour.
 *
 * Doing the zoom here rather than in the projection is what keeps the
 * per-sub-unit pixel lists valid for the whole animation — the map is
 * rasterised once at native scale and everything afterwards is a crop.
 *
 * The region's aspect (about 2.6:1) is wider than a 16:9 frame, so at low zoom
 * there is always some frame left over; it is filled with the background
 * rather than clamped, which would silently shift the map off centre.
 */
export function viewport(map, view) {
  const outWidth = view.outWidth ?? map.width;
  const outHeight = view.outHeight ?? map.height;
  // Where in the frame the view's centre point should land. Defaults to the
  // middle of the frame; the film overrides it so the map is centred in the
  // band between the header and the footer rather than behind them.
  const atX = view.atX ?? outWidth / 2;
  const atY = view.atY ?? outHeight / 2;
  const sourceWidth = outWidth / view.zoom;
  const sourceHeight = outHeight / view.zoom;

  // A view larger than the map has nothing to clamp — the map is simply
  // centred in it. Otherwise the window is kept inside the map, so the film
  // never pans off the edge into empty background.
  const span = (centre, size, extent) => {
    if (size >= extent) return (extent - size) / 2;
    return Math.max(0, Math.min(extent - size, centre - size / 2));
  };
  const x0 = span(view.x + (atX - outWidth / 2) / view.zoom, sourceWidth, map.width);
  const y0 = span(view.y + (atY - outHeight / 2) / view.zoom, sourceHeight, map.height);
  return { x0, y0, sourceWidth, sourceHeight, outWidth, outHeight, zoom: view.zoom };
}

/** Screen pixel of a point already in map space, under a given viewport. */
export function projectWithViewport(view, sx, sy) {
  return [(sx - view.x0) * view.zoom, (sy - view.y0) * view.zoom];
}

export function cropTo(map, view) {
  const { x0, y0, sourceWidth, sourceHeight, outWidth, outHeight, zoom } = viewport(map, view);
  const out = new Raster(outWidth, outHeight, THEME.background);
  const src = map.raster.data;
  const dst = out.data;
  const srcWidth = map.raster.width;
  const srcHeight = map.raster.height;

  for (let y = 0; y < outHeight; y++) {
    const sy = Math.floor(y0 + (y * sourceHeight) / outHeight);
    if (sy < 0 || sy >= srcHeight) continue;
    const srcRow = sy * srcWidth;
    let d = y * outWidth * 4;
    for (let x = 0; x < outWidth; x++) {
      const sx = Math.floor(x0 + (x * sourceWidth) / outWidth);
      if (sx >= 0 && sx < srcWidth) {
        const s = (srcRow + sx) * 4;
        dst[d] = src[s];
        dst[d + 1] = src[s + 1];
        dst[d + 2] = src[s + 2];
        dst[d + 3] = 255;
      }
      d += 4;
    }
  }
  return out;
}

/** Marks the pixel a given lon/lat lands on. */
export function screenOf(map, lon, lat) {
  return map.toScreen(...map.project(lon, lat));
}
