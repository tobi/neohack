/** Presentation-only evidence selection. Never used to choose game actions.
 * Feed full public replies in order, not raw inputs or observation deltas.
 *
 * The digest keeps almost everything the hero witnessed: every reply that
 * carried a message, a vitals reversal, a place change, a notable action or
 * the ending becomes a turn line. Only genuinely routine repetition is
 * collapsed (identical consecutive messages are counted, not repeated) and the
 * prompt budget is generous, so the story is written from the journal itself
 * rather than from a handful of highlights. */
export const DIGEST_VERSION = 2;
/** Rendered transcript budget: about 70k tokens of markdown at ~3.5 chars/token. */
export const MAX_PROMPT_CHARS = 245000;
/** Retention memory for million-input transcripts: entries, not a history chain. */
const POOL_LIMIT = 16000, POOL_KEEP = 12000;
const clean = (value, limit = 700) =>
  typeof value === "string"
    // oxlint-disable-next-line no-control-regex -- Reject or strip control characters at this text boundary.
    ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, limit)
    : undefined;
const routine =
  /^(?:You (?:miss|hit|kill|destroy) (?:the|a|an) .{1,80}[.!]|You swap places with .{1,60}[.!]|You (?:see|hear) nothing special[.!]|You reached the selected square[.!])$/;
const dramatic =
  /\b(?:prayer|pray|god|divine|trap|bear|axe|limb|arm|leg|explod\w*|explosion|amputat\w*|sever\w*|regrow\w*|grew back|restor\w*|resurrect\w*|petrif\w*|polymorph\w*|wish|genocid\w*|chok\w*|starv\w*|faint\w*|betray\w*|kitten|cat|dog|pet)\b/i;
