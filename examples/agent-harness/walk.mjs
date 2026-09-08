import responseSchema from '../../lib/neonethack/protocol/response.schema.json' with { type: 'json' };

/**
 * One caller-authorized, bounded knownWalking leg. No transport, state store,
 * replanning, force fallback, decision answers, or uncertain-input retries.
 *
 * go(args) must be a dispatcher-approved MCP go returning its reconstructed,
 * current structuredContent (not a raw envelope, delta, or historical receipt).
 * The dispatcher owns serialization, exact operation IDs, revisions and receipts.
 * Keep exclusive session ownership from initialFrame through go completion.
 * maxActions bounds inputs, not elapsed turns; ordinary movement can attack.
 *
 * Every invocation checks the initial and returned frame. Interruption/arrival
 * is never inferred from summary text. A caller must explicitly invoke again to
 * replan after any stop, including stepLimit. Set maxActions:1 for one-input legs.
 * The returned frame is the exact last public response, even when malformed;
 * uncertain:true means it MUST NOT become authority for another input.
 */

/** @typedef {{x:number,y:number}} Point */
/** @typedef {Point & {sessionId:string,levelId:string}} WalkTarget */
/** @typedef {Omit<import('../../lib/neonethack/typescript/types.js').Snapshot,'requestId'> & {
 * requestId?:string|null,
 * navigation?:{reason:string,actionsTaken:number,turnsElapsed:number,observation?:string},
 * creatures?:Array<{position:Point,kind:string,attitude?:string}>,
 * operationId?:string,historical?:boolean
 * }} WalkFrame
 */

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const string = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 0 };
const point = object({ x: { ...integer, minimum: 1, maximum: 79 }, y: { ...integer, maximum: 20 } });
const p = responseSchema.properties;
const observation = p.observation;
const select = (source, keys) => Object.fromEntries(keys.map(k => [k, source[k]]));
const navigationReasons = ['arrived', 'attempted', 'stepLimit', 'decision', 'interrupted', 'changed', 'noRoute', 'ended', 'aborted', 'error'];
// Validate an explicit projection of public fields consumed by walking, not the
// entire protocol or action catalog. Strengthen open vitals for required facts.
// Other public fields are retained untouched; unknown decisions/outcomes stop.
const cellFields = ['x', 'y', 'occupant', 'objects', 'hazards'];
const localLayers = object(select(p.cell.properties, cellFields), ['x', 'y']);
const neighborhoodSchema = object({
  status: { enum: ['available', 'unavailable'] }, basis: p.basis, inputGate: p.inputGate,
  cells: { type: 'array', items: localLayers, minItems: 81, maxItems: 81 },
}, ['status']);
const frameSchema = object({
  ...select(p, ['version', 'outcome', 'decision', 'events', 'ended', 'end', 'error', 'storage', 'recording', 'inputGate']),
  sessionId: string, revision: integer,
  historical: { type: 'boolean' }, operationId: string,
  observation: object({
    ...select(observation.properties, ['turn', 'location', 'you']),
    world: { type: 'array', items: object(select(observation.properties.world.items.properties, ['x', 'y', 'occupant', 'objects']), ['x', 'y']) },
    neighborhood: neighborhoodSchema,
    vitals: {
      ...observation.properties.vitals,
      properties: {
        ...observation.properties.vitals.properties,
        health: { type: 'integer' }, maxHealth: { type: 'integer', minimum: 1 },
        condition: { type: 'array', items: string, uniqueItems: true },
      },
      required: ['health', 'maxHealth', 'hunger', 'condition'],
    },
  }, ['turn', 'location', 'you', 'vitals', 'world']),
  creatures: { type: 'array', items: object({
    ...observation.properties.world.items.properties.occupant.properties,
    position: point,
  }, ['position', 'kind']) },
  navigation: object({
    reason: { enum: navigationReasons }, actionsTaken: integer, turnsElapsed: integer,
    observation: { enum: ['current', 'lastConfirmed'] }, lastOperationId: string,
  }, ['reason', 'actionsTaken', 'turnsElapsed']),
}, ['version', 'sessionId', 'revision', 'outcome', 'observation', 'events', 'decision', 'ended', 'end']);

// Fail at import if the selected public schemas acquire unsupported assertions.
// This checks only this projection, not a second general protocol validator.
const vocabulary = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'const', 'oneOf', 'anyOf', 'title', 'description', '$schema']);
function auditSchema(schema) {
  if (typeof schema === 'boolean') return;
  for (const key of Object.keys(schema)) if (!vocabulary.has(key)) throw new TypeError(`Unsupported walk schema keyword: ${key}`);
  if (schema.type && !['null', 'boolean', 'string', 'integer', 'number', 'array', 'object'].includes(schema.type)) throw new TypeError('Unsupported walk schema type');
  Object.values(schema.properties ?? {}).forEach(auditSchema);
  for (const key of ['oneOf', 'anyOf']) (schema[key] ?? []).forEach(auditSchema);
  for (const key of ['items', 'additionalProperties']) if (schema[key] !== undefined) auditSchema(schema[key]);
}
auditSchema(frameSchema);

