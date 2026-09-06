import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hungerStates, burdenStates } from '../protocol/response.ts';
const run = promisify(execFile);
test('C self-state normalization covers every generated state and displayed padding/case', async t => {
  const temp = await mkdtemp('/tmp/nnh-status-');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const cases = [];
  for (const [hunger, values] of [[1, hungerStates], [0, burdenStates]]) {
    for (const expected of values) for (const label of [expected, ` \t${expected.toUpperCase()}  `]) cases.push({ hunger, label, expected });
    for (const label of ['', '  \t']) cases.push({ hunger, label, expected: hunger ? 'not_hungry' : 'unencumbered' });
    for (const label of ['unfamiliar', 'x'.repeat(80)]) cases.push({ hunger, label, expected: 'unknown' });
  }
  cases.push({ hunger: 1, label: 'Not Hungry  ', expected: 'not_hungry' });
  const calls = cases.map(c => `puts(nnh_perceived_status(${JSON.stringify(c.label)}, ${c.hunger}));`).join('\n');
  await writeFile(`${temp}/status.c`, `#include <stdio.h>\n#include "perceived_status.h"\nint main(void) {${calls}\nputs(nnh_perceived_status(NULL,1));return 0;}\n`);
  await run('cc', ['-std=c99', '-Wall', '-Wextra', '-Werror', `-I${import.meta.dirname}/../src`, `${temp}/status.c`, '-o', `${temp}/status`]);
  const { stdout } = await run(`${temp}/status`);
  assert.deepEqual(stdout.trim().split('\n'), [...cases.map(c => c.expected), 'unknown']);
});
