import { createHash } from "node:crypto";
import { read, update, storage, type Storage } from "./storage.ts";
import type { Run } from "./board.ts";
import { preserveAttribution } from './run-attribution.ts';
import { publicReplayStorage } from "./public-replay-store.ts";
const SHARDS = 32;
const DAY = 86_400_000;
const SUMMARY_FORMAT = 2;
const RECENT_LIMIT = 200;
const RECORD_LIMIT = 3;
const partition = (id: string) =>
  createHash("sha256").update(id).digest()[0]! % SHARDS;
const rank = (a: Run, b: Run) =>
  Number(b.endKind === "ascended") - Number(a.endKind === "ascended") ||
  (b.maxLevel ?? 0) - (a.maxLevel ?? 0) ||
  b.turn - a.turn ||
  a.id.localeCompare(b.id);
export type ReplayState = {
  version: number; available: boolean; checkedAt: number;
  reason: "published" | "verified" | "missing" | "invalid";
  source?: string;
};
type Entry = { run: Run; recorded: boolean; chronicled?: boolean; replay?: ReplayState };
const replayStatePath = (id: string) => "ledger/replays/" + id + ".json";
export const replayState = (id: string) => read<ReplayState>(replayStatePath(id));
/** A maintenance result is bound to the exact public and authoritative heads.
 * Tokens and private data never leave this function. */
export async function replaySource(id: string) {
  const publicStore = publicReplayStorage();
  const heads = await Promise.all([
    storage().read("input-runs/" + id + ".json"),
    storage().read("replays/" + id + ".json"),
    publicStore.head ? publicStore.head("replays/" + id + "/manifest.json") : publicStore.read("replays/" + id + "/manifest.json"),
  ]);
  return createHash("sha256").update(JSON.stringify(heads.map(h => h?.etag ?? null))).digest("hex");
}
type Shard = { version: number; entries: Record<string, Entry> };
const emptyShard = (): Shard => ({ version: 0, entries: {} });
type PublicRun = Run & { replayAvailable: boolean; chronicleAvailable: boolean };
type DailyRecords = { runs: number; level: PublicRun[]; depth: PublicRun[] };
const recentOrder = (a: Run, b: Run) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
const score = (run: Run, metric: "level" | "depth") => metric === "level" ? run.maxLevel : run.maxDepth;
const knownScore = (value: number | undefined): value is number => Number.isSafeInteger(value) && value! > 0;
function records(runs: PublicRun[], metric: "level" | "depth") {
  return runs.filter(run => knownScore(score(run, metric)))
    .sort((a, b) => score(b, metric)! - score(a, metric)! || recentOrder(a, b))
    .slice(0, RECORD_LIMIT);
}
function progress(old: Run | undefined, run: Run): Run {
  const peak = (a: number | undefined, b: number | undefined) =>
    knownScore(a) || knownScore(b) ? Math.max(knownScore(a) ? a : 0, knownScore(b) ? b : 0) : undefined;
  const nameOverride = old?.nameOverride ?? run.nameOverride;
  return { ...run, ...(nameOverride ? {nameOverride, name:nameOverride.name} : {}), maxLevel: peak(old?.maxLevel, run.maxLevel), maxDepth: peak(old?.maxDepth, run.maxDepth) };
}
function summarize(shard: Shard, now = Date.now()) {
  const entries = Object.values(shard.entries),
    runs = entries
      .map((e) => ({ ...e.run, replayAvailable: e.recorded, chronicleAvailable: e.chronicled === true }))
      .sort(rank),
    roles: Record<string, number> = {};
  for (const run of runs) roles[run.role] = (roles[run.role] ?? 0) + 1;
  const today = Math.floor(now / DAY), daily: Record<string, DailyRecords> = {};
  for (let day = today - 6; day <= today; day++) {
    const active = runs.filter(run => Math.floor(run.updatedAt / DAY) === day);
    if (active.length) daily[day] = { runs: active.length, level: records(active, "level"), depth: records(active, "depth") };
  }
  return {
    format: SUMMARY_FORMAT,
    version: shard.version,
    totals: {
      runs: runs.length,
      living: runs.filter((r) => !r.ended).length,
      ascended: runs.filter((r) => r.endKind === "ascended").length,
      longest: runs.reduce((n, r) => Math.max(n, r.turn), 0),
    },
    roles,
    best: runs.slice(0, 100),
    recorded: runs.filter((r) => r.replayAvailable).slice(0, 100),
    recent: [...runs].sort(recentOrder).slice(0, RECENT_LIMIT),
    daily,
  };
}
type Summary = ReturnType<typeof summarize>;
async function publishSummary(shard: number, summary: Summary) {
  return update("ledger/summaries/" + shard + ".json", () => summarize(emptyShard()), doc => {
    if (summary.version > doc.version || (summary.version === doc.version && doc.format !== SUMMARY_FORMAT))
      Object.assign(doc, summary);
    return doc;
  });
}
const newer = (old: Run | undefined, run: Run) =>
  !old ||
  (!(old.ended && !run.ended) &&
    run.turn >= old.turn &&
    (run.turn > old.turn || run.updatedAt >= old.updatedAt));
