/**
 * Themes.
 *
 * Rather than hand-listing sixty colours per theme, each one declares a dozen
 * key hues and the rest are derived from them. That keeps greens, roads and
 * shadows in agreement with the theme's overall cast, and makes adding a new
 * theme a fifteen-line job.
 *
 * A theme may also declare `quantise`, a hard colour list every derived value
 * is snapped to — that is how the four-tone Game Boy palette stays honest.
 */

import { darken, hex, lighten, luminance, mix, shade, type RGB } from './color.js';
import type { GreenKind, RoadClass } from '../types.js';

export interface WindowStyle {
  /** Unlit window colour, painted onto walls. */
  dark: RGB;
  /** Lit window colour, or null for themes with no lighting. */
  lit: RGB | null;
  /** Fraction of windows that are lit, 0-1. */
  litChance: number;
}

export interface Theme {
  name: string;
  description: string;
  sky: RGB;
  ground: [RGB, RGB];
  groundEdge: RGB;
  water: [RGB, RGB];
  waterShore: RGB;
  green: Record<GreenKind, [RGB, RGB]>;
  sand: [RGB, RGB];
  landcover: Record<'residential' | 'industrial' | 'commercial' | 'parking', RGB>;
  road: Record<RoadClass, RGB>;
  roadCasing: RGB;
  rail: RGB;
  railTie: RGB;
  shadow: RGB;
  shadowAlpha: number;
  outline: RGB;
  roofs: RGB[];
  walls: RGB[];
  landmarkRoof: RGB;
  landmarkWall: RGB;
  tree: { canopy: [RGB, RGB]; trunk: RGB };
  window: WindowStyle;
  text: RGB;
  textShadow: RGB | null;
}

interface ThemeSpec {
  name: string;
  description: string;
  sky: string;
  ground: string;
  water: string;
  greenery: string;
  asphalt: string;
  roofs: string[];
  walls: string[];
  landmark: string;
  ink: string;
  paper: string;
  window: { dark: string; lit?: string; litChance: number };
  shadowAlpha: number;
  /** Snap every derived colour to the nearest entry in this list. */
  quantise?: string[];
}

