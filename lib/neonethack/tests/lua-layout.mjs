// Exercise automatic pkg-config selection independently of LUA_HOME/mise and
// the bundled archive, using supplied Lua headers/library in a multiarch layout.
// Usage: node tests/lua-layout.mjs /path/to/headers /path/to/liblua.a
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, copyFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeTransport } from '../dist/typescript/native.js';
import { Neonethack } from '../dist/typescript/client.js';
const root = resolve(import.meta.dirname, '..');
const [headers, library] = process.argv.slice(2);
if (!headers || !library) throw Error('Supply a Lua 5.4 header directory and static library');
const work = await mkdtemp(`${tmpdir()}/neonethack-lua-layout-`);
let api, passed = false;
try {
  const prefix = `${work}/system`, libdir = `${prefix}/lib/test-multiarch`, include = `${prefix}/include/lua5.4`;
  await mkdir(include, { recursive: true }); await mkdir(`${libdir}/pkgconfig`, { recursive: true });
  for (const file of ['lua.h', 'luaconf.h', 'lualib.h', 'lauxlib.h']) await copyFile(`${headers}/${file}`, `${include}/${file}`);
  await copyFile(library, `${libdir}/liblua5.4.a`);
  await writeFile(`${libdir}/pkgconfig/lua5.4.pc`, `prefix=${prefix}\nlibdir=${libdir}\nincludedir=${include}\nName: Lua 5.4 layout fixture\nDescription: Test pkg-config selection\nVersion: 5.4\nLibs: -L\${libdir} -llua5.4\nCflags: -I\${includedir}\n`);
  const source = `${work}/library`;
  const files = ['scripts/build-engine.sh', ...JSON.parse(await readFile(`${root}/engine/SOURCES.json`, 'utf8')).map(p => `engine/${p}`)];
  for (const file of files) { await mkdir(dirname(`${source}/${file}`), { recursive: true }); await copyFile(`${root}/${file}`, `${source}/${file}`); }
  const env = { ...process.env, PKG_CONFIG_LIBDIR: `${libdir}/pkgconfig`, PKG_CONFIG_PATH: '', NNH_LUA_ARCHIVE: `${work}/absent.tar.gz` };
  delete env.LUA_HOME; delete env.PKG_CONFIG_SYSROOT_DIR;
  const output = execFileSync('sh', [`${source}/scripts/build-engine.sh`], { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.ok(output.includes(`${libdir}/liblua5.4.a`), 'Build must link the pkg-config selected static library');
  assert.ok((await readFile(`${source}/engine/include/nhlua.h`, 'utf8')).includes(`${include}/lua.h`));
  assert.match(await readFile(`${source}/build/LUA-LICENSE.txt`, 'utf8'), /Copyright/);
  api = new Neonethack(new NativeTransport({ executable: process.env.NEONETHACK_EXECUTABLE ?? `${root}/build/native/neonethack`, enginePath: `${source}/engine/playground/nethack`, dataPath: `${source}/engine/playground`, sessionsPath: `${work}/sessions` }));
  const game = await api.create({ seed: 42, name: 'Pkgconfig', role: 'valkyrie', race: 'dwarf', gender: 'female', align: 'lawful' });
  const before = game.observation.turn;
  assert.equal((await game.wait()).observation.turn, before + 1);
  await game.close(); passed = true;
  console.log('pkg-config include/lua5.4 + multiarch/liblua5.4.a selection, fresh build and public gameplay passed');
} finally {
  await api?.close();
  if (passed) await rm(work, { recursive: true, force: true });
  else console.error(`Failed layout workspace preserved at ${work}`);
}
