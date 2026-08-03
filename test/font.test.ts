import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ASCENDER_ROWS,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  __glyphTable,
  __markTables,
  drawText,
  glyphCoverage,
  hasGlyph,
  layoutCells,
  measureText,
} from '../src/render/font.js';
import { Raster } from '../src/render/raster.js';

test('every glyph is exactly 7 rows of 5 columns', () => {
  for (const [char, spec] of Object.entries(__glyphTable)) {
    const rows = spec.split('/');
    assert.equal(rows.length, GLYPH_HEIGHT, `glyph ${JSON.stringify(char)} has ${rows.length} rows`);
    for (const [i, row] of rows.entries()) {
      assert.equal(row.length, GLYPH_WIDTH, `glyph ${JSON.stringify(char)} row ${i} is "${row}"`);
      assert.ok(/^[.#]+$/.test(row), `glyph ${JSON.stringify(char)} row ${i} has stray characters`);
    }
  }
});

test('every accent sprite is exactly 2 rows of 5 columns', () => {
  for (const table of __markTables) {
    for (const [code, spec] of Object.entries(table)) {
      const rows = spec.split('/');
      assert.equal(rows.length, 2, `mark U+${Number(code).toString(16)} has ${rows.length} rows`);
      for (const row of rows) {
        assert.equal(row.length, GLYPH_WIDTH, `mark U+${Number(code).toString(16)} row "${row}"`);
        assert.ok(/^[.#]+$/.test(row));
      }
    }
  }
});

test('the full printable ASCII range is covered', () => {
  for (let code = 0x20; code <= 0x7e; code++) {
    const char = String.fromCharCode(code);
    assert.ok(__glyphTable[char], `missing glyph for ${JSON.stringify(char)} (U+${code.toString(16)})`);
  }
});

test('accents are composed onto the base letter, not shown as tofu', () => {
  const cells = layoutCells('Köln');
  assert.equal(cells.length, 4, 'the diaeresis must not take a cell of its own');
  assert.ok(cells[1]!.above, 'the o should carry a mark above it');
  assert.equal(cells[1]!.glyph, __glyphTable['o']);
});

test('a variety of European place names stay fully renderable', () => {
  for (const name of ['Köln', 'München', 'Zürich', 'Malmö', 'Kraków', 'Reykjavík', 'Aarhus', 'Genève']) {
    assert.equal(glyphCoverage(name), 1, `${name} is not fully renderable`);
  }
});

test('letters without a decomposition have their own glyphs', () => {
  for (const char of ['ß', 'ø', 'Ø', '©']) {
    assert.ok(hasGlyph(char), `${char} should be renderable`);
    assert.equal(layoutCells(char).length, 1);
  }
});

test('ligatures expand to several cells', () => {
  assert.equal(layoutCells('Æ').length, 2);
  assert.equal(layoutCells('æ').length, 2);
  assert.equal(layoutCells('ł').length, 1);
});

test('cedillas are stamped below the glyph', () => {
  const cells = layoutCells('ç');
  assert.equal(cells.length, 1);
  assert.ok(cells[0]!.below, 'expected a mark below');
});

test('unknown characters fall back to tofu and are reported by coverage', () => {
  const cells = layoutCells('東京');
  assert.equal(cells.length, 2);
  assert.equal(glyphCoverage('東京'), 0);
  assert.ok(glyphCoverage('Tokyo 東京') > 0 && glyphCoverage('Tokyo 東京') < 1);
});

test('measureText matches the advance width', () => {
  const single = measureText('A', { scale: 1, letterSpacing: 1 });
  assert.equal(single.width, GLYPH_WIDTH);
  assert.equal(single.height, GLYPH_HEIGHT);

  const triple = measureText('ABC', { scale: 1, letterSpacing: 1 });
  assert.equal(triple.width, 3 * GLYPH_WIDTH + 2);

  const scaled = measureText('ABC', { scale: 2, letterSpacing: 1 });
  assert.equal(scaled.width, triple.width * 2);
  assert.equal(scaled.height, GLYPH_HEIGHT * 2);

  assert.equal(measureText('').width, 0);
});

test('drawText paints ink and returns the advance', () => {
  const raster = new Raster(80, 20, [0, 0, 0]);
  const advance = drawText(raster, 'HI', 2, ASCENDER_ROWS, [255, 255, 255]);
  assert.equal(advance, measureText('HI').width);

  let lit = 0;
  for (let i = 0; i < raster.data.length; i += 4) {
    if (raster.data[i] === 255) lit++;
  }
  assert.ok(lit > 10, 'expected the glyphs to light up pixels');
});

test('drawText with a shadow paints strictly more pixels', () => {
  const plain = new Raster(80, 20, [0, 0, 0]);
  drawText(plain, 'Ag', 2, ASCENDER_ROWS, [255, 255, 255]);

  const shadowed = new Raster(80, 20, [0, 0, 0]);
  drawText(shadowed, 'Ag', 2, ASCENDER_ROWS, [255, 255, 255], { shadow: [128, 128, 128] });

  const count = (r: Raster, value: number) => {
    let n = 0;
    for (let i = 0; i < r.data.length; i += 4) if (r.data[i] === value) n++;
    return n;
  };
  assert.equal(count(plain, 255), count(shadowed, 255), 'ink coverage is unchanged');
  assert.ok(count(shadowed, 128) > 0, 'shadow was drawn');
});

test('text drawn off-canvas is clipped rather than throwing', () => {
  const raster = new Raster(10, 10, [0, 0, 0]);
  drawText(raster, 'A very long label indeed', -50, -50, [255, 255, 255]);
  drawText(raster, 'A very long label indeed', 200, 200, [255, 255, 255]);
});

test('lowercase descenders sit on the baseline, not the cap line', () => {
  // A regression guard: p/g/q/y once started a row too high and read as capitals.
  for (const char of ['p', 'g', 'q', 'y']) {
    const rows = __glyphTable[char]!.split('/');
    assert.equal(rows[0], '.....', `${char} should not reach the cap line`);
    assert.equal(rows[1], '.....', `${char} should start at the x-height`);
  }
  // ...while true ascenders still do reach it.
  for (const char of ['b', 'd', 'h', 'k', 'l']) {
    assert.notEqual(__glyphTable[char]!.split('/')[0], '.....', `${char} should have an ascender`);
  }
});