function nearest(color: RGB, palette: RGB[]): RGB {
  let best = palette[0]!;
  let bestDistance = Infinity;
  for (const candidate of palette) {
    const dr = color[0] - candidate[0];
    const dg = color[1] - candidate[1];
    const db = color[2] - candidate[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best;
}

function buildTheme(spec: ThemeSpec): Theme {
  const palette = spec.quantise?.map(hex);
  const q = (c: RGB): RGB => (palette ? nearest(c, palette) : c);

  const sky = hex(spec.sky);
  const ground = hex(spec.ground);
  const water = hex(spec.water);
  const greenery = hex(spec.greenery);
  const asphalt = hex(spec.asphalt);
  const ink = hex(spec.ink);
  const paper = hex(spec.paper);
  const landmark = hex(spec.landmark);

  // A warm/cool pair used to push derived greens apart without inventing hues.
  const straw = mix(greenery, [222, 205, 130], 0.55);

  const greenPair = (base: RGB): [RGB, RGB] => [q(base), q(darken(base, 0.07))];

  return {
    name: spec.name,
    description: spec.description,
    sky: q(sky),
    ground: [q(ground), q(darken(ground, 0.045))],
    groundEdge: q(darken(ground, 0.35)),
    water: [q(water), q(darken(water, 0.09))],
    waterShore: q(lighten(water, 0.22)),
    green: {
      park: greenPair(greenery),
      forest: greenPair(darken(greenery, 0.2)),
      garden: greenPair(lighten(greenery, 0.08)),
      grass: greenPair(lighten(greenery, 0.14)),
      farmland: greenPair(straw),
      cemetery: greenPair(darken(greenery, 0.1)),
      pitch: greenPair(mix(greenery, [120, 170, 110], 0.4)),
    },
    sand: [q(mix(ground, [232, 216, 168], 0.75)), q(mix(ground, [216, 199, 150], 0.75))],
    landcover: {
      residential: q(mix(ground, hex(spec.roofs[0] ?? spec.ink), 0.07)),
      industrial: q(mix(ground, asphalt, 0.35)),
      commercial: q(mix(ground, hex(spec.roofs[2] ?? spec.ink), 0.09)),
      parking: q(mix(ground, asphalt, 0.6)),
    },
    road: {
      motorway: q(lighten(asphalt, 0.1)),
      trunk: q(lighten(asphalt, 0.08)),
      primary: q(lighten(asphalt, 0.06)),
      secondary: q(lighten(asphalt, 0.03)),
      tertiary: q(asphalt),
      residential: q(darken(asphalt, 0.03)),
      service: q(darken(asphalt, 0.07)),
      pedestrian: q(mix(asphalt, ground, 0.45)),
      cycleway: q(mix(asphalt, ground, 0.35)),
      footway: q(mix(asphalt, ground, 0.55)),
      track: q(mix(asphalt, ground, 0.65)),
      steps: q(mix(asphalt, ground, 0.4)),
    },
    roadCasing: q(darken(asphalt, 0.34)),
    rail: q(darken(asphalt, 0.2)),
    railTie: q(darken(asphalt, 0.45)),
    shadow: q(mix(darken(ground, 0.45), ink, 0.35)),
    shadowAlpha: spec.shadowAlpha,
    outline: q(ink),
    roofs: spec.roofs.map((c) => q(hex(c))),
    walls: spec.walls.map((c) => q(hex(c))),
    landmarkRoof: q(landmark),
    landmarkWall: q(lighten(landmark, 0.55)),
    tree: {
      canopy: [q(darken(greenery, 0.16)), q(darken(greenery, 0.36))],
      trunk: q(mix(darken(greenery, 0.5), [90, 62, 44], 0.6)),
    },
    window: {
      dark: q(hex(spec.window.dark)),
      lit: spec.window.lit ? q(hex(spec.window.lit)) : null,
      litChance: spec.window.litChance,
    },
    // Labels sit on the sky, so their contrast has to follow it: dark ink on a
    // bright sky, light paper on a dark one.
    ...(luminance(sky) < 110
      ? { text: q(paper), textShadow: q(ink) }
      : { text: q(ink), textShadow: q(paper) }),
  };
}

const SPECS: ThemeSpec[] = [
  {
    name: 'daylight',
    description: 'Clear midday light, warm roofs, dry pavement.',
    sky: '#bcdff0',
    ground: '#cdc8b0',
    water: '#4c9fc4',
    greenery: '#78ab55',
    asphalt: '#aaa79d',
    roofs: ['#c2705a', '#b05f4b', '#9c5744', '#8c6a58', '#98897a', '#7c8b8c', '#b98d52', '#6f8266'],
    walls: ['#e3d2bb', '#d9c6ae', '#cfbaa2', '#cbbcaa', '#ddd6c8', '#d1d6d4', '#e0cdad', '#ccd3c2'],
    landmark: '#5f9c8c',
    ink: '#3d3628',
    paper: '#f6f1e4',
    window: { dark: '#5c6b74', litChance: 0 },
    shadowAlpha: 0.26,
  },
  {
    name: 'dusk',
    description: 'Low sun and long blue shadows, with the first lights on.',
    sky: '#3d3a63',
    ground: '#6a6070',
    water: '#3a5d8f',
    greenery: '#4e7355',
    asphalt: '#5f5867',
    roofs: ['#8f5347', '#7d4a41', '#6f4a45', '#6a5560', '#5f6472', '#7a5f4a', '#565f6b', '#84604f'],
    walls: ['#9b8b8a', '#918082', '#877a7e', '#8a8290', '#7f8390', '#9a8878', '#7c8492', '#a08a7d'],
    landmark: '#c98a4b',
    ink: '#241f33',
    paper: '#ece6f4',
    window: { dark: '#3a3450', lit: '#ffd98a', litChance: 0.45 },
    shadowAlpha: 0.3,
  },
  {
    name: 'night',
    description: 'Deep night, windows glowing, streets barely lit.',
    sky: '#111426',
    ground: '#262b3d',
    water: '#16233f',
    greenery: '#1f3a2c',
    asphalt: '#2f3448',
    roofs: ['#3a3140', '#33303c', '#2e3340', '#3d3a44', '#2b3242', '#3f3536', '#343d48', '#2f3a3c'],
    walls: ['#454050', '#3f3c4c', '#3a3a4a', '#4a4654', '#383f52', '#4c4245', '#3f4856', '#3a4650'],
    landmark: '#6b4f7a',
    ink: '#080a12',
    paper: '#cfd6ee',
    window: { dark: '#1c2033', lit: '#ffd27a', litChance: 0.62 },
    shadowAlpha: 0.34,
  },
  {
    name: 'noir',
    description: 'Greyscale, high contrast, no colour at all.',
    sky: '#d8d8d8',
    ground: '#b4b4b4',
    water: '#8e8e8e',
    greenery: '#9a9a9a',
    asphalt: '#a0a0a0',
    roofs: ['#5a5a5a', '#4e4e4e', '#666666', '#454545', '#727272', '#3c3c3c', '#5f5f5f', '#4a4a4a'],
    walls: ['#dcdcdc', '#d0d0d0', '#e4e4e4', '#c6c6c6', '#eaeaea', '#bcbcbc', '#d6d6d6', '#c8c8c8'],
    landmark: '#2e2e2e',
    ink: '#121212',
    paper: '#ffffff',
    window: { dark: '#3a3a3a', litChance: 0 },
    shadowAlpha: 0.28,
  },
  {
    name: 'gameboy',
    description: 'The original four-tone DMG palette, and nothing else.',
    sky: '#9bbc0f',
    ground: '#8bac0f',
    water: '#306230',
    greenery: '#306230',
    asphalt: '#8bac0f',
    roofs: ['#0f380f', '#306230', '#0f380f', '#306230', '#0f380f', '#306230', '#0f380f', '#306230'],
    walls: ['#9bbc0f', '#8bac0f', '#9bbc0f', '#8bac0f', '#9bbc0f', '#8bac0f', '#9bbc0f', '#8bac0f'],
    landmark: '#0f380f',
    ink: '#0f380f',
    paper: '#9bbc0f',
    window: { dark: '#0f380f', lit: '#9bbc0f', litChance: 0.4 },
    shadowAlpha: 0.5,
    quantise: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  },
  {
    name: 'candy',
    description: 'Soft pastels, toy-town colours, gentle contrast.',
    sky: '#ffd9e8',
    ground: '#f4e7db',
    water: '#7fd4e8',
    greenery: '#8fd98a',
    asphalt: '#ddcbd2',
    roofs: ['#ff8fa3', '#ffb26b', '#c79bff', '#7fd4e8', '#ffd76b', '#8fd98a', '#ff9ecd', '#9ab8ff'],
    walls: ['#fff5ee', '#fff1e4', '#f7f0ff', '#eafaff', '#fff9e6', '#effbea', '#fff2f9', '#f0f3ff'],
    landmark: '#b06bff',
    ink: '#6b4a5a',
    paper: '#ffffff',
    window: { dark: '#c9aeba', lit: '#fff3b0', litChance: 0.25 },
    shadowAlpha: 0.16,
  },
];

export const THEMES: Record<string, Theme> = Object.fromEntries(
  SPECS.map((spec) => [spec.name, buildTheme(spec)]),
);

export const THEME_NAMES: string[] = SPECS.map((s) => s.name);

export const DEFAULT_THEME = 'daylight';

export function getTheme(name: string): Theme {
  const theme = THEMES[name];
  if (!theme) {
    throw new Error(`Unknown theme "${name}". Available: ${THEME_NAMES.join(', ')}`);
  }
  return theme;
}

/**
 * Picks a roof/wall pair for a building. Landmarks get the accent colour so
 * churches and stations stand out from the surrounding housing stock.
 */
export function buildingColors(
  theme: Theme,
  index: number,
  landmark: boolean,
): { roof: RGB; wall: RGB } {
  if (landmark) return { roof: theme.landmarkRoof, wall: theme.landmarkWall };
  const i = ((index % theme.roofs.length) + theme.roofs.length) % theme.roofs.length;
  return {
    roof: theme.roofs[i]!,
    wall: theme.walls[i % theme.walls.length]!,
  };
}

/** Slight per-building tone shift so identical colours do not band together. */
export function jitterColor(color: RGB, unit: number, strength = 0.06): RGB {
  return shade(color, 1 + (unit - 0.5) * 2 * strength);
}

/** A 3-number array inside a theme is always an RGB triple. */
function isRgb(value: unknown): value is RGB {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    typeof value[2] === 'number'
  );
}

/**
 * Rebuilds a theme with every colour passed through `fn`, leaving numbers,
 * strings and structure alone.
 *
 * Walking the theme generically rather than listing its sixty-odd colour
 * fields means a new field added to `Theme` is transformed automatically
 * instead of being silently skipped.
 */
export function mapThemeColors(theme: Theme, fn: (color: RGB) => RGB): Theme {
  const walk = (value: unknown): unknown => {
    if (isRgb(value)) return fn(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(theme) as Theme;
}

/**
 * Drains the colour out of a theme, for spotlight renders where one building
 * stays in colour and the city around it goes to grey.
 *
 * `amount` of 1 is fully neutral; lower values keep a hint of the original
 * hue. Luminance is compressed slightly toward mid-grey so the surviving
 * colour has room to stand out without the greys turning to mud.
 */
export function desaturateTheme(theme: Theme, amount = 1): Theme {
  return mapThemeColors(theme, (color) => {
    // Slightly expanded around mid-grey: a straight luminance map leaves roofs,
    // walls and pavement sitting too close together to tell apart once the hue
    // that separated them is gone.
    const grey = luminance(color);
    const spread = Math.max(0, Math.min(255, 128 + (grey - 128) * 1.22));
    return mix(color, [spread, spread, spread], amount);
  });
}
