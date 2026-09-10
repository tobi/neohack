#!/usr/bin/env bun
import {createServer,type IncomingMessage} from 'node:http';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {readdir,readFile} from 'node:fs/promises';
import {McpRuntime} from './runtime.js';
import {McpService} from './service.js';
import {RpcPeer,RpcError,parseFrame,errorFrame,versions} from './rpc.js';
const limit=65536;
const args=process.argv.slice(2);
let port:number|undefined,store=join(process.env.XDG_STATE_HOME??join(homedir(),'.local/state'),'neohack/mcp-wasm'),runtimePath:string|undefined,list=false;
for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(arg==='--help'){console.log('Usage: neohack-mcp [--http PORT] [--sessions PATH] [--runtime PATH] [--list]\nBun + the same WASM/MCP adapter as WebMCP. HTTP listens on 127.0.0.1 at /mcp.\nDefault sessions: '+store);process.exit(0);}
  if(arg==='--list'){list=true;continue;}
  if(!['--http','--sessions','--runtime'].includes(arg!)||!args[i+1]||args[i+1]!.startsWith('--'))throw Error('Unknown or incomplete option: '+arg);
  const value=args[++i]!;
  if(arg==='--http'){if(!/^\d+$/.test(value)||+value<1||+value>65535)throw Error('--http must be a port from 1 to 65535');port=+value;}
  else if(arg==='--sessions')store=resolve(value);else runtimePath=resolve(value);
}
if(!process.versions.bun)throw Error('neohack-mcp requires Bun. The game runs in the pinned WASM engine.');
if(list){
  const dirs=await readdir(join(store,'runs')).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;});
  for(const id of dirs.filter(id=>/^[A-Za-z0-9_-]{16}$/.test(id)))console.log(JSON.stringify({sessionId:id,...JSON.parse(await readFile(join(store,'runs',id,'runtime.json'),'utf8'))}));
  process.exit(0);
}
process.umask(0o077);
const runtime=new McpRuntime(store,runtimePath),service=new McpService(runtime),jobs=new Set<Promise<unknown>>();
let stopping=false;
let server:ReturnType<typeof createServer>|undefined;
function track(work:Promise<unknown>){jobs.add(work);void work.finally(()=>jobs.delete(work)).catch(()=>{});}
let shutdown:Promise<void>|undefined;
function stop(){return shutdown??=(async()=>{
  stopping=true;process.stdin.pause();server?.close();
  const deadline=setTimeout(()=>{console.error('Shutdown deadline exceeded; reserved inputs remain recoverable.');process.exit(1);},90000);
  await Promise.allSettled([...jobs]);await runtime.close();server?.closeAllConnections();clearTimeout(deadline);
  process.exit(0);
})();}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
function media(header:string|undefined,wanted:string){return header?.split(',').some(part=>part.split(';')[0]?.trim().toLowerCase()===wanted&&!/;\s*q=0(?:\.0*)?(?:;|$)/i.test(part));}
function header(req:IncomingMessage,name:string){
  const values:string[]=[];for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i]?.toLowerCase()===name)values.push(req.rawHeaders[i+1]!);
  if(values.length>1)throw new RpcError(-32600,'Duplicate routing header');return values[0];
}
if(port!==undefined){
  server=createServer({maxHeaderSize:16384},(req,res)=>{
    const work=(async()=>{
      let id:unknown;
      const reply=(status:number,body:unknown)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...(status===405?{Allow:'POST'}:{})});res.end(body===null?undefined:JSON.stringify(body));};
      try{
        if(stopping||jobs.size>=128)throw new RpcError(-32000,'Server busy; no operation admitted',503);
        if(req.url!=='/mcp')throw new RpcError(-32601,'Not found',404);
        const host=header(req,'host'),origin=header(req,'origin');
        if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host??''))throw new RpcError(-32600,'Invalid Host',403);
        if(origin&&!['http://'+host].includes(origin))throw new RpcError(-32600,'Invalid Origin',403);
        if(req.method!=='POST')throw new RpcError(-32600,'Only POST is supported',405);
        if(!media(header(req,'content-type'),'application/json'))throw new RpcError(-32600,'Expected application/json',415);
        if(!media(header(req,'accept'),'application/json')||!media(header(req,'accept'),'text/event-stream'))throw new RpcError(-32600,'Accept must include application/json and text/event-stream',406);
        const bytes=await new Promise<Buffer>((resolve,reject)=>{
          const parts:Buffer[]=[];let length=0,oversized=false;
          req.on('data',(part:Buffer)=>{length+=part.length;if(length>limit){if(!oversized){oversized=true;parts.length=0;reject(new RpcError(-32600,'Request exceeds 65536 bytes',413));}}else if(!oversized)parts.push(part);});
          req.on('end',()=>{if(!oversized)resolve(Buffer.concat(parts));});req.on('error',reject);req.on('aborted',()=>reject(new RpcError(-32700,'Truncated request')));
        });
        const frame=parseFrame(bytes);id=frame.id;
        const version=header(req,'mcp-protocol-version')??'2025-03-26',modern=version===versions[0];
        if(!(versions as readonly string[]).includes(version))throw new RpcError(-32022,'Unsupported MCP version');
        const method=header(req,'mcp-method'),name=header(req,'mcp-name'),meta=frame.params?._meta;
        if((method&&method!==frame.method)||(modern&&!method)||(meta?.['io.modelcontextprotocol/protocolVersion']&&meta['io.modelcontextprotocol/protocolVersion']!==version))throw new RpcError(-32020,'Mismatched protocol metadata');
        if(modern&&(!meta||typeof meta['io.modelcontextprotocol/clientCapabilities']!=='object'||meta['io.modelcontextprotocol/protocolVersion']!==version))throw new RpcError(-32602,'Required protocol metadata missing');
        const decoded=name?.startsWith('=?base64?')?Buffer.from(name.slice(9,-2),'base64').toString('utf8'):name;
        if(frame.method==='tools/call'&&((modern&&!name)||(name&&decoded!==frame.params?.name)))throw new RpcError(-32020,'Mismatched tool name');
        // HTTP disconnect does not cancel accepted input. IDs are request-local;
        // short explicit game tokens select state, never a transport header.
        const body=await new RpcPeer(service,true).request(frame,modern);reply(body===null?202:200,body);
      }catch(e){const result=errorFrame(id,e);reply(result.status,result.body);}
    })();track(work);
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.listen(port,'127.0.0.1',()=>console.error(`MCP listening on http://127.0.0.1:${port}/mcp`));
  server.on('error',error=>{console.error(error.message);process.exitCode=1;void runtime.close().then(()=>process.exit(1));});
}else{
  const peer=new RpcPeer(service);let pending=Buffer.alloc(0),discarding=false;
  const emit=(value:unknown)=>new Promise<void>(resolve=>{process.stdout.write(JSON.stringify(value)+'\n',()=>resolve());});
  process.stdout.on('error',()=>void stop());
  const line=(bytes:Buffer)=>track((async()=>{
    let id:unknown;
    try{if(jobs.size>=128)throw new RpcError(-32000,'Server busy; no operation admitted',503);const frame=parseFrame(bytes);id=frame.id;const result=await peer.request(frame);if(result)await emit(result);}
    catch(e){await emit(errorFrame(id,e).body);}
  })());
  process.stdin.on('data',(chunk:Buffer)=>{
    if(stopping)return;
    let start=0;
    for(let i=0;i<chunk.length;i++)if(chunk[i]===10){
      const tail=chunk.subarray(start,i);
      if(!discarding&&pending.length+tail.length<=limit)line(Buffer.concat([pending,tail]));
      else if(!discarding)track(emit(errorFrame(null,new RpcError(-32700,'Request exceeds 65536 bytes')).body));
      pending=Buffer.alloc(0);discarding=false;start=i+1;
    }
    if(!discarding){pending=Buffer.concat([pending,chunk.subarray(start)]);if(pending.length>limit){pending=Buffer.alloc(0);discarding=true;track(emit(errorFrame(null,new RpcError(-32700,'Request exceeds 65536 bytes')).body));}}
  });
  process.stdin.on('end',()=>{if(pending.length&&!discarding)track(emit(errorFrame(null,new RpcError(-32700,'Truncated request')).body));void stop();});
  process.stdin.on('error',()=>void stop());
}
