import {test} from 'node:test';
import {withSessionViews,assertSceneObservation} from './mcp-view-fixture.mjs';
import assert from 'node:assert/strict';
import {WasmTransport} from '../dist/typescript/wasm.js';
import {registerWebMcp} from '../dist/typescript/webmcp.js';
import {McpService,tools} from '../dist/mcp/service.js';
import {mcpClient} from './mcp-client-fixture.mjs';
import {identity} from './native-fixture.mjs';
const normalized=(value,id)=>JSON.parse(JSON.stringify(value,(key,entry)=>key==='enrichmentMs'||key==='planningElapsedMs'?0:entry).replaceAll(id,'RUN').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,'OPERATION'));
for(const mode of ['stdio','http'])test(`${mode} and WebMCP execute identical schemas and real WASM journey replies`,async t=>{
  const cli=await mcpClient(t,mode),worker=await WasmTransport.create(),registered=new Map();t.after(()=>worker.close());
  const registration=await registerWebMcp(worker,{registerTool:tool=>{registered.set(tool.name,tool);}});t.after(()=>registration.dispose());
  const catalog=(await cli.client().listTools()).tools;assert.deepEqual(catalog,tools);
  assert.deepEqual(catalog.map(({name,description,inputSchema,annotations})=>({name,description,inputSchema,readOnlyHint:annotations.readOnlyHint})),[...registered.values()].map(({name,description,inputSchema,annotations})=>({name,description,inputSchema,readOnlyHint:annotations.readOnlyHint})));
  let webResult;
  const webCall=withSessionViews(async(name,args)=>{webResult=await registered.get(name).execute(args);return webResult.structuredContent;});
  const a=await cli.call('create',identity),b=await webCall('create',identity);
  assert.deepEqual(normalized(a,a.basis.sessionId),normalized(b,b.basis.sessionId));
  let sa=a,sb=b;
  for(const [name,params] of [['route',{to:a.scene.self.position}],['inspect',{}],['go',{to:a.scene.self.position}],['search',{turns:5}],['pray',{}],['cancel',null],['explore',{maxActions:4}],['syncState',{}]]){
    const aa={sessionId:a.basis.sessionId,...(params??{decisionId:sa.decision.id})},bb={sessionId:b.basis.sessionId,...(params??{decisionId:sb.decision.id})};
    sa=await cli.call(name,aa);sb=await webCall(name,bb);const result=webResult;
    assert.deepEqual(JSON.parse(result.content[0].text),sb);
    if(sb.scene?.map){
      assert.equal(result.content[1].type,'text');
      assert.equal(result.content[1].text,`Perceived map (exact feature coordinates: scene.map.positions):\n~~~~text\n${sb.scene.map.text}\n~~~~`);
    }else assert.equal(result.content.length,1);
    assert.deepEqual(normalized(sa,a.basis.sessionId),normalized(sb,b.basis.sessionId),name);
  }
});
test('shared executor captures queued revisions, preserves uncertainty and recovers an exact accepted input',async t=>{
  const worker=await WasmTransport.create();t.after(()=>worker.close());
  let hold,entered,release,lose=false;let dispatches=0;
  const transport={send:async request=>{
    if(request.method.startsWith('game.'))dispatches++;
    const response=await worker.send(request);
    if(hold&&request.method==='game.search'){entered();await hold;hold=undefined;}
    if(lose&&request.method==='game.search'){lose=false;throw Error('Test lost accepted reply');}
    return response;
  }};
  const service=new McpService(transport),call=withSessionViews(async(name,args)=>(await service.call(name,args)).structuredContent);
  const created=await call('create',identity),sid={sessionId:created.basis.sessionId};
  const barrier=new Promise(r=>entered=r);hold=new Promise(r=>release=r);
  const first=call('search',{...sid,turns:1});await barrier;
  const second=call('search',{...sid,turns:1});release();
  const [a,b]=await Promise.all([first,second]);assert.equal(a.error,undefined);assert.equal(b.error.code,'staleRevision');assert.equal(b.outcome.operationId,undefined);assert.equal(dispatches,1);
  lose=true;const lost=await call('search',{...sid,turns:1});assert.equal(lost.error.code,'uncertainExecution');
  const blocked=await call('search',{...sid,turns:1});assert.ok(blocked.error);assert.equal(dispatches,2);
  const recovered=await call('syncState',sid);assert.equal(recovered.verification.operationId,lost.outcome.operationId);assert.equal(recovered.basis.turn,a.basis.turn+1);
  assert.equal(dispatches,2,'receipt verification sends no gameplay');
  const receipt=await call('receipt',{...sid,operationId:lost.outcome.operationId});assertSceneObservation(recovered,receipt.result.receipt.observation);assert.deepEqual(receipt.result.receipt.outcome,recovered.verification.outcome);
});
