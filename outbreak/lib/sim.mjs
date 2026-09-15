/**
 * The outbreak itself: a stochastic metapopulation SEIR model over the
 * Rheinland and the Ruhr.
 *
 * Structure — every sub-unit (Gemeinde or Stadtteil) is one well-mixed
 * compartment. Each has a population and a centroid. Movement between them is
 * a gravity model over the real road network, and within a unit people are
 * split into a *core* (dense, urban, mixes fast) and a *sprawl* (the rest),
 * which is what lets a city fall district by district rather than all at once.
 *
 * Why a metapopulation model and not a per-person agent simulation: 10 million
 * individuals × 400 days is 4 billion agent-steps, and the emergent behaviour
 * at that scale is exactly what the deterministic-plus-noise equations below
 * already produce. The randomness that matters — a chain of transmission
 * going extinct before it takes off, a suburb holding out for a week — is
 * modelled explicitly rather than emerging from noise.
 *
 * Everything is driven by one seeded PRNG, so a given seed always produces the
 * same outbreak.
 */

/* -------------------------------------------------------------------------- */
/* Random                                                                     */
/* -------------------------------------------------------------------------- */

/** mulberry32 — the same PRNG iso-cities uses, so results are reproducible. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal, Box–Muller. */
function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/* -------------------------------------------------------------------------- */
/* Disease model                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A zombie outbreak is an SEIR model with a hard end state: infection is
 * effectively always lethal and always converts, so `removed` is "no longer
 * part of the human population" — dead, or turned.
 *
 * Timings are the genre's, not epidemiology's. A bite turns someone in a day
 * or two, which is what makes a region-wide collapse possible in months
 * rather than never.
 */
export const DISEASE = {
  /** Mean latent period, days. Bitten, not yet infectious. */
  incubationDays: 0.9,
  /** Mean time from infectious to turned, days. */
  onsetDays: 1.4,
  /**
   * Secondary infections per infectious case per day, in a fully susceptible,
   * fully-mixed district.
   *
   * This is the number the whole film depends on. R0 is
   * `beta * (incubationDays + onsetDays)`, so at 1.35 it is about 3.1 — high
   * enough that an established district is unstoppable, low enough that an
   * average doubling still takes two to three days, which is what leaves the
   * front legible instead of turning the map into a flood.
   */
  beta: 1.35,
  /**
   * Share of a district's turned that travels to a neighbour per day.
   *
   * Deliberately small. This is an *export* rate, and it compounds: at 0.22
   * (the first value tried) a city of 50,000 turned was exporting 11,000
   * walkers a day across the region and the whole Rhineland was over before
   * the front had a shape. At 0.03 the outbreak still crosses 40 km in a
   * fortnight but arrives somewhere, rather than everywhere at once.
   */
  mobility: 0.03,
};

/**
 * The probability a single case outside the initial focus dies out on its own.
 * Without this a spark in a village of 300 people instantly becomes a regional
 * outbreak, because the equations are deterministic and 300 susceptible people
 * is 300 guaranteed infections.
 */
const SPARK_ESCAPE_BASE = 0.86;

/* -------------------------------------------------------------------------- */
/* Building the model                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Splits a sub-unit into a dense core and a sprawl.
 *
 * A Stadtteil of 30,000 in Essen is mostly apartment blocks — a few hundred
 * metres of contact network. A Gemeinde of 30,000 in the Kreis Kleve is a town
 * plus 40 km² of fields. Same population, completely different outbreak
 * speed, so density decides the split.
 */
function splitCore(population, areaKm2) {
  const perKm2 = areaKm2 > 0 ? population / areaKm2 : 0;
  // Below ~250/km² it is rural enough that there is no separate core.
  const coreShare = Math.max(0, Math.min(0.9, (perKm2 - 250) / 2250));
  return {
    core: Math.round(population * coreShare),
    sprawl: population - Math.round(population * coreShare),
    density: perKm2,
  };
}