async function indexEntries(shard: number, entries: Entry[]) {
  const summary = await update<Shard, ReturnType<typeof summarize>>(
    "ledger/shards/" + shard + ".json",
    emptyShard,
    (doc) => {
      for (const { run, recorded, chronicled, replay } of entries) {
        const prior = doc.entries[run.id];
        const state = replay && replay.version > (prior?.replay?.version ?? 0) ? replay : prior?.replay;
        const available = state?.available ?? (recorded || prior?.recorded || false);
        const attributed = preserveAttribution(prior?.run, progress(prior?.run, run), newer(prior?.run, run));
        // A delayed metadata projection must not undo an operator correction.
        const correction = run.nameOverride ?? prior?.run.nameOverride;
        if (correction) Object.assign(attributed, {nameOverride:correction, name:correction.name});
        if (
          JSON.stringify(prior?.run) !== JSON.stringify(attributed) ||
          available !== prior?.recorded || state?.version !== prior?.replay?.version ||
          (chronicled && !prior?.chronicled)
        ) {
          doc.entries[run.id] = {
            // Indexing may arrive after a newer write with the same timestamp.
            run: attributed,
            recorded: available,
            ...(state ? { replay: state } : {}),
            ...(chronicled || prior?.chronicled ? { chronicled: true } : {}),
          };
          doc.version++;
        }
      }
      return summarize(doc);
    },
  );
  await publishSummary(shard, summary);
}
const indexRun = async (run: Run, recorded = false, chronicled = false) =>
  indexEntries(partition(run.id), [{ run, recorded, chronicled, replay: await replayState(run.id) ?? undefined }]);
async function writeRun(run: Run, recorded = false) {
  const original = (await read("ledger/runs/" + run.id + ".json"))
    ? undefined
    : (await read("board/index.json"))?.runs?.find((r: Run) => r.id === run.id);
  const current = await update<{ run?: Run }, Run>(
    "ledger/runs/" + run.id + ".json",
    () => ({ run: original }),
    (doc) => {
      doc.run = preserveAttribution(doc.run, progress(doc.run, run), newer(doc.run, run));
      return doc.run!;
    },
  );
  await indexRun(current, recorded);
  return current;
}
const initialization = new WeakMap<Storage, Promise<void>>();
/** Rebuild public indexes additively. Published predecessor records are never removed. */
async function initialize() {
  const backend = storage();
  let pending = initialization.get(backend);
  if (pending) return pending;
  pending = (async () => {
    if (await read("ledger/initialized.json")) return;
    const original = await read("board/index.json");
    if (
      original &&
      (!Array.isArray(original.runs) || !Array.isArray(original.errors))
    )
      throw Error("Published ledger index is invalid");
    // Bootstrap bounded summaries in batches. Historical run records remain at
    // their published source until explicitly materialized; no per-run cold-start writes.
    const groups = Array.from({ length: SHARDS }, () => [] as Entry[]);
    for (const run of original?.runs ?? [])
      groups[partition(run.id)]!.push({ run, recorded: false });
    for (let i = 0; i < SHARDS; i += 4)
      await Promise.all(
        groups
          .slice(i, i + 4)
          .map((entries, n) =>
            entries.length ? indexEntries(i + n, entries) : Promise.resolve(),
          ),
      );
    await update(
      "ledger/initialized.json",
      () => ({ ready: false }),
      (doc) => {
        doc.ready = true;
      },
    );
  })();
  initialization.set(backend, pending);
  try {
    await pending;
  } catch (error) {
    initialization.delete(backend);
    throw error;
  }
}
export async function saveLedgerRun(run: Run) {
  await initialize();
  // A private input head alone does not prove that public publication succeeded.
  // markRecorded persists publication even when it precedes the metadata write.
  return writeRun(run);
}
/** Explicit operator maintenance; not exposed through an HTTP upload. */
export async function renameLedgerRun(id: string, original: string, name: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !/^[A-Za-z][A-Za-z ]{0,63}$/.test(name)) throw Error('Invalid name correction');
  await initialize();
  const prior = await ledgerRun(id);
  if (!prior) throw Error('Run not found');
  const current = await update<{run:Run},Run>('ledger/runs/' + id + '.json', () => ({run:prior}), doc => {
    if (doc.run.name !== original && !(doc.run.name === name && doc.run.nameOverride?.original === original)) throw Error('Run name changed; review before renaming');
    doc.run = {...doc.run, name, nameOverride:{original,name}};
    return doc.run;
  });
  await indexRun(current);
  return current;
}
export async function markRecorded(id: string) {
  await initialize();
  await update<ReplayState, void>(replayStatePath(id), () => ({ version: 0, available: false, checkedAt: 0, reason: "missing" }), async state => {
    // Appending cannot repair an already corrupt prefix. Only another full
    // audit may reinstate it. A first publication can repair a missing archive.
    if (state.available || state.reason === "invalid") return;
    const source = await replaySource(id);
    if (state.source === source) return;
    Object.assign(state, { version: state.version + 1, available: true, reason: "published", checkedAt: Date.now(), source });
  });
  const run = await ledgerRun(id);
  if (run) await indexRun(run, true);
}
/** Explicit maintenance only. Transient errors never create a negative verdict.
 * A later publication/audit or changed source makes this result inapplicable. */
