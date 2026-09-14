import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createBridge} from './bridge.mjs';
import {createDecisionClient} from './decision-client.mjs';

// Opt-in real MCP + WASM scenario. Every invocation owns a disposable store.
if(process.env.NEONETHACK_MCP_TEST_ROOT){
  test('MCP v2 runner: compact actions, explicit decisions, stale views and no action-sync loop', {timeout:30000}, async t=>{
    const root=process.env.NEONETHACK_MCP_TEST_ROOT;
    const dir=await mkdtemp(join(tmpdir(),'neohack-mcp-v2-'));
    const bridge=createBridge({command:join(root,'dist/mcp/cli.js'),
      args:['--sessions',join(dir,'sessions')],journalPath:join(dir,'bridge.jsonl')});
    t.after(async()=>{await bridge.close();await rm(dir,{recursive:true,force:true});});
    let sequence=0;
    const rpc=(method,params)=>bridge.rpc({jsonrpc:'2.0',id:++sequence,method,params});
    await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'v2-example-fixture',version:'2'}});
    await bridge.notify({jsonrpc:'2.0',method:'notifications/initialized'});
    const tools=(await rpc('tools/list',{})).result.tools;
    const created=(await rpc('tools/call',{name:"session",arguments:{action: "create", seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'}})).result.structuredContent;
    assert.equal(created.version,2);
    const sessionId=created.basis.sessionId;
    const {SceneReader}=await import(pathToFileURL(join(root,'dist/mcp/scene.js')).href);
    const sent=[];
    const client=createDecisionClient({sessionId,tools,reader:new SceneReader(),send:async call=>{
      sent.push(call);return (await rpc('tools/call',call)).result.structuredContent;
    }});
    client.accept(created);
    const waited=await client.call({name:"interact",arguments:{action: "rest", viewId:created.basis.viewId}});
    assert.equal(sent.length,1);
    assert.equal(waited.scene.world,undefined);
    assert.equal(typeof waited.scene.map.text,'string');
    assert.equal(waited.basis.turn,created.basis.turn+waited.outcome.turnsElapsed);
    assert.equal(waited.basis.revision,created.basis.revision+1);
    await assert.rejects(client.call({name:"interact",arguments:{action: "rest", viewId:created.basis.viewId}}),/viewId/);
    assert.equal(sent.length,1);
    const prayer=await client.call({name:"interact",arguments:{action: "pray", viewId:waited.basis.viewId}});
    assert.equal(prayer.control.gate,'decision');
    assert.equal(prayer.decision.reply.tool,'respond');
    await assert.rejects(client.call({name:"respond",arguments:{action: "answer", decisionId:'old-question',value:false}}),/exact/);
    const declined=await client.call({name:prayer.decision.reply.tool,
      arguments:{...prayer.decision.reply.arguments,value:false}});
    assert.equal(declined.basis.turn,prayer.basis.turn);
    assert.ok(declined.basis.revision>prayer.basis.revision);
    assert.equal(declined.control.gate,'ready');
    assert.equal(sent.filter(call=>call.name==='observe').length,0);
    const synced=await client.call({name:"observe",arguments:{}});
    assert.ok(Array.isArray(synced.scene.world));
    assert.equal(synced.basis.revision,declined.basis.revision);
    const closed=await bridge.close();
    assert.equal(closed.childClosed,true);assert.equal(closed.ownedProcessesRemaining,false);
  });
}
