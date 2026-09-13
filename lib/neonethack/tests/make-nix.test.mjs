import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));
async function fixture(t) {
  const dir = await mkdtemp(`${tmpdir()}/neohack-make-`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = `${dir}/source with spaces`, bin = `${dir}/bin`, log = `${dir}/calls`;
  await mkdir(`${project}/lib/neonethack`, { recursive: true });
  await mkdir(bin);
  for (const path of ['Makefile', 'lib/neonethack/Makefile']) {
    await copyFile(resolve(root, path), `${project}/${path}`);
  }
  await writeFile(`${bin}/nix`, `#!/bin/sh
printf 'nix:%s:%s\\n' "$1" "$2" >> "$NNH_TEST_LOG"
[ "$1" = develop ] && [ "$2" = "$NNH_TEST_PROJECT" ] && [ "$3" = --command ] || exit 91
shift 3
export NNH_NIX_SHELL=1
exec "$@"
`, { mode: 0o755 });
  for (const command of ['cmake', 'ctest', 'node']) {
    await writeFile(`${bin}/${command}`, `#!/bin/sh
printf '${command}:%s\\n' "$*" >> "$NNH_TEST_LOG"
exit "\${NNH_TEST_EXIT:-0}"
`, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NNH_TEST_LOG: log, NNH_TEST_PROJECT: project };
  for (const key of ['NNH_NIX_SHELL', 'MAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEOVERRIDES']) delete env[key];
  return {
    env,
    run: (args = [], extra = {}) => spawnSync('make', args, { cwd: project, env: { ...env, ...extra }, encoding: 'utf8' }),
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n'),
  };
}
function succeeds(result) { assert.equal(result.status, 0, result.stdout + result.stderr); }

test('root default make enters Nix once and builds native', async t => {
  const f = await fixture(t);
  succeeds(f.run());
  const calls = await f.calls();
  assert.equal(calls.filter(line => line.startsWith('nix:')).length, 1);
  assert.match(calls[1], /^cmake:-S \. -B build\/native/);
  assert.equal(calls[2], 'cmake:--build build/native --target native');
});
test('root multiple targets share Nix and preserve overrides and dependencies', async t => {
  const f = await fixture(t);
  succeeds(f.run(['native', 'test', 'BUILD=build/custom', 'GENERATOR=Unix Makefiles', 'PREFIX=/tmp/custom', 'LIBDIR=lib64']));
  const calls = await f.calls();
  assert.equal(calls.filter(line => line.startsWith('nix:')).length, 1);
  assert.equal(calls.filter(line => line.includes('--target native')).length, 1);
  assert.match(calls[1], /-B build\/custom -G Unix Makefiles.*-DCMAKE_INSTALL_PREFIX=\/tmp\/custom -DCMAKE_INSTALL_LIBDIR=lib64/);
  assert.equal(calls.at(-1), 'ctest:--test-dir build/custom --output-on-failure');
});
test('direct library targets enter Nix even from an unrelated Nix shell', async t => {
  const f = await fixture(t);
  succeeds(f.run(['-C', 'lib/neonethack', 'generate', 'check-generated'], { IN_NIX_SHELL: 'impure' }));
  const calls = await f.calls();
  assert.equal(calls.filter(line => line.startsWith('nix:')).length, 1);
  assert.deepEqual(calls.slice(1), ['node:scripts/generate.ts', 'node:scripts/generate.ts --check']);
});
test('existing neohack shell does not invoke Nix again', async t => {
  const f = await fixture(t);
  succeeds(f.run(['test'], { NNH_NIX_SHELL: '1' }));
  assert.ok((await f.calls()).every(line => !line.startsWith('nix:')));
});
test('failed inner build fails the outer make invocation', async t => {
  const f = await fixture(t);
  assert.notEqual(f.run(['test'], { NNH_TEST_EXIT: '42' }).status, 0);
  const calls = await f.calls();
  assert.equal(calls.length, 2);
  assert.match(calls[1], /^cmake:-S/);
});
