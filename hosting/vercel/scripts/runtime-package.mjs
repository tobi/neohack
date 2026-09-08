import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wasmInputs, toolchain } from '../../../lib/neonethack/scripts/wasm-inputs.mjs';
import { sourceState, sha256 } from '../../../lib/neonethack/scripts/source-files.mjs';
import { compiled, notices, workers, checkCompiled } from '../../../lib/neonethack/scripts/check-package.mjs';
export const root = resolve(import.meta.dirname, '../../..');
const dist = `${root}/lib/neonethack/dist/wasm`;
const cache = `${root}/hosting/vercel/.runtime-cache`;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function validateRegistry(registry) {
  if (registry.version !== 1 || !registry.builds || !registry.packages ||
      Object.entries(registry.builds).some(([key, value]) => !hash(key) || !hash(value) || !registry.packages[value]) ||
      Object.keys(registry.packages).some(key => !hash(key))) throw Error('Invalid runtime registry');
  for (const [id, manifest] of Object.entries(registry.packages)) {
    if (manifest.version !== 1 || manifest.buildId !== id || sha256(JSON.stringify(manifest.files)) !== id ||
        [...compiled,'assets.mjs','block-store.mjs','core-worker.mjs','engine-worker.mjs','worker-port.mjs'].some(name=>!(name in manifest.files)) ||
        Object.keys(manifest.files).some(name=>![...compiled,...workers].includes(name)) ||
        Object.values(manifest.files).some(value=>!hash(value))) throw Error('Invalid runtime manifest');
  }
  return registry;
}
async function get(base, path, optional = false) {
  const response = await fetch(new URL(path, base), {signal:AbortSignal.timeout(60000),cache:'no-store'});
  if (optional && response.status === 404) return null;
  if (!response.ok) throw Error(`Runtime fetch failed: ${path} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
export async function restore(base, directory = dist, cacheDirectory = cache) {
  const raw = await get(base, 'runtime/wasm/registry.json', true);
  const registry = raw ? validateRegistry(JSON.parse(new TextDecoder().decode(raw))) : {version:1,builds:{},packages:{}};
  await rm(cacheDirectory, {recursive:true,force:true}); await mkdir(cacheDirectory,{recursive:true});
  // Retain published immutable packages in the next deployment's asset manifest.
  // Vercel's asset hash negotiation uploads only missing contents.
  const downloaded = new Map();
  for (const [id, manifest] of Object.entries(registry.packages)) {
    const target = `${cacheDirectory}/${id}`; await mkdir(target,{recursive:true});
    await Promise.all([...Object.keys(manifest.files), ...notices].map(async name => {
      const existing = downloaded.get(manifest.files[name]);
      if (existing) { await cp(existing, `${target}/${name}`); return; }
      const bytes = await get(base, `runtime/wasm/${id}/${name}`);
      if (manifest.files[name] && sha256(bytes) !== manifest.files[name]) throw Error(`Corrupt hosted runtime: ${id}/${name}`);
      await writeFile(`${target}/${name}`,bytes);
      if (manifest.files[name]) downloaded.set(manifest.files[name], `${target}/${name}`);
    }));
    await writeFile(`${target}/manifest.json`,JSON.stringify(manifest,null,2)+'\n');
  }
  // Build records are not runtime assets: source/provenance metadata can change
  // independently of an immutable executable package.
  for (const key of Object.keys(registry.builds)) {
    const record = await get(base,`runtime/wasm/builds/${key}.json`);
    await mkdir(`${cacheDirectory}/builds`,{recursive:true});
    await writeFile(`${cacheDirectory}/builds/${key}.json`,record);
  }
  await writeFile(`${cacheDirectory}/registry.json`,JSON.stringify(registry,null,2)+'\n');
  const compileKey = await wasmInputs();
  const id = registry.builds[compileKey];
  if (!id) return false;
  const build = JSON.parse(await readFile(`${cacheDirectory}/builds/${compileKey}.json`,'utf8'));
  if (build.compileKey !== compileKey || JSON.stringify(build.toolchain) !== JSON.stringify(toolchain)) throw Error('Hosted build inputs differ');
  await mkdir(directory,{recursive:true});
  for (const name of [...compiled,...notices]) await cp(`${cacheDirectory}/${id}/${name}`,`${directory}/${name}`);
  // The same compiled bytes now accompany this source tree. Verify the recorded
  // compiler inputs and byte hashes before refreshing its distribution provenance.
  await writeFile(`${directory}/build.json`,JSON.stringify({...build,sourceHash:(await sourceState()).hash},null,2)+'\n');
  await checkCompiled(directory);
  return true;
}
export async function stage(directory, source = dist, cacheDirectory = cache) {
  let registry;
  try {registry=validateRegistry(JSON.parse(await readFile(`${cacheDirectory}/registry.json`,'utf8')));}
  catch (error) {if(error.code!=='ENOENT') throw error; registry={version:1,builds:{},packages:{}};}
  const manifest=JSON.parse(await readFile(`${source}/manifest.json`,'utf8'));
  const build=await checkCompiled(source);
  if (build.compileKey !== await wasmInputs()) throw Error('WASM compiler inputs changed; rebuild before staging');
  const id=manifest.buildId;
  registry.packages[id]=manifest;
  // Keep the first verified compiler artifact for a key; wrapper-only updates
  // get a new package ID but do not invalidate the compiler cache.
  registry.builds[build.compileKey] ??= id;
  validateRegistry(registry);
  await mkdir(directory,{recursive:true});
  // The current TypeScript transport imports this small host bridge. Engine
  // workers and their dependencies use the immutable package copy instead.
  await cp(`${source}/worker-port.mjs`, `${directory}/worker-port.mjs`);
  for (const old of Object.keys(registry.packages)) if(old!==id) await cp(`${cacheDirectory}/${old}`,`${directory}/${old}`,{recursive:true});
  try {await cp(`${cacheDirectory}/builds`,`${directory}/builds`,{recursive:true});} catch(error){if(error.code!=='ENOENT')throw error;}
  await mkdir(`${directory}/${id}`,{recursive:true});
  for(const name of [...compiled,...workers,...notices,'manifest.json']) await cp(`${source}/${name}`,`${directory}/${id}/${name}`);
  for (const [packageId, expected] of Object.entries(registry.packages)) {
    await Promise.all(Object.entries(expected.files).map(async ([name, digest]) => {
      if (sha256(await readFile(`${directory}/${packageId}/${name}`)) !== digest)
        throw Error(`Runtime changed before deployment: ${packageId}/${name}`);
    }));
  }
  await mkdir(`${directory}/builds`,{recursive:true});
  const record=`${directory}/builds/${build.compileKey}.json`;
  try {await readFile(record);} catch(error){if(error.code!=='ENOENT')throw error; await writeFile(record,JSON.stringify(build,null,2)+'\n');}
  await writeFile(`${directory}/registry.json`,JSON.stringify(registry,null,2)+'\n');
  await writeFile(`${directory}/current.json`,JSON.stringify({version:1,buildId:id})+'\n');
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  if(process.argv[2]!=='restore')throw Error('usage: runtime-package.mjs restore https://neohack.dev/');
  const hit=await restore(process.argv[3]);
  if(process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT,`hit=${hit}\n`,{flag:'a'});
  console.log(hit?'Verified hosted compiler artifacts restored; compilation skipped.':'Compiler inputs are new; compilation required.');
}
