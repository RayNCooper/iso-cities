/**
 * A 5x7 bitmap font, drawn pixel by pixel.
 *
 * Bundling a font rather than depending on a text-rendering library keeps the
 * package free of native dependencies and, more importantly, keeps labels
 * looking like they belong in the image: no hinting, no anti-aliasing, every
 * stroke exactly one pixel wide at 1x.
 *
 * Accents are composed rather than enumerated. Text is NFD-normalised, the
 * base letter is drawn from the table below, and combining marks are stamped
 * above (or below) it — which covers the Latin-script place names that make up
 * most queries without needing hundreds of precomposed glyphs.
 */

import type { RGB } from './color.js';
import type { Raster } from './raster.js';

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
/** Rows reserved above the glyph box for accents. */
export const ASCENDER_ROWS = 3;
/** Rows reserved below the glyph box for cedillas and descenders. */
export const DESCENDER_ROWS = 2;

/** Each glyph is 7 rows of 5 columns, '#' = ink. */
const GLYPHS: Record<string, string> = {
  ' ': '...../...../...../...../...../...../.....',
  '!': '..#../..#../..#../..#../..#../...../..#..',
  '"': '.#.#./.#.#./...../...../...../...../.....',
  '#': '.#.#./.#.#./#####/.#.#./#####/.#.#./.#.#.',
  $: '..#../.####/#.#../.###./..#.#/####./..#..',
  '%': '##.../##..#/...#./..#../.#.../#..##/...##',
  '&': '.##../#..#./.#.../##.#./#..#./#..#./.##.#',
  "'": '..#../..#../...../...../...../...../.....',
  '(': '...#./..#../.#.../.#.../.#.../..#../...#.',
  ')': '.#.../..#../...#./...#./...#./..#../.#...',
  '*': '...../#.#.#/.###./#####/.###./#.#.#/.....',
  '+': '...../..#../..#../#####/..#../..#../.....',
  ',': '...../...../...../...../..##./..#../.#...',
  '-': '...../...../...../#####/...../...../.....',
  '.': '...../...../...../...../...../.##../.##..',
  '/': '....#/....#/...#./..#../.#.../#..../#....',
  '0': '.###./#...#/#..##/#.#.#/##..#/#...#/.###.',
  '1': '..#../.##../..#../..#../..#../..#../.###.',
  '2': '.###./#...#/....#/...#./..#../.#.../#####',
  '3': '#####/...#./..##./....#/....#/#...#/.###.',
  '4': '...#./..##./.#.#./#..#./#####/...#./...#.',
  '5': '#####/#..../####./....#/....#/#...#/.###.',
  '6': '..##./.#.../#..../####./#...#/#...#/.###.',
  '7': '#####/....#/...#./..#../.#.../.#.../.#...',
  '8': '.###./#...#/#...#/.###./#...#/#...#/.###.',
  '9': '.###./#...#/#...#/.####/....#/..#../.##..',
  ':': '...../.##../.##../...../.##../.##../.....',
  ';': '...../.##../.##../...../.##../..#../.#...',
  '<': '...#./..#../.#.../#..../.#.../..#../...#.',
  '=': '...../...../#####/...../#####/...../.....',
  '>': '.#.../..#../...#./....#/...#./..#../.#...',
  '?': '.###./#...#/....#/...#./..#../...../..#..',
  '@': '.###./#...#/....#/.##.#/#.#.#/#.#.#/.##..',
  A: '.###./#...#/#...#/#####/#...#/#...#/#...#',
  B: '####./#...#/#...#/####./#...#/#...#/####.',
  C: '.###./#...#/#..../#..../#..../#...#/.###.',
  D: '###../#..#./#...#/#...#/#...#/#..#./###..',
  E: '#####/#..../#..../####./#..../#..../#####',
  F: '#####/#..../#..../####./#..../#..../#....',
  G: '.###./#...#/#..../#.###/#...#/#...#/.####',
  H: '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  I: '.###./..#../..#../..#../..#../..#../.###.',
  J: '..###/...#./...#./...#./...#./#..#./.##..',
  K: '#...#/#..#./#.#../##.../#.#../#..#./#...#',
  L: '#..../#..../#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#',
  N: '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#',
  O: '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  P: '####./#...#/#...#/####./#..../#..../#....',
  Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#',
  R: '####./#...#/#...#/####./#.#../#..#./#...#',
  S: '.####/#..../#..../.###./....#/....#/####.',
  T: '#####/..#../..#../..#../..#../..#../..#..',
  U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  V: '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  W: '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#',
  X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  Y: '#...#/#...#/.#.#./..#../..#../..#../..#..',
  Z: '#####/....#/...#./..#../.#.../#..../#####',
  '[': '.###./.#.../.#.../.#.../.#.../.#.../.###.',
  '\\': '#..../#..../.#.../..#../..#../...#./....#',
  ']': '.###./...#./...#./...#./...#./...#./.###.',
  '^': '..#../.#.#./#...#/...../...../...../.....',
  _: '...../...../...../...../...../...../#####',
  '`': '.#.../..#../...../...../...../...../.....',
  a: '...../...../.###./....#/.####/#...#/.####',
  b: '#..../#..../####./#...#/#...#/#...#/####.',
  c: '...../...../.###./#..../#..../#...#/.###.',
  d: '....#/....#/.####/#...#/#...#/#...#/.####',
  e: '...../...../.###./#...#/#####/#..../.###.',
  f: '..##./.#.../.#.../####./.#.../.#.../.#...',
  g: '...../...../.####/#...#/.####/....#/.###.',
  h: '#..../#..../####./#...#/#...#/#...#/#...#',
  i: '..#../...../.##../..#../..#../..#../.###.',
  j: '...#./...../...#./...#./...#./#..#./.##..',
  k: '#..../#..../#..#./#.#../##.../#.#../#..#.',
  l: '.##../..#../..#../..#../..#../..#../.###.',
  m: '...../...../##.#./#.#.#/#.#.#/#.#.#/#.#.#',
  n: '...../...../####./#...#/#...#/#...#/#...#',
  o: '...../...../.###./#...#/#...#/#...#/.###.',
  p: '...../...../####./#...#/####./#..../#....',
  q: '...../...../.####/#...#/.####/....#/....#',
  r: '...../...../#.##./##..#/#..../#..../#....',
  s: '...../...../.####/#..../.###./....#/####.',
  t: '.#.../.#.../####./.#.../.#.../.#..#/..##.',
  u: '...../...../#...#/#...#/#...#/#..##/.##.#',
  v: '...../...../#...#/#...#/#...#/.#.#./..#..',
  w: '...../...../#...#/#.#.#/#.#.#/#.#.#/.#.#.',
  x: '...../...../#...#/.#.#./..#../.#.#./#...#',
  y: '...../...../#...#/#...#/.####/....#/.###.',
  z: '...../...../#####/...#./..#../.#.../#####',
  '{': '...##/..#../..#../.#.../..#../..#../...##',
  '|': '..#../..#../..#../..#../..#../..#../..#..',
  '}': '##.../..#../..#../...#./..#../..#../##...',
  '~': '...../...../.#..#/#.#.#/#..#./...../.....',
  // Latin letters that NFD does not decompose.
  'ß': '.##../#..#./#..#./#.##./#...#/#...#/#.##.',
  'ø': '...../...../.###./#.##./##.#./.###./.....',
  'Ø': '.###./#..##/#.#.#/#.#.#/##..#/.###./.....',
  '©': '.###./#...#/#.##./#.#../#.##./#...#/.###.',
  '°': '.##../#..#./.##../...../...../...../.....',
  '·': '...../...../...../..#../...../...../.....',
};

