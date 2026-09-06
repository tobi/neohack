import {createServer} from 'node:http';
import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createTestHarness} from '../node_modules/wrangler/wrangler-dist/cli.js';
import {chromium} from '../../../example/pixel-bun/node_modules/playwright-core/index.mjs';
async function fixture(t,{insecure=false}={}){
 const server=createTestHarness({root:resolve(import.meta.dirname,'..'),workers:[{configPath:'wrangler.toml'}]});
 const {url}=await server.listen();
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true,args:insecure?['--host-resolver-rules=MAP workshop-preview.test 127.0.0.1','--no-proxy-server']:[]});
 t.after(async()=>{await browser.close();await server.close();});
 const context=await browser.newContext();const page=await context.newPage();
 const errors=[];page.on('response',async r=>{if(r.status()>=500)console.error('HTTP FAILURE',r.url(),await r.text().catch(String));});page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 return {page,context,browser,url:url.href.replace('127.0.0.1','localhost').replace(/\/$/,''),errors};
}
test('a foreign origin embeds the single module without runtime or artwork requests', {timeout:30000},async t=>{
 const {page,url,errors}=await fixture(t);const external=url;
 const requests=[];page.on('request',r=>requests.push(r.url()));
 const embed=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<!doctype html><style>neohack-world{height:400px}</style><script type="module" src="${external}/component/neohack.js"></script><neohack-world static></neohack-world>`);});
 await new Promise(resolve=>embed.listen(0,'127.0.0.1',resolve));t.after(()=>embed.close());
 await page.goto('http://localhost:'+embed.address().port+'/embed-test');await page.waitForFunction(()=>document.querySelector('neohack-world').shadowRoot?.querySelector('canvas')?.width>300,{},{timeout:5000}).catch(e=>{throw Error(errors.join('\n')+'\n'+requests.join('\n'),{cause:e});});
 assert.equal(requests.filter(u=>u.includes('/art/')||u.includes('/runtime/')).length,0);
 assert.equal((await page.evaluate(()=>document.querySelector('neohack-world').postMessage({jsonrpc:'2.0',id:'embed',method:'world.snapshot'}))).result,null);
});