/**
 * Builds the transmissible graph: every sub-unit, its neighbourhood of
 * connected sub-units, and the corridor length between each pair.
 *
 * Connections are found by a uniform spatial grid rather than an all-pairs
 * sweep — 1200 sub-units all-pairs is 720,000 distance tests per rebuild, and
 * the graph is rebuilt for each of ~400 days.
 */
export function buildModel(region, options = {}) {
  const {
    /** Beyond this, a corridor is too long to matter. Metres. */
    maxCorridorM = 45_000,
    /** How many neighbours each sub-unit connects to. */
    neighbours = 12,
    /**
     * Road corridor bonus: units joined by a motorway/trunk road are closer
     * than their centroid distance suggests. See `roadGraph`.
     */
    roadLinks = new Map(),
    seed = 1337,
  } = options;

  const rng = makeRng(seed);

  /** Flattens the two-level hierarchy into one list of compartments. */
  const cells = [];
  for (const unit of region.units) {
    /**
     * A kreisfreie Stadt with no Stadtteile in OSM is its own compartment. Two
     * of them are in this position — Remscheid has no level-10 districts at
     * all, and Hamm's are level 9 — and dropping them would quietly remove
     * 290,000 people from the region.
     */
    const children = unit.children.length > 0 ? unit.children : [
      {
        id: unit.id,
        name: unit.name,
        population: unit.population,
        areaKm2: unit.areaKm2,
        center: unit.center,
      },
    ];

    for (const child of children) {
      const { core, sprawl, density } = splitCore(child.population, child.areaKm2);
      cells.push({
        id: child.id,
        name: child.name,
        parentId: unit.id,
        parentName: unit.name,
        population: child.population,
        areaKm2: child.areaKm2,
        density,
        core,
        sprawl,
        lon: child.center[0],
        lat: child.center[1],
      });
    }
  }

  // A single projection origin for the whole region: at 200 km across, the
  // equirectangular error is a few parts in 10,000 — under a pixel on the map.
  const originLat = cells.reduce((s, c) => s + c.lat, 0) / cells.length;
  const originLon = cells.reduce((s, c) => s + c.lon, 0) / cells.length;
  const ky = 111320;
  const kx = ky * Math.cos((originLat * Math.PI) / 180);
  for (const cell of cells) {
    cell.x = (cell.lon - originLon) * kx;
    cell.y = -(cell.lat - originLat) * ky;
  }

  /* --- Neighbourhood graph ------------------------------------------------ */

  const cellIndex = new Map(cells.map((c, i) => [c.id, i]));
  const gridSize = maxCorridorM;
  const grid = new Map();
  const keyOf = (gx, gy) => `${gx},${gy}`;
  const gxOf = (x) => Math.floor(x / gridSize);
  const gyOf = (y) => Math.floor(y / gridSize);

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const key = keyOf(gxOf(cell.x), gyOf(cell.y));
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  const links = cells.map(() => []);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const gx = gxOf(cell.x);
    const gy = gyOf(cell.y);
    const candidates = [];
    // A 3x3 block of grid cells is enough: it reaches maxCorridorM in every
    // direction, and only the nearest `neighbours` are kept anyway.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(keyOf(gx + dx, gy + dy));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j === i) continue;
          const other = cells[j];
          const dist = Math.hypot(other.x - cell.x, other.y - cell.y);
          if (dist <= maxCorridorM) candidates.push({ j, dist });
        }
      }
    }
    candidates.sort((a, b) => a.dist - b.dist);

    for (const candidate of candidates.slice(0, neighbours)) {
      const other = cells[candidate.j];
      // A road link shortens the effective corridor: two towns joined by a
      // motorway are one outbreak, however far apart their centres are.
      const road = roadLinks.get(`${cell.id}|${other.id}`) ?? roadLinks.get(`${other.id}|${cell.id}`);
      const effective = road ? road.corridorM : candidate.dist;
      const weight =
        (Math.sqrt(cell.population * other.population) / 1e6) *
        Math.exp(-effective / 18_000) *
        roadFactor(road);

      links[i].push({
        to: candidate.j,
        population: other.population,
        distanceM: Math.round(effective),
        weight,
        road: road ? road.ref : null,
      });
    }
    // Renormalised per source cell so that a fringe cell with four neighbours
    // and a city cell with twelve leave at the same rate.
    const total = links[i].reduce((n, l) => n + l.weight, 0);
    if (total > 0) for (const link of links[i]) link.share = link.weight / total;
    else for (const link of links[i]) link.share = 1 / links[i].length;
  }

  const totalPopulation = cells.reduce((n, c) => n + c.population, 0);

  return {
    cells,
    links,
    cellIndex,
    origin: { lat: originLat, lon: originLon, kx, ky },
    totalPopulation,
    rng,
    disease: { ...DISEASE },
  };
}

