import {createHash} from 'node:crypto';
import {read,Conflict} from './storage.ts';
import {publicReplayStorage} from './public-replay-store.ts';
import {replayFrames} from './replay-frames.ts';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Publication runs only after an authenticated recording commit, never on playback.
export async function publishReplay(id:string) {
 if(!/^[\w-]{1,64}$/.test(id))throw Error('Invalid public run');
 const store=publicReplayStorage(), manifestPath='replays/'+id+'/manifest.json';
 const sourceCache=new Map<string,Promise<any>>();
 for(let attempt=0;attempt<8;attempt++) {
  const revision=store.head?await store.head(manifestPath):await store.read(manifestPath);
  const doc=await read('replays/'+id+'.json');if(!doc)return;
  const current=await store.read(manifestPath);
  if(current?.etag===revision?.etag && current && current.value.count>=doc.frames.length)return;
  const chunks:string[]=[];
  for(let offset=0;offset<doc.frames.length;) {
   const target=offset===0?3:25, remaining=doc.frames.length-offset;
   // Publish a partial tail as single immutable frames. Consolidate it once
   // full, avoiding rereading/reuploading a growing 25-frame tail every turn.
   const refs=doc.frames.slice(offset,offset+(remaining>=target?target:1));
   const key=hash({version:1,id,offset,refs}), name='chunks/'+key+'.json';
   chunks.push(name);
   // Completed chunks never change. Only a growing tail needs republishing.
   if(!current?.value.chunks?.includes(name)) {
    const frames=await replayFrames(doc,offset,refs.length,sourceCache);
    if(frames.some(f=>!f))throw Error('Public recording incomplete');
    const path='replays/'+id+'/'+name;
    if(!(await store.read(path)))try{await store.write(path,{frames});}catch(e){if(!(e instanceof Conflict))throw e;}
   }
   offset+=refs.length;
  }
  const manifest={version:1,count:doc.frames.length,chunks,role:doc.role,seed:doc.seed,partial:doc.partial,complete:doc.complete===true&&!doc.partial};
  try {await store.write(manifestPath,manifest,revision?.etag);return;}catch(e){if(!(e instanceof Conflict))throw e;}
 }
 throw new Conflict();
}
