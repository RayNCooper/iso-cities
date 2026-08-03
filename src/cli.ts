#!/usr/bin/env node
/**
 * Command line interface.
 */

import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { renderCity, clampRadius, DEFAULT_RADIUS_METRES, MAX_RADIUS_METRES, MIN_RADIUS_METRES } from './index.js';
import { ResponseCache, defaultCacheDir } from './net/cache-node.js';
import { GeocodeError, type PlaceQuery } from './net/nominatim.js';
import { OverpassError } from './net/overpass.js';
import { DEFAULT_THEME, THEMES, THEME_NAMES } from './render/palette.js';
import { DEFAULT_HIGHLIGHT_COLOR } from './render/render.js';
import { PACKAGE_NAME, PROJECT_URL, VERSION } from './version.js';

const HELP = `${PACKAGE_NAME} ${VERSION} — turn a city or postal code into isometric pixel art

USAGE
  iso-cities <place>                       Free-form search
  iso-cities --postcode <code> --country <c>
  iso-cities --city <name> --country <c>
  iso-cities --lat <deg> --lon <deg>

EXAMPLES
  iso-cities "Kreuzberg, Berlin"
  iso-cities --postcode 10115 --country DE --theme dusk
  iso-cities "Porto" --radius 250 --scale 4 -o porto.png
  iso-cities --lat 45.4408 --lon 12.3155 --theme gameboy
  iso-cities --postcode 10115 --country DE --region
  iso-cities "Bruges, Belgium" --region --no-trees
  iso-cities --postcode 10115 --country DE --region \\
             --highlight "Museum fuer Naturkunde, Berlin"

PLACE
  --city <name>            City, town or district name
  --postcode <code>        Postal code (pair it with --country)
  --county <name>          County / district
  --state <name>           State or region
  --country <name|code>    Country name or ISO code, e.g. DE
  --lat <deg> --lon <deg>  Exact coordinates, skipping the geocoder
  --name <text>            Override the label drawn on the image
  --language <code>        Preferred language for place names (default: en)

REGION
      --region             Draw the place's real outline instead of a square.
                           Works for postcode districts and city boundaries;
                           falls back to --radius if the match has no outline.

HIGHLIGHT
      --highlight <addr>   Single out an address: everything else turns grey
                           and a pin is dropped on the matching building
      --highlight-lat <d>  Highlight an exact coordinate instead
      --highlight-lon <d>
      --highlight-label <t>  Label to draw for it (default: the query text)
      --highlight-color <hex>  Accent colour (default: ${DEFAULT_HIGHLIGHT_COLOR})
      --no-marker          Skip the pin, colour the building only
      --no-desaturate      Keep everything in colour, just accent the match

FRAMING
  -r, --radius <metres>    Half-width of the area to draw (default: ${DEFAULT_RADIUS_METRES}, ${MIN_RADIUS_METRES}-${MAX_RADIUS_METRES})
  -w, --width <px>         Native pixel width before upscaling (default: 1024)
      --height <px>        Native pixel height (default: derived from width)
  -s, --scale <n>          Nearest-neighbour upscale factor (default: 2)
      --exaggeration <n>   Vertical height multiplier (default: 1.35)

  A smaller radius means more pixels per metre and chunkier, more detailed
  buildings. Windows and railway sleepers only appear once there is room.

STYLE
  -t, --theme <name>       ${THEME_NAMES.join(', ')} (default: ${DEFAULT_THEME})
      --themes             List themes with descriptions and exit
      --seed <n>           Seed for roof colours and tree scatter (default: 0)
      --title <text>       Override the title text
      --no-title           Omit the title
      --no-subtitle        Omit the coordinate line
      --no-attribution     Omit the OpenStreetMap credit (see ATTRIBUTION.md)
      --no-shadows         Skip ground shadows
      --no-windows         Skip windows on walls
      --no-outlines        Skip dark building outlines

LAYERS
  --no-buildings  --no-roads  --no-water  --no-greenery  --no-trees  --no-rails

OUTPUT
  -o, --out <file>         PNG path (default: derived from the place name)
      --json <file>        Also write the scene as JSON
      --stdout             Write PNG bytes to stdout instead of a file
  -q, --quiet              Suppress progress output

NETWORK
  --no-cache               Bypass the on-disk response cache
  --cache-dir <dir>        Cache location (default: ${defaultCacheDir()})
  --clear-cache            Delete all cached responses and exit
  --nominatim-url <url>    Geocoder base URL
  --overpass-url <url>     Overpass endpoint (comma-separate for mirrors)
  --timeout <ms>           Per-request timeout (default: 90000)

  Map data © OpenStreetMap contributors, licensed under the ODbL. Please keep
  the credit on images you publish, and be gentle with the public APIs.
  ${PROJECT_URL}
`;

