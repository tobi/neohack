const PLAYER = "neohack-player";
let generatedPlayer: string | undefined;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function requestedRun() {
  const values = new URLSearchParams(location.hash.slice(1));
  const id = values.get("run"), vault = values.get("vault");
  if (!id && !vault) return null;
  if (!id || !vault || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !UUID.test(vault)) throw Error("This adventure link is incomplete or invalid.");
  return { id, vault, local: values.get("local") === "1" };
}
export function showRunUrl(id: string, vault = playerId()) {
  const url = new URL(location.href);
  url.hash = new URLSearchParams({ run: id, vault, ...(new URLSearchParams(url.hash.slice(1)).get("local") === "1" ? {local:"1"} : {}) }).toString();
  history.replaceState(null, "", url);
}
export function clearRunUrl() {
  const url = new URL(location.href); url.hash = "";
  history.replaceState(null, "", url);
}


export type PlayControl = "manual" | "webmcp" | "bot" | "script" | "playground";
export type CloudAdventure = {
  branch?: string;
  buildId?: string;
  id: string;
  vaultId?: string;
  accountId?: string;
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
  control?: PlayControl;
  automated?: boolean;
};

export function playerId() {
  try { const linked = requestedRun(); if (linked) return linked.vault; } catch { /* The mounted page reports invalid links. */ }
  let id = localStorage.getItem(PLAYER);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    id = generatedPlayer ??= crypto.randomUUID();
  }
  return id;
}

export function rememberPlayer(id: string) { if (!localStorage.getItem(PLAYER)) localStorage.setItem(PLAYER, id); }

export function journalUrl(vault = playerId()) {
  return new URL(`/api/vaults/${vault}`, location.href).href;
}

export async function cloudReady() {
  try {
    const response = await fetch("/api/health", {cache:"no-store",signal:AbortSignal.timeout(8000)});
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}

export async function restoreAdventures(vault = playerId()) {
try {
  const response = await fetch(`/api/vaults/${vault}/adventures`, {signal:AbortSignal.timeout(3000)});
  if (!response.ok) return null;
  const data: unknown = await response.json();
  return Array.isArray(data) ? data as CloudAdventure[] : null;
} catch {
  // Remote discovery is optional; never block a new or locally saved game.
  return null;
}
}

type Pending = {saves:CloudAdventure[]; since:number; timer?:ReturnType<typeof setTimeout>; attempts:number; saved?:()=>void};
const pending = new Map<string,Pending>();
function schedule(vault:string,delay:number) {const p=pending.get(vault)!;clearTimeout(p.timer);p.timer=setTimeout(()=>{
  const copy=p.saves;
  void publishCloud(copy,vault).then(()=>{if(p.saves===copy){pending.delete(vault);p.saved?.();}else {p.since=Date.now();schedule(vault,5000);}},()=>{p.attempts++;schedule(vault,Math.min(60000,1000*2**Math.min(p.attempts,6)));});
},delay);}
export function queueCloud(saves:CloudAdventure[],vault=playerId(),saved?:()=>void) {
  const p=pending.get(vault)??{saves:[],since:Date.now(),attempts:0};p.saves=structuredClone(saves);pending.set(vault,p);if(saved){p.saved=saved;schedule(vault,0);return;}
  if(!p.attempts)schedule(vault,Math.max(0,Math.min(5000,p.since+30000-Date.now())));
}
window.addEventListener('online',()=>{for(const vault of pending.keys())schedule(vault,0);});

let publication: Promise<void> = Promise.resolve();
const published = new Map<string, string>();
const publishedRuns=new Map<string,string>();
export function publishCloud(saves: CloudAdventure[], vault = playerId()) {
  const copy = structuredClone(saves);
  const next = publication.then(() => writeCloud(copy, vault));
  publication = next.catch(() => {});
  return next;
}
async function writeCloud(saves: CloudAdventure[], vault: string) {
  const serialized = JSON.stringify(saves);
  if (published.get(vault) === serialized) return;
  const headers = { "content-type": "application/json" };
  // Both endpoints accept bounded additive batches; a long adventure history
  // cannot reject publication of the newest run.
  const batches:CloudAdventure[][]=[];let batch:CloudAdventure[]=[];
  for(const save of saves){
    if(publishedRuns.get(vault+":"+save.id)===JSON.stringify(save))continue;
    if(batch.length && (batch.length>=50 || new TextEncoder().encode(JSON.stringify([...batch,save])).length>60000)){batches.push(batch);batch=[];}
    batch.push(save);
  }
  if(batch.length)batches.push(batch);
  for(const runs of batches) {
    const responses=await Promise.all([
      fetch(`/api/vaults/${vault}/adventures`,{method:'PUT',headers,body:JSON.stringify(runs),signal:AbortSignal.timeout(10000)}),
      fetch('/api/runs',{method:'POST',headers,body:JSON.stringify({runs:runs.map(save=>{const {pending:_pending,...meta}=save as CloudAdventure & {pending?:unknown};return meta;})}),signal:AbortSignal.timeout(10000)}),
    ]);
    if(responses.some(r=>!r.ok))throw Error('Cloud adventure metadata was not saved.');
    for(const run of runs)publishedRuns.set(vault+':'+run.id,JSON.stringify(run));
  }
  published.set(vault,serialized);
}
