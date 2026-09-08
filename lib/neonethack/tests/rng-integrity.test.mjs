import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {fixture,root} from './native-fixture.mjs';

test('private SHA-256 matches host crypto across padding and streaming boundaries',async t=>{
  const dir=await mkdtemp(`${tmpdir()}/neohack-sha-`);t.after(()=>rm(dir,{recursive:true,force:true}));
  execFileSync(process.env.CC||'cc',['-std=c99','-Wall','-Wextra','-Werror',`${root}/tests/sha256.c`,'-o',`${dir}/sha`]);
  for(const n of [0,1,3,55,56,63,64,65,79,128,4096,1000000]){
    const bytes=Buffer.alloc(n);for(let i=0;i<n;i++)bytes[i]=(i*71+19)%256;
    assert.equal(execFileSync(`${dir}/sha`,[],{input:bytes}).toString().trim(),createHash('sha256').update(bytes).digest('hex'));
  }
});
async function privateReplay(t,lines,queries=0){
  const dir=await mkdtemp(`${tmpdir()}/neohack-rng-replay-`);
  await cp(`${root}/build/native/data`,dir,{recursive:true});
  for(const file of ['logfile','record','xlogfile','livelog','perm'])await writeFile(dir+'/'+file,'');
  await mkdir(dir+'/save',{recursive:true});
  const epoch=lines[0].params.calendarEpoch;
  const child=spawn(`${root}/engine/playground/nethack`,[`--runtime-v1=${epoch}`],{
    cwd:dir,env:{PATH:process.env.PATH,NETHACKDIR:dir,HOME:dir,USER:'Explorer',LOGNAME:'Explorer',LC_ALL:'C',TZ:'UTC'},stdio:['pipe','pipe','pipe']});
  const exit=once(child,'exit');let errors='',pending='',index=2,tail=[];const records=[];
  child.stderr.on('data',b=>errors+=b);
  t.after(async()=>{child.kill('SIGKILL');await exit;await rm(dir,{recursive:true,force:true});});
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error(`Private replay timed out: ${errors}`)),5000);
    child.on('error',reject);child.on('exit',()=>{clearTimeout(timer);reject(Error(`Private engine exited: ${errors}; ${JSON.stringify(tail)}`));});
    child.stdout.on('data',bytes=>{
      pending+=bytes;
      for(;;){const end=pending.indexOf('\n');if(end<0)break;const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line)continue;
        let msg;try{msg=JSON.parse(line);}catch(e){clearTimeout(timer);reject(e);return;}
        tail.push({method:msg.method,id:msg.id,text:msg.params?.text});if(tail.length>5)tail.shift();
        if(msg.id===-33 && msg.result){
          assert.deepEqual(msg.result.rngIntegrity,records.at(-1).rng,'lore query consumes zero core or display draws and preserves full RNG state');
          if(--queries>0)child.stdin.write(JSON.stringify({id:-33,method:'lore',params:{name:'floating eye'}})+'\n');
          else{clearTimeout(timer);resolve(records);}
          continue;
        }
        if(msg.method!=='input')continue;
        records.push({id:msg.id,kind:msg.params.kind,rng:msg.params.rngIntegrity});
        if(index<lines.length){const response=lines[index++];if(response.id!==msg.id){clearTimeout(timer);reject(Error('Input ID mismatch'));return;}child.stdin.write(JSON.stringify(response)+'\n');}
        else if(queries>0)child.stdin.write(JSON.stringify({id:-33,method:'lore',params:{name:'floating eye'}})+'\n');
        else{clearTimeout(timer);resolve(records);}
      }
    });
    child.stdin.write(lines.slice(0,2).map(JSON.stringify).join('\n')+'\n');
  });
}
test('private input-boundary RNG fingerprints reproduce exactly and do not enter gameplay frames',async t=>{
  const b=await fixture(t),game=await b.api.create({name:'Verifier',seed:42,role:'wizard',race:'human',gender:'female',align:'neutral'});
  const frames=[structuredClone(game.state),await game.search({turns:5}),await game.cast()];
  const lines=(await readFile(`${b.sessions}/${game.id}/input.log.jsonl`,'utf8')).trim().split('\n').map(JSON.parse);
  const a=await privateReplay(t,lines,20),c=await privateReplay(t,lines);
  assert.deepEqual(a,c,'all witnessed RNG boundaries agree under exact replay');
  assert.ok(a.length>=2);
  for(const record of a){
    assert.equal(record.rng.algorithm,'isaac64-sha256-v1');
    for(const stream of ['core','display']){
      assert.match(record.rng[stream].state,/^[a-f0-9]{64}$/);assert.match(record.rng[stream].draws,/^\d+$/);
      assert.ok(!JSON.stringify(frames).includes(record.rng[stream].state),'fingerprint is never a gameplay field');
    }
  }
  assert.ok(!JSON.stringify(frames).includes('rngIntegrity'));
  assert.ok(BigInt(a.at(-1).rng.core.draws)>BigInt(a[0].rng.core.draws));
});

