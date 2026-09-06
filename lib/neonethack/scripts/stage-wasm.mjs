import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sourceState, sha256 } from './source-files.mjs';
import { wasmInputs, toolchain } from './wasm-inputs.mjs';
import { compiled } from './check-package.mjs';
const root = resolve(import.meta.dirname, '..');
const [artifacts, lua, emscripten] = process.argv.slice(2);
if (!artifacts || !lua || !emscripten) throw Error('usage: stage-wasm.mjs ARTIFACTS LUA_SOURCE EMSCRIPTEN_ROOT');
const out = `${root}/dist/wasm`;
await mkdir(out, { recursive: true });
for (const name of ['neonethack-core.mjs', 'neonethack-core.wasm', 'neonethack-engine.mjs', 'neonethack-engine.wasm', 'neonethack-engine.data']) await copyFile(`${artifacts}/${name}`, `${out}/${name}`);
await copyFile(`${root}/engine/dat/license`, `${out}/NETHACK-LICENSE.txt`);
const header = await readFile(`${lua}/src/lua.h`, 'utf8');
const compilerVersion = JSON.parse(await readFile(`${emscripten}/emscripten-version.txt`, 'utf8'));
const luaVersion = ['MAJOR', 'MINOR', 'RELEASE'].map(part => header.match(new RegExp(`#define LUA_VERSION_${part}\\s+"([^"\\n]+)"`))?.[1]).join('.');
if (compilerVersion !== toolchain.emscripten || luaVersion !== toolchain.lua) throw Error('WASM toolchain differs from its compiler cache profile');
const start = header.lastIndexOf('Copyright (C)');
if (start < 0) throw Error('Lua copyright notice not found');
await writeFile(`${out}/LUA-LICENSE.txt`, header.slice(start, header.lastIndexOf('*/')).replace(/^\s*\*+ ?/gm, '').trim() + '\n');
for (const [source, name] of [
  ['LICENSE', 'EMSCRIPTEN-LICENSE.txt'],
  ['system/lib/libc/musl/COPYRIGHT', 'MUSL-COPYRIGHT.txt'],
  ['system/lib/compiler-rt/LICENSE.TXT', 'COMPILER-RT-LICENSE.txt'],
  ['system/lib/llvm-libc/LICENSE.TXT', 'LLVM-LIBC-LICENSE.txt'],
]) await copyFile(`${emscripten}/${source}`, `${out}/${name}`);
const hashes = {};
for (const name of compiled) hashes[name] = sha256(await readFile(`${out}/${name}`));
await writeFile(`${out}/build.json`, JSON.stringify({ version: 1, compileKey: await wasmInputs(), toolchain, sourceHash: (await sourceState()).hash, emscripten: JSON.parse(await readFile(`${emscripten}/emscripten-version.txt`, 'utf8')), lua: '5.4.9', compiled: hashes }, null, 2) + '\n');
await import('./copy-runtime.mjs');
console.log(`WASM package staged at ${out}`);
