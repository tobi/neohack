import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fixture, root, identity } from './native-fixture.mjs';
const run = promisify(execFile), quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const directions = new Map([['-1,-1','northwest'],['0,-1','north'],['1,-1','northeast'],['-1,0','west'],['1,0','east'],['-1,1','southwest'],['0,1','south'],['1,1','southeast']]);

test('actual heavy pickup and boulder push report costs and witnessed changes, with exact receipts', async t => {
  const temp = await mkdtemp('/tmp/nnh-attempt-engine-');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const cwd = `${root}/engine/src`;
  const flags = async expression => (await run('make', ['-s', '--eval', `nnh-test-flags:;@echo ${expression}`, 'nnh-test-flags'], { cwd })).stdout.trim().split(/\s+/);
  const compile = await flags('$(TARGET_CC) $(TARGET_CFLAGS)');
  const link = await flags('$(TARGET_LINK) $(TARGET_LFLAGS) $(HOBJ) $(DATE_O) $(GENTILEOFILE) $(TARGET_HACKLIB) $(WINLIB) $(TARGET_LIBS) $(LUALIBS) $(AUTOLIBS)');
  const original = await readFile(`${root}/engine/win/headless/winheadless.c`, 'utf8');
  const needle = '        headless_flush();\n        hl_perception();';
  assert.ok(original.includes(needle));
  const source = original.replace('static char *\nhl_input(', `#include ${JSON.stringify(`${root}/tests/attempt-outcomes.inc`)}\nstatic char *\nhl_input(`)
    .replace(needle, '    attempt_fixture_prepare();\n' + needle);
  await writeFile(`${temp}/winheadless.c`, source);
  await run(compile[0], [...compile.slice(1), `-I${root}/engine/win/headless`, '-c', `${temp}/winheadless.c`, '-o', `${temp}/winheadless.o`], { cwd });
  const header = /#include "([^"]*lua.h)"/.exec(await readFile(`${root}/engine/include/nhlua.h`, 'utf8'))?.[1];
  assert.ok(header);
  const candidates = [resolve(dirname(header), 'liblua.a'), resolve(dirname(header), '../lib/liblua.a')];
  let lua;
  for (const path of candidates) if (await access(path).then(() => true, () => false)) { lua = path; break; }
  assert.ok(lua);
  await run(link[0], [...link.slice(1).map(a => a === 'winheadless.o' ? `${temp}/winheadless.o` : /lua.*\.a$/.test(a) ? lua : a), '-o', `${temp}/engine`], { cwd });
  for (const mode of ['heavy', 'push']) {
    const wrapper = `${temp}/${mode}`;
    await writeFile(wrapper, `#!/bin/sh\nexec env NNH_ATTEMPT_FIXTURE=${quote(mode)} ${quote(`${temp}/engine`)} "$@"\n`, { mode: 0o700 });
    const b = await fixture(t, { enginePath: wrapper }), game = await b.api.create(identity);
    const before = game.state;
    let request, target, destination;
    if (mode === 'heavy') {
      const boulder = before.observation.here.items.find(i => /boulder/.test(i.label));
      assert.ok(boulder, 'The real engine must disclose the underfoot boulder and its item ID');
      request = { version: 1, method: 'game.pickup', params: { sessionId: game.id, requestId: 'heavy-once', expectedRevision: before.revision, item: { id: boulder.id } } };
    } else {
      target = before.observation.neighborhood.cells.find(c => c.movement.intent === 'possiblePush' && c.movement.relation === 'adjacent');
      assert.ok(target, 'The real renderer must disclose possiblePush: ' + JSON.stringify({you:before.observation.you, cells:before.observation.neighborhood.cells.filter(c => c.objects?.length || c.movement.relation === 'adjacent')}));
      assert.ok(before.observation.world.some(c => c.x === target.x && c.y === target.y && c.objects?.some(o => o.kind === 'boulder')));
      destination = { x: target.x + target.dx, y: target.y + target.dy };
      const known = before.observation.world.find(c => c.x === destination.x && c.y === destination.y);
      assert.ok(known?.visible && known.terrain.type === 'floor' && !known.objects?.length);
      request = { version: 1, method: 'game.move', params: { sessionId: game.id, requestId: 'push-once', expectedRevision: before.revision, direction: directions.get(`${target.dx},${target.dy}`) } };
    }
    const result = await b.transport.send(request);
    assert.equal(result.error, undefined);
    assert.equal(result.outcome.turnsElapsed, 1);
    assert.equal(result.observation.turn, before.observation.turn + 1);
    if (mode === 'heavy') {
      assert.equal(result.outcome.status, 'blocked');
      assert.equal(result.outcome.reason, 'notPossible');
      assert.equal(result.outcome.positionChanged, false);
      assert.ok(result.events.some(e => e.type === 'heard' && /heavy|lift|carrying|cannot/i.test(e.text)));
      assert.ok(result.observation.here.items.some(i => i.id === request.params.item.id));
    } else {
      assert.equal(result.outcome.positionChanged, true);
      assert.deepEqual(result.observation.you, { x: target.x, y: target.y });
      assert.ok(result.observation.world.some(c => c.x === destination.x && c.y === destination.y && c.objects?.some(o => o.kind === 'boulder')), 'Witnessed new boulder location, beyond mere moved effect');
      assert.ok(!result.observation.world.find(c => c.x === target.x && c.y === target.y).objects?.some(o => o.kind === 'boulder'));
    }
    assert.deepEqual(await b.transport.send(request), result);
    assert.equal((await game.observe()).observation.turn, result.observation.turn);
    await b.api.close();
  }
});

