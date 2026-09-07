import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fixture,root,identity} from './native-fixture.mjs';

for(const fault of ['lost','wrong-id','invalid-json','missing-lines','invalid-line','invalid-found','changed-rng']) {
  test(`lore ${fault} reply blocks further input until exact resume`,{timeout:20000},async t=>{
    const dir=await mkdtemp(`${tmpdir()}/neohack-lore-fault-`);
    t.after(()=>rm(dir,{recursive:true,force:true}));
    const armed=`${dir}/armed`,engine=`${dir}/engine`;
    await writeFile(engine,`#!${process.execPath}
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const child=spawn(${JSON.stringify(root+'/engine/playground/nethack')},process.argv.slice(2),{stdio:['pipe','pipe','inherit']});
process.stdin.pipe(child.stdin);
child.on('exit',code=>process.exit(code??1));
let pending='';
child.stdout.on('data',bytes=>{
 pending+=bytes;
 for(;;){
  const end=pending.indexOf('\\n');if(end<0)break;
  let line=pending.slice(0,end);pending=pending.slice(end+1);
  let message;try{message=JSON.parse(line);}catch{}
  if(message?.id===-33 && fs.existsSync(${JSON.stringify(armed)})){
   fs.unlinkSync(${JSON.stringify(armed)});
   const fault=${JSON.stringify(fault)};
   if(fault==='lost'){child.kill('SIGKILL');process.exit(1);}
   if(fault==='wrong-id')message.id=-34;
   if(fault==='missing-lines')delete message.result.lines;
   if(fault==='invalid-line')message.result.lines=[42];
   if(fault==='invalid-found')message.result.found='yes';
   if(fault==='changed-rng')message.result.rngIntegrity.core.draws='99999999';
   line=fault==='invalid-json'?'{"id":-33,':JSON.stringify(message);
  }
  process.stdout.write(line+'\\n');
 }
});
`,{mode:0o700});
    const b=await fixture(t,{enginePath:engine});
    let game=await b.api.create(identity);
    await game.eat();
    const before=structuredClone(game.state);
    const journal=`${b.sessions}/${game.id}/input.log.jsonl`;
    const history=await readFile(journal,'utf8');
    await writeFile(armed,'1');
    await assert.rejects(game.lookup('floating eye'),error=>error.response?.error?.code==='recoveryRequired');
    await assert.rejects(game.lookup('floating eye'),error=>error.response?.error?.code==='noGame');
    await assert.rejects(game.cancel(game.decision.id));
    assert.equal(await readFile(journal,'utf8'),history,'fault never submits a decision answer');
    game=await b.api.resume(game.id);
    assert.deepEqual(game.decision,before.decision);
    assert.deepEqual(game.observation,before.observation);
    assert.equal((await game.lookup('floating eye')).found,true);
    await game.cancel(game.decision.id);
  });
}
