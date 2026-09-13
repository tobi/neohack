import { mkdir, copyFile, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sourceState, sha256 } from './source-files.mjs';
import { wasmInputs, toolchain } from './wasm-inputs.mjs';
import { compiled } from './check-package.mjs';
const root = resolve(import.meta.dirname, '..');
const [artifacts, lua, emscripten] = process.argv.slice(2);
if (!artifacts || !lua || !emscripten) throw Error('usage: stage-wasm.mjs ARTIFACTS LUA_SOURCE EMSCRIPTEN_ROOT');
const out = `${root}/dist/wasm`;
await mkdir(out, { recursive: true });
await copyFile(`${root}/engine/dat/license`, `${out}/NETHACK-LICENSE.txt`);
const header = await readFile(`${lua}/src/lua.h`, 'utf8');
// The pinned Nix package builds the upstream release tag, whose source marker
// is plain text with a -git suffix (not the SDK installer's JSON string).
const compilerVersion = (await readFile(`${emscripten}/emscripten-version.txt`, 'utf8')).trim();
const luaVersion = ['MAJOR', 'MINOR', 'RELEASE'].map(part => header.match(new RegExp(`#define LUA_VERSION_${part}\\s+"([^"\\n]+)"`))?.[1]).join('.');
if (compilerVersion !== `${toolchain.emscripten}-git` || luaVersion !== toolchain.lua) throw Error('WASM toolchain differs from its compiler cache profile');
for (const name of compiled) await copyFile(`${artifacts}/${name}`, `${out}/${name}`);
const start = header.lastIndexOf('Copyright (C)');
if (start < 0) throw Error('Lua copyright notice not found');
await writeFile(`${out}/LUA-LICENSE.txt`, header.slice(start, header.lastIndexOf('*/')).replace(/^\s*\*+ ?/gm, '').trim() + '\n');
for (const [source, name] of [
  ['LICENSE', 'EMSCRIPTEN-LICENSE.txt'],
  ['system/lib/libc/musl/COPYRIGHT', 'MUSL-COPYRIGHT.txt'],
  ['system/lib/compiler-rt/LICENSE.TXT', 'COMPILER-RT-LICENSE.txt'],
  ['system/lib/llvm-libc/LICENSE.TXT', 'LLVM-LIBC-LICENSE.txt'],
]) {
  // Nix-store files are read-only. Staged notices must remain writable for
  // the next build without changing the immutable compiler installation.
  const destination = `${out}/${name}`;
  await chmod(destination, 0o644).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await writeFile(destination, await readFile(`${emscripten}/${source}`), {mode: 0o644});
}
const hashes = {};
for (const name of compiled) hashes[name] = sha256(await readFile(`${out}/${name}`));
await writeFile(`${out}/build.json`, JSON.stringify({ version: 1, compileKey: await wasmInputs(), toolchain, sourceHash: (await sourceState()).hash, emscripten: toolchain.emscripten, lua: toolchain.lua, compiled: hashes }, null, 2) + '\n');
await import('./copy-runtime.mjs');
console.log(`WASM package staged at ${out}`);
