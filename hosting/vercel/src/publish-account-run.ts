import {read,update,immutable} from './storage.ts';
import {publishReplay} from './publish-replay.ts';
import {saveLedgerRun,markRecorded} from './ledger-store.ts';

/** An owner-selected recording becomes a separate public replay, never a save. */
export async function publishAccountRun(key:string) {
 const source=await read(key);if(!source?.run||!source.publicId)return;
 const id=source.publicId,owner='account:'+key,run=source.run;
 await update<any,void>('replays/'+id+'.json',()=>({owner,frames:[],revision:-1,role:run.role,seed:run.seed,buildId:run.buildId,partial:run.partial}),async doc=>{
  if(doc.owner!==owner)throw Error('Public recording owner differs');
  for(let i=doc.frames.length;i<source.frames.length;i++) {
   const f=await read(source.frames[i]);if(!f)throw Error('Recording incomplete');
   const observation={...f.observation};delete observation.neighborhood;
   // Never copy source artifacts, notes, account metadata, receipts or storage.
   const frame={version:1,sessionId:id,requestId:f.requestId,revision:f.revision,ended:!!f.ended,observation,outcome:f.outcome,events:f.events,decision:f.decision,end:f.end};
   doc.frames.push(await immutable(frame));doc.revision=f.revision;doc.complete=!!f.ended;
  }
 });
 await publishReplay(id);
 await saveLedgerRun({id,name:run.name,role:run.role,turn:run.turn,ended:run.ended,maxLevel:run.maxLevel,heroLevel:run.level,depthLabel:run.depth,endKind:run.ended?run.outcome:undefined,control:run.control==='bot'?'bot':'manual',automated:!!run.automated,buildId:run.buildId,seed:run.seed,updatedAt:Date.now()});
 if(source.frames.length)await markRecorded(id);
 await update<any,void>(key,()=>{throw Error('Recording disappeared');},doc=>{
  if(doc.publicId!==id)throw Error('Public recording identity differs');
  doc.run.publishedCount=Math.max(doc.run.publishedCount??0,source.frames.length);
 });
}