test('authoritative stale revisions/items and terminal rejections do not authorize blind repeats', async t => {
  const b = await fixture(t), game = await b.api.create(identity);
  const initial = game.state;
  const stale = await b.api.request('game.search', { sessionId: game.id, requestId: 'stale-revision', expectedRevision: initial.revision + 1 });
  assert.equal(stale.error.code, 'staleRevision');
  assert.equal((await game.observe()).observation.turn, initial.observation.turn);
  const food = game.observation.inventory.find(i => i.category === 'food');
  assert.ok(food); const weapon = game.observation.inventory.find(i => i.category === 'weapon'); assert.ok(weapon); await game.drop({ id: weapon.id }); await game.drop({ id: food.id });
  const floor = game.observation.here.items.find(i => i.category === 'food'); assert.ok(floor);
  await game.pickup({ id: floor.id });
  const afterPickup = game.state;
  const obsolete = await b.api.request('game.pickup', { sessionId: game.id, requestId: 'stale-item', expectedRevision: afterPickup.revision, item: { id: floor.id } });
  assert.equal(obsolete.error.code, 'staleReference');
  assert.equal(obsolete.outcome.turnsElapsed, 0);
  assert.equal((await game.observe()).observation.turn, afterPickup.observation.turn);
  const prompt = await game.quit(); assert.equal(prompt.decision.kind, 'confirmation');
  const terminal = await game.answer(prompt.decision.id, { kind: 'confirmation', confirm: true });
  assert.equal(terminal.ended, true); assert.equal(terminal.end.kind, 'quit');
  const afterEnd = await b.api.request('game.wait', { sessionId: game.id, requestId: 'after-end', expectedRevision: terminal.revision });
  assert.equal(afterEnd.error.code, 'gameEnded');
  assert.equal(afterEnd.outcome.turnsElapsed, 0);
  assert.deepEqual(afterEnd.end, terminal.end);
});

test('a lost actual input reply retains the immutable request across observe and exact retry', async t => {
  const b = await fixture(t), game = await b.api.create(identity);
  const send = b.transport.send.bind(b.transport);
  let lost = false, originalReceipt;
  b.transport.send = async request => {
    const response = await send(request);
    if (!lost && request.method === 'game.search') {
      lost = true; originalReceipt = structuredClone(response);
      throw Error('injected reply loss after actual engine execution');
    }
    return response;
  };
  await assert.rejects(game.search(), error => error.name === 'UncertainExecution');
  const exact = game.pendingRequest;
  assert.ok(exact && Object.isFrozen(exact) && Object.isFrozen(exact.params));
  await game.observe();
  assert.equal(game.pendingRequest, exact, 'observation cannot resolve the missing receipt');
  await assert.rejects(game.wait(), error => error.name === 'UncertainExecution');
  assert.deepEqual(await game.retry(), originalReceipt);
  assert.equal(game.pendingRequest, null);
  assert.equal((await game.observe()).observation.turn, originalReceipt.observation.turn);
  await game.search();
  const newer = game.state;
  assert.deepEqual(await b.transport.send(exact), originalReceipt);
  assert.equal(game.state, newer, 'a historical receipt is not a current observation');
  assert.deepEqual((await game.observe()).observation, newer.observation);
});
