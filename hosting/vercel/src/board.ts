import { read, update } from "./storage.ts";

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROLS = new Set(["manual", "webmcp", "bot", "script", "playground"]);

export type Run = {
  id: string;
  name: string;
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
  const control = str(raw.control, 16);
  return {
    id: raw.id,
    name: str(raw.name, 64) ?? "Adventurer",
    role: str(raw.role, 32) ?? "valkyrie",
    actualClass: str(raw.actualClass, 32) ?? str(raw.role, 32),
    randomClass: flag(raw.randomClass),
    seed: num(raw.seed),
    seedSpecified: flag(raw.seedSpecified),
    turn: num(raw.turn) ?? 0,
    ended: Boolean(raw.ended),
    heroLevel: num(raw.heroLevel),
    maxLevel: num(raw.maxLevel),
    maxDepth: num(raw.maxDepth),
    depthLabel: str(raw.depthLabel, 64),
    gold: num(raw.gold),
    kills: num(raw.kills),
    experience: num(raw.experience),
    gotAmulet: flag(raw.gotAmulet),
    endKind: str(raw.endKind, 32),
    score: num(raw.score),
    control: control && CONTROLS.has(control) ? control : undefined,
    automated:
      flag(raw.automated) ?? (control ? control !== "manual" : undefined),
    buildId: str(raw.buildId, 64),
    updatedAt: now,
  };
}

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
const codes = new Set([
  "store_owned",
  "runtime_unavailable",
  "module_load",
  "network",
  "storage",
  "engine",
  "client",
  "server",
]);
const empty = () => ({
  runs: [] as Run[],
  errors: [] as Array<{
    day: string;
    code: string;
    build: string;
    count: number;
    last: number;
  }>,
});
export async function board(request: Request) {
  const url = new URL(request.url),
    path = url.pathname;
  if (request.method === "GET") {
    const doc =
      (await read<ReturnType<typeof empty>>("board/index.json")) ?? empty();
    if (path === "/api/stats") {
      const runs: Run[] = doc.runs,
        roles: Record<string, number> = {};
      for (const run of runs) roles[run.role] = (roles[run.role] ?? 0) + 1;
      const since = new Date(Date.now() - 13 * 86400000)
        .toISOString()
        .slice(0, 10);
      return json({
        generatedAt: Date.now(),
        totals: {
          runs: runs.length,
          living: runs.filter((r) => !r.ended).length,
          ascended: runs.filter((r) => r.endKind === "ascended").length,
          longest: Math.max(0, ...runs.map((r) => r.turn)),
        },
        best: [...runs]
          .sort(
            (a, b) =>
              Number(b.endKind === "ascended") -
                Number(a.endKind === "ascended") ||
              (b.maxLevel ?? 0) - (a.maxLevel ?? 0) ||
              b.turn - a.turn ||
              a.id.localeCompare(b.id),
          )
          .slice(0, 100),
        roles: Object.entries(roles)
          .map(([role, count]) => ({ role, count }))
          .sort((a, b) => b.count - a.count),
        errors: doc.errors
          .filter((e) => e.day >= since)
          .sort((a, b) => b.day.localeCompare(a.day) || b.count - a.count)
          .slice(0, 500),
        errorSince: since,
      });
    }
    if (path.startsWith("/api/runs/")) {
      const run = doc.runs.find(
        (r) => r.id === path.slice("/api/runs/".length),
      );
      return run ? json(run) : json({ error: "not found" }, 404);
    }
    return json(
      doc.runs.slice(
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
      (body.buildId && !/^[a-f0-9]{64}$/.test(body.buildId))
    )
      return json({ error: "invalid diagnostic" }, 400);
    return update("board/index.json", empty, (doc) => {
      const day = new Date(now).toISOString().slice(0, 10),
        build = body.buildId || "";
      const entry = doc.errors.find(
        (e) => e.day === day && e.code === body.code && e.build === build,
      );
      if (!entry && doc.errors.filter((e) => e.day === day).length >= 512)
        return json({ error: "diagnostic capacity reached" }, 429);
      if (entry) {
        entry.count = Math.min(entry.count + 1, 1000000);
        entry.last = now;
      } else
        doc.errors.push({ day, code: body.code, build, count: 1, last: now });
      doc.errors = doc.errors.filter(
        (e) =>
          e.day >= new Date(now - 14 * 86400000).toISOString().slice(0, 10),
      );
      return new Response(null, { status: 204 });
    });
  }
  if (!Array.isArray(body.runs) || body.runs.length > 50)
    return json({ error: "invalid runs" }, 400);
  return update("board/index.json", empty, (doc) => {
    let stored = 0;
    const runs = new Map(doc.runs.map((r) => [r.id, r]));
    for (const raw of body.runs) {
      const run = sanitizeRun(raw, now);
      if (!run) continue;
      const old = runs.get(run.id);
      if (old && (old.turn > run.turn || (old.ended && !run.ended))) continue;
      run.maxLevel = Math.max(old?.maxLevel ?? 0, run.maxLevel ?? 0);
      runs.set(run.id, run);
      stored++;
    }
    doc.runs = [...runs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return json({ stored });
  });
}