/** Motorways carry far more cross-city traffic than a primary road. */
function roadFactor(road) {
  if (!road) return 1;
  if (road.roadClass === 'motorway') return 2.6;
  if (road.roadClass === 'trunk') return 1.9;
  return 1.45;
}

/**
 * Which sub-units share a road corridor, and how long that corridor is.
 *
 * Walks each road polyline, finds the sub-unit centroids near it, and links
 * consecutive ones. This is what turns the drawn motorway network into the
 * transmission graph, rather than a decorative layer on a separate model.
 *
 * `frame` is the projection the cells were placed with, so road distance and
 * centroid distance are measured in the same metres.
 */
export function roadGraph(roads, cells, frame, options = {}) {
  const { snapM = 3500, maxRefs = 400 } = options;
  const links = new Map();
  const gridSize = snapM;
  const grid = new Map();
  const keyOf = (gx, gy) => `${gx},${gy}`;
  const gxOf = (x) => Math.floor(x / gridSize);
  const gyOf = (y) => Math.floor(y / gridSize);

  for (let i = 0; i < cells.length; i++) {
    const key = keyOf(gxOf(cells[i].x), gyOf(cells[i].y));
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  const nearestCell = (x, y) => {
    const gx = gxOf(x);
    const gy = gyOf(y);
    let best = -1;
    let bestDist = snapM;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(keyOf(gx + dx, gy + dy));
        if (!bucket) continue;
        for (const i of bucket) {
          const dist = Math.hypot(cells[i].x - x, cells[i].y - y);
          if (dist < bestDist) {
            bestDist = dist;
            best = i;
          }
        }
      }
    }
    return best;
  };

  const project = (lon, lat) => [
    (lon - frame.lon) * frame.kx,
    -(lat - frame.lat) * frame.ky,
  ];

  for (const road of roads) {
    let previous = -1;
    let travelled = 0;
    const stops = [];
    for (let i = 0; i < road.line.length; i++) {
      const [x, y] = project(road.line[i][0], road.line[i][1]);
      if (i > 0) {
        const [px, py] = project(road.line[i - 1][0], road.line[i - 1][1]);
        travelled += Math.hypot(x - px, y - py);
      }
      const cell = nearestCell(x, y);
      if (cell === -1 || cell === previous) continue;
      stops.push({ cell, travelled });
      previous = cell;
    }
    const trimmed = stops.slice(0, maxRefs);
    for (let i = 1; i < trimmed.length; i++) {
      const a = trimmed[i - 1];
      const b = trimmed[i];
      if (a.cell === b.cell) continue;
      const corridorM = Math.max(1000, b.travelled - a.travelled);
      const ids = [cells[a.cell].id, cells[b.cell].id].sort();
      const key = `${ids[0]}|${ids[1]}`;
      const existing = links.get(key);
      if (!existing || corridorM < existing.corridorM) {
        links.set(key, { corridorM, ref: road.ref, roadClass: road.class });
      }
    }
  }
  return links;
}
/* -------------------------------------------------------------------------- */
/* Simulation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Runs the outbreak and returns the history.
 *
 * State per cell: susceptible, exposed, infectious, turned. Turned individuals
 * are the ones doing the infecting — this is a zombie outbreak, not a flu.
 *
 * The reproduction number is the thing to get right. With `beta` secondary
 * infections per turned per day and a mean time-to-turn of `incubation +
 * onset` days, R0 is `beta * (incubation + onset)`; at the defaults that is
 * about 0.65, which means the outbreak dies out everywhere and the video is a
 * blank map. The `beta` below is set so R0 lands near 3.2 — high enough that
 * an established district is unstoppable, low enough that a lone arrival in a
 * city usually fizzles, which is what gives the spread its ragged front.
 */
