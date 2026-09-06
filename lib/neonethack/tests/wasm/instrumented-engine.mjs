// Test-only: compile a fresh engine fixture against the actual WASM build,
// retaining a complete isolated package and a new, verified package identity.
// Never mutates the production package, an old save, journal or receipt.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { checkCompiled, compiled } from '../../scripts/check-package.mjs';
const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export async function buildInstrumentedEngine(t, { includePath, hook }) {
  assert.ok(isAbsolute(includePath), 'fixture source must be an explicit absolute path');
  assert.match(hook, /^[A-Za-z_]\w*\(\);$/, 'one test initialization call, not arbitrary shell text');
  const temp = await mkdtemp('/tmp/nnh-wasm-fixture-');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const packageDir = `${temp}/package`, build = `${root}/build/wasm`;
  const basePackage = `${root}/dist/wasm`;
  const baseBuild = await checkCompiled(basePackage);
  const baseManifest = JSON.parse(await readFile(`${basePackage}/manifest.json`, 'utf8'));
  assert.equal(sha256(JSON.stringify(baseManifest.files)), baseManifest.buildId);
  for (const [name, hash] of Object.entries(baseManifest.files)) {
    assert.match(name, /^[\w.-]+$/);
    assert.equal(sha256(await readFile(`${basePackage}/${name}`)), hash, `base package integrity: ${name}`);
  }
  await cp(basePackage, packageDir, { recursive: true });
  const originalPath = `${root}/engine/win/headless/winheadless.c`;
  const original = await readFile(originalPath, 'utf8');
  const fixtureSource = await readFile(includePath, 'utf8');
  const input = 'static char *\nhl_input(', boundary = '        headless_flush();\n        hl_perception();';
  assert.equal(original.split(input).length, 2, 'exactly one engine input function');
  assert.ok(original.includes(boundary), 'actual public perception boundary required');
  await writeFile(`${temp}/fixture.inc`, fixtureSource);
  const instrumented = original.replace(input, `#include ${JSON.stringify(`${temp}/fixture.inc`)}\n${input}`)
    .replace(boundary, `    ${hook}\n${boundary}`);
  await writeFile(`${temp}/winheadless.c`, instrumented);
  const object = 'CMakeFiles/neonethack-engine.dir/engine/win/headless/winheadless.c.o';
  const target = 'artifacts/neonethack-engine.mjs';
  async function commandFor(target) {
    const { stdout } = await run('ninja', ['-t', 'commands', target], { cwd: build, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim().split('\n').at(-1);
  }
  let compile = await commandFor(object), link = await commandFor(target);
  assert.ok(compile.includes(object) && compile.includes(`-c ${originalPath}`), 'actual headless compile command');
  assert.ok(link.includes(object) && link.includes(`-o ${target}`), 'actual engine link command');
  // These are trusted Ninja-generated build commands. Only explicit source,
  // dependency/object and output paths change; replacements are shell-quoted.
  compile = compile.replaceAll(object, quote(`${temp}/winheadless.o`))
    .replace(`-c ${originalPath}`, `-I${quote(`${root}/engine/win/headless`)} -c ${quote(`${temp}/winheadless.c`)}`);
  link = link.replaceAll(object, quote(`${temp}/winheadless.o`))
    .replace(`-o ${target}`, `-o ${quote(`${packageDir}/neonethack-engine.mjs`)}`);
  await run('sh', ['-c', compile], { cwd: build, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  await run('sh', ['-c', link], { cwd: build, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const provenance = {
    kind: 'instrumented-test-engine', baseBuildId: baseManifest.buildId,
    baseSourceHash: baseBuild.sourceHash,
    originalHeadlessHash: sha256(original), fixtureHash: sha256(fixtureSource),
    hook, instrumentedHeadlessHash: sha256(instrumented),
    note: 'Fresh test fixture package; not the original release engine or an upgrade of an existing save.',
  };
  const files = {};
  for (const name of Object.keys(baseManifest.files).sort()) files[name] = sha256(await readFile(`${packageDir}/${name}`));
  const buildId = sha256(JSON.stringify(files));
  assert.notEqual(buildId, baseManifest.buildId, 'the fixture is a distinct package');
  const compiledHashes = {};
  for (const name of compiled) compiledHashes[name] = files[name];
  await writeFile(`${packageDir}/manifest.json`, JSON.stringify({ version: 1, buildId, files }, null, 2) + '\n');
  await writeFile(`${packageDir}/build.json`, JSON.stringify({ version: 1,
    sourceHash: sha256(JSON.stringify(provenance)), compiled: compiledHashes, testProvenance: provenance }, null, 2) + '\n');
  await writeFile(`${temp}/provenance.json`, JSON.stringify(provenance, null, 2) + '\n');
  await checkCompiled(packageDir);
  return { workerUrl: pathToFileURL(`${packageDir}/core-worker.mjs`), buildId, provenance };
}