function witnessedMessages(snapshot, first) {
  const passages = snapshot.events
    .filter((event) => event.type === "passage")
    .map((event) => event.text)
    .filter((text) => typeof text === "string");
  const events = snapshot.events.filter(
    (event) =>
      event.type === "passage" ||
      (event.type === "heard" &&
        typeof event.text === "string" &&
        !passages.some((passage) => passage.split("\n").includes(event.text))),
  );
  // observation.heard is a rolling window, not fresh narration for this action.
  // Only the first snapshot may seed context from that window.
  const texts = events.length
    ? events.map((event) =>
        clean(event.text, event.type === "passage" ? 1500 : 550),
      )
    : first
      ? snapshot.observation.heard.map((text) => clean(text, 550))
      : [];
  const messages = [
    ...new Set(texts.map((text) => text?.trim()).filter(Boolean)),
  ];
  if (messages.length <= 12) return messages;
  const chosen = new Set([0, messages.length - 1]);
  const order = messages
    .map((text, index) => ({ index, score: dramatic.test(text) ? 1 : 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  for (const { index } of order) {
    if (chosen.size >= 12) break;
    chosen.add(index);
  }
  return [...chosen].sort((a, b) => a - b).map((index) => messages[index]);
}
const selectedVitals = (v) =>
  Object.fromEntries(
    ["health", "maxHealth", "level", "hunger", "condition"]
      .filter((k) => v[k] !== undefined)
      .map((k) => [
        k,
        Array.isArray(v[k])
          ? v[k].map((x) => clean(x, 50)).slice(0, 12)
          : typeof v[k] === "string"
            ? clean(v[k], 100)
            : v[k],
      ]),
  );

/** A full public reply, whether or not it advances the run. Pending decision
 * prompts and cancelled actions keep their revision and are still real replies. */
export const isFullReply = (reply) => {
  const s = reply?.structuredContent ?? reply?.response ?? reply;
  return (
    s?.version === 1 &&
    !!s.observation &&
    Array.isArray(s.observation.heard) &&
    Array.isArray(s.events)
  );
};

/** Turn ids are citation coordinates: T<turn>, or T<turn>.<n> within a turn. */
export const turnId = (turn) => "T" + turn;

/** Rough transcript size of one entry; the final prompt is measured exactly. */
const estimate = (beat) =>
  24 +
  (beat.messages ?? []).reduce((n, m) => n + m.length + 1, 0) +
  (beat.action ? 24 : 0) +
  (beat.changes ? 40 : 0) +
  (beat.witnesses ? 60 : 0) +
  (beat.ending ? 80 : 0);

export class ChronicleDigest {
  constructor(identity = {}) {
    this.hero = Object.fromEntries(
      ["name", "role", "race"]
        .filter((k) => clean(identity[k], 80))
        .map((k) => [k, clean(identity[k], 80)]),
    );
    this.pool = [];
    this.previous = null;
    this.session = null;
    this.count = 0;
    this.ignored = 0;
    this.repeated = 0;
    this.collapsed = 0;
    this.silent = 0;
    this.lastRevision = -1;
    this.frequencies = new Map();
    this.first = null;
    this.last = null;
  }
  /** The batch worker verifies full receipts before projecting this evidence.
   * It is intentionally a separate format, never passed off as a full scene. */
  addEvidence(evidence) {
    if (evidence?.rejected === true) { this.ignored++; return false; }
    const o = evidence?.observation;
    if (!o || !Array.isArray(o.companions)) throw Error('Invalid replay evidence');
    return this.add({ ...evidence, version: 1, observation: {
      ...o, world: o.companions.map(appearance => ({ occupant: { kind: 'ally', appearance } })),
    } });
  }
  add(reply) {
    // SDK/MCP captures may wrap a full snapshot. Never accept arbitrary script notes.
    const s = reply?.structuredContent ?? reply?.response ?? reply;
    if (!isFullReply(reply)) return false;
    if (
      !Number.isSafeInteger(s.revision) ||
      !Number.isSafeInteger(s.observation.turn) ||
      typeof s.sessionId !== "string" ||
      !s.sessionId
    )
      throw Error("Invalid snapshot boundary");
    if (this.session && this.session !== s.sessionId)
      throw Error("A chronicle must contain exactly one run");
    this.session = s.sessionId;
    // Free observations / historical receipts are not new events or time travel.
    if (s.revision <= this.lastRevision) {
      this.ignored++;
      return false;
    }
    this.lastRevision = s.revision;
    this.count++;
    const o = s.observation,
      v = selectedVitals(o.vitals ?? {}),
      changes = {};
    const messages = witnessedMessages(s, !this.first);
    const place = clean(o.location?.depthLabel, 60)?.trim() || undefined,
      action = clean(s.outcome?.action, 50);
    let score = this.first ? 0 : 100;
    if (this.previous) {
      for (const k of ["level", "hunger", "condition"])
        if (
          JSON.stringify(v[k]) !== JSON.stringify(this.previous.v[k]) &&
          v[k] !== undefined
        ) {
          changes[k] = { from: this.previous.v[k], to: v[k] };
          score += k === "level" ? 25 : 35;
        }
      if (place !== this.previous.place) {
        changes.place = { from: this.previous.place, to: place };
        score += 30;
      }
      const before = Number(this.previous.v.health),
        after = Number(v.health),
        max = Number(v.maxHealth);
      if (
        Number.isFinite(before) &&
        Number.isFinite(after) &&
        max > 0 &&
        (Math.abs(after - before) >= max * 0.3 ||
          (after < before && after <= max * 0.25))
      ) {
        changes.health = {
          direction: after > before ? "recovered" : "lost",
          ...(after >= max
            ? { fullyRecovered: true }
            : after <= max * 0.25
              ? { criticallyLow: true }
              : {}),
        };
        score += 45;
      }
    }
    const special = [];
    for (const e of s.events) {
      if (e.type === "lifeSaved") {
        special.push({ type: "lifeSaved", cause: clean(e.cause) });
        score += 100;
      }
      // Apparent allies are introductions, never inferred pet deaths/disappearances.
    }
    if (!this.first) {
      const companions = [
        ...new Set(
          (o.world ?? [])
            .filter((c) => c.occupant?.kind === "ally")
            .map((c) => clean(c.occupant.appearance, 80))
            .filter(Boolean),
        ),
      ].slice(0, 5);
      if (companions.length)
        special.push({ type: "apparentCompanions", names: companions });
    }
    let novel = 0;
    for (const m of messages) {
      const key = m.toLowerCase(),
        n = this.frequencies.get(key) ?? 0;
      if (!n) novel++;
      else this.repeated++;
      if (this.frequencies.size >= 4096 && !this.frequencies.has(key))
        this.frequencies.delete(this.frequencies.keys().next().value);
      this.frequencies.set(key, n + 1);
      if (dramatic.test(m)) score += Math.max(4, 28 - n * 8);
    }
    score += Math.min(20, novel * 4);
    const onlyRoutine =
      messages.length &&
      !Object.keys(changes).length &&
      !special.length &&
      messages.every((m) => routine.test(m));
    if (onlyRoutine) score = Math.min(score, 2);
    if (["pray", "offer", "wish", "invoke"].includes(action)) score += 20;
    const notableAction =
      action &&
      ![
        "move", "wait", "search", "create", "look", "inventory", "observe",
        "travel", "navigate",
      ].includes(action) &&
      (score > 2 || !onlyRoutine);
    const ending =
      s.ended && s.end
        ? {
            kind: clean(s.end.kind, 30),
            cause: clean(s.end.cause),
            turn: s.end.turn,
            score: s.end.score,
          }
        : undefined;
    if (ending) score = 1000;
    const beat = {
      id: turnId(o.turn),
      turn: o.turn,
      place,
      ...(notableAction
        ? {
            action,
            status: clean(s.outcome?.status, 30),
            elapsed: s.outcome?.turnsElapsed,
          }
        : {}),
      ...(messages.length ? { messages } : {}),
      ...(Object.keys(changes).length ? { changes } : {}),
      ...(special.length ? { witnesses: special } : {}),
      ...(ending ? { ending } : {}),
    };
    const entry = { beat, score, order: this.count, repeats: 0 };
    if (!this.first) this.firstAction = action;
    this.first ??= entry;
    this.last = entry;
    // Identical routine repetition ("You hit the jackal.") is counted on the
    // previous entry rather than retold line by line.
    const tail = this.pool.at(-1);
    if (
      onlyRoutine &&
      tail &&
      tail !== this.first &&
      !tail.beat.ending &&
      JSON.stringify(tail.beat.messages) === JSON.stringify(messages) &&
      !beat.changes
    ) {
      tail.repeats++;
      tail.through = o.turn;
      this.collapsed++;
      this.last = tail;
      this.previous = { v, place };
      return true;
    }
    const worthKeeping =
      messages.length || Object.keys(changes).length || special.length || notableAction || ending || !this.pool.length;
    if (worthKeeping) this.pool.push(entry);
    else this.silent++;
    if (this.pool.length > POOL_LIMIT) {
      const keep = new Set(
        [...this.pool]
          .sort((a, b) => b.score - a.score || b.order - a.order)
          .slice(0, POOL_KEEP),
      );
      keep.add(this.first);
      this.pool = this.pool.filter((e) => keep.has(e));
    }
    this.previous = { v, place };
    return true;
  }
  finish() {
    if (!this.first)
      throw Error(
        "No full public replies found. Replay input-only logs with the pinned engine first.",
      );
    const chosen = new Set([this.first, this.last]);
    let size = estimate(this.first.beat) + estimate(this.last.beat);
    for (const entry of [...this.pool].sort(
      (a, b) => b.score - a.score || a.order - b.order,
    )) {
      if (chosen.has(entry)) continue;
      const cost = estimate(entry.beat);
      if (size + cost > MAX_PROMPT_CHARS) continue;
      chosen.add(entry);
      size += cost;
    }
    // One transcript line per retained reply, in order. Turn ids are the
    // citation coordinates; a second event within the same turn is T12.2.
    const perTurn = new Map(), events = [];
    for (const entry of [...chosen].sort((a, b) => a.order - b.order)) {
      const b = entry.beat, n = (perTurn.get(b.turn) ?? 0) + 1;
      perTurn.set(b.turn, n);
      events.push({
        ...b,
        id: n === 1 ? b.id : `${b.id}.${n}`,
        ...(entry.repeats ? { repeats: entry.repeats, through: entry.through } : {}),
      });
    }
    return {
      version: DIGEST_VERSION,
      hero: this.hero,
      coverage: {
        observedReplies: this.count,
        ignoredObservationsOrOldReceipts: this.ignored,
        selectedEvents: events.length,
        omittedReplies:
          this.count - this.silent - [...chosen].reduce((n, e) => n + 1 + e.repeats, 0),
        collapsedRoutineReplies: this.collapsed,
        silentReplies: this.silent,
        repeatedMessages: this.repeated,
        complete: !!this.last.beat.ending,
        startsAtCreation: ["new_game", "create"].includes(this.firstAction),
      },
      events,
    };
  }
}
