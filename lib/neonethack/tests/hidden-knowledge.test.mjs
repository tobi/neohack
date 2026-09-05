import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,readFile,writeFile,rm,access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fixture, root } from './native-fixture.mjs';
const run=promisify(execFile),quote=s=>`'${s.replaceAll("'", "'\\''")}'`;
test('real headless perception is invariant under hidden locks, traps, disguises, monsters, curses and properties', async t=> {
  const temp=await mkdtemp('/tmp/nnh-hidden-engine-'); t.after(()=>rm(temp,{recursive:true,force:true}));
  const cwd=`${root}/engine/src`;
  const flags=async expression=>(await run('make',['-s','--eval',`nnh-test-flags:;@echo ${expression}`,'nnh-test-flags'],{cwd})).stdout.trim().split(/\s+/);
  const compile=await flags('$(TARGET_CC) $(TARGET_CFLAGS)');
  const link=await flags('$(TARGET_LINK) $(TARGET_LFLAGS) $(HOBJ) $(DATE_O) $(GENTILEOFILE) $(TARGET_HACKLIB) $(WINLIB) $(TARGET_LIBS) $(LUALIBS) $(AUTOLIBS)');
  let source=await readFile(`${root}/engine/win/headless/winheadless.c`,'utf8');
  // A previous perception generation lacks the new optional contract facts.
  source=source.replace('    jb_key(&jb, "affordanceVersion");', '    if (!getenv("NNH_HIDDEN_VARIANT") || strcmp(getenv("NNH_HIDDEN_VARIANT"),"legacy")) {\n    jb_key(&jb, "affordanceVersion");')
    .replace('    jb_key(&jb, "directionReliable"); jb_bool(&jb, !Confusion && !Stunned);','    jb_key(&jb, "directionReliable"); jb_bool(&jb, !Confusion && !Stunned);\n    }');
  const needle='    headless_flush();\n    hl_perception();';assert.ok(source.includes(needle));
  await writeFile(`${temp}/winheadless.c`,source.replace('static char *\nhl_input(',`#include ${JSON.stringify(`${root}/tests/hidden-knowledge.inc`)}\nstatic char *\nhl_input(`).replace(needle,'    fixture_begin();\n'+needle+'\n    fixture_end();'));
  await run(compile[0],[...compile.slice(1),`-I${root}/engine/win/headless`,'-c',`${temp}/winheadless.c`,'-o',`${temp}/winheadless.o`],{cwd});
  const luaHeader = /#include "([^"]*lua.h)"/.exec(await readFile(root+'/engine/include/nhlua.h','utf8'))?.[1];
  assert.ok(luaHeader, 'native engine build must record its actual Lua headers');
  const luaDir=dirname(luaHeader), candidates=[resolve(luaDir,'liblua.a'),resolve(luaDir,'../lib/liblua.a')];
  let lua; for(const candidate of candidates) if(await access(candidate).then(()=>true,()=>false)) {lua=candidate;break;}
  assert.ok(lua,'matching native Lua static library is required for controlled engine fixtures');
  await run(link[0],[...link.slice(1).map(arg=>arg==='winheadless.o'?`${temp}/winheadless.o`:/lua.*\.a$/.test(arg)?lua:arg),'-o',`${temp}/engine`],{cwd});
  let baseline, appearances;
  for(const variant of ['baseline','lock','trap','secret','monster','mimic','curse','property','legacy','hallucination']) {
    const wrapper=`${temp}/bridge-${variant}`,report=`${temp}/report-${variant}`;
    await writeFile(wrapper,`#!/bin/sh\nexec env NNH_HIDDEN_VARIANT=${quote(variant)} NNH_HIDDEN_REPORT=${quote(report)} ${quote(`${temp}/engine`)} "$@"\n`,{mode:0o700});
    const b=await fixture(t,{enginePath:wrapper});
    const game=await b.api.create({name:'Equivalence',seed:42,role:'rogue',race:'human',gender:'female',align:'chaotic'});
    const counts=(await readFile(report,'utf8')).trim().split(' ').map(Number);
    assert.ok(counts.every(n=>n>0),`fixture must exercise actual doors, walls, unseen monsters and a carried tool: ${counts}`);
    const n=game.observation.neighborhood;
    const creatures=game.observation.world.filter(c=>c.occupant && c.occupant.kind!=='self');
    assert.ok(creatures.length, 'actual perceived creatures are required');
    if(variant==='hallucination') {
      assert.ok(creatures.every(c=>c.occupant.appearance===undefined), 'hallucination must not reveal real species');
      await b.api.close(); continue;
    }
    if(!appearances) {
      appearances=creatures;
      assert.ok(creatures.every(c=>typeof c.occupant.appearance==='string'));
    } else assert.deepEqual(creatures,appearances,`hidden ${variant} changed apparent creature descriptions`);
    if(variant==='legacy') {
      assert.deepEqual(n,{version:1,status:'unavailable',reason:'unsupportedPerception'});
      const response=await b.api.request('session.actions',{sessionId:game.id,expectedRevision:game.state.revision,target:'here'});
      assert.equal(response.error.code,'unsupportedPerception'); await b.api.close(); continue;
    }
    assert.equal(n.status,'available');
    assert.ok(n.cells.some(c=>c.door),'fixture includes a perceived door');
    if(!baseline) baseline=n; else assert.deepEqual(n,baseline,`hidden ${variant} changed affordances`);
    await b.api.close();
  }
});
