import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const run=profile=>JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('./run.mjs',import.meta.url)),profile,'7'],{encoding:'utf8',timeout:30000}));
test('fixed navigator reference reproduces public metrics and reaches a second level',()=>{
  const a=run('navigator'),b=run('navigator');
  assert.deepEqual(a,b);
  assert.ok(a.downwardTransitions>=1);assert.ok(a.maxDepth>=2);
  assert.ok(a.turns>0);assert.equal(a.tokens,null);assert.equal(a.ended,false);
  assert.ok(a.lowCalls['session.navigation']);
});
test('world-only reference never uses shared navigation queries',()=>{
  const a=run('world-only');assert.equal(a.lowCalls['session.navigation'],undefined);assert.equal(a.lowCalls['session.route'],undefined);
  assert.ok(a.lowCalls['session.actions']);assert.ok(a.lowCalls['game.move']);
});