/** Drawn for any character with no glyph and no usable decomposition. */
const TOFU = '...../.###./.#.#./.#.#./.#.#./.###./.....';

/** Start and end of the Unicode combining-diacritical-marks block. */
const COMBINING_START = 0x0300;
const COMBINING_END = 0x036f;

/** Combining marks stamped above the glyph box (2 rows of 5), by code point. */
const MARKS_ABOVE: Record<number, string> = {
  0x0300: '.#.../..#..', // grave
  0x0301: '...#./..#..', // acute
  0x0302: '..#../.#.#.', // circumflex
  0x0303: '..##./##...', // tilde
  0x0304: '...../#####', // macron
  0x0306: '#...#/.###.', // breve
  0x0307: '...../..#..', // dot above
  0x0308: '...../.#.#.', // diaeresis
  0x030a: '.###./.#.#.', // ring above
  0x030b: '..#.#/.#.#.', // double acute
  0x030c: '.#.#./..#..', // caron
};

/** Combining marks stamped below the glyph box (2 rows of 5), by code point. */
const MARKS_BELOW: Record<number, string> = {
  0x0327: '..#../.##..', // cedilla
  0x0328: '..#../.##..', // ogonek
  0x0323: '..#../.....', // dot below
};

/** Characters expanded to several letters before layout. */
const EXPANSIONS: Record<string, string> = {
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
  ĳ: 'ij',
  Ĳ: 'IJ',
  ł: 'l',
  Ł: 'L',
  đ: 'd',
  Đ: 'D',
  ð: 'd',
  Ð: 'D',
  þ: 'th',
  Þ: 'Th',
  ı: 'i',
  ' ': ' ',
  '–': '-',
  '—': '-',
  '’': "'",
  '‘': "'",
  '“': '"',
  '”': '"',
};

