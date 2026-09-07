import { createHash } from "node:crypto";
import { read, update, storage, type Storage } from "./storage.ts";
import type { Run } from "./board.ts";
import { publicReplayIds } from "./replays.ts";
const SHARDS = 32;
const partition = (id: string) =>
  createHash("sha256").update(id).digest()[0]! % SHARDS;
const rank = (a: Run, b: Run) =>
  Number(b.endKind === "ascended") - Number(a.endKind === "ascended") ||
  (b.maxLevel ?? 0) - (a.maxLevel ?? 0) ||
  b.turn - a.turn ||
  a.id.localeCompare(b.id);
type Entry = { run: Run; recorded: boolean };
type Shard = { version: number; entries: Record<string, Entry> };
const emptyShard = (): Shard => ({ version: 0, entries: {} });
function summarize(shard: Shard) {
  const entries = Object.values(shard.entries),
    runs = entries
      .map((e) => ({ ...e.run, replayAvailable: e.recorded }))
      .sort(rank),
    roles: Record<string, number> = {};
  for (const run of runs) roles[run.role] = (roles[run.role] ?? 0) + 1;
  return {
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
  };
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
      for (const { run, recorded } of entries) {
        const prior = doc.entries[run.id];
        if (
          (newer(prior?.run, run) &&
            JSON.stringify(prior?.run) !== JSON.stringify(run)) ||
          (recorded && !prior?.recorded)
        ) {
          doc.entries[run.id] = {
            run: newer(prior?.run, run) ? run : prior!.run,
            recorded: recorded || prior?.recorded || false,
          };
          doc.version++;
        }
      }
      return summarize(doc);
    },
  );
  await update(
    "ledger/summaries/" + shard + ".json",
    () => summarize(emptyShard()),
    (doc) => {
      if (summary.version > doc.version) Object.assign(doc, summary);
    },
  );
}
const indexRun = (run: Run, recorded = false) =>
  indexEntries(partition(run.id), [{ run, recorded }]);
async function writeRun(run: Run, recorded = false) {
  const original = (await read("ledger/runs/" + run.id + ".json"))
    ? undefined
    : (await read("board/index.json"))?.runs?.find((r: Run) => r.id === run.id);
  const current = await update<{ run?: Run }, Run>(
    "ledger/runs/" + run.id + ".json",
    () => ({ run: original }),
    (doc) => {
      if (newer(doc.run, run))
        doc.run = {
          ...run,
          maxLevel: Math.max(run.maxLevel ?? 0, doc.run?.maxLevel ?? 0),
        };
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
    const recorded = await publicReplayIds();
    // Bootstrap bounded summaries in batches. Historical run records remain at
    // their published source until explicitly materialized; no per-run cold-start writes.
    const groups = Array.from({ length: SHARDS }, () => [] as Entry[]);
    for (const run of original?.runs ?? [])
      groups[partition(run.id)]!.push({ run, recorded: recorded.has(run.id) });
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
  return writeRun(run);
}
export async function markRecorded(id: string) {
  await initialize();
  const run = await ledgerRun(id);
  if (run) await indexRun(run, true);
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
export async function ledgerStats() {
  await initialize();
  const summaries = await Promise.all(
    Array.from({ length: SHARDS }, (_, n) =>
      read<ReturnType<typeof summarize>>("ledger/summaries/" + n + ".json"),
    ),
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
  };
}
export async function rebuildLedgerSummaries() {
  await initialize();
  const recorded = await publicReplayIds();
  const runs = await ledgerRuns();
  for (const run of runs) await indexRun(run, recorded.has(run.id));
  return { runs: runs.length };
}
