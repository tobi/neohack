import {read} from './storage.ts';
import {createHash} from 'node:crypto';
/** Read only explicitly public recording sources. Older published prefixes keep
 * their original object references; new uploads store a whole batch together. */
export async function replayFrames(doc:any,start:number,count:number,cache=new Map<string,Promise<any>>()) {
 const load=(path:string)=>{let value=cache.get(path);if(!value){value=read(path);cache.set(path,value);}return value;};
 return Promise.all(doc.frames.slice(start,start+count).map(async(ref:string,offset:number)=>{
  const index=start+offset;
  const batch=doc.batches?.find((b:any)=>index>=b.start&&index<b.start+b.count);
  const frame=batch?(await load(batch.ref))?.frames?.[index-batch.start]:await load(ref);
  if(!frame)throw Error('Public recording incomplete');
  if('objects/'+createHash('sha256').update(JSON.stringify(frame)).digest('hex')+'.json'!==ref)throw Error('Public recording frame differs');
  return frame;
 }));
}
