import type {Snapshot} from 'neonethack/types';
export type ReplayBatch = {index:number; frames:Snapshot[]};
type Queue = {version:3; index:number|null; bytes:number; count:number; lastRevision:number};
const size=(frame:Snapshot)=>new TextEncoder().encode(JSON.stringify(frame)).length;
const request=<T>(r:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const range=(key:string)=>IDBKeyRange.bound([key,0],[key,Number.MAX_SAFE_INTEGER]);

/** Keep the published database version and stores. Upload batches live separately
 * from the small head read during a turn; no pending frame payload enters it. */
async function transaction<T>(key:string,change:(q:Queue,frames:IDBObjectStore,uploads:IDBObjectStore)=>Promise<T>|T):Promise<T>{
  const opening=indexedDB.open('neohack-public-recordings-v1',2);
  opening.onupgradeneeded=()=>{for(const name of ['queues','frames','heads'])if(!opening.result.objectStoreNames.contains(name))opening.result.createObjectStore(name);};
  const db=await request(opening);
  try{return await new Promise<T>((resolve,reject)=>{
    const tx=db.transaction(['queues','frames','heads'],'readwrite',{durability:'strict'});
    const queues=tx.objectStore('queues'),frames=tx.objectStore('frames'),heads=tx.objectStore('heads');let result:T;
    tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error??Error('Recording storage interrupted'));
    void(async()=>{
      let q=await request(heads.get(key));
      if(q?.version!==3){
        // One-time recovery of already-published layouts, never a per-turn scan.
        const old=await request(queues.get(key));
        for(const frame of old?.frames??[])if(await request(frames.getKey([key,frame.revision]))===undefined)frames.add(frame,[key,frame.revision]);
        q={version:3,index:q?.index??old?.index??null,bytes:0,count:0,lastRevision:-1};
        await new Promise<void>((done,fail)=>{
          const cursor=frames.openCursor(range(key));cursor.onerror=()=>fail(cursor.error);
          cursor.onsuccess=()=>{const c=cursor.result;if(!c){done();return;}q.bytes+=size(c.value);q.count++;q.lastRevision=Math.max(q.lastRevision,c.value.revision);c.continue();};
        });
        queues.delete(key);
      }
      result=await change(q,frames,queues);heads.put(q,key);
    })().catch(error=>{tx.abort();reject(error);});
  });}finally{db.close();}
}
export function appendReplay(key:string,frame:Snapshot){return transaction(key,async(q,frames)=>{
  if(frame.revision<=q.lastRevision||await request(frames.getKey([key,frame.revision]))!==undefined)return;
  frames.add(frame,[key,frame.revision]);q.lastRevision=frame.revision;q.bytes+=size(frame);q.count++;
});}
export function replayQueue(key:string){return transaction(key,q=>({index:q.index,count:q.count,bytes:q.bytes}));}
export function reconcileReplay(key:string,index:number,revision:number){return transaction(key,async(q,frames)=>{
  if(q.index!==null)return;
  await new Promise<void>((resolve,reject)=>{
    const cursor=frames.openCursor(IDBKeyRange.bound([key,0],[key,Math.max(0,revision)]));cursor.onerror=()=>reject(cursor.error);
    cursor.onsuccess=()=>{const c=cursor.result;if(!c){resolve();return;}if(c.value.revision<=revision){q.count--;q.bytes-=size(c.value);c.delete();}c.continue();};
  });
  q.index=index;q.lastRevision=Math.max(q.lastRevision,revision);
});}
export function nextReplayBatch(key:string){return transaction(key,async(q,frames,uploads)=>{
  const pending=await request(uploads.get('pending:'+key));if(pending)return pending as ReplayBatch;
  if(q.index===null||!q.count)return null;
  const selected:Snapshot[]=[];let bytes=0;
  await new Promise<void>((resolve,reject)=>{
    const cursor=frames.openCursor(range(key));cursor.onerror=()=>reject(cursor.error);
    cursor.onsuccess=()=>{const c=cursor.result;if(!c){resolve();return;}const n=size(c.value);
      if(selected.length&&(selected.length>=128||bytes+n>1500000)){resolve();return;}
      if(n>1900000){reject(Error('Recorded frame exceeds upload limit'));return;}
      selected.push(c.value);bytes+=n;c.continue();};
  });
  if(!selected.length)throw Error('Recording queue is incomplete');
  const batch={index:q.index,frames:selected};uploads.put(batch,'pending:'+key);return batch;
});}
export function acknowledgeReplay(key:string,batch:ReplayBatch,acknowledged:number){return transaction(key,async(q,frames,uploads)=>{
  const pending=await request(uploads.get('pending:'+key));
  if(!pending||pending.index!==batch.index||JSON.stringify(pending.frames)!==JSON.stringify(batch.frames)||acknowledged!==batch.index+batch.frames.length)throw Error('Recording acknowledgement differs');
  for(const frame of batch.frames){frames.delete([key,frame.revision]);q.count--;q.bytes-=size(frame);}
  q.index=acknowledged;uploads.delete('pending:'+key);
});}
