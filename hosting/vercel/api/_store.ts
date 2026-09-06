import { list, put } from "@vercel/blob";

const RUNS = "neohack/runs.json";

export type Run = {
  id: string;
  name: string;
  role: string;
  turn: number;
  ended: boolean;
  updatedAt: number;
};

export async function readRuns(): Promise<Run[]> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return [];
  const found = await list({ prefix: RUNS, limit: 1 });
  const blob = found.blobs.find((b) => b.pathname === RUNS);
  if (!blob) return [];
  const response = await fetch(blob.url, { cache: "no-store" });
  if (!response.ok) return [];
  const data: unknown = await response.json();
  return Array.isArray(data) ? (data as Run[]) : [];
}

export async function writeRuns(runs: Run[]) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Vercel Blob is not linked");
  }
  await put(RUNS, JSON.stringify(runs), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

export function mergeRuns(existing: Run[], incoming: Run[]) {
  const map = new Map(existing.map((run) => [run.id, run]));
  for (const run of incoming) map.set(run.id, run);
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
}

export function summarize(runs: Run[]) {
  const byRole: Record<string, number> = {};
  let ended = 0;
  let maxTurn = 0;
  for (const run of runs) {
    byRole[run.role] = (byRole[run.role] ?? 0) + 1;
    if (run.ended) ended += 1;
    if (run.turn > maxTurn) maxTurn = run.turn;
  }
  return {
    platform: "vercel",
    blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    sessions: runs.length,
    ended,
    living: runs.length - ended,
    maxTurn,
    byRole,
    farthest: [...runs].sort((a, b) => b.turn - a.turn).slice(0, 20),
  };
}
