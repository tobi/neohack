const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[a-f0-9]{64}$/;
const codes = new Set(["store_owned", "runtime_unavailable", "module_load", "network", "storage", "engine", "client", "server"]);
const ends = new Set(["death", "ascended", "escaped", "quit", "disconnected", "engineError", "unknown"]);
const json = (value: unknown, status = 200) => Response.json(value, {status, headers:{"cache-control":"no-store"}});
const number = (value: unknown, max: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
export class Board {
  constructor(private readonly ctx: DurableObjectState) {}
  async fetch(request: Request) {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS errors (day TEXT, code TEXT, build TEXT, count INTEGER, last INTEGER, PRIMARY KEY(day,code,build))");
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.pathname.endsWith("/stats")) {
        const totals = sql.exec(`SELECT count(*) AS runs,
          coalesce(sum(json_extract(json,'$.ended') = 0),0) AS living,
          coalesce(sum(json_extract(json,'$.endKind') = 'ascended'),0) AS ascended,
          coalesce(max(json_extract(json,'$.turn')),0) AS longest
          FROM runs`).toArray()[0];
        const best = sql.exec(`SELECT json FROM runs ORDER BY
          coalesce(json_extract(json,'$.endKind') = 'ascended',0) DESC,
          coalesce(json_extract(json,'$.maxLevel'),0) DESC,
          json_extract(json,'$.turn') DESC, id LIMIT 100`).toArray().map(row => JSON.parse(String(row.json)));
        const roles = sql.exec("SELECT json_extract(json,'$.role') AS role, count(*) AS count FROM runs GROUP BY role ORDER BY count DESC").toArray();
        const since = new Date(Date.now()-13*86400000).toISOString().slice(0,10);
        const errors = sql.exec("SELECT day,code,build,count,last FROM errors WHERE day >= ? ORDER BY day DESC,count DESC LIMIT 500",since).toArray();
        return json({generatedAt:Date.now(), totals, best, roles, errors, errorSince:since});
      }
      return json(sql.exec("SELECT json FROM runs ORDER BY updated DESC LIMIT 200").toArray().map(row=>JSON.parse(String(row.json))));
    }
    if (request.method !== "POST") return json({error:"method not allowed"},405);
    const text = await request.text();
    if (text.length > 64*1024) return json({error:"too large"},413);
    let body;
    try {body=JSON.parse(text);} catch {return json({error:"invalid JSON"},400);}
    if (!body || typeof body !== "object") return json({error:"invalid body"},400);
    const now=Date.now();
    if (url.pathname.endsWith("/errors")) {
      if (!codes.has(body.code) || (body.buildId && !HASH.test(body.buildId))) return json({error:"invalid diagnostic"},400);
      const day=new Date(now).toISOString().slice(0,10);
      const existing=sql.exec("SELECT 1 FROM errors WHERE day=? AND code=? AND build=?",day,body.code,body.buildId || "").toArray().length;
      if (!existing && Number(sql.exec("SELECT count(*) AS n FROM errors WHERE day=?",day).toArray()[0]?.n) >= 512) return json({error:"diagnostic capacity reached"},429);
      // Categories only; no request bodies, stack traces, bookmarks or player IDs.
      sql.exec("INSERT INTO errors VALUES (?,?,?,?,?) ON CONFLICT(day,code,build) DO UPDATE SET count=min(count+1,1000000),last=excluded.last",day,body.code,body.buildId || "",1,now);
      sql.exec("DELETE FROM errors WHERE day < ?",new Date(now-14*86400000).toISOString().slice(0,10));
      console.error("diagnostic", {code:body.code, buildId:body.buildId || ""});
      return new Response(null,{status:204});
    }
    if (!Array.isArray(body.runs) || body.runs.length > 50) return json({error:"invalid runs"},400);
    let stored=0;
    for (const run of body.runs) {
      if (!run || typeof run.id !== "string" || !RUN_ID.test(run.id) || !number(run.turn,1e9)) continue;
      const row=sql.exec("SELECT json FROM runs WHERE id = ?",run.id).toArray()[0];
      const old=row ? JSON.parse(String(row.json)) : null;
      if (old && (old.turn > run.turn || old.ended && !run.ended)) continue;
      const record={
        id:run.id,
        name:typeof run.name==="string" ? run.name.slice(0,64) : "Adventurer",
        role:typeof run.role==="string" ? run.role.slice(0,32) : "unknown",
        turn:run.turn, ended:run.ended === true,
        maxLevel:Math.max(old?.maxLevel ?? 0, number(run.maxLevel,30) ? run.maxLevel : 0),
        depthLabel:typeof run.depthLabel==="string" ? run.depthLabel.slice(0,64) : "",
        endKind:ends.has(run.endKind) ? run.endKind : null,
        buildId:HASH.test(run.buildId) ? run.buildId : null,
        updatedAt:now,
      };
      sql.exec("INSERT INTO runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,updated=excluded.updated",record.id,JSON.stringify(record),now);
      stored++;
    }
    return json({stored});
  }
}
