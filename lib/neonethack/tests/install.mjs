import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, writeFile, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from './native-fixture.mjs';
const env = { ...process.env };
delete env.LD_LIBRARY_PATH;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
// Explicit suite: compiling four configurations is not part of npm's fast tests.
for (const [shared, type, generator] of [
  ['OFF', 'Debug', 'Ninja'], ['OFF', 'Release', 'Unix Makefiles'],
  ['ON', 'Debug', 'Unix Makefiles'], ['ON', 'Release', 'Ninja'],
]) test(`installed ${type} shared=${shared} ${generator}, relocated without loader environment`, { timeout: 120_000 }, async t => {
  const dir = await mkdtemp(`${tmpdir()}/neonethack-install-`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  run('cmake', ['-S', root, '-B', `${dir}/build`, '-G', generator, `-DCMAKE_BUILD_TYPE=${type}`, `-DBUILD_SHARED_LIBS=${shared}`, '-DNNH_INSTALL_ENGINE=OFF', '-DBUILD_TESTING=OFF', '-DCMAKE_INSTALL_LIBDIR=lib']);
  run('cmake', ['--build', `${dir}/build`, '-j4']);
  run('cmake', ['--install', `${dir}/build`, '--prefix', `${dir}/original`]);
  const prefix = `${dir}/relocated prefix`;
  await rename(`${dir}/original`, prefix);
  const result = run(`${prefix}/bin/neonethack`, [`${root}/engine/playground/nethack`, `${root}/engine/playground`, `${dir}/worlds`], { input: '{"version":1,"method":"protocol.describe","params":{}}\n' });
  assert.equal(JSON.parse(result).version, 1);
  assert.ok(JSON.parse(result).catalog.methods.length > 20);
  await mkdir(`${dir}/consumer`);
  await writeFile(`${dir}/consumer/main.c`, '#include <neonethack.h>\nint main(void) {nnh_result_free(0); nnh_context_close(0); return 0;}\n');
  await writeFile(`${dir}/consumer/CMakeLists.txt`, 'cmake_minimum_required(VERSION 3.20)\nproject(consumer LANGUAGES C CXX)\nfind_package(neonethack CONFIG REQUIRED)\nadd_executable(consumer main.c)\ntarget_link_libraries(consumer PRIVATE neonethack::neonethack)\n');
  run('cmake', ['-S', `${dir}/consumer`, '-B', `${dir}/consumer/build`, '-G', 'Ninja', `-DCMAKE_PREFIX_PATH=${prefix}`]);
  run('cmake', ['--build', `${dir}/consumer/build`]);
  run(`${dir}/consumer/build/consumer`, []);
  const libdir = run('pkg-config', ['--variable=libdir', 'neonethack'], { env: { ...env, PKG_CONFIG_PATH: `${prefix}/lib/pkgconfig` } }).trim();
  // pkgconf escapes spaces even in --variable output for shell consumers.
  assert.equal(await realpath(libdir.replace(/\\(.)/g, '$1')), await realpath(`${prefix}/lib`));
  const publicHeader = await readFile(`${prefix}/include/neonethack.h`, 'utf8');
  const documented = [...new Set([...publicHeader.matchAll(/\b(nnh_\w+)\s*\(/g)].map(m => m[1]))].sort();
  if (shared === 'OFF' && process.platform === 'linux') {
    const symbols = [...run('nm', ['-g', '--defined-only', `${prefix}/lib/libneonethack.a`]).matchAll(/^\w+\s+\w\s+(\w+)$/gm)].map(m => m[1]);
    assert.ok(symbols.length > documented.length);
    for (const symbol of symbols) assert.ok(documented.includes(symbol) || symbol.startsWith('nnh_private_'), `Unexpected static link name: ${symbol}`);
    for (const symbol of documented) assert.ok(symbols.includes(symbol));
  }
  if (shared === 'ON' && process.platform === 'linux') {
    const exports = run('nm', ['-D', '--defined-only', `${prefix}/lib/libneonethack.so`]).trim().split('\n').map(line => line.trim().split(/\s+/).at(-1)).sort();
    assert.deepEqual(exports, documented, 'Only the public header functions may be dynamically exported');
  }
  const example = await readFile(resolve(root, '../../examples/c/main.c'), 'utf8');
  // Generic host names must neither collide in static linkage nor interpose
  // in shared linkage. Additionally test the actual hidden shared parser name.
  // These are deliberately conflicting host definitions, not private API calls.
  const canary = 'int mj_valid(const char *s) { (void)s; return 0; }\n'
    + 'void *nhx_open(const char *a, const char *b, const char *c) { (void)a; (void)b; (void)c; return 0; }\n'
    + 'void *nh_session_start(const char *a, const char *b, char *const c[]) { (void)a; (void)b; (void)c; return 0; }\n'
    + (shared === 'ON' ? 'int nnh_private_mj_valid(const char *s) { (void)s; return 0; }\n' : '');
  await writeFile(`${dir}/consumer/installed.c`, canary + example);
  const flags = run('pkg-config', ['--cflags', '--libs', '--static', 'neonethack'], { env: { ...env, PKG_CONFIG_PATH: `${prefix}/lib/pkgconfig` } });
  const args = (flags.match(/(?:\\.|[^\s])+/g) ?? []).map(arg => arg.replace(/\\(.)/g, '$1'));
  run('cc', ['-Wall', '-Wextra', '-Werror', `${dir}/consumer/installed.c`, ...args, ...(process.platform === 'linux' ? ['-Wl,--export-dynamic'] : []), `-Wl,-rpath,${prefix}/lib`, '-o', `${dir}/consumer/installed`]);
  const played = JSON.parse(run(`${dir}/consumer/installed`, [`${root}/engine/playground/nethack`, `${root}/engine/playground`, `${dir}/pkg-worlds`]));
  assert.equal(played.error, undefined); assert.equal(played.revision, 1);
  run('c++', ['-Wall', '-Wextra', '-Werror', `-I${prefix}/include`, '-x', 'c++', '-fsyntax-only', '-'], { input: '#include <neonethack.h>\nint main(){return 0;}\n' });
});