export function simulate(model, options = {}) {
  const {
    /** Which sub-unit patient zero is in. */
    seedCellId,
    /** Days to simulate. */
    days = 640,
    /** How often to emit a snapshot. */
    reportEvery = 1,
    /** Infectious people present in the seed cell at day 0. */
    initialCases = 3,
    /**
     * Days until the authorities understand what they are dealing with. Travel
     * does not stop on day one — the first days of a zombie outbreak look like
     * a bad week of public disorder.
     */
    awarenessDay = 3,
    /** Days for the long-distance network to collapse once awareness hits. */
    travelCollapseDays = 7,
    /** Secondary infections per infectious case per day, fully susceptible. */
    beta = model.disease.beta,
    /** Share of a district's turned that leaves for a neighbour each day. */
    mobility = model.disease.mobility,
    /**
     * Movement stops entirely once the region is this thoroughly overrun;
     * there is nobody left to move it.
     */
    mobilityFloor = 0.02,
    onProgress,
  } = options;

  const rng = model.rng;
  const n = model.cells.length;
  const seedIndex = model.cellIndex.get(seedCellId);
  if (seedIndex === undefined) throw new Error(`Unknown seed cell: ${seedCellId}`);

  const S = new Float64Array(n);
  const E = new Float64Array(n);
  const I = new Float64Array(n);
  const Z = new Float64Array(n);
  /** Running total of S, so the per-day O(n) sum is not repeated three times. */
  let susceptibleTotal = model.totalPopulation;

  for (let i = 0; i < n; i++) S[i] = model.cells[i].population;

  /** Day each sub-unit first received a case; -1 while untouched. */
  const firstCaseDay = new Float64Array(n).fill(-1);
  /**
   * Whether a sub-unit's outbreak has taken hold. A spark that has not yet
   * established is re-tested once per generation rather than once per day —
   * testing daily would give even a single zombie a thousand chances to catch
   * over a long outbreak, which is the opposite of the intended behaviour.
   */
  const established = new Uint8Array(n);

  S[seedIndex] -= initialCases;
  I[seedIndex] = initialCases;
  susceptibleTotal -= initialCases;
  firstCaseDay[seedIndex] = 0;
  established[seedIndex] = 1;

  const snapshots = [];
  const totalPopulation = model.totalPopulation;
  const incubationRate = 1 / model.disease.incubationDays;
  const onsetRate = 1 / model.disease.onsetDays;
  /** Days per generation, used to space out the spark-extinction tests. */
  const generationDays = model.disease.incubationDays + model.disease.onsetDays;

  for (let day = 0; day < days; day++) {
    // --- Long-distance travel collapses as the news gets out ---------------
    //
    // It does not stop on day one: the first days of a zombie outbreak look
    // like a bad week of public disorder. Once the region is visibly lost,
    // road movement falls to almost nothing because there is nobody left to
    // drive — which is why the last sub-units fall late, not never.
    const awareness = Math.max(0, Math.min(1, (day - awarenessDay) / travelCollapseDays));
    const overrun = 1 - susceptibleTotal / totalPopulation;
    const mobilityScale = Math.max(mobilityFloor, (1 - awareness) * (1 - 0.85 * overrun));

    // --- Transmission within each cell -------------------------------------
    //
    // Density drives the contact rate: an apartment district mixes far more
    // than the fields around it, so a city falls from the inside out. The
    // force of infection is per-capita, which keeps the rate independent of
    // how big the sub-unit is.
    for (let i = 0; i < n; i++) {
      if (S[i] <= 0 || Z[i] <= 0) continue;
      const cell = model.cells[i];
      const coreShare = cell.population > 0 ? cell.core / cell.population : 0;
      const densityFactor = 1 + 2.6 * coreShare;
      const force = (Z[i] * beta * densityFactor) / cell.population;
      // Noise, so a village of 300 with one zombie in it is a coin toss rather
      // than a certainty. The binomial variance of a small count is what makes
      // the front ragged instead of smooth.
      const expected = S[i] * force;
      const jittered = expected * (1 + 0.2 * gaussian(rng));
      const newInfections = Math.min(S[i], Math.max(0, jittered));
      S[i] -= newInfections;
      E[i] += newInfections;
      susceptibleTotal -= newInfections;
    }

    // --- Progression -------------------------------------------------------
    for (let i = 0; i < n; i++) {
      if (E[i] <= 0 && I[i] <= 0) continue;
      const becameInfectious = Math.min(E[i], E[i] * incubationRate * (1 + 0.15 * gaussian(rng)));
      E[i] -= becameInfectious;
      I[i] += becameInfectious;
      const turned = Math.min(I[i], I[i] * onsetRate * (1 + 0.15 * gaussian(rng)));
      I[i] -= turned;
      Z[i] += turned;
    }

    // --- Movement between cells -------------------------------------------
    //
    // Walkers are allocated as *whole people* across the outbound links, by
    // largest remainder. Splitting them fractionally is the obvious thing to
    // do and it is wrong in a way that shows: a single walker divided over
    // twelve neighbours leaves 0.08 of a zombie in each, which reads as a
    // district with "some infection" and paints an active outbreak across the
    // map on day one. People are integers; so are outbreaks.
    const arrivals = new Float64Array(n);
    if (mobilityScale > 0) {
      for (let i = 0; i < n; i++) {
        if (Z[i] < 1) continue;
        const leaving = Math.min(
          Math.floor(Z[i]),
          Math.max(1, Math.floor(Z[i] * mobility * mobilityScale)),
        );
        if (leaving <= 0) continue;

        const shares = model.links[i].map((link) => leaving * link.share);
        const whole = shares.map((s) => Math.floor(s));
        let assigned = whole.reduce((a, b) => a + b, 0);
        // Hand out what the flooring left over, largest fractional part first.
        const order = shares
          .map((s, k) => ({ k, frac: s - Math.floor(s) }))
          .sort((a, b) => b.frac - a.frac);
        for (const { k } of order) {
          if (assigned >= leaving) break;
          whole[k]++;
          assigned++;
        }

        let sent = 0;
        for (let k = 0; k < whole.length; k++) {
          if (whole[k] <= 0) continue;
          arrivals[model.links[i][k].to] += whole[k];
          sent += whole[k];
        }
        Z[i] -= sent;
      }
      for (let i = 0; i < n; i++) {
        if (arrivals[i] <= 0) continue;
        Z[i] += arrivals[i];
        if (firstCaseDay[i] < 0) firstCaseDay[i] = day;
      }
    }

    // --- Do this generation's sparks take hold? ----------------------------
    if (day % generationDays < 1) {
      for (let i = 0; i < n; i++) {
        if (established[i] || Z[i] + E[i] + I[i] <= 0) continue;
        const arrivalsHere = Z[i] + E[i] + I[i];
        /**
         * The probability a fresh spark dies out. Small arrivals almost
         * always fail — one zombie walking into Düsseldorf is lost in a crowd
         * of 600,000, one walking into a village of 400 is a disaster. This is
         * the term that keeps the spread looking like an epidemic (a ragged,
         * retried front) rather than a flood that fills the map evenly.
         */
        const escape = Math.min(0.97, 0.9 * Math.exp(-arrivalsHere / 8));
        if (rng() < escape) {
          Z[i] = 0;
          E[i] = 0;
          I[i] = 0;
          firstCaseDay[i] = -1;
          continue;
        }
        established[i] = 1;
      }
    }

    // --- Report ------------------------------------------------------------
    if (day % reportEvery === 0) {
      let turned = 0;
      let affected = 0;
      let collapsed = 0;
      let infectious = 0;
      for (let i = 0; i < n; i++) {
        infectious += I[i];
        turned += Z[i];
        if (firstCaseDay[i] >= 0 && Z[i] > 0) affected++;
        if (model.cells[i].population > 0 && Z[i] / model.cells[i].population >= 0.9) collapsed++;
      }
      snapshots.push({
        day,
        susceptible: susceptibleTotal,
        infectious,
        turned,
        affected,
        collapsed,
        /** Turned as a share of the region's starting population. */
        prevalence: turned / totalPopulation,
        cells: {
          susceptible: Float64Array.from(S),
          infectious: Float64Array.from(I),
          turned: Float64Array.from(Z),
          firstCaseDay: Float64Array.from(firstCaseDay),
        },
      });
      onProgress?.(day, turned / totalPopulation, affected);
    }

    /**
     * Stop once the front has stopped moving.
     *
     * The model asymptotes rather than terminating: the per-capita force of
     * infection means the last few thousand susceptible people are infected at
     * a geometrically decaying rate, so the run would continue for another
     * four hundred days to add a final 0.2%. That tail is real epidemiology
     * and it is unwatchable, so the film ends when the region is effectively
     * lost — under 1% of the population still uninfected.
     */
    if (day > 10 && susceptibleTotal < totalPopulation * 0.01) {
      if ((day + 1) % reportEvery !== 0) {
        const previous = snapshots[snapshots.length - 1];
        snapshots.push({ ...previous, day });
      }
      break;
    }
  }

  return {
    snapshots,
    model,
    seedIndex,
    totalPopulation,
    days: snapshots[snapshots.length - 1].day + 1,
  };
}

