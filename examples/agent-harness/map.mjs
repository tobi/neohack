// Offline presentation only: no IO, transport, game inputs, or hidden state.
// Pass one complete/reconstructed public observation, never an MCP delta.
const TERRAIN = new Map(Object.entries({
  wall: '#', floor: '.', corridor: '.', closedDoor: 'D', openDoor: '[',
  stairsUp: '<', stairsDown: '>', altar: '_', fountain: '{', throne: '\\',
  trap: '^', unknown: '?', dark: ' ', water: '~', lava: '~', sink: '}',
  grass: ',', bars: '|', tree: 'T', ice: '.', grave: '+', bridge: '=',
}));
const positionKey = ({ x, y }) => `${x},${y}`;
const visibility = cell => cell.visible === true ? 'visible' :
  cell.visible === false ? 'not visible' : 'unknown';
const asciiMark = mark => typeof mark === 'string' && /^[!-~]$/.test(mark) ? mark : '*';

function glyph(cell) {
  if (cell.occupant) return cell.occupant.kind === 'self' ? '@' : 'M';
  if (cell.objects?.some(object => object.kind === 'boulder')) return 'O';
  if (cell.objects?.length) return asciiMark(cell.objects[0].mark);
  // Only the canonical public terrain label "trap" establishes trap terrain.
  // Unknown labels retain their exact text in the listing; never guess by prefix.
  return TERRAIN.get(cell.terrain?.type) ?? '?';
}

function displayLayers(cell) {
  return {
    visibility: visibility(cell),
    terrain: cell.terrain ? structuredClone(cell.terrain) : null,
    objects: structuredClone(cell.objects ?? []),
    occupant: cell.occupant ? structuredClone(cell.occupant) : null,
  };
}

/**
 * Return sorted {x, y, glyph, world?, neighborhood?, hero?} records.
 * world/neighborhood hold separate perceived display layers, including original
 * terrain freshness and object marks (marks never identify an item).
 * neighborhood additionally holds hazards and its public basis. Objects have no
 * canonical freshness field: retain cell visibility and terrain freshness
 * separately rather than inventing object freshness from terrain knowledge.
 * Returned records own their data. No action offers or eligibility are inferred.
 */
export function mapLayers(observation) {
  if (!observation || !Array.isArray(observation.world)) {
    throw new TypeError('mapLayers requires a reconstructed public observation with world[]');
  }
  const cells = new Map();
  const ensure = cell => {
    if (!Number.isSafeInteger(cell.x) || !Number.isSafeInteger(cell.y)) {
      throw new TypeError('Map coordinates must be safe integers');
    }
    const key = positionKey(cell);
    if (!cells.has(key)) cells.set(key, { x: cell.x, y: cell.y, glyph: '?' });
    return cells.get(key);
  };
  for (const cell of observation.world) {
    const record = ensure(cell);
    record.world = displayLayers(cell);
    record.glyph = glyph(cell);
  }
  const neighborhood = observation.neighborhood;
  if (neighborhood?.status === 'available') {
    // Reject a supplied neighborhood from another level; don't combine scenes.
    if (neighborhood.basis?.levelId !== observation.location?.id) {
      throw new TypeError('Neighborhood and observation level must match');
    }
    for (const cell of neighborhood.cells) {
      if (!cell.inBounds) continue;
      const record = ensure(cell);
      record.neighborhood = {
        ...displayLayers(cell), hazards: structuredClone(cell.hazards ?? []),
        basis: structuredClone(neighborhood.basis),
      };
      if (!record.world) record.glyph = glyph(cell);
    }
  }
  if (observation.you) {
    const record = ensure(observation.you);
    record.hero = true;
    record.glyph = '@';
  }
  return [...cells.values()].sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Render ASCII plus a lossless display-layer listing. The single-glyph grid uses
 * hero > occupant > boulder > first object > terrain. Its adjacent visibility
 * grid and mandatory listing preserve overlap and uncertainty. Neighborhood
 * hazards are listed separately, never substituted for world terrain.
 */
export function renderMap(observation) {
  const cells = mapLayers(observation);
  const unavailable = observation.neighborhood?.status === 'unavailable'
    ? `neighborhood unavailable: ${JSON.stringify(observation.neighborhood.reason)}` : null;
  if (!cells.length) return ['no world data', unavailable].filter(Boolean).join('\n');
  const xs = cells.map(cell => cell.x), ys = cells.map(cell => cell.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  // A malformed/sparse external snapshot must not allocate an unbounded grid.
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 100_000) {
    throw new RangeError('Map bounding box exceeds 100000 cells');
  }
  const indexed = new Map(cells.map(cell => [positionKey(cell), cell]));
  const lines = [
    `map ${x0}..${x1} x ${y0}..${y1}`,
    '@=you M=apparent occupant O=boulder object=public mark <=upstairs >=downstairs ^=trap terrain ?=unknown terrain',
    'Right grid: v=visible m=out of sight ?=visibility unknown; terrain freshness is listed separately.',
  ];
  for (let y = y0; y <= y1; y++) {
    let marks = '', seen = '';
    for (let x = x0; x <= x1; x++) {
      const cell = indexed.get(`${x},${y}`);
      marks += cell?.glyph ?? ' ';
      const state = (cell?.world ?? cell?.neighborhood)?.visibility;
      seen += !cell ? ' ' : state === 'visible' ? 'v' : state === 'not visible' ? 'm' : '?';
    }
    lines.push(`${String(y).padStart(3)} ${marks} | ${seen}`);
  }
  lines.push('Layers (object marks do not identify items; terrain knowledge does not establish object freshness):');
  for (const cell of cells) {
    for (const source of ['world', 'neighborhood']) {
      if (cell[source]) lines.push(`${source} (${cell.x},${cell.y}) ${JSON.stringify(cell[source])}`);
    }
  }
  if (unavailable) lines.push(unavailable);
  return lines.join('\n');
}