interface ParsedFlags {
  [key: string]: string | boolean | undefined;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        themes: { type: 'boolean' },
        'clear-cache': { type: 'boolean' },

        city: { type: 'string' },
        postcode: { type: 'string' },
        county: { type: 'string' },
        state: { type: 'string' },
        country: { type: 'string' },
        lat: { type: 'string' },
        lon: { type: 'string' },
        name: { type: 'string' },
        language: { type: 'string' },

        region: { type: 'boolean' },
        highlight: { type: 'string' },
        'highlight-lat': { type: 'string' },
        'highlight-lon': { type: 'string' },
        'highlight-label': { type: 'string' },
        'highlight-color': { type: 'string' },
        'no-marker': { type: 'boolean' },
        'no-desaturate': { type: 'boolean' },

        radius: { type: 'string', short: 'r' },
        width: { type: 'string', short: 'w' },
        height: { type: 'string' },
        scale: { type: 'string', short: 's' },
        exaggeration: { type: 'string' },

        theme: { type: 'string', short: 't' },
        seed: { type: 'string' },
        title: { type: 'string' },
        'no-title': { type: 'boolean' },
        'no-subtitle': { type: 'boolean' },
        'no-attribution': { type: 'boolean' },
        'no-shadows': { type: 'boolean' },
        'no-windows': { type: 'boolean' },
        'no-outlines': { type: 'boolean' },

        'no-buildings': { type: 'boolean' },
        'no-roads': { type: 'boolean' },
        'no-water': { type: 'boolean' },
        'no-greenery': { type: 'boolean' },
        'no-trees': { type: 'boolean' },
        'no-rails': { type: 'boolean' },

