# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-09-15

### Added

- **The outbreak simulation** (`outbreak/`). A stochastic metapopulation SEIR
  model over the Rheinland and the Ruhr, rendered to an isometric pixel-art map
  and encoded to video. Patient zero is Eicken, in Mönchengladbach; the outbreak
  travels the real road network and reaches every Kreis in the region.

  Built on the package rather than added to it: 646 compartments from OSM
  boundaries (Gemeinde and Stadtteil granularity), populations from Wikidata
  P1082, 45k road segments driving a gravity model. Density-weighted
  transmission, integer walkers allocated by largest remainder, and a
  spark-extinction term that gives the advancing front its ragged edge. Seeded
  and deterministic. `node outbreak/render.mjs`.

- **`--auto`**: one input that infers the framing from what you actually
  matched. A county, state or country is drawn as its own outline; a city or
  district gets a radius around its centre; a single address is drawn close with
  its building picked out. Reads Nominatim's `place_rank`, and falls back to the
  centre point with an explanation when the shape is too large for the public
  Overpass API to serve.

- **Six new themes** — `blueprint`, `sepia`, `neon`, `autumn`, `arctic` and
  `newsprint` — bringing the set to twelve. A theme declares about a dozen key
  colours and the rest is derived, so the palette stays internally consistent;
  `gameboy` still snaps every derived value to four tones.

- **`--center-on-highlight`** (and the `--centre-` spelling): frame the render on
  the highlighted address rather than on the place's centroid, which for a large
  city can otherwise leave the address outside the picture entirely. Warns
  rather than silently doing nothing with `--region`.

- **A live demo**, running the whole renderer client-side with no install and
  nothing uploaded, plus a share card, touch icon, `robots.txt` and a sitemap.
  `npm run serve`.

### Changed

- **The greyscale default is gone.** A render now opens on a real theme, and the
  demo's picker was rebuilt around the full twelve.
- The demo was restyled to Olio's identity, with a loader and address centring.
- The demo's opening view is a scene baked at build time rather than rendered on
  first load, so the page is complete before any network request.

### Fixed

- **Overpass 504s.** Requests are now sized to the area they cover — asking for
  half a gigabyte to draw four city blocks means queueing behind every other
  large job, which is where the gateway timeouts came from. Mirror list
  corrected to real, currently-live backends, with an empty answer treated as
  suspicious and re-asked elsewhere rather than rendered as a blank image.

[Unreleased]: https://github.com/RayNCooper/iso-cities/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/RayNCooper/iso-cities/compare/v0.1.0...v0.2.0
