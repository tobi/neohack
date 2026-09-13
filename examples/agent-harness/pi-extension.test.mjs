import test from 'node:test';
import assert from 'node:assert/strict';
import extension from './pi-extension.mjs';
function env(t,key,value){const old=process.env[key];process.env[key]=value;t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});}

test('Pi binding registers only discovered tools, passes exact arguments, reports active tools and model limit', async t=>{
  env(t,'NEOHACK_PI_ENDPOINT','http://127.0.0.1:1234');
  env(t,'NEOHACK_PI_TOKEN','fixture');
  const calls=[], registered=[], handlers=new Map();
  const schema={type:'object',properties:{},additionalProperties:false};
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url,options});
    assert.equal(options.headers.authorization,'Bearer fixture');
    return {ok:true,json:async()=>url.endsWith('/tools')?{tools:[{name:'syncState',description:'Synchronize',inputSchema:schema}]}:{result:'fixture'}};
  });
  await extension({registerTool:tool=>registered.push(tool),on:(event,fn)=>handlers.set(event,fn),getActiveTools:()=>['syncState']});
  assert.deepEqual(registered.map(t=>t.name),['syncState']);
  assert.deepEqual(registered[0].parameters,schema);
  await handlers.get('session_start')({}, {model:{provider:'vllm',id:'current',contextWindow:524288}});
  assert.equal(JSON.parse(calls[1].options.body).contextWindow,524288);
  const output=await registered[0].execute('id',{});
  assert.deepEqual(JSON.parse(calls[2].options.body),{name:'syncState',arguments:{}});
  assert.equal(output.content[0].text,'{"result":"fixture"}');
});

test('binding does not retry a rejected or uncertain request',async t=>{
  env(t,'NEOHACK_PI_ENDPOINT','http://127.0.0.1:1234');
  env(t,'NEOHACK_PI_TOKEN','fixture');
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return {ok:false,status:409,json:async()=>({error:'uncertain'})};});
  await assert.rejects(extension({}),/uncertain/);
  assert.equal(calls,1);
});