function schemaIssue(value, schema, path = '$') {
  if (schema === true) return;
  if (schema === false) return `${path}: forbidden`;
  for (const [keyword, match] of [['anyOf', n => n > 0], ['oneOf', n => n === 1]]) {
    if (schema[keyword] && !match(schema[keyword].filter(s => !schemaIssue(value, s, path)).length)) return `${path}: ${keyword}`;
  }
  if ('const' in schema && value !== schema.const) return `${path}: const`;
  if (schema.enum && !schema.enum.includes(value)) return `${path}: enum`;
  if (schema.type === 'null' && value !== null) return `${path}: null`;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return `${path}: boolean`;
  if (schema.type === 'string' && (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))) return `${path}: string`;
  if (['integer', 'number'].includes(schema.type) &&
      (!(schema.type === 'integer' ? Number.isSafeInteger(value) : Number.isFinite(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return `${path}: ${schema.type}`;
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return `${path}: array`;
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) return `${path}: uniqueItems`;
    for (let i = 0; i < value.length; i++) {
      const issue = schema.items && schemaIssue(value[i], schema.items, `${path}[${i}]`);
      if (issue) return issue;
    }
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path}: object`;
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return `${path}.${key}: required`;
    for (const [key, entry] of Object.entries(value)) {
      const child = schema.properties?.[key] ?? schema.additionalProperties;
      if (child === false) return `${path}.${key}: unexpected property`;
      if (child && typeof child === 'object') {
        const issue = schemaIssue(entry, child, `${path}.${key}`);
        if (issue) return issue;
      }
    }
  }
}

function frameIssue(frame) {
  return schemaIssue(frame, frameSchema) ||
    (frame.update?.kind === 'delta' && 'unreconstructed delta') ||
    (frame.historical === true && 'historical receipt') ||
    (frame.observation.neighborhood?.status === 'available' &&
      schemaIssue(frame.observation.neighborhood, { ...neighborhoodSchema, required: ['status', 'basis', 'inputGate', 'cells'] })) ||
    (frame.observation.you !== null && schemaIssue(frame.observation.you, point));
}

/** Capture coordinates in their observed session and level; never recapture on resume. */
export function captureWalkTarget(frame, to) {
  const issue = frameIssue(frame) || schemaIssue(to, point);
  if (issue) throw new TypeError(`Cannot capture walk target: ${issue}`);
  return Object.freeze({ x: to.x, y: to.y, sessionId: frame.sessionId, levelId: frame.observation.location.id });
}

const severeHunger = new Set(['weak', 'fainting', 'fainted', 'starved', 'unknown']);
// Policy triage, not engine movement eligibility. Unknown conditions also need
// explicit review. These stable conditions alone do not require triage.
const ordinaryConditions = new Set(['bareHands', 'flying', 'glowingHands', 'levitating', 'riding']);
const sameConditions = (a, b) => a.length === b.length && a.every(c => b.includes(c));
const distance = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function gates(frame, baseline, target, override) {
  const stops = [];
  const add = (reason, context = {}) => stops.push({ reason, ...context });
  const { observation: o } = frame, v = o.vitals;
  if (frame.ended || frame.end || frame.events.some(e => e.type === 'ended')) add('ended', { end: frame.end });
  if (frame.decision) add('decision', { decision: frame.decision });
  if (frame.error || frame.outcome.status === 'unknown' || frame.navigation?.observation === 'lastConfirmed') add('uncertain', { error: frame.error ?? null });
  if (frame.outcome.status === 'needsChoice' && !frame.decision) add('uncertain', { issue: 'needsChoice without an exact decision' });
  for (const source of ['storage', 'recording']) if (frame[source] && frame[source].status !== 'ok') add('uncertain', { source, status: frame[source].status });
  if (frame.inputGate && frame.inputGate.state !== 'ready') add('inputGate', { inputGate: frame.inputGate });
  if (frame.sessionId !== target.sessionId) add('sessionChanged');
  if (o.location.id !== target.levelId) add('levelChanged', { from: target.levelId, to: o.location.id });
  if (!o.you) add('unknownPosition');
  if (baseline) {
    if (frame.revision < baseline.revision || o.turn < baseline.observation.turn) add('staleFrame');
    const previous = baseline.observation.vitals;
    if (v.health < previous.health) add('damage', { from: previous.health, to: v.health });
    if (v.hunger !== previous.hunger) add('hungerChanged', { from: previous.hunger, to: v.hunger });
    if (!sameConditions(v.condition, previous.condition)) add('conditionsChanged', { from: previous.condition, to: v.condition });
  }
  const hunger = severeHunger.has(v.hunger) && override?.hunger !== v.hunger ? v.hunger : null;
  const conditions = v.condition.filter(c => !ordinaryConditions.has(c) && !override?.conditions?.includes(c));
  if (hunger || conditions.length || v.health <= 0) add('triage', { hunger, conditions, health: v.health });

  const neighborhood = o.neighborhood;
  if (neighborhood?.status === 'unavailable') add('inputGate', { inputGate: { state: 'unavailable' } });
  if (neighborhood?.status === 'available') {
    const { basis, inputGate } = neighborhood;
    if (basis.revision !== frame.revision || basis.levelId !== o.location.id || !o.you || distance(basis.origin, o.you) !== 0) add('stalePerception');
    if (inputGate.state !== 'ready') add('inputGate', { inputGate });
  }
  // Public creature positions, world occupants, and available local layers all
  // count. A floor glyph never proves absence of an occupant/object/hazard.
  const cells = [...o.world, ...(neighborhood?.status === 'available' ? neighborhood.cells : [])];
  const creatures = [...(frame.creatures ?? []), ...cells.filter(c => c.occupant).map(c => ({ ...c.occupant, position: c }))];
  if (o.you) {
    const nearby = creatures.filter(c => c.kind !== 'self' && c.attitude !== 'tame' && c.attitude !== 'peaceful' && distance(c.position, o.you) <= 3);
    if (nearby.length) add('creatureNearby', { creatures: nearby });
  }
  for (const cell of cells.filter(c => c.x === target.x && c.y === target.y)) {
    if (cell.hazards?.length) add('targetHazard', { hazards: cell.hazards });
    if (cell.objects?.some(o => o.kind === 'boulder')) add('targetObject', { objects: cell.objects });
    if (cell.occupant && cell.occupant.kind !== 'self') add('targetOccupied', { occupant: cell.occupant });
  }
  return stops;
}

/**
 * @param {{initialFrame:WalkFrame,target:WalkTarget,maxActions:number,
 * go:(args:{sessionId:string,to:Point,maxActions:number})=>Promise<unknown>,
 * override?:{reason:string,hunger?:string,conditions?:string[]}}} options
 * override acknowledges only named INITIAL triage facts for this invocation;
 * it never bypasses changes, damage, creatures, decisions, terminal or uncertainty.
 * Normal movement, healing, and unchanged ordinary conditions allow arrival.
 * stops retains all contexts; reason is the highest-priority one. reachedTarget
 * reports coordinates+level separately from successful arrival (reason:arrived).
 */
export async function runBoundedWalk({ initialFrame, target, maxActions, go, override }) {
  const targetIssue = schemaIssue(target, object({ ...point.properties, sessionId: string, levelId: string }));
  if (targetIssue || !Number.isSafeInteger(maxActions) || maxActions < 1 || maxActions > 1659 || typeof go !== 'function') throw new TypeError('Walk requires a captured target, go callback, and maxActions from 1 to 1659');
  if (override !== undefined) {
    const issue = schemaIssue(override, { ...object({ reason: string, hunger: observation.properties.vitals.properties.hunger, conditions: { type: 'array', items: string } }, ['reason']), additionalProperties: false });
    if (issue || !override.reason.trim()) throw new TypeError('Override requires a reason and exact triage hunger/conditions');
  }
  // Copy intent/baseline before calling injected code; retain original responses
  // in results so receipt identity and additive public fields are never rewritten.
  target = { ...target };
  override = override && structuredClone(override);
  let frame = initialFrame, calls = 0;
  const result = (stops, uncertain = false) => ({
    reason: stops[0].reason, stops, frame, calls,
    uncertain: uncertain || stops.some(s => ['uncertain', 'staleFrame', 'sessionChanged', 'stalePerception'].includes(s.reason)),
    reachedTarget: frame?.sessionId === target.sessionId && frame?.observation?.location?.id === target.levelId && frame?.observation?.you?.x === target.x && frame?.observation?.you?.y === target.y,
    override: override ?? null,
  });
  let issue = frameIssue(frame);
  if (issue) return result([{ reason: 'invalidFrame', issue }], true);
  let stops = gates(frame, null, target, override);
  if (stops.length) return result(stops);
  if (distance(frame.observation.you, target) === 0) return result([{ reason: 'arrived' }]);
  const baseline = structuredClone(frame);
  calls++;
  try {
    frame = await go({ sessionId: target.sessionId, to: { x: target.x, y: target.y }, maxActions });
  } catch (error) {
    return result([{ reason: 'uncertain', error }], true);
  }
  issue = frameIssue(frame);
  if (issue) return result([{ reason: 'invalidFrame', issue }], true);
  stops = gates(frame, baseline, target, override);
  const nav = frame.navigation;
  if (!nav) stops.push({ reason: 'invalidFrame', issue: 'go response requires navigation' });
  else {
    if (nav.actionsTaken > maxActions) stops.push({ reason: 'invalidFrame', issue: 'go exceeded maxActions' });
    if (nav.reason !== 'arrived') stops.push({ reason: nav.reason, navigation: nav });
    else if (!frame.observation.you || distance(frame.observation.you, target) !== 0) stops.push({ reason: 'invalidFrame', issue: 'arrival coordinates disagree' });
    if (nav.actionsTaken > 0 && frame.revision <= baseline.revision) stops.push({ reason: 'staleFrame' });
    if (frame.outcome.status !== 'completed') stops.push({ reason: 'interrupted', outcome: frame.outcome });
  }
  if (stops.length) return result(stops, stops.some(s => s.reason === 'invalidFrame' || s.reason === 'error'));
  return result([{ reason: 'arrived' }]);
}
