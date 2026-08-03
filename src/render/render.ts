/**
 * Scene -> pixels.
 *
 * Drawing order is a plain painter's algorithm:
 *   sky -> ground -> land cover -> water -> rails -> roads -> shadows ->
 *   depth-sorted sprites (buildings and trees) -> labels
 *
 * Flat features have no height, so they can be laid down in a fixed order.
 * Anything that stands up is sorted by isometric depth and drawn back to
 * front, which is what makes near buildings occlude far ones.
 */

import { boundaryOutline } from '../geo/boundary.js';
import { ROAD_PRIORITY } from '../osm/classify.js';
import type {
  AreaFeature,
  BuildingFeature,
  GreenKind,
  RailFeature,
  RoadFeature,
  Scene,
  TreeFeature,
} from '../types.js';
import { stableIndex, stableUnit } from '../util/rand.js';
import {
  bayer8,
  darken,
  hex,
  lighten,
  mix,
  pixelNoise,
  quantiseFactor,
  shade,
  type RGB,
} from './color.js';
import { ASCENDER_ROWS, GLYPH_HEIGHT, drawText, measureText } from './font.js';
import { createProjector, layoutFor, projectRing, squareExtent, type Projector } from './iso.js';
import {
  DEFAULT_THEME,
  buildingColors,
  desaturateTheme,
  getTheme,
  jitterColor,
  type Theme,
} from './palette.js';
import { Raster, rasterizeMask, solid, type ScreenPoint, type Shader } from './raster.js';

/** Direction the sun comes from, in local (east, south) metres. */
const LIGHT = { x: 0.86, y: -0.51 };
/** Walls are shaded in this many flat steps rather than a smooth gradient. */
const WALL_SHADE_STEPS = 4;
/** Below this many pixels per metre, windows become sub-pixel noise. */
const MIN_SCALE_FOR_WINDOWS = 0.55;
/** Below this, railway sleepers stop reading as sleepers. */
const MIN_SCALE_FOR_SLEEPERS = 0.8;
/** Default accent for a highlighted address. Chosen to survive a grey field. */
export const DEFAULT_HIGHLIGHT_COLOR = '#ff4a2b';

export interface RenderOptions {
  /** Theme name or a theme object. */
  theme?: string | Theme;
  /** Native render width in pixels, before upscaling. */
  width?: number;
  /** Native render height. Derived from the width when omitted. */
  height?: number;
  /** Nearest-neighbour upscale applied at the end. */
  scale?: number;
  margin?: number;
  /** Multiplier on building heights; >1 makes the skyline more legible. */
  verticalExaggeration?: number;
  seed?: number;
  /** Label drawn top-left. Pass false to omit. */
  title?: string | false;
  /** Second label line. Pass false to omit. */
  subtitle?: string | false;
  /** Draws the OpenStreetMap credit. See ATTRIBUTION.md before disabling. */
  attribution?: boolean;
  shadows?: boolean;
  windows?: boolean;
  outlines?: boolean;
  /** Accent colour for a highlighted building and its marker. */
  highlightColor?: string | RGB;
  /** Draw a pin above the highlighted point. On by default when one exists. */
  marker?: boolean;
  /**
   * Drain colour from everything except the highlight. Off by default; `true`
   * is full desaturation, or give a number between 0 and 1 for partial.
   */
  desaturate?: boolean | number;
}

export interface RenderedImage {
  raster: Raster;
  width: number;
  height: number;
  /** Pixels per metre in the native render. */
  metresToPixels: number;
  theme: Theme;
}