        out: { type: 'string', short: 'o' },
        json: { type: 'string' },
        stdout: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },

        'no-cache': { type: 'boolean' },
        'cache-dir': { type: 'string' },
        'nominatim-url': { type: 'string' },
        'overpass-url': { type: 'string' },
        timeout: { type: 'string' },
      },
    });
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\nRun "iso-cities --help" for usage.\n`);
    return 2;
  }

  const flags = parsed.values as ParsedFlags;
  const positionals = parsed.positionals;

  if (flags['help']) {
    process.stdout.write(HELP);
    return 0;
  }
  if (flags['version']) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flags['themes']) {
    for (const name of THEME_NAMES) {
      process.stdout.write(`  ${name.padEnd(10)} ${THEMES[name]!.description}\n`);
    }
    return 0;
  }
  if (flags['clear-cache']) {
    const dir = (flags['cache-dir'] as string) ?? defaultCacheDir();
    const removed = await new ResponseCache({ dir }).clear();
    process.stdout.write(`Removed ${removed} cached response(s) from ${dir}\n`);
    return 0;
  }

  const quiet = Boolean(flags['quiet']) || Boolean(flags['stdout']);
  const log = (message: string) => {
    if (!quiet) process.stderr.write(`${message}\n`);
  };

  let query: PlaceQuery;
  try {
    query = buildQuery(flags, positionals);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\nRun "iso-cities --help" for usage.\n`);
    return 2;
  }

  const theme = (flags['theme'] as string) ?? DEFAULT_THEME;
  if (!THEME_NAMES.includes(theme)) {
    process.stderr.write(`Unknown theme "${theme}". Available: ${THEME_NAMES.join(', ')}\n`);
    return 2;
  }

  const radius = clampRadius(numberFlag(flags, 'radius', DEFAULT_RADIUS_METRES));
  const requestedRadius = numberFlag(flags, 'radius', DEFAULT_RADIUS_METRES);
  if (requestedRadius !== radius) {
    log(`Radius clamped to ${radius} m (allowed range ${MIN_RADIUS_METRES}-${MAX_RADIUS_METRES}).`);
  }

  const timeout = numberFlag(flags, 'timeout', 90_000);

  let highlight: PlaceQuery | undefined;
  try {
    highlight = buildHighlightQuery(flags);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\nRun "iso-cities --help" for usage.\n`);
    return 2;
  }

  try {
    const result = await renderCity(query, {
      radius,
      theme,
      region: Boolean(flags['region']),
      ...(highlight ? { highlight } : {}),
      ...(flags['highlight-label'] ? { highlightLabel: flags['highlight-label'] as string } : {}),
      ...(flags['highlight-color'] ? { highlightColor: flags['highlight-color'] as string } : {}),
      marker: !flags['no-marker'],
      ...(flags['no-desaturate'] ? { desaturate: false } : {}),
      width: numberFlag(flags, 'width', 1024),
      ...(flags['height'] ? { height: numberFlag(flags, 'height', 0) } : {}),
      scale: numberFlag(flags, 'scale', 2),
      verticalExaggeration: numberFlag(flags, 'exaggeration', 1.35),
      seed: numberFlag(flags, 'seed', 0),
      title: flags['no-title'] ? false : ((flags['title'] as string) ?? undefined),
      subtitle: flags['no-subtitle'] ? false : undefined,
      attribution: !flags['no-attribution'],
      shadows: !flags['no-shadows'],
      windows: !flags['no-windows'],
      outlines: !flags['no-outlines'],
      layers: {
        buildings: !flags['no-buildings'],
        roads: !flags['no-roads'],
        water: !flags['no-water'],
        greenery: !flags['no-greenery'],
        trees: !flags['no-trees'],
        rails: !flags['no-rails'],
      },
      cache: flags['no-cache']
        ? false
        : flags['cache-dir']
          ? { dir: flags['cache-dir'] as string }
          : {},
      geocode: {
        ...(flags['nominatim-url'] ? { url: flags['nominatim-url'] as string } : {}),
        ...(flags['language'] ? { language: flags['language'] as string } : {}),
        timeoutMs: timeout,
      },
      overpass: {
        ...(flags['overpass-url'] ? { urls: splitList(flags['overpass-url'] as string) } : {}),
        timeoutMs: timeout,
      },
      onProgress: log,
    });

    if (result.scene.stats.buildings === 0) {
      log(
        'Warning: no buildings found here. The area may be rural, or the query ' +
          'may have resolved somewhere unexpected — try a larger --radius.',
      );
    }

    if (flags['stdout']) {
      process.stdout.write(result.png);
    } else {
      const out = resolve((flags['out'] as string) ?? `${slugify(result.place.name)}.png`);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, result.png);
      log(`Wrote ${basename(out)} (${result.width}x${result.height}, ${formatBytes(result.png.length)})`);
      if (!quiet) process.stdout.write(`${out}\n`);
    }

    if (flags['json']) {
      const jsonPath = resolve(flags['json'] as string);
      await mkdir(dirname(jsonPath), { recursive: true });
      await writeFile(jsonPath, JSON.stringify(result.scene, null, 2));
      log(`Wrote ${basename(jsonPath)}`);
    }

    return 0;
  } catch (error) {
    process.stderr.write(`\n${describeFailure(error)}\n`);
    return 1;
  }
}

function buildQuery(flags: ParsedFlags, positionals: string[]): PlaceQuery {
  const query: PlaceQuery = {};

  const lat = flags['lat'] as string | undefined;
  const lon = flags['lon'] as string | undefined;
  if ((lat === undefined) !== (lon === undefined)) {
    throw new Error('--lat and --lon must be given together.');
  }
  if (lat !== undefined && lon !== undefined) {
    const latValue = Number(lat);
    const lonValue = Number(lon);
    if (!Number.isFinite(latValue) || !Number.isFinite(lonValue)) {
      throw new Error('--lat and --lon must be numbers.');
    }
    query.lat = latValue;
    query.lon = lonValue;
  }

  if (flags['city']) query.city = flags['city'] as string;
  if (flags['postcode']) query.postcode = flags['postcode'] as string;
  if (flags['county']) query.county = flags['county'] as string;
  if (flags['state']) query.state = flags['state'] as string;
  if (flags['country']) query.country = flags['country'] as string;
  if (flags['name']) query.name = flags['name'] as string;

  const free = positionals.join(' ').trim();
  if (free.length > 0) {
    if (query.lat !== undefined) {
      // Coordinates win; treat the text as the label.
      if (!query.name) query.name = free;
    } else {
      query.q = free;
    }
  }

  const hasSomething =
    query.q !== undefined ||
    query.lat !== undefined ||
    query.city !== undefined ||
    query.postcode !== undefined ||
    query.county !== undefined ||
    query.state !== undefined ||
    query.country !== undefined;

  if (!hasSomething) {
    throw new Error('No place given. Pass a name, or --postcode with --country, or --lat/--lon.');
  }
  if (query.postcode && !query.country && query.lat === undefined) {
    throw new Error(
      'A postcode on its own is ambiguous — add --country (e.g. --postcode 10115 --country DE).',
    );
  }
  return query;
}

/** Builds the highlight query from --highlight or --highlight-lat/-lon. */
function buildHighlightQuery(flags: ParsedFlags): PlaceQuery | undefined {
  const address = flags['highlight'] as string | undefined;
  const lat = flags['highlight-lat'] as string | undefined;
  const lon = flags['highlight-lon'] as string | undefined;

  if ((lat === undefined) !== (lon === undefined)) {
    throw new Error('--highlight-lat and --highlight-lon must be given together.');
  }

  if (lat !== undefined && lon !== undefined) {
    const latValue = Number(lat);
    const lonValue = Number(lon);
    if (!Number.isFinite(latValue) || !Number.isFinite(lonValue)) {
      throw new Error('--highlight-lat and --highlight-lon must be numbers.');
    }
    return { lat: latValue, lon: lonValue };
  }

  if (address !== undefined) {
    if (address.trim().length === 0) throw new Error('--highlight needs an address.');
    return { q: address };
  }

  if (flags['highlight-label'] || flags['highlight-color']) {
    throw new Error('--highlight-label and --highlight-color need --highlight or --highlight-lat/-lon.');
  }
  return undefined;
}

function numberFlag(flags: ParsedFlags, key: string, fallback: number): number {
  const raw = flags[key];
  if (raw === undefined || typeof raw !== 'string') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${key} must be a number, got "${raw}".`);
  }
  return value;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function slugify(name: string): string {
  // Decompose, drop combining marks by code point, then keep only ASCII
  // word characters. Avoids embedding literal combining marks in source.
  const stripped = Array.from(name.normalize('NFD'))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x0300 || code > 0x036f;
    })
    .join('');
  const slug = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug.slice(0, 60) : 'city';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeFailure(error: unknown): string {
  if (error instanceof GeocodeError) {
    return `Could not find that place.\n  ${error.message}`;
  }
  if (error instanceof OverpassError) {
    return `Could not fetch map data.\n  ${error.message}`;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Request timed out. Try a smaller --radius or a longer --timeout.';
  }
  return `Unexpected error.\n  ${errorMessage(error)}`;
}

// Only run when executed directly, so importing this module (from tests, or
// to reuse `main`) does not kick off a render. realpath is what makes the npm
// bin symlink resolve to this file.
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
