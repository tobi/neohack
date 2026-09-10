import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';
import {createTestHarness} from './server.mjs';

test('account names, source filenames/code and script journal text stay literal in the browser',async t=>{
 const server=createTestHarness(),{url}=await server.listen();t.after(()=>server.close());
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const text='<img data-injected src=x onerror="window.__injected=true"> & </pre><svg data-injected onload="window.__injected=true">';
 await page.route('**/api/account**',route=>{
  const path=new URL(route.request().url()).pathname;
  const data=path.endsWith('/source')?{artifact:JSON.stringify({compiler:{version:text},entrypoint:text,files:{[text]:text}}),sha256:text}:
   path.endsWith('/journal')?{entries:[{author:text,turn:text,text}],next:null}:
   path.endsWith('/runs')?[{id:'literal',name:text,role:text,depth:text,level:1,maxLevel:1,turn:1,outcome:text,locations:[text],count:1,automated:true,control:'bot',source:true,journal:true}]:{name:text};
  return route.fulfill({json:data});
 });
 await page.goto(new URL('/login',url).href);
 await page.locator('#runs .run').waitFor();
 assert.equal(await page.locator('#handle').textContent(),text);
 assert.equal(await page.locator('neohack-rail #account-name').textContent(),text);
 await page.getByRole('button',{name:'View bot source',exact:true}).click();
 await page.locator('#runs pre').waitFor();
 assert.equal(await page.locator('#runs pre').textContent(),text);
 await page.getByRole('button',{name:'View script journal',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('#runs pre').length===2);
 assert.ok((await page.locator('#runs pre').nth(1).textContent()).includes(text));
 assert.equal(await page.locator('[data-injected]').count(),0);
 assert.equal(await page.evaluate(()=>window.__injected),undefined);assert.deepEqual(errors,[]);
});
