import {AsyncLocalStorage} from 'node:async_hooks';
import {get,put,BlobNotFoundError,BlobPreconditionFailedError} from '@vercel/blob';
import {Conflict,type Storage} from './storage.ts';
export const publicReplayContext=new AsyncLocalStorage<Storage>();
export const publicReplayConfigured=()=>!!publicReplayContext.getStore() || (!!process.env.PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN && !!process.env.PUBLIC_REPLAY_ORIGIN);
// A separate PUBLIC store. Never fall back to the private save-store token.
export function publicReplayStorage(): Storage {
 const injected=publicReplayContext.getStore();if(injected)return injected;
 if(!publicReplayConfigured())throw Error('Public replay store is not configured');
 const token=process.env.PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN!;
 return {
  async read(path){try{const result=await get(path,{access:'public',token,useCache:false});if(!result)return null;if(result.statusCode!==200||!result.stream||!result.blob.etag)throw Error('Cannot read public replay');return {value:await new Response(result.stream).json(),etag:result.blob.etag};}catch(e){if(e instanceof BlobNotFoundError)return null;throw e;}},
  async write(path,value,etag){try{await put(path,JSON.stringify(value),{access:'public',token,addRandomSuffix:false,allowOverwrite:!!etag,...(etag?{ifMatch:etag}:{}),contentType:'application/json',cacheControlMaxAge:path.endsWith('/manifest.json')?60:31536000});}catch(e){if(e instanceof BlobPreconditionFailedError)throw new Conflict();if(!etag){const existing=await get(path,{access:'public',token,useCache:false});if(existing){await existing.stream?.cancel();throw new Conflict();}}throw e;}},
  async list(){throw Error('Public replay listing is not supported');},
 };
}
