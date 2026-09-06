// Source of truth. Run `node scripts/generate.ts`; generated files are committed
// so native consumers need only a C compiler, not a JavaScript toolchain.
export const PROTOCOL_VERSION = 1;
export type Schema = Record<string, any>;
const text = (bytes: number, min = 1): Schema => ({ type: "string", minLength: min, maxLength: bytes, "x-maxBytes": bytes, pattern: "^[^\\u0000-\\u001f\\u007f]*$" });
const enumeration = (...values: string[]): Schema => ({ type: "string", enum: values });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: "object", properties, required, additionalProperties: false });
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): Schema => ({ type: "integer", minimum, maximum });
export const compass = enumeration("north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest");
const direction = enumeration(...compass.enum, "up", "down");
export const target = { oneOf: [enumeration("self"), object({ direction })] };
export const item = { oneOf: [text(127), object({ id: text(64) })] };
export const answer = { oneOf: [
  object({ kind: { const: "item" }, item }),
  object({ kind: { const: "target" }, target }),
  object({ kind: { const: "confirmation" }, confirm: { type: "boolean" } }),
  object({ kind: { const: "choice" }, choose: { type: "array", minItems: 1, maxItems: 64, uniqueItems: true, items: integer(0, 2147483647) } }),
  object({ kind: { const: "text" }, text: text(128, 0) }),
] };
const sid = { ...text(64), pattern: "^[A-Za-z0-9_-]+$", description: "Opaque session identifier returned by create or resume." };
const guard = {
  sessionId: sid,
  requestId: { ...text(128), description: "Unique operation ID. On a timeout retry this exact ID and payload; never create a new ID to retry." },
  expectedRevision: { ...integer(), description: "Revision of the observation on which this operation is based. Not game time. Known retries are checked before this guard." },
};
export interface Method { name: string; description: string; schema: Schema; tool: string; action?: string; readOnly?: boolean; idempotent?: boolean }
const methods: Method[] = [];
function add(name: string, description: string, schema: Schema, tool: string, extra: Partial<Method> = {}) { methods.push({ name, description, schema, tool, ...extra }); }
add("protocol.describe", "Read the protocol version, method schemas and backend guarantees. Does not start an engine or open a session.", object({}), "", { readOnly: true, idempotent: true });
add("session.create", "Create one new game. Returns its sessionId, revision, full perceived observation and any genuine choice. Omitted identity fields are selected by the engine. Profile 1 records a fixed UTC creation calendar and isolates user options/configuration. A seed alone is not a full world identity; calendar, pinned engine/data and target matter. Creation is NOT retry-idempotent: retain the returned sessionId; do not blindly retry after a transport failure.", object({
  name: text(31), seed: integer(-Number.MAX_SAFE_INTEGER),
  role: enumeration("archeologist", "barbarian", "caveman", "healer", "knight", "monk", "priest", "rogue", "ranger", "samurai", "tourist", "valkyrie", "wizard"),
  race: enumeration("human", "elf", "dwarf", "gnome", "orc"), gender: enumeration("male", "female"), align: enumeration("lawful", "neutral", "chaotic"),
}, []), "new_game");
add("session.observe", "Read the currently loaded session's full observation and standing decision. No engine input, game turn, revision change or event consumption. Does not resume an unloaded session. A cached receipt is historical; observe for current state.", object({ sessionId: sid }), "get_state", { readOnly: true, idempotent: true });
add("session.actions", "Read revision-bound attempts for here or an adjacent square using only perceived knowledge. No engine input, event consumption, receipt or automatic resume. Offers do not promise safety or success.", object({ sessionId: sid, expectedRevision: integer(), target: { oneOf: [enumeration("here"), object({ direction: compass })] } }), "actions", { readOnly: true, idempotent: true });
add("session.resume", "Re-enter a persisted session by replaying validated input with its pinned engine. Restores the recorded runtime profile, observation and pending decision without answering it. Unprofiled history is refused, not migrated with invented settings. Matching prompts are not a universal replay proof. Requires exclusive ownership. Integrity or uncertain-boundary failures block new operations. This runs an engine; archive review is a separate, read-only client facility.", object({ sessionId: sid }), "resume");
add("session.close", "Retire the loaded session's engine and release ownership, retaining journals and pending decisions for resume. A loaded terminal world whose engine already retired closes as a no-op. Does not quit, kill the hero, delete the game or answer a warning. Check returned storage health; do not assume a transport timeout means the close succeeded.", object({ sessionId: sid }), "end_session");
function game(action: string, description: string, properties: Record<string, Schema> = {}, required: string[] = []) {
  add(`game.${action}`, description + " Returns outcome, ordered events, full observation and at most one decision. Answer a decision separately; never repeat this operation to continue it.", object({ ...guard, ...properties }, [...Object.keys(guard), ...required]), "act", { action, idempotent: true });
}
game("move", "Attempt exactly one adjacent step. Normal NetHack bump behavior can attack, open a door or exchange places with an ally. Meaningful warnings require consent. Direction is a compass word, not a key.", { direction: compass }, ["direction"]);
game("wait", "Request one waiting turn. The engine can refuse when danger is nearby; a zero-turn refusal is blocked, not forced through or reported as a completed turn. This is not a read-only query or a repeated rest.");
game("climb", "Attempt stairs or another engine-supported vertical transition. up/down is climbing, not aiming. Level changes replace the perceived map.", { direction: enumeration("up", "down") }, ["direction"]);
game("search", "Search once from the current square. May spend a turn; reports only discoveries the hero perceives. Does not search repeatedly until success.");
for (const action of ["kick", "open", "close"]) game(action, `Attempt to ${action} in an adjacent compass direction. Omit target to receive a target decision; self and vertical directions are not valid.`, { target: object({ direction: compass }) });
const descriptions: Record<string, string> = {
  pickup: "Pick up a perceived object underfoot, not a distant object or a carried item. Does not walk or select an entire floor implicitly.",
  eat: "Eat a perceived eligible item carried or underfoot. Eligibility is not safety. Preserve choking and other warnings; an interrupted meal is not automatically restarted.",
  drink: "Drink a perceived carried potion, or omit item on a perceived fountain or sink to request the engine’s drinking confirmation. Unidentified properties remain unknown; do not interpret eligibility as safety.",
  wield: "Wield the selected perceived carried item. Does not choose a weapon strategically.",
  equip: "Wear the selected armor, ring or amulet using its known class. Genuine slot choices remain decisions; no silent replacement or removal of other equipment.",
  remove: "Remove selected worn equipment. Physical accessibility constrains candidates; hidden curses are not revealed by filtering.",
  read: "Read the selected perceived scroll or spellbook. Study may take multiple turns or be interrupted; a new attempt needs a new operation.",
  apply: "Apply a perceived carried tool. Tool-specific targets or options are subsequent typed decisions, not initial guessed arguments.",
  drop: "Drop a selected carried item or stack using the engine's normal single-selection behavior. Quantity selection is not supported by this protocol version.",
  zap: "Zap a selected perceived wand. Target may be self or a compass/vertical direction; here is not a target. Unknown powers and charges remain unknown.",
};
for (const [action, description] of Object.entries(descriptions)) game(action, description + " Item accepts an opaque {id} or a perceived-name query; omit it for a zero-turn candidate decision (drink may instead prompt for a fountain or sink underfoot). Ambiguity never selects the first match.", { item, ...(action === "zap" ? { target } : {}) });
game("quit", "Abandon this run through the engine. Presents the genuine quit confirmation; only an explicit affirmative answer ends the adventure. Retains its journal.");
game("pray", "Begin a prayer. Always preserve genuine confirmation; the API does not reveal divine favor or prayer cooldown or decide whether prayer is safe.");
add("decision.answer", "Continue exactly the standing decisionId with one typed answer. Use returned item refs and integer choice IDs unchanged. confirm:false declines; it is not cancellation. A wrong answer or stale ID does not advance the world. May lead to another decision. Retry the same requestId and payload after uncertainty, never the initiating game operation.", object({ ...guard, decisionId: text(64), answer }), "act", { idempotent: true });
add("decision.cancel", "Cancel the standing decision only when it is cancellable. Does not implicitly decline every future warning, restart an action or undo turns already spent. Returns the actual outcome and observation.", object({ ...guard, decisionId: text(64) }), "act", { idempotent: true });
export const catalog = { version: PROTOCOL_VERSION, methods };
export const requestSchema = { $schema: "https://json-schema.org/draft/2020-12/schema", title: "libneonethack request v1", oneOf: methods.map(m => object({ version: { const: PROTOCOL_VERSION }, method: { const: m.name }, params: m.schema })) };
