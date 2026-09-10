// Independently consume the finished archives, never the preview's work/ tree.
// This executes TRUSTED local preview source/binaries; hashes are integrity
// checks, not signatures/authentication. No upload, publication or Git changes.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, copyFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { root, sha256, sourceState, safePath, sourcePath, walk } from './source-files.mjs';
import { readTar, extract, hostPathLeak } from './archive.mjs';
import { checkInventory, nativeFiles, checkNpmSources } from './package-files.mjs';
import { compiled, workers, notices, checkCompiled, checkPackage } from './check-package.mjs';
const input = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw Error('Usage: node scripts/check-archives.mjs PREVIEW_DIR [NEW_AUDIT_DIR]');
const out = resolve(process.argv[3] ?? `${input}/audit`);
if (await lstat(out).catch(() => null)) throw Error(`Audit output must not exist: ${out}`);
const preview = JSON.parse(await readFile(`${input}/PREVIEW.json`, 'utf8'));
assert.match(preview.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
assert.equal(preview.publicationApproved, false);
assert.match(preview.sourceHash, /^[a-f0-9]{64}$/); assert.match(preview.buildId, /^[a-f0-9]{64}$/);
assert.ok(Number.isSafeInteger(preview.epoch) && preview.epoch >= 0);
const base = `neonethack-${preview.version}`;
const names = [`${base}-source.tar.gz`, `${base}-${process.platform}-${process.arch}.tar.gz`, `${base}.tgz`];
assert.deepEqual(Object.keys(preview.archives).sort(), [...names].sort(), 'Exactly three matching build-host archives required');
const sums = (await readFile(`${input}/SHA256SUMS`, 'utf8')).trim().split('\n').sort();
assert.deepEqual(sums, names.map(name => `${preview.archives[name]}  ${name}`).sort());
const archives = [];
let npmArchive;
for (let i = 0; i < names.length; ++i) {
  const bytes = await readFile(`${input}/${names[i]}`);
  assert.equal(sha256(bytes), preview.archives[names[i]], `Archive checksum: ${names[i]}`);
  archives.push(readTar(bytes, [base, 'native', 'package'][i]));
  if (i === 2) npmArchive = bytes;
}
const [sources, native, npm] = archives;
if (!process.env.EMSDK) throw Error('Set EMSDK to the trusted 6.0.9 SDK used for this audit/rebuild');
const sdk = resolve(process.env.EMSDK, 'upstream/emscripten');
const json = (files, path) => JSON.parse(files.get(path)?.data.toString() ?? 'null');
const manifest = json(sources, 'SOURCE-MANIFEST.json');
assert.equal(manifest.version, 1); assert.equal(manifest.sourceHash, preview.sourceHash); assert.equal(manifest.epoch, preview.epoch);
assert.deepEqual(manifest.toolchain, { emscripten: '6.0.9', lua: '5.4.9' });
assert.deepEqual([...sources.keys()].sort(), [...Object.keys(manifest.files), 'SOURCE-MANIFEST.json'].sort());
for (const [path, hash] of Object.entries(manifest.files)) {
  safePath(path); assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(sha256(sources.get(path).data), hash, `Source hash: ${path}`);
  sourcePath(path);
}
assert.equal(sha256(sources.get('lib/neonethack/third_party/lua-5.4.9.tar.gz').data), '2335b6c582a52654f94612bf10d2f4672805d05329aa6568b1d8cd9e5c6fb8e6');
assert.equal(json(sources, 'lib/neonethack/third_party/emscripten-runtime/emscripten-version.txt'), '6.0.9');
assert.equal(JSON.parse(await readFile(`${sdk}/emscripten-version.txt`, 'utf8')), '6.0.9');
const sdkPrefix = 'lib/neonethack/third_party/emscripten-runtime/';
const sdkPaths = ['LICENSE', 'emscripten-version.txt'];
for (const dir of ['src', 'system/lib', 'system/include'])
  for (const path of await walk(`${sdk}/${dir}`)) sdkPaths.push(`${dir}/${path}`);
assert.deepEqual([...sources.keys()].filter(p => p.startsWith(sdkPrefix)).sort(), sdkPaths.map(p => sdkPrefix + p).sort(), 'Complete actual SDK runtime source/header inventory required');
for (const path of sdkPaths) assert.equal(sha256(sources.get(sdkPrefix + path).data), sha256(await readFile(`${sdk}/${path}`)), `SDK source differs: ${path}`);
checkInventory(native.keys(), nativeFiles, 'native');
assert.deepEqual(json(native, 'share/neonethack/SOURCE.json'), { sourceHash: preview.sourceHash, buildId: preview.buildId, sourceArchive: names[0], epoch: preview.epoch });
const metadata = json(npm, 'package.json');
assert.equal(metadata.name, 'neonethack'); assert.equal(metadata.version, preview.version); assert.equal(metadata.private, true);
checkNpmSources(sources, npm);
for (const [files, kind] of [[native, 'native'], [npm, 'npm']]) for (const [path, { data }] of files) {
  assert.ok(!data.includes(Buffer.from(`${input}/work/`)), `Build workspace leaked into ${kind}/${path}`);
  assert.equal(hostPathLeak(data), null, `Owner path leaked into ${kind}/${path}`);
}
for (const [installed, source] of [
  ['include/neonethack.h', 'include/neonethack.h'], ['share/neonethack/NOTICE.md', 'NOTICE.md'],
  ['share/neonethack/README.md', 'README.md'],
  ['share/neonethack/license', 'engine/dat/license'], ['share/neonethack/data/license', 'engine/dat/license'],
  ...['catalog.json', 'request.schema.json', 'response.schema.json'].map(p => [`share/neonethack/protocol/${p}`, `protocol/${p}`]),
]) assert.deepEqual(native.get(installed)?.data, sources.get(`lib/neonethack/${source}`)?.data, `Native source copy: ${installed}`);
await mkdir(out, { recursive: true });
await writeFile(`${out}/verified-npm.tgz`, npmArchive, { flag: 'wx' });
await extract(sources, `${out}/source`); await extract(native, `${out}/native`); await extract(npm, `${out}/npm`);
const library = `${out}/source/lib/neonethack`;
assert.equal((await sourceState(library)).hash, preview.sourceHash);
const provenance = await checkCompiled(`${out}/npm/dist/wasm`); assert.equal(provenance.sourceHash, preview.sourceHash);
assert.equal(provenance.emscripten, manifest.toolchain.emscripten); assert.equal(provenance.lua, manifest.toolchain.lua);
const wasm = json(npm, 'dist/wasm/manifest.json'); assert.equal(wasm.buildId, preview.buildId); assert.equal(sha256(JSON.stringify(wasm.files)), preview.buildId);
assert.deepEqual(Object.keys(wasm.files).sort(), [...compiled, ...workers].sort());
for (const [path, hash] of Object.entries(wasm.files)) assert.equal(sha256(npm.get(`dist/wasm/${path}`).data), hash);
for (const path of notices) assert.ok(npm.get(`dist/wasm/${path}`)?.data.length > 100, `Missing runtime notice: ${path}`);
assert.deepEqual(npm.get('dist/wasm/NETHACK-LICENSE.txt').data, sources.get('lib/neonethack/engine/dat/license').data);
for (const [source, name] of [['LICENSE', 'EMSCRIPTEN-LICENSE.txt'], ['system/lib/libc/musl/COPYRIGHT', 'MUSL-COPYRIGHT.txt'], ['system/lib/compiler-rt/LICENSE.TXT', 'COMPILER-RT-LICENSE.txt'], ['system/lib/llvm-libc/LICENSE.TXT', 'LLVM-LIBC-LICENSE.txt']])
  assert.deepEqual(npm.get(`dist/wasm/${name}`).data, sources.get(sdkPrefix + source).data, `Runtime notice: ${name}`);
const lua = readTar(sources.get('lib/neonethack/third_party/lua-5.4.9.tar.gz').data, 'lua-5.4.9');
const header = lua.get('src/lua.h').data.toString();
const license = header.slice(header.lastIndexOf('Copyright (C)'), header.lastIndexOf('*/')).replace(/^\s*\*+ ?/gm, '').trim();
const normalize = text => text.replace(/\s+/g, ' ').trim();
assert.equal(normalize(npm.get('dist/wasm/LUA-LICENSE.txt').data.toString()), normalize(license));
assert.equal(normalize(native.get('share/neonethack/LUA-LICENSE.txt').data.toString()), normalize(license));
// Reuse the artifact validator against an independently extracted source/npm
// pair. This only stages dist in our NEW audit directory; it never re-signs it.
await extract(new Map([...npm].filter(([path]) => path.startsWith('dist/')).map(([path, value]) => [path.slice(5), value])), `${library}/dist`);
await checkPackage(library);
const env = { ...process.env, SOURCE_DATE_EPOCH: String(preview.epoch), LUA_HOME: '', GIT_CEILING_DIRECTORIES: `${out}/source` };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'LD_LIBRARY_PATH', 'NNH_LUA_ARCHIVE', 'NEONETHACK_EXECUTABLE', 'NNH_FAULT_MODULE']) delete env[name];
async function run(command, args, cwd = library, input) {
  console.log(`> ${command} ${args.join(' ')}`);
  return new Promise((resolve_, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'] });
    if (input !== undefined) { child.stdin.on('error', reject); child.stdin.end(input); }
    child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve_() : reject(Error(`${command} failed: ${code ?? signal}; audit retained at ${out}`)));
  });
}
const consumer = `${out}/consumer`; await mkdir(consumer);
await writeFile(`${consumer}/package.json`, JSON.stringify({ private: true, type: 'module',
  dependencies: { neonethack: `file:${out}/verified-npm.tgz`, '@modelcontextprotocol/sdk': metadata.devDependencies['@modelcontextprotocol/sdk'] },
  devDependencies: { typescript: metadata.devDependencies.typescript, '@types/node': metadata.devDependencies['@types/node'] },
}, null, 2));
await copyFile(`${root}/tests/archive-consumer.mjs`, `${consumer}/smoke.mjs`);
await copyFile(`${root}/tests/archive-consumer.ts`, `${consumer}/smoke.ts`);
await run('npm', ['install', '--ignore-scripts', '--registry=https://registry.npmjs.org'], consumer);
await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--resolveJsonModule', 'smoke.ts'], consumer);
await run(process.execPath, ['smoke.mjs', `${out}/native`], consumer);
await mkdir(`${out}/c-consumer`);
await copyFile(`${out}/source/examples/c/main.c`, `${out}/c-consumer/main.c`);
await writeFile(`${out}/c-consumer/CMakeLists.txt`, 'cmake_minimum_required(VERSION 3.20)\nproject(consumer C)\nfind_package(neonethack CONFIG REQUIRED)\nadd_executable(consumer main.c)\ntarget_link_libraries(consumer PRIVATE neonethack::neonethack)\n');
await run('cmake', ['-S', `${out}/c-consumer`, '-B', `${out}/c-consumer/build`, '-G', 'Ninja', `-DCMAKE_PREFIX_PATH=${out}/native`]);
await run('cmake', ['--build', `${out}/c-consumer/build`]);
await run(`${out}/c-consumer/build/consumer`, [`${out}/native/libexec/neonethack/engine`, `${out}/native/share/neonethack/data`, `${out}/c-worlds`]);
// Remove the staged npm dist before rebuilding: extraction completeness, not
// cached compiler output from either the preview or packed npm, is tested.
const { rm } = await import('node:fs/promises'); await rm(`${library}/dist`, { recursive: true });
await run('node', ['scripts/generate.ts', '--check']);
await run('make', ['test']);
await run('npm', ['ci', '--ignore-scripts', '--registry=https://registry.npmjs.org']);
await run('make', ['wasm']);
await run('npm', ['test']);
await run('npm', ['run', 'test:wasm']);
await run('npm', ['run', 'test:browser']);
const rebuilt = await checkPackage(library); assert.equal(rebuilt.sourceHash, preview.sourceHash);
await writeFile(`${out}/AUDIT.json`, JSON.stringify({ publicationApproved: false, sourceHash: preview.sourceHash, archivedBuildId: preview.buildId, rebuiltBuildId: rebuilt.buildId, sourceFilesVerified: Object.keys(manifest.files).length, archives: preview.archives, checks: ['archive-structure-hashes-inventories', 'installed-typescript-public-exports', 'installed-native-wasm-webmcp-mcp-bin-consumers', 'installed-cmake-c-consumer', 'extracted-source-native-wasm-browser-rebuild'] }, null, 2) + '\n');
console.log(`Independent archive audit passed: ${out}. No publication or license grant.`);