export function renderScene(scene: Scene, options: RenderOptions = {}): RenderedImage {
  const requested =
    typeof options.theme === 'object' ? options.theme : getTheme(options.theme ?? DEFAULT_THEME);
  const seed = options.seed ?? 0;
  const width = Math.max(64, Math.round(options.width ?? 1024));
  const margin = options.margin ?? Math.max(6, Math.round(width * 0.012));
  const verticalExaggeration = options.verticalExaggeration ?? 1.35;
  const upscale = Math.max(1, Math.floor(options.scale ?? 1));
  const shadows = options.shadows ?? true;
  const windows = options.windows ?? true;
  const outlines = options.outlines ?? true;

  // Off unless explicitly asked for. A highlight used to imply it, but draining
  // the colour out of the map to make one building stand out costs more than it
  // buys — the accent already reads clearly against a full-colour city.
  const desaturation =
    options.desaturate === true ? 1 : options.desaturate === false || options.desaturate === undefined ? 0 : options.desaturate;
  const theme = desaturation > 0 ? desaturateTheme(requested, desaturation) : requested;
  const accent = resolveAccent(options.highlightColor);

  // Frame the boundary itself when there is one; otherwise the square.
  const extent = scene.boundary ? boundaryOutline(scene.boundary) : squareExtent(scene.radius);

  const layout = layoutFor({
    extent,
    width,
    margin,
    maxHeight: Math.max(scene.stats.maxHeight, 12),
    verticalExaggeration,
    ...(options.height !== undefined ? { height: Math.max(64, Math.round(options.height)) } : {}),
  });

  const projector = createProjector({
    scale: layout.scale,
    verticalExaggeration,
    originX: layout.originX,
    originY: layout.originY,
  });

  const raster = new Raster(layout.width, layout.height, theme.sky);

  // The ground shape, as projected screen rings.
  const groundRings: ScreenPoint[][] = scene.boundary
    ? scene.boundary.polygons.flatMap((rings) => rings.map((ring) => projectRing(projector, ring)))
    : [projectRing(projector, squareExtent(scene.radius))];

  // Everything lying flat on the ground is confined to that shape. Buildings
  // and trees are not: they stand up, so their tops legitimately rise above
  // the silhouette, and they were filtered by containment when the scene was
  // built instead.
  raster.clipMask = rasterizeMask(groundRings, raster.width, raster.height);

  drawGround(raster, groundRings, theme, seed);
  for (const area of scene.areas) drawArea(raster, projector, area, theme, seed);
  drawRails(raster, projector, scene.rails, theme);
  drawRoads(raster, projector, scene.roads, theme);
  if (shadows) drawShadows(raster, projector, scene, theme);

  raster.clipMask = null;

  for (const ring of groundRings) raster.outline(ring, theme.groundEdge);

  drawSprites(raster, projector, scene, theme, { seed, windows, outlines, accent });

  if (scene.highlight && (options.marker ?? true)) {
    drawMarker(raster, projector, scene, theme, accent);
  }

  drawLabels(raster, scene, theme, options, upscale);

  const finalRaster = raster.scaleUp(upscale);
  return {
    raster: finalRaster,
    width: finalRaster.width,
    height: finalRaster.height,
    metresToPixels: layout.scale,
    theme,
  };
}

function resolveAccent(value: string | RGB | undefined): RGB {
  if (!value) return hex(DEFAULT_HIGHLIGHT_COLOR);
  return typeof value === 'string' ? hex(value) : value;
}

/* -------------------------------------------------------------------------- */
/* Ground                                                                     */
/* -------------------------------------------------------------------------- */

function drawGround(raster: Raster, groundRings: ScreenPoint[][], theme: Theme, seed: number): void {
  const [base, alt] = theme.ground;
  raster.fillPath(groundRings, (x, y) => (pixelNoise(x, y, seed) < 0.14 ? alt : base));
}

