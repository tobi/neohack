import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Ajv from 'ajv/dist/2020.js';
import { fixture, root, identity } from './native-fixture.mjs';
const catalog = JSON.parse(await readFile(`${root}/protocol/catalog.json`, 'utf8'));
const ajv = new Ajv({ strict: false });
ajv.addKeyword({ keyword: 'x-maxBytes', type: 'string', validate: (limit, value) => Buffer.byteLength(value, 'utf8') <= limit });
function example(schema) {
  if ('const' in schema) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.oneOf) return example(schema.oneOf[0]);
  if (schema.type === 'object') return Object.fromEntries(schema.required.map(name => [name, example(schema.properties[name])]));
  if (schema.type === 'array') return [example(schema.items)];
  if (schema.type === 'integer') return Math.max(0, schema.minimum ?? 0);
  if (schema.type === 'boolean') return false;
  return 'test';
}
test('every method agrees with its published schema for valid, missing and irrelevant fields', async t => {
  const { transport } = await fixture(t);
  for (const method of catalog.methods) {
    const valid = method.name === 'session.create' ? identity : example(method.schema);
    const validate = ajv.compile(method.schema);
    assert.equal(validate(valid), true, method.name);
    const reply = await transport.send({ version: 1, method: method.name, params: valid });
    assert.notEqual(reply.error?.code, 'invalidParams', method.name);
    const invalids = [{ ...valid, terminalKey: 'x' }, null, [], ...method.schema.required.map(key => { const copy = { ...valid }; delete copy[key]; return copy; })];
    for (const params of invalids) {
      assert.equal(validate(params), false, method.name);
      const result = await transport.send({ version: 1, method: method.name, params });
      assert.equal(result.error?.code, 'invalidParams', `${method.name}: ${JSON.stringify(params)}`);
    }
  }
});

test('UTF-8 byte bounds and all decision answer variants match C validation', async t => {
  const { transport } = await fixture(t);
  const method = catalog.methods.find(m => m.name === 'decision.answer');
  const validate = ajv.compile(method.schema);
  const base = { sessionId: 'unknown', requestId: 'test', expectedRevision: 0, decisionId: 'decision-1' };
  const cases = [
    [{ kind: 'item', item: { id: 'item-1' } }, true],
    [{ kind: 'target', target: 'self' }, true],
    [{ kind: 'confirmation', confirm: false }, true],
    [{ kind: 'choice', choose: [0, 1] }, true],
    [{ kind: 'text', text: '' }, true],
    [{ kind: 'text', text: '😀'.repeat(32) }, true],
    [{ kind: 'text', text: '😀'.repeat(33) }, false],
    [{ kind: 'text', text: 'nul\0text' }, false],
    [{ kind: 'choice', choose: [] }, false],
    [{ kind: 'choice', choose: [0, 0] }, false],
    [{ kind: 'confirmation', confirm: 'no' }, false],
    [{ kind: 'confirmation', confirm: false, text: 'no' }, false],
  ];
  for (const [answer, accepted] of cases) {
    const params = { ...base, answer };
    assert.equal(validate(params), accepted);
    const result = await transport.send({ version: 1, method: method.name, params });
    assert.equal(result.error?.code !== 'invalidParams', accepted);
  }
});

test('native framing rejects duplicate, escaped, invalid UTF-8, NUL and oversized input without losing the next frame', async t => {
  const sessions = await mkdtemp(`${tmpdir()}/neonethack-framing-`);
  t.after(() => rm(sessions, { recursive: true, force: true }));
  const good = '{"version":1,"method":"protocol.describe","params":{}}';
  const frames = [
    Buffer.from('{"version":1,"version":1,"method":"protocol.describe","params":{}}'),
    Buffer.from('{"vers\\u0069on":1,"method":"protocol.describe","params":{}}'),
    Buffer.from('{"version":1,"method":"session.create","params":{"name":"A","name":"B"}}'),
    Buffer.from('x'.repeat(12_000)),
    Buffer.concat([Buffer.from(good.slice(0, 3)), Buffer.from([0]), Buffer.from(good.slice(3))]),
    Buffer.from([0xc0, 0x80]),
    Buffer.from(good + ' trailing'),
    Buffer.from(good),
  ];
  const input = Buffer.concat([...frames.flatMap(frame => [frame, Buffer.from('\n')]), Buffer.from(good)]);
  const process = spawnSync(`${root}/build/native/neonethack`, [`${root}/engine/playground/nethack`, `${root}/engine/playground`, sessions], { input, timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.equal(process.status, 0, process.stderr.toString());
  const responses = process.stdout.toString().trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, frames.length + 1);
  assert.ok(responses.slice(0, -2).every(r => r.error));
  assert.deepEqual(responses.at(-2).catalog, catalog);
  assert.equal(responses.at(-1).error.code, 'invalidFrame');
});
