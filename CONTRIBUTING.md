# Contributing

Thanks for taking a look. Bug reports, new themes and better OSM tag coverage are all genuinely useful.

## Getting set up

```bash
git clone https://github.com/RayNCooper/iso-cities.git
cd iso-cities
npm install
npm test
```

Node.js 20.11 or newer. There are no runtime dependencies and only two dev dependencies (TypeScript and `@types/node`); please keep it that way unless there is a strong reason not to.

```bash
npm run build       # compile src -> dist
npm test            # compile and run the test suite (no network needed)
npm run typecheck   # types only, no output
node dist/cli.js "your home town"
```

## Project layout

```
src/
  cli.ts            Command line entry point
  index.ts          Public API — renderCity() plus the individual steps
  geo/              lat/lon -> local metres, polygon clipping and stitching
  net/              Nominatim, Overpass, rate limiting, disk cache
  osm/              OSM tags -> the categories the renderer understands
  scene/            Overpass response -> projected, clipped, classified scene
  render/           Isometric projection, rasteriser, themes, font, drawing
  image/png.ts      PNG encoder
test/               node:test suites, one per area
```

The dependency direction is one way: `render/` knows nothing about OSM or HTTP, `scene/` knows nothing about pixels. Keeping that boundary is what lets the renderer be tested without a network.

## Testing

The suite runs entirely offline — Overpass responses are constructed as fixtures in the test files rather than recorded. Please keep it that way; a test suite that needs the network is a test suite that fails in CI for reasons unrelated to your change.

Useful things to assert:

- **Rendering is deterministic.** Same scene, same seed, same options must give byte-identical output. If you add a visual feature, drive its variation from `stableUnit(id, seed, channel)`, never from `Math.random()`.
- **Nothing throws on bad data.** OSM contains unclosed "closed" ways, relations with no members, 99999-metre buildings and nodes with no coordinates. Every one of those has a test.
- **Geometry stays inside the square.** Features are clipped to the render bounds; if you touch clipping, assert that.

## Adding a theme

Themes live in `SPECS` in `src/render/palette.ts`. Add an entry with the dozen key colours and the rest is derived:

```ts
{
  name: 'blueprint',
  description: 'One line, shown by --themes.',
  sky: '#0d2b52',
  ground: '#123a6b',
  // ...roofs, walls, asphalt, greenery, water, ink, paper, window, shadowAlpha
}
```

`quantise` is optional: give it a list of hex colours and every derived value snaps to the nearest one. That is how `gameboy` holds to four tones.

Two tests will hold you to it automatically: every theme must define every road class and green kind, and label text must contrast with the sky by at least 40 units of luminance.

## Improving tag coverage

`src/osm/classify.ts` is where OSM's open-ended tagging becomes a small set of drawable categories. It deliberately keeps only what changes a pixel.

If a feature type renders wrong or not at all, that file is almost always the place to fix it. Add the tag to the relevant map, add a case to `test/classify.test.ts`, and — if it needs fetching too — add it to the Overpass query in `src/net/overpass.ts`. Those two must stay in sync; a tag that is classified but never fetched does nothing.

## Pull requests

- One concern per PR.
- Run `npm test` before pushing. CI runs the same thing on Node 20 and 22.
- Match the surrounding style: comments explain *why*, not *what*.
- For anything that changes how output looks, please attach a before/after image. It is a rendering project; screenshots review faster than diffs.

## Reporting a bug

Include the exact command, what you expected, and what you got. For rendering problems the output image is worth far more than a description. If the geocoder sent you somewhere unexpected, `--json` dumps the resolved scene, which usually shows why straight away.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
