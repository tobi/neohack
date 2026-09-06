// Build separate temporary engines with controlled real objects. No release
// binary, data, recording or existing save is modified. Both targets execute
// the same fixture C and normal engine pickup/transfer code.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, writeFile, cp, rm, access} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const hash = data => createHash('sha256').update(data).digest('hex');
export function pickupEngine(t, wasm = false) { return scenarioEngine(t, wasm, 'pickup-fixture.inc', 'pickup_fixture'); }
export async function scenarioEngine(t, wasm, fixtureFile, prepare) {
  const fixturePath = resolve(root, 'tests', fixtureFile);
  const temp = await mkdtemp('/tmp/nnh-pickup-engine-');
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const original = await readFile(`${root}/engine/win/headless/winheadless.c`,'utf8');
  const source = original.replace('static char *\nhl_input(', `#include ${JSON.stringify(fixturePath)}\nstatic char *\nhl_input(`);
  await writeFile(`${temp}/winheadless.c`, source);
  const main = await readFile(`${root}/engine/src/allmain.c`,'utf8');
  const initial = '        (void) pickup(1);      /* autopickup at initial location */';
  assert.ok(main.includes(initial));
  const fixtureMain = main.replace(initial, `        { extern void ${prepare}(void); ${prepare}(); }\n` + initial);
  await writeFile(`${temp}/allmain.c`,fixtureMain);
  if (!wasm) {
    const cwd = `${root}/engine/src`;
    const flags = async expression => (await run('make',['-s','--eval',`nnh-test-flags:;@echo ${expression}`,'nnh-test-flags'],{cwd})).stdout.trim().split(/\s+/);
    const compile = await flags('$(TARGET_CC) $(TARGET_CFLAGS)');
    const link = await flags('$(TARGET_LINK) $(TARGET_LFLAGS) $(HOBJ) $(DATE_O) $(GENTILEOFILE) $(TARGET_HACKLIB) $(WINLIB) $(TARGET_LIBS) $(LUALIBS) $(AUTOLIBS)');
    await run(compile[0],[...compile.slice(1),`-I${root}/engine/win/headless`,'-c',`${temp}/winheadless.c`,'-o',`${temp}/winheadless.o`],{cwd});
    await run(compile[0],[...compile.slice(1),'-c',`${temp}/allmain.c`,'-o',`${temp}/allmain.o`],{cwd});
    const luaHeader = /#include "([^"]*lua.h)"/.exec(await readFile(`${root}/engine/include/nhlua.h`,'utf8'))?.[1];
    assert.ok(luaHeader);
    let lua;
    for (const candidate of [resolve(dirname(luaHeader),'liblua.a'),resolve(dirname(luaHeader),'../lib/liblua.a')])
      if (await access(candidate).then(()=>true,()=>false)) { lua = candidate; break; }
    assert.ok(lua);
    await run(link[0],[...link.slice(1).map(arg=>arg === 'winheadless.o' ? `${temp}/winheadless.o` : arg === 'allmain.o' ? `${temp}/allmain.o` : /lua.*\.a$/.test(arg) ? lua : arg),'-o',`${temp}/engine`],{cwd});
    return {enginePath:`${temp}/engine`};
  }
  const cwd = `${root}/build/wasm`;
  const lines = (await run('ninja',['-t','commands','artifacts/neonethack-engine.mjs'],{cwd,maxBuffer:4*1024*1024})).stdout.trim().split('\n');
  const obj = 'CMakeFiles/neonethack-engine.dir/engine/win/headless/winheadless.c.o';
  const compile = lines.find(line=>line.includes(`-o ${obj} `));
  assert.ok(compile);
  await run('sh',['-c',compile.replace(/ -MD -MT \S+ -MF \S+/, '')
    .replace(`-o ${obj}`, `-I${quote(`${root}/engine/win/headless`)} -o ${quote(`${temp}/winheadless.o`)}`)
    .replace(`-c ${root}/engine/win/headless/winheadless.c`, `-c ${quote(`${temp}/winheadless.c`)}`)],{cwd});
  const mainObj = 'CMakeFiles/neonethack-engine.dir/engine/src/allmain.c.o';
  const mainCompile = lines.find(line=>line.includes(`-o ${mainObj} `)); assert.ok(mainCompile);
  await run('sh',['-c',mainCompile.replace(/ -MD -MT \S+ -MF \S+/, '')
    .replace(`-o ${mainObj}`, `-o ${quote(`${temp}/allmain.o`)}`)
    .replace(`-c ${root}/engine/src/allmain.c`, `-c ${quote(`${temp}/allmain.c`)}`)],{cwd});
  await cp(`${root}/dist/wasm`,`${temp}/wasm`,{recursive:true});
  const link = lines.at(-1).replace(obj, quote(`${temp}/winheadless.o`))
    .replace(mainObj, quote(`${temp}/allmain.o`))
    .replace('-o artifacts/neonethack-engine.mjs', `-o ${quote(`${temp}/wasm/neonethack-engine.mjs`)}`);
  await run('sh',['-c',link],{cwd,maxBuffer:4*1024*1024});
  const manifest = JSON.parse(await readFile(`${temp}/wasm/manifest.json`,'utf8'));
  const build = JSON.parse(await readFile(`${temp}/wasm/build.json`,'utf8'));
  for (const name of ['neonethack-engine.mjs','neonethack-engine.wasm','neonethack-engine.data']) {
    const digest = hash(await readFile(`${temp}/wasm/${name}`));
    manifest.files[name] = digest; build.compiled[name] = digest;
  }
  build.sourceHash = hash(source + fixtureMain + await readFile(fixturePath,'utf8'));
  await writeFile(`${temp}/wasm/build.json`, JSON.stringify(build));
  if ('build.json' in manifest.files) manifest.files['build.json'] = hash(await readFile(`${temp}/wasm/build.json`));
  manifest.buildId = hash(JSON.stringify(manifest.files));
  await writeFile(`${temp}/wasm/manifest.json`,JSON.stringify(manifest));
  return {workerUrl: new URL(`file://${temp}/wasm/core-worker.mjs`)};
}
