import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {MemoryStorage} from './server.mjs';

test('emitted JavaScript starts the API and imports every service without TypeScript sources',async t=>{
 const root=resolve(import.meta.dirname,'..');
 await mkdir(resolve(root,'.vercel'),{recursive:true});
 const out=await mkdtemp(resolve(root,'.vercel/compiled-api-'));
 t.after(()=>rm(out,{recursive:true,force:true}));
 await promisify(execFile)(process.execPath,[resolve(root,'node_modules/typescript/bin/tsc'),'-p',resolve(root,'tsconfig.json'),'--noEmit','false','--outDir',out]);
 const {handler}=await import(pathToFileURL(resolve(out,'api/index.js')).href);
 const {storageContext}=await import(pathToFileURL(resolve(out,'src/storage.js')).href);
 await storageContext.run(new MemoryStorage(),async()=>{
  assert.equal((await handler(new Request('https://neohack.dev/api/health'))).status,200);
  assert.equal((await handler(new Request('https://neohack.dev/api/account'))).status,401);
  const commit={version:1,base:null,commit:crypto.randomUUID(),files:[],blocks:[]};
  const response=await handler(new Request(`https://neohack.dev/api/vaults/${crypto.randomUUID()}`,{method:'PUT',body:JSON.stringify(commit)}));
  assert.equal(response.status,200);assert.equal((await response.json()).revision,commit.commit);
 });
});
