import {
  ledgerStats,
  ledgerRun,
  ledgerRuns,
  saveLedgerRun,
  vaultOwner,
} from "./ledger-store.ts";
import { read } from "./storage.ts";
import { attributionName } from './run-attribution.ts';
import { publicName } from '../.generated/adventurer-names.mjs';

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VAULT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROLS = new Set(["manual", "webmcp", "bot", "script", "playground"]);
// Hosting never simulates the game, but it can refuse what the engine cannot
// produce. Impossible values reject the whole upload; unknown ones stay omitted.
const MAX_HERO_LEVEL = 30; // engine MAXULEV
const MAX_DEPTH = 512; // engine MAXDUNGEON * MAXLEVEL
const END_KINDS = new Set(["death", "quit", "disconnected", "ascended", "escaped", "engineError", "unknown"]);

export type Run = {
  id: string;
  name: string;
  /** Operator-owned presentation correction; never accepted from uploads. */
  nameOverride?: { original: string; name: string };
  role: string;
  actualClass?: string;
  randomClass?: boolean;
  seed?: number;
  seedSpecified?: boolean;
  turn: number;
  ended: boolean;
  heroLevel?: number;
  maxLevel?: number;
  maxDepth?: number;
  depthLabel?: string;
  gold?: number;
  kills?: number;
  experience?: number;
  gotAmulet?: boolean;
  endKind?: string;
  score?: number;
  control?: string;
  automated?: boolean;
  webmcpAutomated?: boolean;
  harness_name?: string;
  model_name?: string;
  buildId?: string;
  updatedAt: number;
};

function str(value: unknown, max: number) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}
function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
function flag(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}
const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;

export function sanitizeRun(
  raw: Record<string, unknown>,
  now: number,
): Run | null {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Number.isSafeInteger(raw.turn) ||
    Number(raw.turn) < 0 ||
    Number(raw.turn) > 1e9
  )
    return null;
  if (typeof raw.id !== "string" || !RUN_ID.test(raw.id)) return null;
  const heroLevel = positiveInteger(raw.heroLevel),
    maxLevel = positiveInteger(raw.maxLevel),
    maxDepth = positiveInteger(raw.maxDepth),
    endKind = str(raw.endKind, 32);
  if (
    (heroLevel ?? 0) > MAX_HERO_LEVEL ||
    (maxLevel ?? 0) > MAX_HERO_LEVEL ||
    (maxDepth ?? 0) > MAX_DEPTH ||
    (heroLevel !== undefined && maxLevel !== undefined && heroLevel > maxLevel) ||
    (endKind !== undefined && !END_KINDS.has(endKind))
  )
    return null;
  const control = str(raw.control, 16);
  return {
    id: raw.id,
    name: publicName(raw.id, raw.name),
    role: str(raw.role, 32) ?? "valkyrie",
    actualClass: str(raw.actualClass, 32) ?? str(raw.role, 32),
    randomClass: flag(raw.randomClass),
    seed: num(raw.seed),
    seedSpecified: flag(raw.seedSpecified),
    turn: num(raw.turn) ?? 0,
    ended: Boolean(raw.ended),
    heroLevel,
    maxLevel,
    maxDepth,
    depthLabel: str(raw.depthLabel, 64),
    gold: num(raw.gold),
    kills: num(raw.kills),
    experience: num(raw.experience),
    gotAmulet: flag(raw.gotAmulet),
    endKind,
    score: num(raw.score),
    control: control && CONTROLS.has(control) ? control : undefined,
    automated:
      raw.webmcpAutomated === true || control === 'webmcp' ? true : flag(raw.automated) ?? (control ? control !== "manual" : undefined),
    webmcpAutomated: raw.webmcpAutomated === true || control === 'webmcp' || undefined,
    harness_name: attributionName(raw.harness_name),
    model_name: attributionName(raw.model_name),
    buildId: str(raw.buildId, 64),
    updatedAt: now,
  };
}

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
const codes = new Set([
  "runtime_timing",
  "store_owned",
  "cloud_conflict",
  "runtime_unavailable",
  "module_load",
  "network",
  "storage",
  "engine",
  "client",
  "server",
]);
export async function board(request: Request) {
  const url = new URL(request.url),
    path = url.pathname;
  if (request.method === "GET") {
    if (path === "/api/stats") {
      const now = Date.now();
      const stats = await ledgerStats(now);
      if (url.searchParams.get('view') === 'count')
        return Response.json({ runs: stats.totals.runs }, { headers: {
          'cache-control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
        } });
      return json({
        generatedAt: now,
        ...stats,
      });
    }
    if (path.startsWith("/api/runs/")) {
      const run = await ledgerRun(path.slice("/api/runs/".length));
      return run ? json(run) : json({ error: "not found" }, 404);
    }
    return json(
      (await ledgerRuns()).slice(
        0,
        Math.min(
          10000,
          Math.max(1, Number(url.searchParams.get("limit")) || 200),
        ),
      ),
    );
  }
  if (request.method !== "POST" || !["/api/errors", "/api/runs"].includes(path))
    return json({ error: "method not allowed" }, 405);
  const text = await request.text();
  if (text.length > 64 * 1024) return json({ error: "too large" }, 413);
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object")
    return json({ error: "invalid body" }, 400);
  const now = Date.now();
  if (path === "/api/errors") {
    if (
      !codes.has(body.code) ||
      (body.buildId !== undefined && (typeof body.buildId !== 'string' || (body.buildId !== '' && !/^[a-f0-9]{64}$/.test(body.buildId))))
    )
      return json({ error: "invalid diagnostic" }, 400);
    if (body.entry !== undefined && (!body.entry || !["create","resume","boot"].includes(body.entry.kind) || typeof body.entry.local !== "boolean")) return json({error:"invalid entry diagnostic"},400);
    if(body.code==='runtime_timing'){
      const v=body.timing;
      if(!v||!['preparation','ownership','assets','compile','local','cloud','engine','ready','action','durability','checkpoint'].includes(v.stage)||!['slow','complete','failed'].includes(v.outcome)||!Number.isSafeInteger(v.duration)||v.duration<0||v.duration>600000)return json({error:'invalid timing'},400);
      console.info(JSON.stringify({event:'runtime_timing',stage:v.stage,duration:v.duration,outcome:v.outcome,buildId:body.buildId||undefined}));
      return new Response(null,{status:204});
    }
    console.warn(JSON.stringify({ event: body.entry ? "game_entry_failed" : "client_diagnostic", code: body.code, buildId: body.buildId || undefined, ...(body.entry ? {kind:body.entry.kind,local:body.entry.local} : {}) }));
    return new Response(null, { status: 204 });
  }
  if (!Array.isArray(body.runs) || body.runs.length > 50)
    return json({ error: "invalid runs" }, 400);
  // The vault capability that registered a run is the only authority allowed to
  // publish its ledger metadata. Registration happens through the private
  // adventure directory; the first publication binds the run to that vault.
  if (typeof body.vault !== "string" || !VAULT.test(body.vault))
    return json({ error: "missing vault" }, 400);
  const registered = new Set<string>(
    ((await read("vaults/" + body.vault + "/adventures.json"))?.values ?? [])
      .map((value: any) => value?.id)
      .filter((id: unknown) => typeof id === "string"),
  );
  const owner = vaultOwner(body.vault);
  let stored = 0, refused = 0;
  for (const raw of body.runs) {
    const run = sanitizeRun(raw, now);
    if (!run) { refused++; continue; }
    if (registered.has(run.id) && (await saveLedgerRun(run, owner))) stored++;
    else refused++;
  }
  return json({ stored, refused });
}