interface Cell {
  glyph: string;
  above: string | null;
  below: string | null;
}

function parseRows(spec: string): string[] {
  return spec.split('/');
}

/** Turns a string into drawable cells, decomposing accents along the way. */
export function layoutCells(text: string): Cell[] {
  const expanded = Array.from(text)
    .map((ch) => EXPANSIONS[ch] ?? ch)
    .join('');
  const normalised = expanded.normalize('NFD');
  const cells: Cell[] = [];

  for (const ch of normalised) {
    const code = ch.codePointAt(0) ?? 0;
    const above = MARKS_ABOVE[code];
    const below = MARKS_BELOW[code];
    if (above || below) {
      const target = cells[cells.length - 1];
      if (target) {
        if (above) target.above = above;
        if (below) target.below = below;
        continue;
      }
    }
    // Combining marks we have no sprite for are dropped rather than shown as
    // tofu — a missing accent beats a box in the middle of a word.
    if (code >= COMBINING_START && code <= COMBINING_END) continue;
    const glyph = GLYPHS[ch];
    cells.push({ glyph: glyph ?? TOFU, above: null, below: null });
  }
  return cells;
}

/** True if the character can be drawn without falling back to tofu. */
export function hasGlyph(ch: string): boolean {
  if (EXPANSIONS[ch]) return true;
  const base = ch.normalize('NFD')[0];
  return base !== undefined && GLYPHS[base] !== undefined;
}

/** Fraction of non-space characters in `text` that render as real glyphs. */
export function glyphCoverage(text: string): number {
  const chars = Array.from(text).filter((c) => c.trim().length > 0);
  if (chars.length === 0) return 1;
  let ok = 0;
  for (const c of chars) if (hasGlyph(c)) ok++;
  return ok / chars.length;
}

export interface TextOptions {
  /** Integer pixel multiplier. */
  scale?: number;
  /** Blank columns between glyphs, in unscaled pixels. */
  letterSpacing?: number;
  /** Drop shadow colour, offset one scaled pixel down-right. */
  shadow?: RGB;
}

export function measureText(text: string, options: TextOptions = {}): { width: number; height: number } {
  const scale = Math.max(1, Math.floor(options.scale ?? 1));
  const spacing = options.letterSpacing ?? 1;
  const cells = layoutCells(text);
  if (cells.length === 0) return { width: 0, height: 0 };
  const width = (cells.length * (GLYPH_WIDTH + spacing) - spacing) * scale;
  return { width, height: GLYPH_HEIGHT * scale };
}

/**
 * Draws `text` with its glyph box's top-left corner at (x, y). Accents extend
 * up to {@link ASCENDER_ROWS} rows above that point, so leave headroom.
 */
export function drawText(
  raster: Raster,
  text: string,
  x: number,
  y: number,
  color: RGB,
  options: TextOptions = {},
): number {
  const scale = Math.max(1, Math.floor(options.scale ?? 1));
  const spacing = options.letterSpacing ?? 1;
  const cells = layoutCells(text);

  const paint = (offsetX: number, offsetY: number, ink: RGB) => {
    let penX = Math.round(x) + offsetX;
    const penY = Math.round(y) + offsetY;
    for (const cell of cells) {
      drawSprite(raster, parseRows(cell.glyph), penX, penY, scale, ink);
      if (cell.above) drawSprite(raster, parseRows(cell.above), penX, penY - 3 * scale, scale, ink);
      if (cell.below) {
        drawSprite(raster, parseRows(cell.below), penX, penY + GLYPH_HEIGHT * scale, scale, ink);
      }
      penX += (GLYPH_WIDTH + spacing) * scale;
    }
  };

  if (options.shadow) paint(scale, scale, options.shadow);
  paint(0, 0, color);

  return (cells.length * (GLYPH_WIDTH + spacing) - spacing) * scale;
}

function drawSprite(
  raster: Raster,
  rows: string[],
  x: number,
  y: number,
  scale: number,
  color: RGB,
): void {
  for (let row = 0; row < rows.length; row++) {
    const line = rows[row]!;
    for (let col = 0; col < line.length; col++) {
      if (line[col] !== '#') continue;
      const px = x + col * scale;
      const py = y + row * scale;
      if (scale === 1) {
        raster.set(px, py, color);
      } else {
        raster.fillRect(px, py, scale, scale, color);
      }
    }
  }
}

/** Exposed for the test that asserts every glyph is well-formed. */
export const __glyphTable: Readonly<Record<string, string>> = GLYPHS;
export const __markTables: Readonly<Record<number, string>>[] = [MARKS_ABOVE, MARKS_BELOW];
