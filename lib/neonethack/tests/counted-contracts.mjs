import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const identity={name:'Patient',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'};
export function countedContracts(test,label,fixture){
  for(const action of ['search','rest'])test(`${label}: counted ${action} stops on the engine interruption rather than restarting`,async t=>{
    const {api}=await fixture(t),game=await api.create(identity);
    const r=await game[action]({turns:1000});
    assert.equal(r.outcome.status,'interrupted');
    assert.ok(r.outcome.turnsElapsed>0&&r.outcome.turnsElapsed<1000);
    assert.ok(r.events.some(e=>e.type==='actionResult'&&e.action===action&&e.status==='interrupted'));
    const before=game.observation.turn;
    assert.equal((await game.observe()).observation.turn,before,'observation does not continue the occupation');
  });
  for(const action of ['search','rest'])test(`${label}: native counted ${action} is one bounded command with exact receipts`,async t=>{
    const b=await fixture(t);let game=await b.api.create(identity);
    const before=game.observation.turn;
    const request={version:1,method:`game.${action}`,params:{sessionId:game.id,requestId:`counted-${action}`,expectedRevision:game.state.revision,turns:5}};
    const result=await b.transport.send(request);
    assert.ok(!result.error,JSON.stringify(result.error));
    assert.equal(result.outcome.turnsElapsed,5);
    assert.equal(result.observation.turn,before+5);
    assert.equal(result.outcome.status,'completed');
    assert.ok(result.events.some(e=>e.type==='actionResult'&&e.action===action&&e.status==='completed'));
    assert.deepEqual(await b.transport.send(request),result,'same count retry returns exact receipt');
    if(b.sessions){
      const log=await readFile(`${b.sessions}/${game.id}/input.log.jsonl`,'utf8');
      assert.equal(log.split('\n').filter(l=>l.includes('"count":5')).length,1,'one counted input rather than repeated commands');
    }
    await game.observe();
    await game.close(); game=await b.api.resume(game.id);
    assert.deepEqual(game.observation,result.observation,'resume replays the exact native count');
    assert.deepEqual(await b.transport.send(request),result,'receipt survives restart');
    await assert.rejects(game[action]({turns:0}));
    await assert.rejects(game[action]({turns:1001}));
    const current=game.state.revision;
    assert.equal((await game.observe()).revision,current);
    await game.eat();const question=game.decision;
    const rejected=await b.transport.send({version:1,method:`game.${action}`,params:{sessionId:game.id,requestId:'pending-count',expectedRevision:game.state.revision,turns:5}});
    assert.equal(rejected.error.code,'pendingDecision');
    assert.deepEqual(rejected.decision,question);
  });
}
