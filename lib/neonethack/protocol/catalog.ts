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
export const item = { description: 'Select by a perceived readable name, or pass an opaque returned reference as {id:"item-…"} or {id:"ground-…"}. A bare string is a name, never an ID.', oneOf: [
  {...text(127), description:'Perceived readable item name, for example "food ration". Do not put an opaque item ID in this string.'},
  {...object({ id: {...text(64), description:'Exact opaque id returned by inventory, here.items or the standing decision.'}, quantity: integer(1, 2147483647) }, ["id"]), description:'Exact returned item reference; optional quantity selects a count from its stack.'},
] };
export const automaticPickup = object({
  enabled: { type: "boolean" },
  itemTypes: { type: "array", maxItems: 15, uniqueItems: true, items: enumeration("gold", "food", "potions", "scrolls", "weapons", "armor", "rings", "amulets", "tools", "spellbooks", "wands", "gems", "rocks", "balls", "chains") },
  review: { type: "boolean", description: "Pause automatic pickup at a review decision before transferring anything. Explicit selection or cancellation required." },
  lootPatterns: { type: "array", maxItems: 16, items: text(64), description: "Case-insensitive literal substrings of the perceived singular item name. Add to category and arrow inclusions; never match hidden identity." },
  ignorePatterns: { type: "array", maxItems: 16, items: text(64), description: "Case-insensitive literal substrings of the perceived singular item name. Override every inclusion." },
  arrows: { type: "boolean" }, leaveCorpses: { type: "boolean" }, leaveKnownCursed: { type: "boolean" },
}, ["enabled", "itemTypes", "arrows", "leaveCorpses", "leaveKnownCursed"]);
export const position = { oneOf: [object({ x: integer(1, 79), y: integer(0, 20) }), enumeration(...compass.enum, "finish", "help")] };
export const answer = { oneOf: [
  object({ kind: { const: "position" }, position }),
  object({ kind: { const: "item" }, item }),
  object({ kind: { const: "target" }, target }),
  object({ kind: { const: "confirmation" }, confirm: { type: "boolean" } }),
  object({ kind: { const: "choice" }, choose: { type: "array", minItems: 1, maxItems: 1024, uniqueItems: true, items: integer(0, 2147483647) } }),
  object({ kind: { const: "text" }, text: text(128, 0) }),
] };
const sid = { ...text(64), pattern: "^[A-Za-z0-9_-]+$", description: "Session ID from create/resume." };
const guard = {
  sessionId: sid,
  requestId: { ...text(128), description: "Unique operation ID; retry only with the same ID and payload." },
  expectedRevision: { ...integer(), description: "Latest observation revision, not game time." },
};
export interface Method { name: string; description: string; schema: Schema; tool: string; action?: string; readOnly?: boolean; idempotent?: boolean }
const methods: Method[] = [];
function add(name: string, description: string, schema: Schema, tool: string, extra: Partial<Method> = {}) { methods.push({ name, description, schema, tool, ...extra }); }
add("protocol.describe", "Read the protocol version, method schemas and backend guarantees. Does not start an engine or open a session.", object({}), "", { readOnly: true, idempotent: true });
add("session.create", "Create a game; omitted fields are generated compatibly by the engine. Retain sessionId. Creation has no retry ID: do not resubmit after an uncertain reply. A seed alone is not a full world identity.", object({
  name: text(31), seed: integer(-Number.MAX_SAFE_INTEGER),
  role: enumeration("archeologist", "barbarian", "caveman", "healer", "knight", "monk", "priest", "rogue", "ranger", "samurai", "tourist", "valkyrie", "wizard"),
  race: enumeration("human", "elf", "dwarf", "gnome", "orc"), gender: enumeration("male", "female"), align: enumeration("lawful", "neutral", "chaotic"),
  automaticPickup,
}, []), "new_game");
add("session.observe", "Read the currently loaded session's full observation and standing decision. No engine input, game turn, revision change or event consumption. Does not resume an unloaded session. A cached receipt is historical; observe for current state.", object({ sessionId: sid }), "get_state", { readOnly: true, idempotent: true });
add("session.actions", "Read revision-bound attempts for here or an adjacent square using only perceived knowledge. No engine input, event consumption, receipt or automatic resume. Offers do not promise safety or success.", object({ sessionId: sid, expectedRevision: integer(), target: { oneOf: [enumeration("here"), object({ direction: compass }), object({x:integer(1,79),y:integer(0,20)})] } }), "actions", { readOnly: true, idempotent: true });
add("session.lookup", "Look up a name in the pinned game encyclopedia. Lore is reference text, not observed identity or a safety prediction. Free query; leaves the standing decision unchanged.", object({sessionId:sid,name:text(255)}), "lookup", {readOnly:true,idempotent:true});
add("session.navigation", "Read perceived frontiers and known downward stairs under the knownWalking policy. Frontiers are reachable unvisited squares bordering unknown cardinal neighbors; exclude every witnessed standing square, including the initial position. Downstairs may have null distance. Free revision-bound query, no movement or hidden level search.", object({sessionId:sid,expectedRevision:integer()}), "navigation", {readOnly:true,idempotent:true});
add("session.route", "Find a shortest known walking route in the perceived current level. Free revision-bound query; does not move. knownWalking excludes closed doors, occupants, boulders, known hazards and uncertain diagonal squeezes. Null distance means no route known under this policy, not impossible or unsafe. Steps exclude the origin. Recheck after input.", object({ sessionId: sid, expectedRevision: integer(), to: object({ x: integer(1,79), y: integer(0,20) }) }), "route", { readOnly: true, idempotent: true });
add("session.receipt", "Read an exact stored operation receipt without executing or retrying input. This is historical, not the current observation. Missing receipts mean uncertainty; observe/resume explicitly before deciding what to do.", object({sessionId:sid,requestId:text(128)}), "receipt", {readOnly:true,idempotent:true});
add("session.resume", "Resume a persisted game with its pinned engine and standing decision. Requires exclusive ownership; integrity or uncertain-boundary failures block play. Starts an engine, not archive review.", object({ sessionId: sid }), "resume");
add("session.close", "Release the loaded engine, preserving the game and standing decision for resume. Does not quit or delete it. Check storage health; a timeout does not prove success.", object({ sessionId: sid }), "end_session");
function game(action: string, description: string, properties: Record<string, Schema> = {}, required: string[] = []) {
  add(`game.${action}`, description + " Answer returned decisions separately.", object({ ...guard, ...properties }, [...Object.keys(guard), ...required]), "act", { action, idempotent: true });
}
game("move", "Attempt exactly one adjacent step. Normal NetHack bump behavior can attack, open a door or exchange places with an ally. Meaningful warnings require consent. Direction is a compass word, not a key.", { direction: compass }, ["direction"]);
game("run", "Run using one native movement command. mode normal (default) is uppercase direction; untilInteresting is g plus direction; pastBranches is G plus direction, ignoring corridor forks as stops. noPickup applies the engine m prefix, suppressing pickup and fighting. Engine stopping, peaceful-creature interactions, interruptions and actual elapsed turns remain authoritative; no safety guarantee or client repeat loop.", { direction: compass, mode: {...enumeration("normal", "untilInteresting", "pastBranches"), description:"normal (default): uppercase direction. untilInteresting: g plus direction, including corridor-fork stops. pastBranches: G plus direction, ignoring corridor forks as stops."}, noPickup: {type:"boolean", description:"Apply the native m prefix: suppress pickup and fighting. False/omitted preserves the current automatic pickup configuration."} }, ["direction"]);
game("wait", "Request one waiting turn. The engine can refuse when danger is nearby; a zero-turn refusal is blocked, not forced through or reported as a completed turn. This is not a read-only query or a repeated rest.");
game("climb", "Attempt stairs or another engine-supported vertical transition. up/down is climbing, not aiming. Level changes replace the perceived map.", { direction: enumeration("up", "down") }, ["direction"]);
game("search", "Request a bounded native counted search (default one). Stops under the engine occupation/interruption rules; reports actual elapsed turns and witnessed discoveries.", {turns:integer(1,1000)});
game("rest", "Request a bounded native counted rest (default one). The engine may refuse or interrupt; never auto-confirms danger or restarts the occupation.", {turns:integer(1,1000)});
for (const action of ["kick", "open", "close"]) game(action, `Attempt to ${action} in an adjacent compass direction. Omit target to receive a target decision; self and vertical directions are not valid.`, { target: object({ direction: compass }) });
const descriptions: Record<string, string> = {
  throw: "Throw one selected carried object using the engine throw command. Target is a direction or self; omit it for an explicit direction decision. This is a manual attempt, with ordinary costs and warnings.",
  offer: "Offer a selected carried item or perceived floor corpse at the current altar. Omit item to enter the engine floor-sacrifice confirmations and inventory selection. The engine determines the sacrifice and terminal result; no readiness or favor is revealed.",
  pickup: "Pick up a perceived object underfoot, not a distant object or a carried item. Does not walk or select an entire floor implicitly.",
  eat: "Eat a perceived eligible item carried or underfoot. Eligibility is not safety. Preserve choking and other warnings; an interrupted meal is not automatically restarted.",
  drink: "Drink a perceived carried potion, or omit item on a perceived fountain or sink to request the engine’s drinking confirmation. Unidentified properties remain unknown; do not interpret eligibility as safety.",
  wield: "Wield the selected perceived carried item. Does not choose a weapon strategically.",
  equip: "Wear selected armor, a ring, an amulet or a recognized wearable accessory. Optional slot expresses an explicit perceived destination (including ring side); omitted slot choices remain decisions; no silent replacement or removal of other equipment.",
  remove: "Remove selected worn equipment. Physical accessibility constrains candidates; hidden curses are not revealed by filtering.",
  read: "Read the selected perceived object. Study may take multiple turns or be interrupted; a new attempt needs a new operation.",
  apply: "Apply a perceived carried object. Tool-specific targets or options are subsequent typed decisions, not initial guessed arguments.",
  drop: "Drop a selected carried item or stack using the engine's normal single-selection behavior. Use {id, quantity} to select an explicit partial stack.",
  zap: "Zap a selected perceived wand. Target may be self or a compass/vertical direction; here is not a target. Unknown powers and charges remain unknown.",
};
for (const [action, description] of Object.entries(descriptions)) game(action, description + " Omit item to choose; use {id} or an unambiguous perceived name.", { item, ...(["equip", "wield"].includes(action) ? {slot: enumeration("bodyArmor", "cloak", "helmet", "shield", "gloves", "boots", "shirt", "amulet", "leftRing", "rightRing", "eyewear", "weapon", "offhand", "alternateWeapon", "quiver", "skin", "ball", "chain")} : {}), ...(["zap", "throw"].includes(action) ? { target } : {}) });
for (const action of ["cast", "enhance", "swap", "twoWeapon", "pay", "engrave"]) game(action, {
  cast: "Begin casting a learned spell. Select the spell explicitly in the engine menu, then answer its real target or other decisions. Casting can fail or backfire.",
  enhance: "Inspect and explicitly advance a practiced skill through the engine skill menu. Available advances are earned by ordinary engine rules.",
  swap: "Swap the primary and alternate weapons using the engine command. A refusal or warning remains an actual outcome.",
  twoWeapon: "Toggle two-weapon combat using the current primary and alternate weapons. No weapon is selected automatically.",
  pay: "Attempt payment to a shopkeeper. Bills, item choices and confirmations come from the engine; no purchase is chosen automatically.",
  engrave: "Write on the floor. Choose a writing implement or hands in the engine menu, then enter your own text. Existing writing, warnings, costs and interruption remain engine decisions.",
}[action]!);
game("fire", "Fire the current quiver using normal engine rules. If ammunition needs selection, choose it explicitly; this does not select a target or repeat attacks.", {target});
game("chat", "Attempt deliberate conversation in a compass direction. Dialogue, services and donations remain explicit engine decisions.", {target: object({direction: compass})});
for (const action of ["dip", "rub", "invoke", "quiver"]) game(action, "Attempt the distinct engine " + action + " command on a carried object. Omit the item to select it; subsequent item, confirmation, target and text choices remain separate decisions. Applicability is an attempt, not a safety prediction.", {item});
for (const action of ["attack", "moveWithoutAttack"]) game(action, action === "attack" ? "Force one attack toward an adjacent square, including apparently empty squares. The engine determines contact and costs." : "Attempt one step without fighting or automatic pickup using the engine movement prefix. No creature is attacked automatically.", {direction: compass}, ["direction"]);
game("loot", "Open perceived containers underfoot. Multiple containers require selection. Unknown contents require explicit inspection, then one combined choice stages take and put stacks. Takes execute before puts through engine rules; warnings and interruptions remain decisions, with no rollback or automatic retry. Does not pick up the container or interact with adjacent creatures.");
game("configurePickup", "Replace automatic ground-pickup settings at a free command boundary without spending a turn. Read actual settings from observation.automaticPickup. Ignore patterns and leave rules override category, arrow and loot-pattern inclusion; thrown, stolen and dropped items follow the same rules. Empty types means only enabled arrow inclusion, never all. No container interaction or auto-confirmation. Settings are journaled and restored with the session.", { automaticPickup }, ["automaticPickup"]);
game("quit", "Abandon this run through the engine. Presents the genuine quit confirmation; only an explicit affirmative answer ends the adventure. Retains its journal.");
game("pray", "Begin a prayer. Always preserve genuine confirmation; the API does not reveal divine favor or prayer cooldown or decide whether prayer is safe.");
add("decision.answer", "Continue exactly the standing decisionId with one typed answer. Use returned item refs and integer choice IDs unchanged. confirm:false declines; it is not cancellation. A wrong answer or stale ID does not advance the world. May lead to another decision. Retry the same requestId and payload after uncertainty, never the initiating game operation.", object({ ...guard, decisionId: text(64), answer }), "act", { idempotent: true });
add("decision.cancel", "Cancel the standing decision only when it is cancellable. Does not implicitly decline every future warning, restart an action or undo turns already spent. Returns the actual outcome and observation.", object({ ...guard, decisionId: text(64) }), "act", { idempotent: true });
export const catalog = { version: PROTOCOL_VERSION, methods };
export const requestSchema = { $schema: "https://json-schema.org/draft/2020-12/schema", title: "libneonethack request v1", oneOf: methods.map(m => object({ version: { const: PROTOCOL_VERSION }, method: { const: m.name }, params: m.schema })) };
