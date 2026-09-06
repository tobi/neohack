import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fixture} from './native-fixture.mjs';
import {identityContracts} from './identity-contracts.mjs';
identityContracts(test,'native',fixture);
test('generated name and random seed are recorded before engine startup and retained in cold replay', async t => {
  const a = await fixture(t), game = await a.api.create();
  const path = `${a.sessions}/${game.id}/input.log.jsonl`;
  const journal = await readFile(path,'utf8');
  const start = journal.trim().split('\n').map(JSON.parse).find(row=>row.method === 'new_game');
  assert.equal(typeof start.params.seed,'number');
  // NetHack's status line abbreviates long names; the journal retains identity.
  const shownName = game.observation.vitals.title.split(' the ')[0];
  assert.ok(start.params.name.startsWith(shownName));
  assert.ok(shownName === start.params.name || shownName.length >= 16);
  const state = game.observation;
  await a.transport.close();
  const b = await fixture(t,{sessions:a.sessions});
  const resumed = await b.api.resume(game.id);
  assert.deepEqual(resumed.observation,state);
  assert.equal(await readFile(path,'utf8'),journal);
});

test('a status-line abbreviation does not truncate journaled identity or cold replay', async t => {
  const a = await fixture(t);
  const game = await a.api.create({name:'Morgan Brightwood',role:'healer',seed:42});
  assert.equal(game.observation.vitals.title.trim(),'Morgan Brightwoo the Rhizotomist');
  const path = `${a.sessions}/${game.id}/input.log.jsonl`;
  const journal = await readFile(path,'utf8');
  const start = journal.trim().split('\n').map(JSON.parse).find(row=>row.method === 'new_game');
  assert.equal(start.params.name,'Morgan Brightwood');
  const state = game.observation;
  await a.transport.close();
  const b = await fixture(t,{sessions:a.sessions});
  assert.deepEqual((await b.api.resume(game.id)).observation,state);
  assert.equal(await readFile(path,'utf8'),journal);
});