/**
 * The order in which sub-units fell, with the day each first received a case.
 * Used for the report and the opening title card.
 */
export function fallOrder(result, options = {}) {
  const { minPopulation = 0, count = Infinity } = options;
  const { model, snapshots } = result;
  return model.cells
    .map((cell, i) => ({
      cell,
      day: snapshots[snapshots.length - 1].cells.firstCaseDay[i],
      population: cell.population,
    }))
    .filter((entry) => entry.day >= 0 && entry.population >= minPopulation)
    .sort((a, b) => a.day - b.day || b.population - a.population)
    .slice(0, count);
}

/**
 * When the outbreak reached each Kreis — the day its first sub-unit fell.
 * This is the region-level timeline the map's headline numbers report.
 */
export function unitTimeline(result) {
  const { model, snapshots } = result;
  const last = snapshots[snapshots.length - 1];
  const byUnit = new Map();
  for (let i = 0; i < model.cells.length; i++) {
    const cell = model.cells[i];
    const day = last.cells.firstCaseDay[i];
    const entry = byUnit.get(cell.parentId) ?? {
      id: cell.parentId,
      name: cell.parentName,
      firstDay: Infinity,
      population: 0,
      subUnits: 0,
      fallenSubUnits: 0,
    };
    entry.population += cell.population;
    entry.subUnits++;
    if (day >= 0) {
      entry.fallenSubUnits++;
      if (day < entry.firstDay) entry.firstDay = day;
    }
    byUnit.set(cell.parentId, entry);
  }
  return [...byUnit.values()].sort((a, b) => a.firstDay - b.firstDay);
}
