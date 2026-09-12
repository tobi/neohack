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
  url.hash = new URLSearchParams({ run: id, vault }).toString();
  history.replaceState(null, "", url);
}
export function clearRunUrl() {
  const url = new URL(location.href); url.hash = "";
  history.replaceState(null, "", url);
}


export type PlayControl = "manual" | "webmcp" | "bot" | "script" | "playground";
export type CloudAdventure = {
  recording?:'inputs';
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
  webmcpAutomated?: boolean;
  harness_name?: string;
  model_name?: string;
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

type Pending = {saves:CloudAdventure[]; since:number; timer?:ReturnType<typeof setTimeout>; attempts:number; flight?:boolean; saved?:()=>void};
const pending = new Map<string,Pending>();
function schedule(vault:string,delay:number) {
  const p=pending.get(vault)!;clearTimeout(p.timer);if(p.flight)return;
  p.timer=setTimeout(()=>{
    p.flight=true;const copy=p.saves;
    void enqueuePublication(copy,vault).then(()=>{
      p.flight=false;p.attempts=0;
      if(p.saves===copy){pending.delete(vault);p.saved?.();}
      else {p.since=Date.now();schedule(vault,5000);}
    },()=>{p.flight=false;p.attempts++;schedule(vault,Math.min(60000,1000*2**Math.min(p.attempts,6)));});
  },delay);
}
export function queueCloud(saves:CloudAdventure[],vault=playerId(),saved?:()=>void) {
  rememberMetadata(saves,vault);
  const p=pending.get(vault)??{saves:[],since:Date.now(),attempts:0};
  const updates=new Map(p.saves.map(save=>[save.id,save]));
  for(const save of structuredClone(saves))updates.set(save.id,save);
  p.saves=[...updates.values()];pending.set(vault,p);if(saved){p.saved=saved;schedule(vault,0);return;}
  if(!p.attempts)schedule(vault,Math.max(0,Math.min(5000,p.since+30000-Date.now())));
}
window.addEventListener('online',()=>{for(const vault of pending.keys())schedule(vault,0);});

let publication: Promise<void> = Promise.resolve();
const published = new Map<string, string>();
const publishedRuns=new Map<string,string>();
const latestRuns=new Map<string,CloudAdventure>();
const directoryRuns=new Map<string,string>();
const directoryFlights=new Map<string,Promise<void>>();
function rememberMetadata(saves:CloudAdventure[],vault:string) {
  for(const save of structuredClone(saves)) {
    const {localStore:_store,savedAt:_time,...metadata}=save as CloudAdventure & {localStore?:string;savedAt?:number};
    const key=vault+':'+save.id, old=latestRuns.get(key);
    if(!old || ((!old.ended || metadata.ended) && metadata.turn>=old.turn))latestRuns.set(key,metadata);
  }
}
// Registration and debounced metadata share the same directory writer. Select
// the latest per-run value when work starts, not the snapshot that queued it.
function writeDirectory(ids:string[],vault:string,signal?:AbortSignal) {
  const next=(directoryFlights.get(vault)??Promise.resolve()).then(async()=>{
    signal?.throwIfAborted();
    const runs=ids.map(id=>latestRuns.get(vault+':'+id)!).filter(run=>directoryRuns.get(vault+':'+run.id)!==JSON.stringify(run));
    if(!runs.length)return;
    const response=await fetch(`/api/vaults/${vault}/adventures`,{
      method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(runs),
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),
    });
    if(!response.ok)throw Error('Cloud adventure registration was not saved.');
    for(const run of runs)directoryRuns.set(vault+':'+run.id,JSON.stringify(run));
  });
  const settled=next.catch(()=>{});
  directoryFlights.set(vault,settled);
  void settled.then(()=>{if(directoryFlights.get(vault)===settled)directoryFlights.delete(vault);});
  return next;
}
/** Only the vault directory is an upload prerequisite; ledger availability is not. */
export function registerCloudRun(save:CloudAdventure,vault:string,signal:AbortSignal) {
  rememberMetadata([save],vault);
  return writeDirectory([save.id],vault,signal);
}
export function publishCloud(saves: CloudAdventure[], vault = playerId()) {
  rememberMetadata(saves,vault);
  return enqueuePublication(saves,vault);
}
function enqueuePublication(saves:CloudAdventure[],vault:string) {
  const ids=saves.map(save=>save.id);
  const next = publication.then(() => writeCloud(ids.map(id=>latestRuns.get(vault+':'+id)!), vault));
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
    // The ledger publishes only runs this vault has registered, so the
    // directory write must land before the metadata upload.
    await writeDirectory(runs.map(run=>run.id),vault);
    const response=await fetch('/api/runs',{method:'POST',headers,body:JSON.stringify({vault,runs:runs.map(save=>{const {pending:_pending,...meta}=save as CloudAdventure & {pending?:unknown};return meta;})}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error('Cloud adventure metadata was not saved.');
    for(const run of runs)publishedRuns.set(vault+':'+run.id,JSON.stringify(run));
  }
  published.set(vault,serialized);
}