function areaShader(area: AreaFeature, theme: Theme, seed: number): Shader {
  switch (area.kind) {
    case 'water': {
      const [base, deep] = theme.water;
      const shore = theme.waterShore;
      return (x, y) => {
        // Broad horizontal banding reads as gentle ripples at this scale.
        const band = (y * 2 + Math.floor(x / 2)) % 23;
        if (band === 0) return shore;
        return bayer8(x, y) < 0.22 ? deep : base;
      };
    }
    case 'green': {
      const pair = theme.green[area.sub as GreenKind] ?? theme.green.grass;
      const [base, alt] = pair;
      return (x, y) => (pixelNoise(x, y, seed ^ 0x51ed) < 0.22 ? alt : base);
    }
    case 'sand': {
      const [base, alt] = theme.sand;
      return (x, y) => (pixelNoise(x, y, seed ^ 0x2b17) < 0.18 ? alt : base);
    }
    case 'parking':
      return solid(theme.landcover.parking);
    case 'industrial':
      return solid(theme.landcover.industrial);
    case 'commercial':
      return solid(theme.landcover.commercial);
    case 'residential':
      return solid(theme.landcover.residential);
  }
}

function drawArea(
  raster: Raster,
  projector: Projector,
  area: AreaFeature,
  theme: Theme,
  seed: number,
): void {
  const rings = area.rings.map((ring) => projectRing(projector, ring));
  if (rings.length === 0 || rings[0]!.length < 3) return;
  raster.fillPath(rings, areaShader(area, theme, seed));
  if (area.kind === 'water') {
    for (const ring of rings) raster.outline(ring, theme.waterShore);
  }
}

/* -------------------------------------------------------------------------- */
/* Linear features                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Apparent stroke width for a world-space width `metres` on a segment running
 * in direction (dx, dy).
 *
 * The isometric transform has determinant k^2, so it preserves area up to that
 * factor. Dividing the projected area of the segment by its projected length
 * gives the perpendicular width exactly — which is why roads running "into"
 * the screen correctly look wider than roads running across it.
 */
function apparentWidth(projector: Projector, metres: number, dx: number, dy: number): number {
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return metres * projector.scale;
  const ux = dx / length;
  const uy = dy / length;
  const px = (ux - uy) * projector.scale;
  const py = (ux + uy) * projector.scale * 0.5;
  const projectedLength = Math.hypot(px, py);
  if (projectedLength < 1e-9) return metres * projector.scale;
  return (projector.scale * projector.scale * metres) / projectedLength;
}

/** Strokes a world-space polyline, varying width per segment. */
function strokeWorldLine(
  raster: Raster,
  projector: Projector,
  line: { x: number; y: number }[],
  metres: number,
  color: RGB,
): void {
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const w = apparentWidth(projector, metres, b.x - a.x, b.y - a.y);
    const pa = projector.project(a.x, a.y, 0);
    const pb = projector.project(b.x, b.y, 0);
    raster.strokePolyline([pa, pb], w, color);
    if (i > 0 && w > 2) raster.fillDisc(pa.x, pa.y, w / 2, color);
  }
}

function drawRoads(
  raster: Raster,
  projector: Projector,
  roads: RoadFeature[],
  theme: Theme,
): void {
  const ordered = [...roads].sort(
    (a, b) =>
      a.layer - b.layer ||
      ROAD_PRIORITY[a.roadClass] - ROAD_PRIORITY[b.roadClass] ||
      (a.id < b.id ? -1 : 1),
  );

  // Casings first across every road, so junctions merge instead of showing
  // seams where one road's casing cuts across another's surface.
  for (const road of ordered) {
    if (road.tunnel) continue;
    const casingWidth = road.width + Math.max(1.2, road.width * 0.16);
    for (const line of road.lines) {
      strokeWorldLine(raster, projector, line, casingWidth, theme.roadCasing);
    }
  }
  for (const road of ordered) {
    if (road.tunnel) continue;
    const color = theme.road[road.roadClass];
    for (const line of road.lines) {
      strokeWorldLine(raster, projector, line, road.width, color);
    }
  }
}

