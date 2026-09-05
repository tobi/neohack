import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { root, sourceState, sha256, walk } from './source-files.mjs';
import { checkInventory, distFiles } from './package-files.mjs';
export const compiled = ['neonethack-core.mjs', 'neonethack-core.wasm', 'neonethack-engine.mjs', 'neonethack-engine.wasm', 'neonethack-engine.data'];
export const workers = ['assets.mjs', 'block-store.mjs', 'core-worker.mjs', 'engine-worker.mjs', 'worker-port.mjs'];
export const notices = ['NETHACK-LICENSE.txt', 'LUA-LICENSE.txt', 'EMSCRIPTEN-LICENSE.txt', 'MUSL-COPYRIGHT.txt', 'COMPILER-RT-LICENSE.txt', 'LLVM-LIBC-LICENSE.txt'];
export async function checkCompiled(directory, optional = false) {
  const names = await readdir(directory);
  if (optional && !compiled.some(name => names.includes(name))) return null;
  let build;
  try { build = JSON.parse(await readFile(`${directory}/build.json`, 'utf8')); }
  catch { throw Error('Missing WASM build provenance. Run make wasm before packing.'); }
  if (build.version !== 1 || !/^[a-f0-9]{64}$/.test(build.sourceHash)) throw Error('Invalid WASM build provenance');
  for (const name of compiled) if (sha256(await readFile(`${directory}/${name}`)) !== build.compiled[name]) throw Error(`WASM build artifact changed since staging: ${name}. Rebuild, do not re-sign damaged artifacts.`);
  return build;
}
export async function checkPackage(base = root) {
  const directory = `${base}/dist/wasm`;
  const build = await checkCompiled(directory);
  if (build.sourceHash !== (await sourceState(base)).hash) throw Error('Sources changed since the WASM build. Rebuild make wasm before packing a matching source/binary pair.');
  checkInventory(await readdir(directory), [...compiled, ...workers, ...notices, 'manifest.json', 'build.json'], 'WASM');
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
  const runtime = [...compiled, ...workers].sort();
  if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(runtime)) throw Error('Incomplete WASM manifest');
  if (sha256(JSON.stringify(manifest.files)) !== manifest.buildId) throw Error('Invalid manifest identity');
  for (const name of runtime) if (sha256(await readFile(`${directory}/${name}`)) !== manifest.files[name]) throw Error(`Manifest mismatch: ${name}`);
  for (const name of notices) if ((await readFile(`${directory}/${name}`)).length < 100) throw Error(`Missing/empty runtime notice: ${name}`);
  if (!(await readFile(`${directory}/NETHACK-LICENSE.txt`)).equals(await readFile(`${base}/engine/dat/license`))) throw Error('NetHack notice differs from source');
  for (const name of workers) if (!(await readFile(`${directory}/${name}`)).equals(await readFile(`${base}/wasm/${name}`))) throw Error(`WASM worker differs from source: ${name}`);
  const files = await walk(`${base}/dist`);
  checkInventory(files.filter(file => !file.startsWith('wasm/')), distFiles, 'dist');
  for (const file of files) {
    if (file.startsWith('wasm/')) continue;
    if (/^protocol\/(catalog|request\.schema|response\.schema)\.json$/.test(file)) {
      if (JSON.stringify(JSON.parse(await readFile(`${base}/dist/${file}`, 'utf8'))) !== JSON.stringify(JSON.parse(await readFile(`${base}/${file}`, 'utf8')))) throw Error(`Stale compiled schema: ${file}`);
      continue;
    }
    const bytes = await readFile(`${base}/dist/${file}`, 'utf8');
    if (/(\/home\/[^/]+\/|\/Users\/|\/tmp\/neonethack-source-check)/.test(bytes)) throw Error(`Machine-local path in dist: ${file}`);
    if (file.endsWith('.js.map') && !JSON.parse(bytes).sourcesContent?.length) throw Error(`Source map lacks source: ${file}`);
  }
  console.log(`Package verified: source ${build.sourceHash}, WASM ${manifest.buildId}`);
  return { sourceHash: build.sourceHash, buildId: manifest.buildId };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await checkPackage();