test('durable RNG records survive resume unchanged and free public queries append nothing',async t=>{
  const b=await fixture(t);let game=await b.api.create({name:'Witness',seed:42,role:'wizard'});
  await game.search({turns:5});
  const path=`${b.sessions}/${game.id}/rng.jsonl`,original=await readFile(path,'utf8');
  for(let i=0;i<10;i++){await game.observe();await game.lookup('floating eye');}
  assert.equal(await readFile(path,'utf8'),original);
  await game.close();game=await b.api.resume(game.id);
  assert.equal(await readFile(path,'utf8'),original,'replay compares without rewriting private evidence');
  await game.search();
  assert.ok((await readFile(path,'utf8')).startsWith(original));
});

test('observation, movement offers and navigation queries preserve the next exact RNG boundary',async t=>{
  const b=await fixture(t);
  const options={name:'Queries',seed:42,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'};
  const queried=await b.api.create(options),control=await b.api.create(options);
  const path=game=>`${b.sessions}/${game.id}/rng.jsonl`;
  const initial=await readFile(path(queried),'utf8');
  assert.equal(initial,await readFile(path(control),'utf8'));
  for(let i=0;i<100;i++){
    await queried.observe();
    await queried.actions({direction:'north'});
    await queried.route(queried.observation.you);
    await queried.navigation();
  }
  assert.equal(await readFile(path(queried),'utf8'),initial,'queries append neither inputs nor private boundaries');
  await queried.search({turns:5});await control.search({turns:5});
  assert.equal(await readFile(path(queried),'utf8'),await readFile(path(control),'utf8'),
    'the next boundary agrees in both stream counters and complete state fingerprints');
});
for(const damage of ['missing','torn','changed','extra'])test(`resume rejects ${damage} private RNG records without repairing them`,async t=>{
  const b=await fixture(t),game=await b.api.create({name:'Witness',seed:42,role:'wizard'});
  await game.search({turns:5});await game.close();
  const path=`${b.sessions}/${game.id}/rng.jsonl`,original=await readFile(path,'utf8');
  let broken=original;
  if(damage==='missing'){await rm(path);broken=null;}
  else{
    if(damage==='torn')broken=original.slice(0,-1);
    if(damage==='changed')broken=original.replace(/"draws":"\d+"/,'"draws":"999999999"');
    if(damage==='extra')broken=original+original.split('\n')[0]+'\n';
    await writeFile(path,broken);
  }
  const next=await fixture(t,{sessions:b.sessions});
  const result=await next.transport.send({version:1,method:'session.resume',params:{sessionId:game.id}});
  assert.equal(result.error?.code,'replayIntegrityError',JSON.stringify(result));
  if(broken===null)await assert.rejects(readFile(path),{code:'ENOENT'});
  else assert.equal(await readFile(path,'utf8'),broken);
});

test('removing the private RNG metadata flag cannot silently disable verification',async t=>{
  const b=await fixture(t),game=await b.api.create({name:'Witness',seed:42,role:'wizard'});
  await game.close();
  const path=`${b.sessions}/${game.id}/meta.json`,meta=JSON.parse(await readFile(path,'utf8'));
  assert.equal(meta.rngIntegrityVersion,2);delete meta.rngIntegrityVersion;
  await writeFile(path,JSON.stringify(meta));
  const next=await fixture(t,{sessions:b.sessions});
  const result=await next.transport.send({version:1,method:'session.resume',params:{sessionId:game.id}});
  assert.equal(result.error?.code,'replayIntegrityError',JSON.stringify(result));
  assert.match(result.error.message,/creation journal/);
});
