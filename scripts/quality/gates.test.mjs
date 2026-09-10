import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'../..');
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'neohack-quality-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));return dir;
}
test('lint gate rejects unsafe code and obsolete suppressions',async t=>{
 const dir=await fixture(t),file=join(dir,'example.js');
 for(const [source,rule] of [
  ["import {test} from 'node:test'; test.only('focused',()=>{});",'no-restricted-properties'],
  ['debugger;','no-debugger'],['eval("1");','no-eval'],
  ['new Promise(async resolve => resolve());','no-async-promise-executor'],
  ['const unused = 1;','no-unused-vars'],['missingBinding();','no-undef'],
  ['// oxlint-disable-next-line no-debugger\nconsole.log("ok");','Unused oxlint-disable']
 ]){
  await writeFile(file,source);
  const result=spawnSync(join(root,'node_modules/.bin/oxlint'),['--config',join(root,'.oxlintrc.json'),'--deny-warnings','--report-unused-disable-directives-severity','error',file],{encoding:'utf8'});
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok((result.stdout+result.stderr).includes(rule),result.stdout+result.stderr);
 }
 await writeFile(file,'export const increment = value => value + 1;');
 assert.equal(spawnSync(join(root,'node_modules/.bin/oxlint'),['--config',join(root,'.oxlintrc.json'),file]).status,0);
});
test('coverage gate rejects missing files, falling percentages and scope drift',async t=>{
 const dir=await fixture(t);
 const limits=JSON.parse(await readFile(new URL('./coverage-limits.json',import.meta.url),'utf8'));
 const files=Object.keys(limits),config={include:files};
 await writeFile(join(dir,'.c8rc.json'),JSON.stringify(config));
 await mkdir(join(dir,'coverage/unit'),{recursive:true});
 const report=Object.fromEntries(files.map(file=>[resolve(dir,file),Object.fromEntries(Object.keys(limits[file]).map(metric=>[metric,{pct:100}]))]));
 const check=async value=>{
  await writeFile(join(dir,'coverage/unit/coverage-summary.json'),JSON.stringify(value));
  return spawnSync(process.execPath,[join(root,'scripts/quality/check-coverage.mjs')],{cwd:dir,encoding:'utf8'});
 };
 assert.equal((await check(report)).status,0);
 const missing=structuredClone(report);delete missing[resolve(dir,files[0])];
 assert.equal((await check(missing)).status,1);
 const low=structuredClone(report);low[resolve(dir,files[0])].branches.pct=0;
 assert.equal((await check(low)).status,1);
 await writeFile(join(dir,'.c8rc.json'),JSON.stringify({include:files.slice(1)}));
 assert.notEqual((await check(report)).status,0);
});
