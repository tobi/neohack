import type {Cell, Observation} from '../typescript/types.js';

/** Text presentation of the perceived level for agents. It is rendered from the
 * same semantic world cells the JSON exposes (terrain types, displayed
 * occupants and objects), never from hidden engine state. `mark` is the
 * character NetHack displays for that square; the legend names what each mark
 * stands for on this map, and the full cell layers stay available through
 * syncState. */
export interface PerceivedMap {
  /** Known bounding box. Labels and ticks mark every fifth x; rows start with y. */
  text: string;
  legend: Record<string, string>;
  /** Exact coordinates of displayed occupants, objects and terrain features. */
  positions: Record<string, {x: number; y: number}[]>;
  bounds: {x: [number, number]; y: [number, number]};
  you: {x: number; y: number} | null;
}
const terrainNames: Record<string, string> = {
  floor: 'floor', corridor: 'corridor', wall: 'wall', closedDoor: 'closed door', openDoor: 'open door',
  stairsUp: 'stairs up', stairsDown: 'stairs down', altar: 'altar', fountain: 'fountain', throne: 'throne',
  trap: 'known trap', water: 'water', lava: 'lava', sink: 'sink', grass: 'grass', bars: 'iron bars', tree: 'tree',
  ice: 'ice', grave: 'grave', bridge: 'drawbridge',
};
const printable = (mark: string | undefined) => typeof mark === 'string' && /^[!-~]$/.test(mark) ? mark : undefined;
/** Engine display character for this cell, or undefined when it is not a single
 * printable non-space ASCII mark. The hero override is `@`. */
export function cellMark(cell: Cell, you?: Observation['you']): string | undefined {
  if (you && you.x === cell.x && you.y === cell.y) return '@';
  return printable(cell.occupant?.mark ?? cell.objects?.[0]?.mark ?? cell.terrain.mark);
}
/** Displayed mark at a coordinate: world-cell lookup plus the hero override.
 * Missing cells and non-printable marks yield `undefined`. */
export function markAt(observation: Pick<Observation, 'world' | 'you'>, x: number, y: number): string | undefined {
  if (observation.you && observation.you.x === x && observation.you.y === y) return '@';
  const cell = observation.world.find(c => c.x === x && c.y === y);
  return cell ? cellMark(cell) : undefined;
}
export function renderMap(observation: Pick<Observation, 'world' | 'you'>): PerceivedMap | undefined {
  const grid = new Map<string, {mark: string; meaning: string}>();
  const place = (x: number, y: number, mark: string, meaning: string) => grid.set(`${x},${y}`, {mark, meaning});
  for (const cell of observation.world) {
    const mark = cellMark(cell, observation.you);
    if (mark === undefined) continue;
    const {occupant, objects} = cell, object = objects?.[0];
    const meaning = observation.you && observation.you.x === cell.x && observation.you.y === cell.y ? 'you'
      : occupant && occupant.kind !== 'self' ? `${occupant.appearance ?? (occupant.kind === 'ally' ? 'ally' : 'creature')}${occupant.attitude ? ` (${occupant.attitude})` : ''}`
      : occupant ? 'you'
      : object?.kind === 'boulder' ? 'boulder'
      : object ? object.known?.appearance ? `object: ${object.known.appearance}` : object.category ? `object: ${object.category}` : 'object'
      : terrainNames[cell.terrain.type] ?? cell.terrain.type;
    place(cell.x, cell.y, mark, meaning);
  }
  if (observation.you) place(observation.you.x, observation.you.y, '@', 'you');
  if (!grid.size) return undefined;
  const points = [...grid.keys()].map(key => key.split(',').map(Number) as [number, number]);
  const x0 = Math.max(0, Math.min(...points.map(p => p[0])) - 1), x1 = Math.min(79, Math.max(...points.map(p => p[0])) + 1);
  const y0 = Math.max(0, Math.min(...points.map(p => p[1])) - 1), y1 = Math.min(20, Math.max(...points.map(p => p[1])) + 1);
  const prefix = (label: string) => label.padStart(3) + ' ';
  const columns = Array.from({length: x1 - x0 + 1}, (_, i) => x0 + i);
  const labels = Array(columns.length + 1).fill(' ');
  const ticks = columns.filter(x => x % 5 === 0);
  if (!ticks.length) ticks.push(x0);
  for (const x of ticks) {
    for (const [i, digit] of [...String(x)].entries()) labels[x - x0 + i] = digit;
  }
  const rows = [prefix('x') + labels.join('').trimEnd(), prefix('') + columns.map(x => ticks.includes(x) ? '|' : ' ').join('')];
  for (let y = y0; y <= y1; y++) rows.push(prefix(String(y)) + columns.map(x => grid.get(`${x},${y}`)?.mark ?? ' ').join(''));
  const legend = new Map<string, Set<string>>();
  for (const {mark, meaning} of grid.values()) legend.set(mark, (legend.get(mark) ?? new Set()).add(meaning));
  legend.set(' ', new Set(['unknown or dark']));
  const positions: PerceivedMap['positions'] = {};
  const features = new Set(observation.world.filter(cell => cell.occupant || cell.objects?.length ||
    !['floor', 'corridor', 'wall', 'unknown', 'dark'].includes(cell.terrain.type)).map(cell => `${cell.x},${cell.y}`));
  if (observation.you) features.add(`${observation.you.x},${observation.you.y}`);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const cell = grid.get(`${x},${y}`);
    if (cell && features.has(`${x},${y}`)) (positions[cell.mark] ??= []).push({x, y});
  }
  return {
    text: rows.join('\n'),
    legend: Object.fromEntries([...legend.entries()].map(([mark, meanings]) => [mark, [...meanings].join(', ')])),
    positions,
    bounds: {x: [x0, x1], y: [y0, y1]},
    you: observation.you,
  };
}
