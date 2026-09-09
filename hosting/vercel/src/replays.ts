import {replayFrames} from './replay-frames.ts';
import {publishReplay} from './publish-replay.ts';
import {publicReplayConfigured} from './public-replay-store.ts';
import {markRecorded} from './ledger-store.ts';
import { createHash } from 'node:crypto';
import { read, update, immutable } from './storage.ts';

// Publication fields are allowlisted here; importing engine source types would
// make the independently deployed Vercel function depend on the library tree.
function recordingFrame(f:any,id:string) {
  return {version:1 as const,sessionId:id,requestId:f.requestId,revision:f.revision,ended:f.ended,observation:f.observation,outcome:f.outcome,events:f.events,decision:f.decision,end:f.end};
}

/** Public presentation recordings are separate from private resumable journals. */
export async function replay(request: Request, id: string) {
  const json = (body:unknown,status=200) => Response.json(body,{status,headers:{'cache-control':'no-store','access-control-allow-origin':'*'}});
  const key='replays/'+id+'.json';
  if(request.method==='GET') {
    const params=new URL(request.url).searchParams;
    if(params.get('publication')==='1') {
      const doc=await read(key);
      if(!doc)return json({error:'No public replay recorded'},404);
      const token=request.headers.get('authorization')?.replace(/^Bearer /,'');
      if(!token||createHash('sha256').update(token).digest('hex')!==doc.owner)return json({error:'Recording owner differs'},403);
      await publishReplay(id);
      return json({count:doc.frames.length,revision:doc.revision});
    }
    const origin=process.env.PUBLIC_REPLAY_ORIGIN || (publicReplayConfigured() ? new URL('/replay-files/', request.url).href : '');
    if(!origin)return json({error:'Public replay delivery is unavailable'},503);
    const location=new URL('replays/'+id+'/manifest.json', origin.endsWith('/')?origin:origin+'/');
    return new Response(null,{status:302,headers:{Location:location.href,'cache-control':'no-cache','access-control-allow-origin':'*'}});
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
  if(!publicReplayConfigured())return json({error:'Public replay publication unavailable'},503);
  const raw=await request.text();if(Buffer.byteLength(raw)>2000000)return json({error:'Recording batch too large'},413);
  let body:any;try{body=JSON.parse(raw);}catch{return json({error:'Invalid JSON'},400);}
  // Already-published clients send one frame; current clients send exact batches.
  if(body?.frame && body.frames===undefined)body.frames=[body.frame];
  if(!Array.isArray(body?.frames)||!body.frames.length||body.frames.length>128||!Number.isInteger(body.index)||body.index<0||body.index+body.frames.length>100000)return json({error:'Invalid recording batch'},400);
  const frames:Array<ReturnType<typeof recordingFrame>>=[],publishedRefs:string[]=[];
  for(const f of body.frames){
    if(!f || f.version!==1 || f.sessionId!==id || !Number.isSafeInteger(f.revision) || f.revision<0 || !f.outcome || !Array.isArray(f.events) || typeof f.ended!=='boolean' || !Array.isArray(f.observation?.inventory) || !Number.isFinite(f.observation?.turn) || !Array.isArray(f.observation?.world) || f.observation.world.length>10000 || !Array.isArray(f.observation.heard) || !f.observation.vitals || typeof f.observation.location?.depthLabel!=='string')return json({error:'Invalid frame'},400);
    // Explicit allowlist: private journals/capabilities never enter public frames.
    const frame=recordingFrame(f,id);
    // A lost acknowledgement from a published writer may refer to the original
    // full observation. Accept those exact committed bytes without rewriting it.
    publishedRefs.push('objects/'+createHash('sha256').update(JSON.stringify(frame)).digest('hex')+'.json');
    const observation={...f.observation};delete observation.neighborhood;
    frames.push({...frame,observation});
  }
  if(frames.some((f,i)=>i>0&&f.revision<=frames[i-1].revision))return json({error:'Recording revisions must increase'},400);
  const owner=createHash('sha256').update(vault).digest('hex');
  const refs=frames.map(frame=>'objects/'+createHash('sha256').update(JSON.stringify(frame)).digest('hex')+'.json');
  const result=await update<any,Response>(key,()=>({owner,frames:[],batches:[],revision:-1,role:run.role,seed:run.seed,buildId:run.buildId,partial:frames[0].observation.turn>1}),async doc=>{
    if(doc.owner!==owner)return json({error:'Recording owner differs'},403);
    if(doc.buildId!==run.buildId)return json({error:'Recording package differs'},409);
    if(body.index<doc.frames.length){
      if(!refs.every((ref,i)=>doc.frames[body.index+i]===ref || doc.frames[body.index+i]===publishedRefs[i]))return json({error:'Recording sequence differs'},409);
      await replayFrames(doc,body.index,refs.length);
      return json({count:doc.frames.length,acknowledged:body.index+refs.length});
    }
    if(body.index!==doc.frames.length||frames[0].revision<=doc.revision)return json({error:'Recording sequence differs'},409);
    doc.batches??=[];
    const tail=doc.batches.at(-1);let combined=frames,start=body.index;
    if(tail&&tail.count+frames.length<=128){
      const previous=await read(tail.ref);
      if(!previous?.frames)throw Error('Public recording incomplete');
      const candidate=[...previous.frames,...frames];
      if(Buffer.byteLength(JSON.stringify(candidate))<=256*1024){combined=candidate;start=tail.start;doc.batches.pop();}
    }
    const ref=await immutable({frames:combined});
    doc.batches.push({start,count:combined.length,ref});
    doc.frames.push(...refs);doc.revision=frames.at(-1)!.revision;doc.complete=frames.at(-1)!.ended;
    return json({count:doc.frames.length,acknowledged:doc.frames.length});
  });
  if(result.ok)await publishReplay(id);
  if(result.ok && body.index===0)await markRecorded(id);
  return result;
}
