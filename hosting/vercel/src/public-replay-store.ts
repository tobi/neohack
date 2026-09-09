import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {get,put,head,BlobNotFoundError,BlobPreconditionFailedError} from '@vercel/blob';
import {Conflict,type Storage} from './storage.ts';
export const publicReplayContext=new AsyncLocalStorage<Storage>();
export const publicReplayConfigured=()=>!!publicReplayContext.getStore() || (!!process.env.PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN && !!process.env.PUBLIC_REPLAY_ORIGIN);
/** Content-addressed compressed input chunks. Repeated writes of the same hash
 * are harmless; publication never needs to download older run chunks. */
export async function writeReplayBytes(path:string,bytes:Uint8Array) {
 const injected=publicReplayContext.getStore();
 if(injected){try{await injected.write(path,bytes);}catch(e){if(!(e instanceof Conflict))throw e;const old=(await injected.read(path))?.value;if(!(old instanceof Uint8Array)||!Buffer.from(old).equals(Buffer.from(bytes)))throw Error('Immutable replay object differs');}return;}
 if(!publicReplayConfigured())throw Error('Replay store is not configured');
 try{await put(path,Buffer.from(bytes),{access:'public',token:process.env.PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN!,
  addRandomSuffix:false,allowOverwrite:false,contentType:'application/gzip',cacheControlMaxAge:31536000});}
 catch(e){
  // The path is the SHA-256 of these bytes. An existing object is an exact
  // retry; all other storage errors remain failures and receive no cursor ack.
  const existing=await get(path,{access:'public',token:process.env.PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN!,useCache:false});
  if(!existing?.stream)throw e;
  const reader=existing.stream.getReader(),hash=createHash('sha256');let length=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>bytes.length)throw Error('Immutable replay object differs');hash.update(value);}}
  finally{await reader.cancel();}
  if(length!==bytes.length||hash.digest('hex')!==createHash('sha256').update(bytes).digest('hex'))throw Error('Immutable replay object differs');
 }
}
// A separate PUBLIC store. Never fall back to the private save-store token.
export function publicReplayStorage(): Storage {
 const injected=publicReplayContext.getStore();if(injected)return injected;
 if(!publicReplayConfigured())throw Error('Public replay store is not configured');
 const token=process.env.PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN!;
 return {
  // Public get() ignores useCache:false. Fetch CAS metadata through the Blob
  // management API so a cached manifest cannot stall publication for a minute.
  async head(path){try{const result=await head(path,{token});if(!result.etag)throw Error('Public replay has no revision token');return {etag:result.etag};}catch(e){if(e instanceof BlobNotFoundError)return null;throw e;}},
  // A public read goes through the CDN, which can keep a not-found answer for
  // a while after the object is written (a chronicle is read while it is still
  // being told, then stored). On a miss, ask the management API; when the object
  // exists, read it under a revision-specific query so no stale entry applies.
  async read(path){
   const decode=async(result:Awaited<ReturnType<typeof get>>)=>{if(!result)return null;if(result.statusCode!==200||!result.stream||!result.blob.etag)throw Error('Cannot read public replay');return {value:await new Response(result.stream).json(),etag:result.blob.etag};};
   const missing=(e:unknown)=>{if(e instanceof BlobNotFoundError)return null;throw e;};
   const cached=await get(path,{access:'public',token,useCache:false}).catch(missing);
   if(cached)return decode(cached);
   const meta=await head(path,{token}).catch(missing);
   if(!meta?.etag)return null;
   const url=new URL(meta.url);url.searchParams.set('v',meta.etag.replace(/"/g,''));
   return decode(await get(url.href,{access:'public',token}).catch(missing));
  },
  async write(path,value,etag){try{await put(path,JSON.stringify(value),{access:'public',token,addRandomSuffix:false,allowOverwrite:!!etag,...(etag?{ifMatch:etag}:{}),contentType:'application/json',cacheControlMaxAge:path.endsWith('/manifest.json')?60:31536000});}catch(e){if(e instanceof BlobPreconditionFailedError)throw new Conflict();if(!etag){const existing=await get(path,{access:'public',token,useCache:false});if(existing){await existing.stream?.cancel();throw new Conflict();}}throw e;}},
  async list(){throw Error('Public replay listing is not supported');},
 };
}
