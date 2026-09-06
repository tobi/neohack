import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTools, checkTools } from '../scripts/check-tools.mjs';
import { mcpTools } from '../protocol/mcp.ts';

test('parity audit diagnoses omissions, extras, duplicates and schema/description/annotation drift', () => {
  assert.deepEqual(compareTools(mcpTools, [...mcpTools].reverse()), []);
  const changed = structuredClone(mcpTools);
  const missing = changed.shift();
  changed.push({ ...changed[0], name: 'hidden_state' }, changed[0]);
  changed[1].description += ' different';
  changed[2].inputSchema.additionalProperties = true;
  changed[3].annotations.readOnlyHint = !changed[3].annotations.readOnlyHint;
  const errors = compareTools(mcpTools, changed);
  assert.ok(errors.includes(`missing: ${missing.name}`));
  assert.ok(errors.includes('extra: hidden_state'));
  assert.ok(errors.includes(`duplicate: ${changed[0].name}`));
  assert.ok(errors.includes(`${changed[1].name}: description differs`));
  assert.ok(errors.includes(`${changed[2].name}: inputSchema differs`));
  assert.ok(errors.includes(`${changed[3].name}: readOnlyHint differs`));
  assert.ok(compareTools(mcpTools, null).length);
});

test('public low/high APIs, WebMCP registration and real native stdio/HTTP expose the canonical contract', { timeout: 60000 }, async () => {
  // Bun/worker checks run separately after the UI build in CI. No optional skips.
  const report = await checkTools({ scripts: false });
  assert.equal(report.results.length, 5);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

test('low-level package declarations reject wrong names and arguments', async t => {
  const ts = (await import('typescript')).default;
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { resolve } = await import('node:path');
  const dir = await mkdtemp(`${tmpdir()}/neohack-parity-types-`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = `${dir}/consumer.mts`;
  await writeFile(file, `import {LowLevel} from ${JSON.stringify(resolve(import.meta.dirname, '../dist/typescript/low.js'))};
declare const low: LowLevel;
low.call('protocol_describe', {});
low.call('session_observe', {sessionId:'test'});
low.call('game_move', {sessionId:'test',requestId:'once',expectedRevision:0,direction:'north'});
// @ts-expect-error No raw-key escape hatch.
low.call('act', {key:'h'});
// @ts-expect-error Direction is semantic, not an arbitrary key.
low.call('game_move', {sessionId:'test',requestId:'once',expectedRevision:0,direction:'h'});
// @ts-expect-error Session observation requires an opaque session ID.
low.call('session_observe', {});
`);
  const program = ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
});