function drawRails(
  raster: Raster,
  projector: Projector,
  rails: RailFeature[],
  theme: Theme,
): void {
  for (const rail of rails) {
    if (rail.tunnel) continue;
    for (const line of rail.lines) {
      strokeWorldLine(raster, projector, line, 3.2, theme.rail);
    }
  }

  if (projector.scale < MIN_SCALE_FOR_SLEEPERS) return;

  // Sleepers: short ticks perpendicular to the track, spaced in world metres.
  const spacing = 4.5;
  for (const rail of rails) {
    if (rail.tunnel) continue;
    for (const line of rail.lines) {
      let carry = 0;
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i]!;
        const b = line[i + 1]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        if (length < 1e-6) continue;
        const nx = -dy / length;
        const ny = dx / length;
        for (let d = spacing - carry; d < length; d += spacing) {
          const t = d / length;
          const cx = a.x + dx * t;
          const cy = a.y + dy * t;
          const p0 = projector.project(cx - nx * 1.6, cy - ny * 1.6, 0);
          const p1 = projector.project(cx + nx * 1.6, cy + ny * 1.6, 0);
          raster.line(p0.x, p0.y, p1.x, p1.y, theme.railTie);
        }
        carry = (carry + length) % spacing;
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Shadows                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Ground shadows are drawn as footprints offset away from the light, before
 * any building goes down — so a shadow can fall across the street but never
 * across the wall of the building casting it.
 */
function drawShadows(raster: Raster, projector: Projector, scene: Scene, theme: Theme): void {
  const alpha = theme.shadowAlpha;
  if (alpha <= 0) return;
  const shadowColor = theme.shadow;

  const blendShader: Shader = (x, y) => mix(raster.get(x, y), shadowColor, alpha);

  for (const building of scene.buildings) {
    const offset = Math.min(building.height * 0.45, 22);
    const dx = -LIGHT.x * offset;
    const dy = -LIGHT.y * offset;
    const rings = building.rings.map((ring) =>
      projectRing(
        projector,
        ring.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      ),
    );
    raster.fillPath(rings, blendShader);
  }

  for (const tree of scene.trees) {
    const offset = tree.size * 0.9;
    const centre = projector.project(
      tree.position.x - LIGHT.x * offset,
      tree.position.y - LIGHT.y * offset,
      0,
    );
    const radius = Math.max(1, tree.size * projector.scale * 0.7);
    fillDiscBlend(raster, centre.x, centre.y, radius, shadowColor, alpha * 0.9);
  }
}

function fillDiscBlend(
  raster: Raster,
  cx: number,
  cy: number,
  radius: number,
  color: RGB,
  alpha: number,
): void {
  // Flattened vertically to sit on the isometric ground plane.
  const ry = Math.max(0.6, radius * 0.5);
  const x0 = Math.floor(cx - radius);
  const x1 = Math.ceil(cx + radius);
  const y0 = Math.floor(cy - ry);
  const y1 = Math.ceil(cy + ry);
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = (px + 0.5 - cx) / radius;
      const dy = (py + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) raster.blend(px, py, color, alpha);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Standing geometry                                                          */
/* -------------------------------------------------------------------------- */

type Sprite =
  | { kind: 'building'; depth: number; building: BuildingFeature }
  | { kind: 'tree'; depth: number; tree: TreeFeature };

function drawSprites(
  raster: Raster,
  projector: Projector,
  scene: Scene,
  theme: Theme,
  options: { seed: number; windows: boolean; outlines: boolean; accent: RGB },
): void {
  const sprites: Sprite[] = [];
  for (const building of scene.buildings) {
    sprites.push({
      kind: 'building',
      depth: projector.depth(building.centroid.x, building.centroid.y),
      building,
    });
  }
  for (const tree of scene.trees) {
    sprites.push({
      kind: 'tree',
      depth: projector.depth(tree.position.x, tree.position.y),
      tree,
    });
  }
  // Back to front. Ties broken by id so the result is stable across runs.
  sprites.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const ai = a.kind === 'building' ? a.building.id : a.tree.id;
    const bi = b.kind === 'building' ? b.building.id : b.tree.id;
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  for (const sprite of sprites) {
    if (sprite.kind === 'building') {
      drawBuilding(raster, projector, sprite.building, theme, options);
    } else {
      drawTree(raster, projector, sprite.tree, theme, options.seed);
    }
  }
}

interface WallFace {
  quad: ScreenPoint[];
  color: RGB;
  /** Index of the starting vertex of the edge, for silhouette detection. */
  index: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

function drawBuilding(
  raster: Raster,
  projector: Projector,
  building: BuildingFeature,
  theme: Theme,
  options: { seed: number; windows: boolean; outlines: boolean; accent: RGB },
): void {
  const outer = building.rings[0];
  if (!outer || outer.length < 3) return;

  const { seed } = options;
  const tone = stableUnit(building.id, seed, 'tone');

  let roofColor: RGB;
  let wallBase: RGB;
  if (building.highlighted) {
    // No jitter here: the point of the accent is that it is unmistakable.
    roofColor = options.accent;
    wallBase = lighten(options.accent, 0.22);
  } else {
    const palette = buildingColors(
      theme,
      stableIndex(building.id, seed, theme.roofs.length, 'colour'),
      building.landmark,
    );
    roofColor = jitterColor(palette.roof, tone, 0.07);
    wallBase = jitterColor(palette.wall, tone, 0.05);
  }

  // Slight per-building height jitter stops uniform terraces from reading as
  // one extruded slab.
  const height = building.height * (0.94 + stableUnit(building.id, seed, 'height') * 0.12);

  const faces: WallFace[] = [];
  const visible: boolean[] = new Array(outer.length).fill(false);

  for (let i = 0; i < outer.length; i++) {
    const a = outer[i]!;
    const b = outer[(i + 1) % outer.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue;

    // Outward normal of a counter-clockwise ring.
    const nx = dy;
    const ny = -dx;
    // Faces pointing away from the camera are never drawn.
    if (nx + ny <= 0) continue;
    visible[i] = true;

    const length = Math.hypot(nx, ny);
    const dot = (nx / length) * LIGHT.x + (ny / length) * LIGHT.y;
    const factor = quantiseFactor((dot + 1) / 2, WALL_SHADE_STEPS, 0.58, 1.02);

    faces.push({
      quad: [
        projector.project(a.x, a.y, 0),
        projector.project(b.x, b.y, 0),
        projector.project(b.x, b.y, height),
        projector.project(a.x, a.y, height),
      ],
      color: shade(wallBase, factor),
      index: i,
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
    });
  }

  for (const face of faces) {
    raster.fillPath([face.quad], solid(face.color));
  }

  if (
    options.windows &&
    !building.highlighted &&
    projector.scale >= MIN_SCALE_FOR_WINDOWS &&
    height >= 5
  ) {
    for (const face of faces) {
      drawWindows(raster, projector, building, face, height, theme, seed);
    }
  }

  // Roof last, so it covers the top edge of every wall.
  const roofRings = building.rings.map((ring) => projectRing(projector, ring, height));
  raster.fillPath(roofRings, solid(roofColor));

  // Below a few pixels across, a one-pixel outline is wider than the face it
  // is meant to define, so whole districts collapse into black. Dropping it
  // there lets the roof tones carry the image instead. The highlight always
  // keeps its outline — it has to stay findable.
  const footprintPixels = Math.sqrt(Math.max(0, building.area)) * projector.scale;
  if (options.outlines && (footprintPixels >= 2.5 || building.highlighted)) {
    const ink = theme.outline;
    for (const ring of roofRings) raster.outline(ring, ink);
    for (const face of faces) {
      const p0 = face.quad[0]!;
      const p1 = face.quad[1]!;
      raster.line(p0.x, p0.y, p1.x, p1.y, ink);
    }
    // Vertical edges only where the silhouette turns, not on every corner.
    for (let i = 0; i < outer.length; i++) {
      const previous = visible[(i + outer.length - 1) % outer.length];
      if (visible[i] === previous) continue;
      const v = outer[i]!;
      const bottom = projector.project(v.x, v.y, 0);
      const top = projector.project(v.x, v.y, height);
      raster.line(bottom.x, bottom.y, top.x, top.y, ink);
    }
  }
}

/**
 * Stamps windows onto one wall face.
 *
 * Positions are computed in the wall's own (along-edge, up) metric frame and
 * then projected, so windows sit flat on the wall regardless of its
 * orientation and never spill past the corners.
 */
function drawWindows(
  raster: Raster,
  projector: Projector,
  building: BuildingFeature,
  face: WallFace,
  height: number,
  theme: Theme,
  seed: number,
): void {
  const dx = face.bx - face.ax;
  const dy = face.by - face.ay;
  const length = Math.hypot(dx, dy);
  if (length < 4) return;

  const style = theme.window;
  const floorHeight = 3.2;
  const columnSpacing = 3.6;
  const inset = 1.6;
  const usable = length - inset * 2;
  if (usable < columnSpacing * 0.5) return;

  const columns = Math.max(1, Math.floor(usable / columnSpacing));
  const floors = Math.floor((height - 2.2) / floorHeight);
  if (floors < 1) return;

  const ux = dx / length;
  const uy = dy / length;
  const wPx = Math.max(1, Math.round(1.1 * projector.scale));
  const hPx = Math.max(1, Math.round(1.5 * projector.verticalScale));

  for (let floor = 0; floor < floors; floor++) {
    const z = 1.9 + floor * floorHeight;
    if (z + 1.5 > height - 0.4) break;
    for (let column = 0; column <= columns; column++) {
      const u = inset + (usable * column) / Math.max(1, columns);
      const key = `${face.index}:${floor}:${column}`;
      const roll = stableUnit(building.id, seed, key);
      const color = style.lit && roll < style.litChance ? style.lit : style.dark;
      // Skip a few windows entirely so facades are not perfectly regular.
      if (!style.lit && roll < 0.08) continue;
      const p = projector.project(face.ax + ux * u, face.ay + uy * u, z);
      raster.fillRect(Math.round(p.x - wPx / 2), Math.round(p.y - hPx), wPx, hPx, color);
    }
  }
}

function drawTree(
  raster: Raster,
  projector: Projector,
  tree: TreeFeature,
  theme: Theme,
  seed: number,
): void {
  const trunkHeight = tree.size * 0.85;
  const base = projector.project(tree.position.x, tree.position.y, 0);
  const crownBase = projector.project(tree.position.x, tree.position.y, trunkHeight);
  const crownCentre = projector.project(tree.position.x, tree.position.y, trunkHeight + tree.size * 0.7);

  raster.line(base.x, base.y, crownBase.x, crownBase.y, theme.tree.trunk);

  const radius = Math.max(1.2, tree.size * projector.scale * 0.85);
  const [light, dark] = theme.tree.canopy;
  const wobble = (stableUnit(tree.id, seed, 'crown') - 0.5) * 0.6;

  raster.fillDisc(crownCentre.x, crownCentre.y, radius, dark);
  raster.fillDisc(
    crownCentre.x - radius * 0.28 + wobble,
    crownCentre.y - radius * 0.3,
    radius * 0.72,
    light,
  );
}

/* -------------------------------------------------------------------------- */
/* Highlight marker                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Draws a pin above the highlighted point.
 *
 * Without it the feature is unusable at district scale, where the building
 * itself may be two pixels across. The pin is sized from the canvas rather
 * than from world units, so it stays findable at any zoom, and it is drawn
 * after every sprite so nothing can occlude it.
 */
function drawMarker(
  raster: Raster,
  projector: Projector,
  scene: Scene,
  theme: Theme,
  accent: RGB,
): void {
  const highlight = scene.highlight;
  if (!highlight) return;

  const building = highlight.buildingId
    ? scene.buildings.find((b) => b.id === highlight.buildingId)
    : undefined;

  const ink = theme.outline;
  const ground = projector.project(highlight.position.x, highlight.position.y, 0);
  const anchor = projector.project(highlight.position.x, highlight.position.y, building?.height ?? 0);

  const radius = Math.max(3, Math.round(raster.width * 0.005));
  const stalk = Math.max(12, radius * 5);
  const tipY = anchor.y - stalk;

  // A ring on the ground, so the eye can find the spot even when the pin head
  // sits among tall buildings.
  drawGroundRing(raster, ground.x, ground.y, radius * 2.6, ink, accent);

  // Stalk, with a dark edge either side so it reads against any background.
  raster.line(anchor.x - 1, anchor.y, anchor.x - 1, tipY, ink);
  raster.line(anchor.x + 1, anchor.y, anchor.x + 1, tipY, ink);
  raster.line(anchor.x, anchor.y, anchor.x, tipY, accent);

  // Head.
  raster.fillDisc(anchor.x, tipY, radius + 1, ink);
  raster.fillDisc(anchor.x, tipY, radius, accent);
  raster.fillDisc(anchor.x - radius * 0.3, tipY - radius * 0.3, Math.max(1, radius * 0.34), lighten(accent, 0.55));
}

/** An ellipse outline lying flat on the isometric ground plane. */
function drawGroundRing(
  raster: Raster,
  cx: number,
  cy: number,
  radius: number,
  ink: RGB,
  color: RGB,
): void {
  const steps = Math.max(24, Math.round(radius * 4));
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius * 0.5;
    raster.set(x, y + 1, ink);
    raster.set(x, y, color);
  }
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                     */
/* -------------------------------------------------------------------------- */

function drawLabels(
  raster: Raster,
  scene: Scene,
  theme: Theme,
  options: RenderOptions,
  upscale: number,
): void {
  const pad = Math.max(4, Math.round(raster.width * 0.014));
  // Keep labels legible after upscaling without letting them dominate.
  const titleScale = upscale >= 3 ? 1 : raster.width >= 900 ? 2 : 1;
  const shadow = theme.textShadow ?? undefined;

  const title = options.title === false ? null : (options.title ?? scene.place.name);
  const subtitleDefault = defaultSubtitle(scene);
  const subtitle = options.subtitle === false ? null : (options.subtitle ?? subtitleDefault);

  let y = pad + ASCENDER_ROWS * titleScale;
  if (title) {
    drawText(raster, title, pad, y, theme.text, {
      scale: titleScale,
      shadow: shadow ? shadow : undefined,
    });
    y += GLYPH_HEIGHT * titleScale + 4;
  }
  if (subtitle) {
    drawText(raster, subtitle, pad, y, mix(theme.text, theme.sky, 0.28), {
      scale: 1,
      shadow: shadow ? shadow : undefined,
    });
  }

  if (options.attribution !== false) {
    const text = scene.attribution;
    const size = measureText(text, { scale: 1 });
    drawText(raster, text, pad, raster.height - pad - size.height, mix(theme.text, theme.sky, 0.2), {
      scale: 1,
      shadow: shadow ? shadow : undefined,
    });
  }
}

function defaultSubtitle(scene: Scene): string {
  // A highlighted address is more useful on the image than its coordinates.
  if (scene.highlight?.label) return scene.highlight.label;

  const { lat, lon } = scene.origin;
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  const where = `${Math.abs(lat).toFixed(4)}${ns} ${Math.abs(lon).toFixed(4)}${ew}`;
  return scene.boundary ? where : `${where} - ${Math.round(scene.radius)} m radius`;
}

/** Exposed for tests. */
export const __internals = { apparentWidth, darken };
