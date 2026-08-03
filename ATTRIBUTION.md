# Attribution and data licensing

## The short version

Images produced by `iso-cities` are derived from OpenStreetMap data. If you publish one, credit:

> © OpenStreetMap contributors

The renderer draws this into the bottom-left of every image by default, and writes it into the PNG's `Source` metadata chunk regardless.

## The longer version

### What licence applies to what

| Thing | Licence |
| --- | --- |
| The source code in this repository | [MIT](LICENSE) |
| Map data fetched at runtime from OpenStreetMap | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |
| Images you render | Derived from ODbL data — see below |

OpenStreetMap data is published under the Open Database License. The project's own guidance is in the [Copyright and License](https://www.openstreetmap.org/copyright) page and the [Licence/Attribution Guidelines](https://wiki.osmfoundation.org/wiki/Licence/Attribution_Guidelines).

### Attribution in practice

The guidelines ask that credit appear "in a place customary for that medium", and be reasonably visible to anyone seeing the image.

- **Sharing an image on its own** (social media, a poster, a slide): keep the drawn-in credit. This is what the default does.
- **Embedding on a page** where you already credit sources: `--no-attribution` is fine, provided "© OpenStreetMap contributors" appears near the image — a caption, a figure credit, or an about page linked from it.
- **Never**: strip the credit and present the image as if the underlying data were yours.

`--no-attribution` exists to let you move the credit somewhere better. It does not exist to remove it.

### Is a render a "Derivative Database" or a "Produced Work"?

A rendered image is a **Produced Work** under the ODbL: a visual presentation of the data rather than a database. Produced Works carry the attribution requirement but do not trigger ODbL's share-alike clause, so you are not obliged to license your image under ODbL.

The scene JSON that `--json` writes is a different matter. That is extracted, restructured map data, so it is closer to a Derivative Database — if you redistribute it, ODbL's share-alike terms apply.

This is a plain-language summary, not legal advice. Read the licence if the distinction matters to your use.

## API usage policies

This tool queries two pieces of free, volunteer-run infrastructure. Both have usage policies, and abusing them gets IP ranges blocked for everyone.

- **Nominatim** (geocoding) — [usage policy](https://operations.osmfoundation.org/policies/nominatim/)
- **Overpass API** (map data) — [usage policy](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)

### What this tool does on your behalf

| Requirement | How it is handled |
| --- | --- |
| Identify yourself with a real User-Agent | Sent automatically; override with `ISO_CITIES_USER_AGENT` |
| No more than 1 request/second | Enforced per host, with a serialised queue |
| Cache aggressively | Responses cached on disk for 7 days (30 for geocoding) |
| Back off on errors | Exponential backoff, and `Retry-After` is honoured |
| Do not hammer a single mirror | Three Overpass mirrors, tried in order |

### What you should do

- **Set a contact User-Agent** if you are running this at any scale, so the operators can reach you rather than just block you:
  ```bash
  export ISO_CITIES_USER_AGENT="my-project/1.0 (me@example.com)"
  ```
- **Leave the cache on.** Re-rendering the same place in six themes should cost one query, not six. It does, unless you pass `--no-cache`.
- **Do not bulk-render.** Looping over thousands of postcodes against the public API is exactly the abuse these policies exist to prevent.
- **Run your own instance** if you need volume: [Overpass installation guide](https://wiki.openstreetmap.org/wiki/Overpass_API/Installation), then point at it with `--overpass-url` or `ISO_CITIES_OVERPASS_URL`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `ISO_CITIES_USER_AGENT` | User-Agent for all outbound requests |
| `ISO_CITIES_OVERPASS_URL` | Overpass endpoint(s), comma-separated |
| `ISO_CITIES_NOMINATIM_URL` | Nominatim base URL |
| `ISO_CITIES_CACHE_DIR` | Cache location |