export async function auditReplayAvailability(id: string, result: { available: boolean; reason: "verified" | "missing" | "invalid"; source: string; version: number }) {
  await initialize();
  const applied = await update<ReplayState, boolean>(replayStatePath(id), () => ({ version: 0, available: false, checkedAt: 0, reason: "missing" }), async state => {
    if (state.version !== result.version || await replaySource(id) !== result.source) return false;
    Object.assign(state, { version: state.version + 1, available: result.available, reason: result.reason, source: result.source, checkedAt: Date.now() });
    return true;
  });
  const run = await ledgerRun(id);
  if (run) await indexRun(run);
  return applied;
}
/** A cached public chronicle exists for this run; the ledger shows its icon. */
export async function markChronicled(id: string) {
  await initialize();
  const run = await ledgerRun(id);
  if (run) await indexRun(run, false, true);
}
export async function ledgerRun(id: string) {
  await initialize();
  return (
    (await read<{ run: Run }>("ledger/runs/" + id + ".json"))?.run ??
    (await read("board/index.json"))?.runs?.find((r: Run) => r.id === id) ??
    null
  );
}
export async function ledgerRuns() {
  await initialize();
  const paths = await storage().list("ledger/runs/");
  const original = (await read("board/index.json"))?.runs ?? [];
  const runs: Run[] = [];
  for (let i = 0; i < paths.length; i += 16) {
    const docs = await Promise.all(
      paths.slice(i, i + 16).map((p) => read<{ run: Run }>(p)),
    );
    for (const doc of docs) if (doc) runs.push(doc.run);
  }
  const merged = new Map<string, Run>(original.map((r: Run) => [r.id, r]));
  for (const run of runs) merged.set(run.id, run);
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function ledgerStats(now = Date.now()) {
  await initialize();
  const summaries = await Promise.all(
    Array.from({ length: SHARDS }, async (_, n) => {
      const summary = await read<Summary>("ledger/summaries/" + n + ".json");
      if (!summary || summary.format === SUMMARY_FORMAT) return summary;
      // Summaries are replaceable projections. Refresh the bounded partition once;
      // never reinterpret or rewrite authoritative run records or saved games.
      const shard = await read<Shard>("ledger/shards/" + n + ".json");
      if (!shard) throw Error("Ledger summary has no source partition");
      return publishSummary(n, summarize(shard, now));
    }),
  );
  const totals = { runs: 0, living: 0, ascended: 0, longest: 0 },
    roles: Record<string, number> = {};
  for (const s of summaries) {
    if (!s) continue;
    totals.runs += s.totals.runs;
    totals.living += s.totals.living;
    totals.ascended += s.totals.ascended;
    totals.longest = Math.max(totals.longest, s.totals.longest);
    for (const [role, count] of Object.entries(s.roles))
      roles[role] = (roles[role] ?? 0) + count;
  }
  const today = Math.floor(now / DAY);
  const window = (startDay: number) => {
    const days = summaries.flatMap(s => Object.entries(s?.daily ?? {}).filter(([day]) => Number(day) >= startDay && Number(day) <= today).map(([, value]) => value));
    return {
      from: startDay * DAY, to: now, runs: days.reduce((n, day) => n + day.runs, 0),
      level: records(days.flatMap(day => day.level), "level"),
      depth: records(days.flatMap(day => day.depth), "depth"),
    };
  };
  return {
    totals,
    roles: Object.entries(roles)
      .map(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count),
    best: summaries
      .flatMap((s) => s?.best ?? [])
      .sort(rank)
      .slice(0, 100),
    recorded: summaries
      .flatMap((s) => s?.recorded ?? [])
      .sort(rank)
      .slice(0, 100),
    recent: summaries.flatMap(s => s?.recent ?? []).sort(recentOrder).slice(0, RECENT_LIMIT),
    records: { timeZone: "UTC", basis: "updatedAt", today: window(today), week: window(today - 6) },
  };
}
export async function rebuildLedgerSummaries() {
  await initialize();
  const runs = await ledgerRuns();
  for (const run of runs) await indexRun(run);
  return { runs: runs.length };
}
