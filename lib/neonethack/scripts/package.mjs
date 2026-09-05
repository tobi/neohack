// Build a LOCAL preview from a source snapshot. Never publish, upload, modify
// the user's Git index, or package a live playground. SDK/compiler are external.
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { root, sourceState, walk, sha256, regularSource } from './source-files.mjs';
import { checkPackage } from './check-package.mjs';
const luaHash = '2335b6c582a52654f94612bf10d2f4672805d05329aa6568b1d8cd9e5c6fb8e6';
const metadata = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
const out = resolve(process.argv[2] ?? `${root}/build/preview-${Date.now()}`);
const sdk = process.env.EMSDK && resolve(process.env.EMSDK, 'upstream/emscripten');
if (!sdk) throw Error('Set EMSDK to the installed SDK root (tested Emscripten 6.0.9).');
const sdkVersion = JSON.parse(await readFile(`${sdk}/emscripten-version.txt`, 'utf8'));
if (sdkVersion !== '6.0.9') throw Error(`Preview toolchain must be 6.0.9, not ${sdkVersion}; review/update the recipe explicitly.`);
if (await lstat(out).catch(() => null)) throw Error(`Output must not already exist: ${out}`);
const source = `${out}/work/neonethack-${metadata.version}`;
const library = `${source}/lib/neonethack`;
const prefix = `${out}/work/native`;
await mkdir(library, { recursive: true });
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.now() / 1000));
if (!Number.isSafeInteger(epoch) || epoch < 0) throw Error('Invalid SOURCE_DATE_EPOCH');
const env = { ...process.env, SOURCE_DATE_EPOCH: String(epoch), LUA_HOME: '', GIT_CEILING_DIRECTORIES: source };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'NNH_LUA_ARCHIVE', 'LD_LIBRARY_PATH']) delete env[name];
async function run(command, args, cwd = library, capture = false) {
  console.log(`> ${command} ${args.join(' ')}`);
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; if (output.length > 1024 * 1024) { child.kill(); reject(Error('Unexpectedly large output')); } });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve(output) : reject(Error(`${command} failed: ${code ?? signal}`)));
  });
}
const sourceManifest = {};
async function record(relative, bytes, mode = 0o644) {
  const destination = `${source}/${relative}`;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: 'wx', mode });
  sourceManifest[relative] = sha256(bytes);
}
const state = await sourceState();
for (const [path, hash] of Object.entries(state.files)) {
  const bytes = await readFile(`${root}/${path}`);
  if (sha256(bytes) !== hash) throw Error(`Source changed during snapshot: ${path}`);
  await record(`lib/neonethack/${path}`, bytes, (await lstat(`${root}/${path}`)).mode & 0o777);
}
if ((await sourceState()).hash !== state.hash) throw Error('Sources changed while taking snapshot; start a new preview.');
const repo = resolve(root, '../..');
async function rootSource(path) {
  await regularSource(repo, path);
  return readFile(`${repo}/${path}`);
}
await record('Makefile', await rootSource('Makefile'));
for (const path of ['c/main.c', 'wasm/index.html', 'wasm/neonethack.ts']) await record(`examples/${path}`, await rootSource(`examples/${path}`));
await record('README.md', `# neonethack ${metadata.version} source snapshot\n\nRead lib/neonethack/README.md and docs/DISTRIBUTION.md in that directory.\nSOURCE-MANIFEST.json records all source/dependency bytes and the build epoch.\nThe native engine and WASM build use the included Lua source archive. The\nexternal compiler/Emscripten SDK and npm tooling must be installed separately.\nThis is a local preview, not an authorized publication or a new license grant.\n`);
// Keep the original hash-checked archive; both build recipes use it locally.
let lua;
try { lua = await readFile(`${root}/build/wasm/_deps/lua-subbuild/lua-populate-prefix/src/lua-5.4.9.tar.gz`); }
catch {
  const response = await fetch('https://www.lua.org/ftp/lua-5.4.9.tar.gz');
  if (!response.ok) throw Error(`Lua download failed: ${response.status}`);
  lua = Buffer.from(await response.arrayBuffer());
}
if (sha256(lua) !== luaHash) throw Error('Lua source archive checksum mismatch');
await record('lib/neonethack/third_party/lua-5.4.9.tar.gz', lua);
// Include the actual SDK's runtime JS, C/C++/assembly and headers, with all
// notices. These are source only, not the SDK binaries/cache or a compiler.
for (const dir of ['src', 'system/lib', 'system/include']) for (const path of await walk(`${sdk}/${dir}`)) {
  if (/(^|\/)(\.git|node_modules|__pycache__|cache)(\/|$)|\.(o|a|bc|wasm|pyc)$/.test(path)) throw Error(`Unexpected generated SDK input: ${dir}/${path}`);
  await record(`lib/neonethack/third_party/emscripten-runtime/${dir}/${path}`, await readFile(`${sdk}/${dir}/${path}`));
}
for (const name of ['LICENSE', 'emscripten-version.txt']) await record(`lib/neonethack/third_party/emscripten-runtime/${name}`, await readFile(`${sdk}/${name}`));
await record('lib/neonethack/third_party/README.md', 'Lua 5.4.9: unmodified archive from https://www.lua.org/ftp/lua-5.4.9.tar.gz.\nEmscripten 6.0.9 runtime source and headers copied from the build SDK. This\nis not a full compiler/SDK distribution. Use the external 6.0.9 SDK to build;\nits bundled license files govern those components. Project code licensing is\nnot granted by bundling third-party source.\n');
await run('node', ['scripts/generate.ts', '--check']);
await run('make', ['test']);
await run('npm', ['ci', '--ignore-scripts', '--registry=https://registry.npmjs.org']);
await run('npm', ['test']);
await run('make', ['wasm']);
await run('npm', ['run', 'test:wasm']);
await run('npm', ['run', 'test:browser']);
await run('cmake', ['--install', 'build/native', '--prefix', prefix]);
await run('cc', ['-Wall', '-Wextra', '-Werror', `-I${prefix}/include`, `${source}/examples/c/main.c`, `-L${prefix}/lib`, '-lneonethack', '-pthread', '-o', `${out}/work/c-client`]);
const frame = JSON.parse(await run(`${out}/work/c-client`, [`${prefix}/libexec/neonethack/engine`, `${prefix}/share/neonethack/data`, `${out}/work/test-worlds`], library, true));
if (frame.error || frame.revision !== 1) throw Error('Installed C client did not deliver the expected game frame');
const identity = await checkPackage(library);
const sourceName = `neonethack-${metadata.version}-source.tar.gz`;
await writeFile(`${source}/SOURCE-MANIFEST.json`, JSON.stringify({ version: 1, sourceHash: state.hash, epoch, toolchain: { emscripten: sdkVersion, lua: '5.4.9' }, files: sourceManifest }, null, 2) + '\n');
// No generated build/test worlds from work/ enter any artifact.
const archiveFlags = ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner'];
const sourcePaths = [...Object.keys(sourceManifest), 'SOURCE-MANIFEST.json'].sort().map(p => `neonethack-${metadata.version}/${p}`);
await writeFile(`${out}/source-paths.list`, sourcePaths.join('\0') + '\0');
await run('tar', [...archiveFlags, '-czf', `${out}/${sourceName}`, '--null', '-T', `${out}/source-paths.list`], `${out}/work`);
await writeFile(`${prefix}/share/neonethack/SOURCE.json`, JSON.stringify({ ...identity, sourceArchive: sourceName, epoch }, null, 2) + '\n');
const nativePaths = await walk(prefix);
const nativeAllowed = /^(bin\/neonethack|include\/neonethack\.h|lib\/libneonethack\.a|lib\/cmake\/neonethack\/neonethack(?:Config|ConfigVersion|Targets|Targets-release)\.cmake|lib\/pkgconfig\/neonethack\.pc|libexec\/neonethack\/engine|share\/neonethack\/(?:README\.md|NOTICE\.md|license|LUA-LICENSE\.txt|SOURCE\.json|data\/(?:nhdat|symbols|sysconf|license)|protocol\/(?:catalog\.json|request\.schema\.json|response\.schema\.json)))$/;
for (const path of nativePaths) if (!nativeAllowed.test(path)) throw Error(`Unexpected native install artifact: ${path}`);
await writeFile(`${out}/native-paths.list`, nativePaths.map(p => `native/${p}`).join('\0') + '\0');
const nativeName = `neonethack-${metadata.version}-${process.platform}-${process.arch}.tar.gz`;
await run('tar', [...archiveFlags, '-czf', `${out}/${nativeName}`, '--null', '-T', `${out}/native-paths.list`], `${out}/work`);
await run('npm', ['pack', '--pack-destination', out]);
const npmName = `neonethack-${metadata.version}.tgz`;
const archives = {};
for (const name of [sourceName, nativeName, npmName]) archives[name] = sha256(await readFile(`${out}/${name}`));
await writeFile(`${out}/PREVIEW.json`, JSON.stringify({ version: metadata.version, publicationApproved: false, ...identity, epoch, archives }, null, 2) + '\n');
await writeFile(`${out}/SHA256SUMS`, Object.entries(archives).map(([name, hash]) => `${hash}  ${name}`).join('\n') + '\n');
await run(process.execPath, ['scripts/check-archives.mjs', out, `${out}/audit`]);
console.log(`Local preview complete: ${out}\nNo publication or license grant was performed. Keep all three matching archives together.`);
