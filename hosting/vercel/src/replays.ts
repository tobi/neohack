import {markRecorded} from './ledger-store.ts';
import { createHash } from 'node:crypto';
import { read, update, immutable, storage, type Storage } from './storage.ts';

const availability = new WeakMap<Storage, {expires:number; ids:Promise<Set<string>>}>();
/** Only committed public recordings count; private account recordings stay private. */
export async function publicReplayIds() {
  const backend=storage(), cached=availability.get(backend);
  if(cached && cached.expires>Date.now())return cached.ids;
  const ids=backend.list('replays/').then(paths=>new Set(paths.flatMap(path=>{
    const match=path.match(/^replays\/([\w-]{1,64})\.json$/);return match?[match[1]]:[];
  })));
  const entry={expires:Date.now()+60000,ids};availability.set(backend,entry);
  try{return await ids;}catch(error){if(availability.get(backend)===entry)availability.delete(backend);throw error;}
}

/** Public presentation recordings are separate from private resumable journals. */
export async function replay(request: Request, id: string) {
  const json = (body:unknown,status=200) => Response.json(body,{status,headers:{'cache-control':'no-store','access-control-allow-origin':'*'}});
  const key='replays/'+id+'.json';
  if(request.method==='GET') {
    const doc=await read(key);
    if(!doc)return json({error:'No public replay recorded'},404);
    const offset=Number(new URL(request.url).searchParams.get('offset')??0);
    if(!Number.isSafeInteger(offset)||offset<0)return json({error:'Invalid offset'},400);
    const frames=await Promise.all(doc.frames.slice(offset,offset+25).map((ref:string)=>read(ref)));
    if(frames.some(f=>!f))return json({error:'Recording incomplete'},409);
    return json({count:doc.frames.length,revision:doc.revision,frames,next:offset+frames.length<doc.frames.length?offset+frames.length:null,role:doc.role,seed:doc.seed,partial:doc.partial,complete:doc.complete===true&&!doc.partial,buildId:doc.buildId});
  }
  if(request.method!=='PUT')return json({error:'Method not allowed'},405);
  const origin=request.headers.get('origin');
  if(origin && origin!==new URL(request.url).origin)return json({error:'Origin differs'},403);
  const vault=request.headers.get('authorization')?.replace(/^Bearer /,'');
  if(!vault || !/^[0-9a-f-]{36}$/i.test(vault))return json({error:'Vault required'},401);
  const adventures=await read('vaults/'+vault+'/adventures.json');
  const run=adventures?.values?.find((r:any)=>r.id===id);
  if(!run)return json({error:'Run does not belong to this vault'},403);
  if(typeof run.buildId!=='string' || !/^[a-f0-9]{64}$/.test(run.buildId))return json({error:'Run package is not recorded'},400);
  const raw=await request.text();if(raw.length>1000000)return json({error:'Frame too large'},413);
  let body:any;try{body=JSON.parse(raw);}catch{return json({error:'Invalid JSON'},400);}
  const f=body?.frame;
  if(!f || f.version!==1 || f.sessionId!==id || !Number.isSafeInteger(f.revision) || f.revision<0 || !f.outcome || !Array.isArray(f.events) || typeof f.ended!=='boolean' || !Array.isArray(f.observation?.inventory) || !Number.isFinite(f.observation?.turn) || !Array.isArray(f.observation?.world) || f.observation.world.length>10000 || !Array.isArray(f.observation.heard) || !f.observation.vitals || typeof f.observation.location?.depthLabel!=='string' || !Number.isInteger(body.index)||body.index<0||body.index>=100000)return json({error:'Invalid frame'},400);
  // Explicit allowlist: no storage descriptors, save capabilities, receipts or journals.
  const observation={...f.observation};delete observation.neighborhood;
  const frame={version:1,sessionId:id,requestId:f.requestId,revision:f.revision,ended:f.ended,observation,outcome:f.outcome,events:f.events,decision:f.decision,end:f.end};
  const owner=createHash('sha256').update(vault).digest('hex');
  const frameRef='objects/'+createHash('sha256').update(JSON.stringify(frame)).digest('hex')+'.json';
  const result=await update<any,Response>(key,()=>({owner,frames:[],revision:-1,role:run.role,seed:run.seed,buildId:run.buildId,partial:f.observation.turn>1}),async doc=>{
    if(doc.owner!==owner)return json({error:'Recording owner differs'},403);
    if(doc.buildId!==run.buildId)return json({error:'Recording package differs'},409);
    if(body.index<doc.frames.length && doc.frames[body.index]===frameRef){if(!(await read(frameRef)))return json({error:'Recorded frame missing'},409);return json({count:doc.frames.length});}
    if(body.index!==doc.frames.length || f.revision<=doc.revision)return json({error:'Recording sequence differs'},409);
    doc.frames.push(await immutable(frame));doc.revision=f.revision;doc.complete=f.ended;
    return json({count:doc.frames.length});
  });
  if(result.ok && body.index===0){availability.delete(storage());await markRecorded(id);}
  return result;
}
