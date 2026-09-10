import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createBridge} from './bridge.mjs';
import {createSnapshotClient} from './client.mjs';
import {createAgentHarness} from './harness.mjs';
import {createOperationValidators} from './operations.mjs';

// Optional real-engine test uses a new disposable store, never archived saves.
if(process.env.NEONETHACK_MCP_TEST_ROOT){
  test('native bridge + snapshot client + composed dispatcher preserve exact one-action ownership', {timeout:30000}, async t=>{
    const root=process.env.NEONETHACK_MCP_TEST_ROOT;
    const dir=await mkdtemp(join(tmpdir(),'neohack-composed-native-'));
    const bridge=createBridge({command:join(root,'dist/mcp/cli.js'),
      args:['--sessions',join(dir,'sessions')],
      journalPath:join(dir,'bridge.jsonl')});
    t.after(async()=>{await bridge.close();await rm(dir,{recursive:true,force:true});});
    let sequence=0;
    await bridge.rpc({jsonrpc:'2.0',id:++sequence,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'composed-fixture',version:'1'}}});
    await bridge.notify({jsonrpc:'2.0',method:'notifications/initialized'});
    const created=await bridge.rpc({jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name:"create",arguments:{name:'ComposedFixture',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'}}});
    const sessionId=created.result.structuredContent.sessionId,runId='disposable';
    const {CompactObservationReader}=await import(pathToFileURL(join(root,'dist/mcp/compact.js')).href);
    const reader=new CompactObservationReader();let sent=0,loseReply=false;const records=[],reservations=new Map();
    const client=createSnapshotClient({runDir:join(dir,'client'),sessionId,
      send:async(call,{reservationId})=>{
        sent++;const request={jsonrpc:'2.0',id:++sequence,method:'tools/call',params:call};
        const response=await bridge.rpc(request,{reservationId});records.push({request,response});
        reservations.set(reservationId,response.result?.structuredContent?.operationId);
        if(loseReply){loseReply=false;throw Error('fixture lost response before client persistence');}
        return response;
      },recoverExact:async(call,{reservationId})=>{
        const operationId=reservations.get(reservationId);assert.equal(typeof operationId,'string');
        return bridge.rpc({jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name:'receipt',arguments:{sessionId,operationId}}});
      },decodeReply:raw=>reader.apply(raw.result.structuredContent)});
    const harness=createAgentHarness({runId,sessionId,client,records:()=>records,operations:createOperationValidators({sessionId})});
    assert.equal((await harness.view()).lifecycle.state,'unknown');
    await harness.observe({deliberate:true});
    const before=await harness.view(),count=sent;
    await assert.rejects(harness.dispatch({runId:'wrong',sessionId,expectedRevision:before.state.revision,operation:"wait",args:{},approved:true}));
    assert.equal(sent,count);
    const waited=await harness.dispatch({runId,sessionId,expectedRevision:before.state.revision,operation:"wait",args:{},approved:true});
    assert.equal(sent,count+1);assert.equal(waited.state.revision,before.state.revision+1);
    assert.equal(waited.response.observation.turn,before.state.snapshot.observation.turn+waited.response.outcome.turnsElapsed);
    loseReply=true;
    await assert.rejects(harness.dispatch({runId,sessionId,expectedRevision:waited.state.revision,operation:"wait",args:{},approved:true}));
    await assert.rejects(harness.observe({deliberate:true}));
    const recovered=await harness.recover({deliberate:true});
    assert.equal(recovered.state.status,'current');assert.equal(harness.lifecycle.status().state,'alive');
    assert.equal(recovered.state.snapshot.observation.turn,waited.state.snapshot.observation.turn+1);
    assert.equal(records.filter(r=>r.request.params.name==="wait").length,2); // first wait and lost-reply wait; no replay
    assert.equal(bridge.pendingCount,0);
    const closed=await bridge.close();assert.equal(closed.childClosed,true);assert.equal(closed.ownedProcessesRemaining,false);
  });
}
