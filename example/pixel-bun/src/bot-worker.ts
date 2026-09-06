import * as client from '../../../lib/neonethack/typescript/client';
import { Neonethack, Game } from '../../../lib/neonethack/typescript/client';
// Bundled as a classic worker, launched only inside the opaque sandbox.
self.onmessage = async (event: MessageEvent) => {
  const {files,initial} = event.data;
  const port: MessagePort = event.ports[0]!;
  let next = 0;
  const pending = new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
  port.onmessage = e => {
    const p = pending.get(e.data.id); if(!p) return;
    pending.delete(e.data.id);
    e.data.error ? p.reject(Error(e.data.error)) : p.resolve(e.data.result);
  };
  const send = (request:any):Promise<any> => new Promise((resolve,reject)=>{
    const id=++next; pending.set(id,{resolve,reject}); port.postMessage({id,request});
  });
  const api = new Neonethack({send,close:async()=>{}});
  const game = new Game(api,initial,()=>'10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0]! & 15 >> Number(c) / 4).toString(16)));
  const log = (...values:unknown[])=>port.postMessage({log:values.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' ').slice(0,2000)});
  console.log=log; console.warn=log; console.error=log;
  const modules = new Map<string,{exports:any}>();
  function requireModule(name:string, from='') : any {
    if(name === 'neonethack') return {...client,default:Neonethack};
    if(from && !name.startsWith('./')) throw Error('Only relative project imports and neonethack are supported');
    let path = name.replace(/^\.\//,'');
    if(!Object.hasOwn(files,path)) path = [path+'.ts',path+'.js'].find(p=>Object.hasOwn(files,p)) ?? '';
    if(!path) throw Error(`Module not found: ${name}`);
    if(modules.has(path)) return modules.get(path)!.exports;
    const module = {exports:{}}; modules.set(path,module);
    new Function('require','module','exports',files[path]+`\n//# sourceURL=bot/${path}`)((n:string)=>requireModule(n,path),module,module.exports);
    return module.exports;
  }
  try {
    const main = requireModule('main.ts');
    const result = await client.runBot(game, main.default, log);
    log('Lifecycle stopped:', result.reason);
    port.postMessage({done:true});
  } catch(error) { port.postMessage({failure:String(error)}); }
};
