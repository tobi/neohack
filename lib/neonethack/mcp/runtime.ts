import {mkdir,readFile,rename,rm,open} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {WasmTransport} from '../typescript/wasm.js';
import type {Request,Response} from '../typescript/types.js';
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const idPattern=/^[A-Za-z0-9_-]{16}$/;
const hashPattern=/^[a-f0-9]{64}$/;
async function durable(path:string,bytes:Uint8Array|string){const f=await open(path,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}
async function syncDir(path:string){const f=await open(path,'r');try{await f.sync();}finally{await f.close();}}
/** One worker/SQLite journal per run. Every worker executes the shipped C WASM;
 * this router only owns filesystem names and exact runtime packages. */
export class McpRuntime {
  private workers=new Map<string,Promise<WasmTransport>>();
  private pins=new Map<string,Promise<string>>();
  private closing=false;
  constructor(readonly sessionsPath:string,readonly runtimePath=resolve(import.meta.dirname,'../wasm')){}
  private async pin(source:string):Promise<string>{
    const raw=await readFile(join(source,'manifest.json'),'utf8');
    const m=JSON.parse(raw);
    if(m.version!==1||!hashPattern.test(m.buildId)||sha(JSON.stringify(m.files))!==m.buildId)throw Error('Invalid runtime identity');
    if(!m.files||!Object.keys(m.files).every(n=>/^[a-z0-9-]+\.(mjs|wasm|data)$/.test(n))||!Object.values(m.files).every(h=>typeof h==='string'&&hashPattern.test(h)))throw Error('Invalid runtime files');
    let pending=this.pins.get(m.buildId);
    if(!pending){pending=(async()=>{
      const base=join(this.sessionsPath,'runtimes'),target=join(base,m.buildId),temp=join(base,'.'+randomUUID());
      await mkdir(temp,{recursive:true,mode:0o700});
      try{
        for(const [name,hash] of Object.entries(m.files)){
          const data=await readFile(join(source,name));if(sha(data)!==hash)throw Error('Runtime checksum mismatch: '+name);
          await durable(join(temp,name),data);
        }
        for(const name of ['NETHACK-LICENSE.txt','LUA-LICENSE.txt','EMSCRIPTEN-LICENSE.txt','MUSL-COPYRIGHT.txt','COMPILER-RT-LICENSE.txt','LLVM-LIBC-LICENSE.txt'])await durable(join(temp,name),await readFile(join(source,name)));
        await durable(join(temp,'manifest.json'),raw);await syncDir(temp);
        try{await rename(temp,target);await syncDir(base);}catch(e){if(!['EEXIST','ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code??''))throw e;}
        await this.verifyPin(target,m.buildId);return m.buildId;
      }finally{await rm(temp,{recursive:true,force:true});}
    })();this.pins.set(m.buildId,pending);}
    return pending;
  }
  private async verifyPin(path:string,buildId:string){
    const m=JSON.parse(await readFile(join(path,'manifest.json'),'utf8'));
    if(m.version!==1||m.buildId!==buildId||sha(JSON.stringify(m.files))!==buildId)throw Error('Stored runtime identity mismatch');
    for(const [name,hash] of Object.entries(m.files)){
      if(!/^[a-z0-9-]+\.(mjs|wasm|data)$/.test(name)||sha(await readFile(join(path,name)))!==hash)throw Error('Stored runtime checksum mismatch');
    }
  }
  private async start(id:string,buildId:string){
    const runtime=join(this.sessionsPath,'runtimes',buildId);
    await this.verifyPin(runtime,buildId);
    // Use the pinned worker plumbing as well as pinned compiled engine/data.
    return WasmTransport.create({workerUrl:pathToFileURL(join(runtime,'core-worker.mjs')),
      runtimeUrl:pathToFileURL(runtime+'/').href,
      storage:{kind:'filesystem',path:join(this.sessionsPath,'runs',id,'journal.sqlite'),sessionId:id},
      onDiagnostic:message=>console.error('[wasm] '+message)});
  }
  async send(request:Request):Promise<Response>{
    if(this.closing)throw Error('MCP runtime is closing');
    let id='sessionId' in request.params?request.params.sessionId:undefined;
    if(request.method==='session.create'){
      const buildId=await this.pin(this.runtimePath);id=randomBytes(12).toString('base64url');
      const directory=join(this.sessionsPath,'runs',id);
      await mkdir(directory,{recursive:true,mode:0o700});
      await durable(join(directory,'runtime.json'),JSON.stringify({version:1,buildId}));await syncDir(directory);await syncDir(join(this.sessionsPath,'runs'));
      this.workers.set(id,this.start(id,buildId));
    }
    if(!id||!idPattern.test(id))return {version:1,error:{code:'invalidSession',message:'Use the returned 16-character sessionId.'}} as Response;
    if(!this.workers.has(id)){
      if(request.method!=='session.resume')return {version:1,error:{code:'sessionNotLoaded',message:'Resume this session before querying or acting.'}} as Response;
      const pending=(async()=>{
        const saved=JSON.parse(await readFile(join(this.sessionsPath,'runs',id!,'runtime.json'),'utf8'));
        if(saved.version!==1||!hashPattern.test(saved.buildId))throw Error('Invalid stored runtime pin');
        return this.start(id!,saved.buildId);
      })();this.workers.set(id,pending);
      pending.catch(()=>{if(this.workers.get(id!)===pending)this.workers.delete(id!);});
    }
    const worker=await this.workers.get(id)!;
    const response=await worker.send(request);
    if(request.method==='session.close'&&!('error' in response)){
      await worker.close();this.workers.delete(id);
    }
    return response;
  }
  async close(){this.closing=true;await Promise.allSettled([...this.workers.values()].map(async w=>(await w).close()));this.workers.clear();}
}
