/** Presentation-only evidence selection. Never used to choose game actions.
 * Feed full public replies in order, not raw inputs or observation deltas. */
export const DIGEST_VERSION = 1;
export const MAX_DIGEST_BYTES = 16000;
const clean = (value, limit = 700) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, limit)
    : undefined;
const routine =
  /^(?:You (?:miss|hit|kill|destroy) (?:the|a|an) .{1,80}[.!]|You swap places with .{1,60}[.!]|You (?:see|hear) nothing special[.!]|You reached the selected square[.!])$/;
const dramatic =
  /\b(?:prayer|pray|god|divine|trap|bear|axe|limb|arm|leg|explod\w*|explosion|amputat\w*|sever\w*|regrow\w*|grew back|restor\w*|resurrect\w*|petrif\w*|polymorph\w*|wish|genocid\w*|chok\w*|starv\w*|faint\w*|betray\w*|kitten|cat|dog|pet)\b/i;
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
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
  if (messages.length <= 8) return messages;
  const chosen = new Set([0, messages.length - 1]);
  const order = messages
    .map((text, index) => ({ index, score: dramatic.test(text) ? 1 : 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  for (const { index } of order) {
    if (chosen.size >= 8) break;
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

export class ChronicleDigest {
  constructor(identity = {}) {
    this.hero = Object.fromEntries(
      ["name", "role", "race"]
        .filter((k) => clean(identity[k], 80))
        .map((k) => [k, clean(identity[k], 80)]),
    );
    this.pool = [];
    this.recent = [];
    this.previous = null;
    this.session = null;
    this.count = 0;
    this.ignored = 0;
    this.repeated = 0;
    this.lastRevision = -1;
    this.frequencies = new Map();
    this.first = null;
    this.last = null;
  }
  add(reply) {
    // SDK/MCP captures may wrap a full snapshot. Never accept arbitrary script notes.
    const s = reply?.structuredContent ?? reply?.response ?? reply;
    if (
      s?.version !== 1 ||
      !s.observation ||
      !Array.isArray(s.observation.heard) ||
      !Array.isArray(s.events)
    )
      return false;
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
    const place = clean(o.location?.depthLabel, 60),
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
      if (this.frequencies.size >= 256 && !this.frequencies.has(key))
        this.frequencies.delete(this.frequencies.keys().next().value);
      this.frequencies.set(key, n + 1);
      if (dramatic.test(m)) score += Math.max(4, 28 - n * 8);
    }
    score += Math.min(20, novel * 4);
    if (
      messages.length &&
      !Object.keys(changes).length &&
      !special.length &&
      messages.every((m) => routine.test(m))
    )
      score = Math.min(score, 2);
    if (["pray", "offer", "wish", "invoke"].includes(action)) score += 20;
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
      id: `e${this.count}`,
      turn: o.turn,
      place,
      ...(action &&
      score > 2 &&
      !["move", "wait", "search", "create"].includes(action)
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
    const previousEntry = this.recent.at(-1);
    const entry = {
      beat,
      score,
      order: this.count,
      context: previousEntry
        ? { beat: previousEntry.beat, order: previousEntry.order }
        : undefined,
    };
    this.first ??= entry;
    this.last = entry;
    this.recent.push(entry);
    if (this.recent.length > 3) this.recent.shift();
    if (score > 2 || !this.pool.length) this.pool.push(entry);
    // Bound selection memory even for million-input transcripts. Context is one beat,
    // not a linked chain retaining the discarded run.
    if (this.pool.length > 96)
      this.pool = this.pool
        .sort((a, b) => b.score - a.score || b.order - a.order)
        .slice(0, 64);
    this.previous = { v, place };
    return true;
  }
  finish() {
    if (!this.first)
      throw Error(
        "No full public replies found. Replay input-only logs with the pinned engine first.",
      );
    const chosen = new Map();
    const insert = (entry) => {
      if (entry) chosen.set(entry.order, entry.beat);
    };
    insert(this.first);
    insert(this.last);
    const build = () => ({
      version: DIGEST_VERSION,
      hero: this.hero,
      coverage: {
        observedReplies: this.count,
        ignoredObservationsOrOldReceipts: this.ignored,
        selectedEvents: chosen.size,
        omittedReplies: this.count - chosen.size,
        repeatedMessages: this.repeated,
        complete: !!this.last.beat.ending,
        startsAtCreation: ["new_game", "create"].includes(
          this.first.beat.action,
        ),
      },
      events: [...chosen.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v),
    });
    // Reserve opening + actual ending before spending the rest of the prompt budget.
    for (const entry of [...this.pool].sort(
      (a, b) => b.score - a.score || a.order - b.order,
    )) {
      if (chosen.size >= 28) break;
      const additions = [entry.context, entry].filter(
        (e) => e && !chosen.has(e.order),
      );
      for (const e of additions) insert(e);
      if (bytes(build()) > MAX_DIGEST_BYTES)
        for (const e of additions) chosen.delete(e.order);
    }
    const digest = build();
    if (bytes(digest) > MAX_DIGEST_BYTES)
      throw Error("Opening or ending exceeds the chronicle evidence budget");
    return digest;
  }
}
