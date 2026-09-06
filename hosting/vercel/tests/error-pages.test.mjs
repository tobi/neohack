import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {handler} from '../api/index.ts';
import {storageContext} from '../src/storage.ts';
import {MemoryStorage} from './server.mjs';

test('error pages are self-contained and browser errors preserve HTTP status and JSON clients',async()=>{
 for(const code of [400,404,500]){
  const html=await readFile(new URL(`../public/${code}.html`,import.meta.url),'utf8');
  assert.match(html,new RegExp(`<title>${code}`));assert.match(html,/data:image\/png;base64/);
  assert.ok(!/<script|<link|src="https?:/i.test(html));
 }
 await storageContext.run(new MemoryStorage(),async()=>{
  for(const [path,status]of[['/api/vaults/not-a-vault',400],['/api/missing',404]]){
   const response=await handler(new Request('https://neohack.dev'+path,{headers:{accept:'text/html'}}));
   assert.equal(response.status,status);assert.match(response.headers.get('content-type'),/text\/html/);assert.match(await response.text(),/torchlit dungeon stone/);
   const api=await handler(new Request('https://neohack.dev'+path));assert.equal(api.status,status);assert.match(api.headers.get('content-type'),/application\/json/);
  }
 });
 await storageContext.run({read:async()=>{throw Error('test storage failure');}},async()=>{
  const response=await handler(new Request('https://neohack.dev/api/stats',{headers:{accept:'text/html'}}));assert.equal(response.status,503);assert.match(await response.text(),/A little trouble below ground/);
 });
});
