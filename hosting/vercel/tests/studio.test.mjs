import {createServer} from 'node:http';
import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import { createTestHarness } from './server.mjs';
import {chromium} from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';
async function fixture(t,{insecure=false}={}){
 const server=createTestHarness();
 const {url}=await server.listen();
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true,args:insecure?['--host-resolver-rules=MAP workshop-preview.test 127.0.0.1','--no-proxy-server']:[]});
 t.after(async()=>{await browser.close();await server.close();});
 const context=await browser.newContext();const page=await context.newPage();
 const errors=[];page.on('response',async r=>{if(r.status()>=500)console.error('HTTP FAILURE',r.url(),await r.text().catch(String));});page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 return {page,context,browser,url:url.href.replace('127.0.0.1','localhost').replace(/\/$/,''),errors};
}
async function waitForRuns(page,predicate){
 const deadline=Date.now()+20000;
 while(Date.now()<deadline){const runs=await page.evaluate(()=>fetch('/api/account/runs').then(r=>r.json()));if(predicate(runs))return runs;await new Promise(r=>setTimeout(r,50));}
 throw Error('Run backup did not finish: '+await page.locator('#recording').textContent());
}
async function passkey(page){const cdp=await page.context().newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});return cdp;}
async function register(page,url,name='AdaTest'){
 await page.goto(url+'/login');await passkey(page);await page.locator('#open-login').click();await page.locator('#name').fill(name);await page.locator('#register').click();
 await page.waitForFunction(()=>!document.querySelector('#account').hidden,{},{timeout:15000}).catch(async e=>{throw Error(await page.locator('#status[role=status]').textContent(),{cause:e});});
}
test('passkey identity, uniqueness, session isolation and origin validation', {timeout:60000},async t=>{
 const {page,context,browser,url}=await fixture(t);await register(page,url);
 assert.equal(await page.locator('#handle').textContent(),'AdaTest');
 const anonymous=await browser.newContext();assert.equal((await anonymous.request.get(url+'/api/account/runs')).status(),401);await anonymous.close();
 const cookies=await context.cookies();assert.ok(cookies.find(c=>c.name==='nh_session')?.httpOnly);
 assert.equal((await context.request.post(url+'/api/account/logout',{headers:{origin:'https://evil.example'},data:{}})).status(),403);
 await page.locator('#logout').click();await page.waitForFunction(()=>!document.querySelector('#auth').hidden,{},{timeout:5000}).catch(async e=>{throw Error('LOGOUT: '+await page.locator('#status[role=status]').textContent(),{cause:e});});
 await page.locator('#open-login').click();await page.locator('#signin').click();await page.waitForFunction(()=>!document.querySelector('#account').hidden,{},{timeout:10000}).catch(async e=>{throw Error(await page.locator('#status[role=status]').textContent(),{cause:e});});
 const other=await browser.newPage();await other.goto(url+'/login');await passkey(other);await other.locator('#open-login').click();await other.locator('#name').fill('adatest');await other.locator('#register').click();await other.waitForFunction(()=>document.querySelector('neohack-rail').shadowRoot.querySelector('#auth-status').textContent.includes('already taken'));
 const invalid=await page.evaluate(async()=>{const options=await fetch('/api/account/options',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});await options.json();const verify=()=>fetch('/api/account/verify',{method:'POST',headers:{'content-type':'application/json'},body:'{"id":"fake"}'}).then(r=>r.status);return [await verify(),await verify()];});assert.deepEqual(invalid,[400,400]);
});
test('component is read-only, bot imports execute real engine, private recordings replay', {timeout:120000},async t=>{
 const {page,url,errors}=await fixture(t);await register(page,url,'BotAuthor');
 await page.goto(url+'/component');await page.waitForFunction(()=>!!document.querySelector('neohack-world')?.postMessage);
 assert.deepEqual(await page.evaluate(async()=>{const w=document.querySelector('neohack-world');return (await w.postMessage({jsonrpc:'2.0',id:1,method:'tools/list'})).result.tools;}),[]);
 const denied=await page.evaluate(async()=>{const w=document.querySelector('neohack-world');return w.postMessage({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'neonethack_game_wait',arguments:{}}});});assert.ok(denied.error);
 await page.waitForFunction(()=>document.querySelector('neohack-world').shadowRoot.querySelector('canvas').width>300);
 await page.screenshot({path:'/tmp/neohack-component.png',fullPage:true});
 await page.goto(url+'/bots?example=curious-imp');await page.waitForFunction(()=>document.querySelector('#author').textContent.includes('BotAuthor'));
 await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Bot saved.');
 await page.locator('#role').selectOption('valkyrie');await page.locator('#seed-mode').selectOption('fixed');await page.locator('#seed').fill('42');
 await page.locator('#test').click();
 await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:90000}).catch(async e=>{throw Error((await page.locator('#status[role=status]').textContent())+'\n'+errors.join('\n'),{cause:e});});
 assert.match(await page.locator('#status[role=status]').textContent(),/Script finished|Test budget reached/);
 assert.ok(await page.evaluate(()=>document.querySelector('neohack-world').snapshot.observation.turn>1));
 await page.screenshot({path:'/tmp/neohack-bots.png',fullPage:true});
 await waitForRuns(page,r=>r.some(v=>v.count>1&&v.sourceHash));
 const runs=await page.evaluate(()=>fetch('/api/account/runs').then(r=>r.json()));assert.equal(runs.length,1);assert.ok(runs[0].count>=2);
 await page.goto(url+'/login');await page.getByRole('button',{name:/Replay \d+ actions/}).click();await page.waitForFunction(()=>!document.querySelector('#playback').hidden,{},{timeout:10000}).catch(async e=>{throw Error(await page.locator('#status[role=status]').textContent(),{cause:e});});
 await page.waitForFunction(count=>Number(document.querySelector('#scrub').max)===count-1,runs[0].count);
 const first=await page.evaluate(()=>document.querySelector('#replay').snapshot);await page.locator('#scrub').fill(String(runs[0].count-1));await page.waitForFunction(first=>document.querySelector('#replay').snapshot.revision>first,first.revision);const last=await page.evaluate(()=>document.querySelector('#replay').snapshot);assert.ok(last.revision>first.revision);
 const publicLink=runs[0].replayUrl;
 const visitor=await page.context().browser().newPage();await visitor.goto(url+'/dashboard?run='+runs[0].id);
 await visitor.waitForFunction(()=>document.querySelector('neohack-world')?.snapshot);
 assert.equal((await visitor.request.get(url+'/api/account/runs/'+runs[0].id+'/source')).status(),401);
 await visitor.close();
 await page.screenshot({path:'/tmp/neohack-login.png',fullPage:true});
 const actualErrors=errors.filter(e=>!e.includes('401')&&!e.includes('400')&&!e.includes('409'));assert.deepEqual(actualErrors,[]);
});
test('sandbox blocks network access and Stop terminates an infinite loop', {timeout:120000},async t=>{
 const {page,url,errors}=await fixture(t);await page.goto(url+'/bots?example=curious-imp');await page.waitForSelector('.cm-content');
 await page.locator('.cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText(`export default {name:\"Test bot\",async initialize({log}) { try { await fetch('/api/account'); log('NETWORK OPEN'); } catch { log('NETWORK BLOCKED'); } while (true) {} }}`);
 await page.locator('#test').click();await page.waitForFunction(()=>document.querySelector('#output').textContent.includes('NETWORK BLOCKED'),{},{timeout:90000}).catch(async e=>{throw Error((await page.locator('#status[role=status]').textContent())+'\n'+errors.join('\n'),{cause:e});});
 await page.locator('#stop').click();await page.waitForFunction(()=>!document.querySelector('#test').disabled);
 assert.match(await page.locator('#status[role=status]').textContent(),/Stopped by you/);assert.equal(await page.locator('iframe').count(),0);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'/tmp/neohack-bots-mobile.png',fullPage:true});
});

test('a foreign origin embeds the single module without runtime or artwork requests', {timeout:30000},async t=>{
 const {page,url,errors}=await fixture(t);const external=url;
 const requests=[];page.on('request',r=>requests.push(r.url()));
 const embed=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<!doctype html><style>neohack-world{height:400px}</style><script type="module" src="${external}/component/neohack.js"></script><neohack-world static></neohack-world>`);});
 await new Promise(resolve=>embed.listen(0,'127.0.0.1',resolve));t.after(()=>embed.close());
 await page.goto('http://localhost:'+embed.address().port+'/embed-test');await page.waitForFunction(()=>document.querySelector('neohack-world').shadowRoot?.querySelector('canvas')?.width>300,{},{timeout:5000}).catch(e=>{throw Error(errors.join('\n')+'\n'+requests.join('\n'),{cause:e});});
 assert.equal(requests.filter(u=>u.includes('/art/')||u.includes('/runtime/')).length,0);
 assert.equal((await page.evaluate(()=>document.querySelector('neohack-world').postMessage({jsonrpc:'2.0',id:'embed',method:'world.snapshot'}))).result,null);
});

test('signed-in human play associates static inputs without sharing account data', {timeout:60000},async t=>{
 const {page,url,browser}=await fixture(t);await register(page,url,'HumanAuthor');await page.goto(url);
 await page.waitForFunction(()=>!document.querySelector('#new-adventure').disabled);
 await page.getByRole('button',{name:'Begin your adventure',exact:true}).click();await page.getByLabel('YOUR NAME',{exact:true}).fill('Human run');await page.locator('input[name=role][value=valkyrie]').check();await page.getByRole('button',{name:'Enter the dungeon →',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.observation&&document.querySelector('pixel-nethack').getAttribute('aria-busy')==='false');
 await page.evaluate(async()=>{const app=document.querySelector('pixel-nethack');await app.run(()=>app.game.search());});
 await page.evaluate(async()=>document.querySelector('pixel-nethack').publicRecorder.flush());
 const runs=await page.evaluate(()=>fetch('/api/account/runs').then(r=>r.json()));assert.equal(runs.length,1);assert.ok(runs[0].count>=2);assert.equal(runs[0].name,'Human run');assert.equal(runs[0].control,'interactive');assert.equal(runs[0].automated,false);
 const other=await browser.newPage();await register(other,url,'OtherAuthor');
 assert.equal(await other.evaluate(async id=>(await fetch('/api/account/runs/'+id+'/frames')).status,runs[0].id),404);
});

test('HTTP workshop explains unavailable Web Crypto before loading the engine', {timeout:30000},async t=>{
 const {page,url,errors}=await fixture(t,{insecure:true});const requests=[];page.on('request',r=>requests.push(r.url()));
 await page.goto(url.replace('localhost','workshop-preview.test')+'/bots?example=curious-imp');await page.waitForSelector('.cm-content');
 assert.equal(await page.evaluate(()=>!!crypto.subtle),false);
 await page.locator('#test').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('HTTPS or localhost'));
 assert.equal(requests.some(u=>u.includes('/runtime/')),false);
 assert.equal(await page.locator('#secure-context').isVisible(),true);
 assert.equal(errors.some(e=>e.includes("reading 'digest'")),false);
});

test('IDE defaults, random project persistence, in-place top-rail login and resizing', {timeout:60000},async t=>{
 const {page,url}=await fixture(t);await page.goto(url+'/bots?example=curious-imp');await page.waitForSelector('.cm-content');
 assert.equal(await page.locator('#role').inputValue(),'random');assert.equal(await page.locator('#seed-mode').inputValue(),'random');assert.equal(await page.locator('#seed').isVisible(),false);assert.equal(await page.locator('#budget').count(),0);
 const code=await page.locator('.cm-content').innerText();
 await passkey(page);await page.locator('#open-login').click();await page.locator('#name').fill('WorkshopAuthor');await page.locator('#register').click();await page.waitForFunction(()=>document.querySelector('#author').textContent.includes('WorkshopAuthor'));
 assert.ok(new URL(page.url()).pathname.startsWith('/bots'));assert.equal(await page.locator('.cm-content').innerText(),code);
 await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Bot saved.');
 const bots=await page.evaluate(()=>fetch('/api/account/bots').then(r=>r.json()));assert.equal(bots[0].seed,'random');assert.equal(bots[0].role,'random');
 await page.locator('#pane-divider').focus();await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('#pane-divider').getAttribute('aria-valuenow'),'50');
 await page.locator('#test').click();await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:50000});
 assert.match(await page.locator('#run-identity').textContent(),/Seed \d+/);assert.ok(await page.evaluate(()=>document.querySelector('#bot-world').snapshot?.observation));
 await page.screenshot({path:'/tmp/neohack-ide-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'/tmp/neohack-ide-mobile.png',fullPage:true});
 for(const path of ['/component','/dashboard','/','/login']){await page.goto(url+path);await page.waitForFunction(()=>document.querySelector('neohack-rail')?.shadowRoot.querySelector('#account-name').textContent==='WorkshopAuthor');assert.equal(await page.locator('neohack-rail #logout').isVisible(),true);}
});

test('test runner enforces its fixed 1000-call budget', {timeout:60000},async t=>{
 const {page,url}=await fixture(t);await page.goto(url+'/bots?example=curious-imp');await page.waitForSelector('.cm-content');
 await page.locator('.cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText('export default {name:\"Test bot\",initialize({hero,game}) { hero.addEventListener("turn", async()=>{ for(let i=0;i<1001;i++) await game.observe(); }); }}');
 await page.locator('#test').click();await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:50000});
 assert.equal(await page.locator('#status[role=status]').textContent(),'Test budget reached (1000 calls).');
});

test('hero API has real TypeScript completions, documentation, diagnostics and multi-file execution', {timeout:120000}, async t=>{
 const {page,url}=await fixture(t);await page.goto(url+'/bots?example=curious-imp');await page.waitForSelector('.cm-content');
 const replace=async code=>{await page.locator('.cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText(code);};
 const prefix="import { Hero, direction, entities, defineBot } from 'neonethack';\n";
 await replace(prefix+'direction.');await page.keyboard.press('Control+Space');
 await page.getByRole('option',{name:'northWest',exact:true}).waitFor();
 await page.getByRole('option',{name:'northWest',exact:true}).click();
 assert.match(await page.locator('.cm-content').innerText(),/direction.northWest/);
 await replace(prefix+'entities.');await page.keyboard.press('Control+Space');
 await page.getByRole('option',{name:'Balrog',exact:true}).waitFor();await page.keyboard.press('Escape');
 await replace(prefix+'defineBot({name:\"Test bot\",initialize({hero}) { hero.');await page.keyboard.press('Control+Space');
 await page.getByRole('option',{name:'senseClosest',exact:true}).waitFor();await page.getByRole('option',{name:'senseClosest',exact:true}).click();await page.keyboard.press('Escape');
 await replace(prefix+'defineBot(async ({game}) => { const hero = new Hero(game); hero.go(123); }});');
 await page.waitForSelector('.cm-lintRange-error');
 const language=await page.evaluate(async()=>{
   const worker=new Worker('/build/bot-language.js',{type:'module'});
   const files={'main.js':"import { defineBot, Hero } from 'neonethack';\nimport { heading } from './strategy';\nexport default defineBot({name:\"Test bot\",initialize({hero}) { hero.addEventListener('turn', async()=>{await hero.game.move(heading);hero.stop();}); }});",'strategy.js':"import { direction } from 'neonethack'; export const heading = direction.northWest;"};
   const ask=(kind,position,name)=>new Promise(resolve=>{worker.onmessage=e=>resolve(e.data);worker.postMessage({id:1,kind,files,file:'main.js',position,name});});
   const clean=await ask('diagnostics');const original=files['main.js'];files['main.js']="import {defineBot} from 'neonethack'; defineBot({initialize(){}});";const unnamed=await ask('diagnostics');files['main.js']=original;files['strategy.js']='export const heading = 123;';const bad=await ask('diagnostics');
   files['main.js']="import { Hero, defineBot } from 'neonethack'; defineBot({name:\"Test bot\",initialize({hero}) { hero.";
   const detail=await ask('detail',files['main.js'].length,'go');
   files['main.js']="import {defineBot} from 'neonethack'; export default defineBot({name:'Typed state',initialize({hero}){ const state={mode:'run'}; hero.controls.button({id:'pause',label:'Pause',onClick:()=>null}); hero.controls.checkbox({id:'bold',label:'Bold',checked:true,onChange:checked=>({state:{bold:checked}})}); hero.addEventListener('stateChange',({detail})=>{if(detail.from==='run' && detail.to===null) return false;}); hero.addEventListener('beforeLoot',async({detail})=>{await detail.select(detail.decision.options.filter(o=>o.suggested).map(o=>o.id));return {state};}); }});";
   const stateTypes=await ask('diagnostics');
   files['main.js']="import {defineBot} from 'neonethack';defineBot({name:'Bad state',initialize({hero}){hero.setState(123);}});";
   const badState=await ask('diagnostics');
   worker.terminate();return {clean,bad,detail,unnamed,stateTypes,badState};
 });
 assert.deepEqual(language.stateTypes.result,[]);assert.ok(language.badState.result.some(d=>d.message.includes('123')));assert.deepEqual(language.clean.result,[]);assert.ok(language.unnamed.result.some(d=>d.message.includes("name")));assert.ok(language.bad.result.some(d=>d.message.includes('123')));assert.match(language.detail.result.docs,/Navigate to a perceived destination/);
 await page.locator('#filename').fill('strategy.js');await page.locator('#add-file').click();
 await page.locator('#tabs').getByRole('tab',{name:'strategy.js'}).click();
 await replace("import { direction } from 'neonethack'; export const heading = direction.north;");
 await page.locator('#tabs').getByRole('tab',{name:'main.js'}).click();
 await replace(prefix+"import { heading } from './strategy';\nexport default defineBot({name:\"Test bot\",initialize({hero, log}){ hero.addEventListener('turn', async()=>{log('hungry',hero.isHungry()); log('enemies',hero.sense(entities.Enemy).length); await hero.game.move(heading); log('hero turn',hero.snapshot.observation.turn);hero.stop();}); }});");
 await page.locator('#role').selectOption('valkyrie');await page.locator('#seed-mode').selectOption('fixed');await page.locator('#seed').fill('42');await page.locator('#test').click();
 await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:90000});
 assert.equal(await page.locator('#status[role=status]').textContent(),'Script finished.');
 assert.match(await page.locator('#output').textContent(),/hungry false/);assert.match(await page.locator('#output').textContent(),/hero turn/);
 await page.screenshot({path:'/tmp/neohack-hero-workshop.png',fullPage:true});
});

test('automated history retains exact source, construction autoloot and executable name', {timeout:90000}, async t=>{
 const {page,url,browser}=await fixture(t);await register(page,url,'SourceAuthor');
 await page.goto(url+'/bots?example=curious-imp');await page.waitForSelector('.cm-content');
 const replace=async code=>{await page.locator('.cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText(code);};
 const main=`import {defineBot} from 'neonethack';
import {message} from './strategy';
export default defineBot({name:'Archive imp',autoloot:{enabled:true,itemTypes:['gold'],arrows:false,leaveCorpses:true,leaveKnownCursed:true,lootPatterns:['ration'],ignorePatterns:['corpse']},initialize({hero,log}) {
 log(message); log('rules',hero.snapshot.observation.automaticPickup);
 hero.addEventListener('turn',async()=>{await hero.wait();hero.stop();});
}});`;
 const helper="export const message='original helper';";
 await page.locator('#filename').fill('strategy.js');await page.locator('#add-file').click();
 await page.locator('#tabs').getByRole('tab',{name:'strategy.js'}).click();await replace(helper);
 await page.locator('#tabs').getByRole('tab',{name:'main.js'}).click();await replace(main);
 await page.locator('#bot-name').fill('Different project label');
 await page.locator('#test').click();await replace('// edited after Test was clicked');
 await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:60000});
 assert.equal(await page.locator('#status[role=status]').textContent(),'Script finished.');
 assert.match(await page.locator('#output').textContent(),/original helper/);
 await waitForRuns(page,r=>r.some(v=>v.sourceHash));
 const runs=await page.evaluate(()=>fetch('/api/account/runs').then(r=>r.json()));
 assert.equal(runs.length,1);const run=runs[0];assert.equal(run.name,'Archive imp');assert.equal(run.automated,true);assert.equal(run.control,'bot');
 const saved=await page.evaluate(id=>fetch(`/api/account/runs/${id}/source`).then(r=>r.json()),run.id);
 const source=JSON.parse(saved.artifact);assert.equal(source.files['main.js'],main);assert.equal(source.files['strategy.js'],helper);
 assert.match(source.compiledFiles['main.js'],/require\("neonethack"\)/);assert.equal(source.compiler.name,'typescript');assert.equal(source.entrypoint,'main.js');
 assert.deepEqual(source.autoloot,{enabled:true,itemTypes:['gold'],arrows:false,leaveCorpses:true,leaveKnownCursed:true,lootPatterns:['ration'],ignorePatterns:['corpse']});
 const {createHash}=await import('node:crypto');assert.equal(saved.sha256,createHash('sha256').update(saved.artifact).digest('hex'));
 await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Bot saved.');
 const rejected=await page.evaluate(async ({run,source})=>{
   const user=await fetch('/api/account').then(r=>r.json());
   const append=extra=>fetch(`/api/account/runs/${run.id}/artifacts`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({owner:user.id,name:run.name,from:0,entries:[],...extra})}).then(r=>r.status);
   return [await append({source:{...source,files:{...source.files,'main.js':'changed'}}}),await append({name:'Renamed imp'}),await append({owner:'different-account'})];
 },{run,source});assert.deepEqual(rejected,[409,409,403]);
 await page.goto(url+'/login');await page.getByRole('button',{name:'View bot source'}).click();
 await page.getByText(main,{exact:true}).waitFor();assert.match(await page.locator('#runs').textContent(),/Automated bot/);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(await page.evaluate(id=>fetch(`/api/account/runs/${id}/source`).then(r=>r.json()),run.id),saved);
 const other=await browser.newPage();await register(other,url,'SourceOther');
 assert.equal(await other.evaluate(async id=>(await fetch(`/api/account/runs/${id}/source`)).status,run.id),404);
});

test('invalid bot names and failed source persistence never initialize the bot', {timeout:90000},async t=>{
 const {page,url}=await fixture(t);await register(page,url,'SourceFailure');await page.goto(url+'/bots?example=curious-imp');await page.waitForSelector('.cm-content');
 const replace=async code=>{await page.locator('.cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText(code);};
 await replace(`export default {initialize({log}){log('MUST NOT RUN')}}`);
 await page.locator('#test').click();await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:60000});
 assert.match(await page.locator('#status[role=status]').textContent(),/needs a name/);
 assert.doesNotMatch(await page.locator('#output').textContent(),/MUST NOT RUN/);
 await page.evaluate(()=>{const original=IDBObjectStore.prototype.add;IDBObjectStore.prototype.add=function(value,...args){if(this.transaction.db.name==='neohack-script-artifacts-v1')throw new DOMException('Fixture quota exhaustion','QuotaExceededError');return original.call(this,value,...args);};});
 await replace(`export default {name:'Failure imp',initialize({log}){log('MUST NOT RUN')}}`);
 await page.locator('#test').click();await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:60000});
 assert.match(await page.locator('#status[role=status]').textContent(),/Could not save bot source/);
 assert.doesNotMatch(await page.locator('#output').textContent(),/MUST NOT RUN/);
 assert.deepEqual(await page.evaluate(()=>fetch('/api/account/runs').then(r=>r.json())),[]);
});

test('script controls, null silence and private journal survive a real workshop run', {timeout:120000},async t=>{
  const {page,context,browser,url}=await fixture(t);await register(page,url,'StateAuthor');
  await page.goto(url+'/bots?example=curious-imp');await page.waitForSelector('.cm-content');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+a');
  await page.keyboard.insertText(`import {defineBot} from 'neonethack';
export default defineBot({name:'Stateful imp',initialize({hero,log}) {
  log('Initial state',hero.state);
  hero.controls.checkbox({id:'bold',label:'Bold exploration',checked:false,onChange:checked=>{log('Bold',checked);return 'explore';}});
  hero.controls.button({id:'yield',label:'Hand back control',onClick:()=>null});
  hero.addEventListener('stateChange',({detail})=>{log('Transition',detail.from,detail.to);if(detail.to==='denied')return false;});
  hero.addEventListener('stop',()=>log('FORBIDDEN STOP'));
  hero.addEventListener('turn',async()=>{log('Turn state',hero.state);if(hero.decision){hero.stop();return;}await hero.wait();await new Promise(resolve=>setTimeout(resolve,200));});
}});`);
  await page.locator('#role').selectOption('valkyrie');await page.locator('#seed-mode').selectOption('fixed');await page.locator('#seed').fill('42');
  await page.locator('#test').click();await page.getByLabel('Bold exploration').waitFor({timeout:60000});
  await page.getByLabel('Bold exploration').check();
  await page.waitForFunction(()=>document.querySelector('#output').textContent.includes('Turn state explore'));
  assert.match(await page.locator('#output').textContent(),/\[Script · Stateful imp · Turn \d+\] Bold true/);
  await page.locator('#script-state').fill('denied');await page.locator('#set-script-state').click();
  await page.waitForFunction(()=>document.querySelector('#output').textContent.includes('Turn state denied'));
  assert.doesNotMatch(await page.locator('#output').textContent(),/Transition explore denied/,'host bypasses veto');
  await page.screenshot({path:'/tmp/neohack-script-controls.png',fullPage:true});
  await page.getByRole('button',{name:'Hand back control'}).click();
  await page.waitForFunction(()=>!document.querySelector('#test').disabled);
  assert.match(await page.locator('#status[role=status]').textContent(),/Control yielded/);
  assert.doesNotMatch(await page.locator('#output').textContent(),/FORBIDDEN STOP/);
  assert.equal(await page.locator('#script-state').inputValue(),'null');
  assert.equal(await page.getByRole('button',{name:'Hand back control'}).isDisabled(),true);
  await page.waitForFunction(()=>document.querySelector('#recording').textContent.startsWith('Run backed up'));
  const runs=await page.evaluate(()=>fetch('/api/account/runs').then(r=>r.json()));assert.equal(runs.length,1);
  const path=url+`/api/account/runs/${runs[0].id}/journal`;
  const journal=await (await context.request.get(path)).json();assert.ok(journal.entries.length>=3);
  assert.ok(journal.entries.every(e=>e.source==='script'&&e.author==='Stateful imp'));
  assert.ok(journal.entries.some(e=>e.text==='Bold true'));assert.ok(!journal.entries.some(e=>e.text==='FORBIDDEN STOP'));
  const headers={origin:url};
  assert.equal((await context.request.put(path,{headers,data:{index:0,entry:journal.entries[0]}})).status(),409,'cannot overwrite notes');
  assert.equal((await context.request.put(path,{headers,data:{index:journal.entries.length,entry:{...journal.entries[0],revision:9999999}}})).status(),409,'cannot attach to unrecorded future frame');
  const anonymous=await browser.newContext();assert.equal((await anonymous.request.get(path)).status(),401);await anonymous.close();
  const other=await browser.newPage();await register(other,url,'OtherStateAuthor');assert.equal((await other.request.get(path)).status(),404);await other.close();
  await page.goto(url+'/login');await page.getByRole('button',{name:'View script journal'}).click();
  await page.waitForFunction(()=>document.querySelector('#runs').textContent.includes('Bold true'));
  assert.match(await page.locator('#runs').textContent(),/Script · Stateful imp/);
});

test('plain-text platform failures explain account outage and a fresh explicit attempt succeeds', {timeout:60000},async t=>{
 const {page,url}=await fixture(t);await page.goto(url+'/login');await passkey(page);
 let calls=0;
 await page.route('**/api/account/options',async route=>{calls++;if(calls===1)return route.fulfill({status:500,contentType:'text/plain',body:'A server error has occurred\nFUNCTION_INVOCATION_FAILED'});return route.continue();});
 await page.locator('#open-login').click();await page.locator('#name').fill('AfterOutage');await page.locator('#register').click();
 await page.waitForFunction(()=>document.querySelector('neohack-rail').shadowRoot.querySelector('#auth-status').textContent.includes('temporarily unavailable'));
 assert.equal(calls,1,'credential ceremonies are not automatically retried');
 assert.equal(await page.evaluate(()=>document.querySelector('neohack-rail').shadowRoot.querySelector('#auth-status').textContent),'The account service is temporarily unavailable. Please try again in a moment.');
 await page.locator('#register').click();
 await page.waitForFunction(()=>!document.querySelector('#account').hidden);
 assert.equal(await page.locator('#handle').textContent(),'AfterOutage');assert.equal(calls,2);
});

test('workshop chooser creates JavaScript scripts and saves private example copies at stable URLs', {timeout:120000}, async t=>{
 const {page,url,browser}=await fixture(t);await register(page,url,'ScriptAuthor');
 await page.goto(url+'/bots');
 await page.locator('#project-picker').waitFor({state:'visible'});
 assert.equal(await page.locator('#project-workspace').isVisible(),false);
 await page.locator('#new-script').click();
 await page.locator('#tabs').getByRole('tab',{name:'main.js'}).waitFor();
 const replace=async code=>{await page.locator('.cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText(code);};
 await page.locator('#filename').fill('helper.ts');await page.locator('#add-file').click();
 assert.match(await page.locator('#status[role=status]').textContent(),/ending in .js/);
 await replace('import {defineBot} from "neonethack";const bot=defineBot({name:"Mine"});export default bot;bot.on("turn",({hero})=>{hero.stop();});');
 await page.locator('#format-code').click();
 await page.waitForFunction(()=>document.querySelector('#status').textContent==='JavaScript formatted.');
 assert.match(await page.locator('.cm-content').innerText(),/\n  hero.stop\(\);\n/);
 await page.locator('#save').click();await page.waitForURL(/\?script=/);
 const ownUrl=page.url();
 const own=await page.evaluate(()=>fetch('/api/account/bots').then(r=>r.json()));assert.equal(own.length,1);
 await page.locator('#choose-project').click();await page.locator('#example-observer').click();
 assert.match(page.url(),/example=first-steps/);
 assert.equal(await page.locator('#save').textContent(),'Save my copy');
 await page.locator('#bot-name').fill('My first steps');await page.locator('#save').click();
 await page.waitForURL(/\?script=/);const firstUrl=page.url();assert.notEqual(firstUrl,ownUrl);
 await page.locator('#bot-name').fill('Revised first steps');await page.locator('#save').click();
 await page.waitForFunction(async()=> (await fetch('/api/account/bots').then(r=>r.json())).some(b=>b.name==='Revised first steps'));
 assert.equal(page.url(),firstUrl);
 await page.reload();await page.locator('#project-workspace').waitFor({state:'visible'});
 assert.equal(await page.locator('#bot-name').inputValue(),'Revised first steps');
 await page.locator('#choose-project').click();await page.locator('#example-observer').click();
 assert.equal(await page.locator('#bot-name').inputValue(),'First steps');
 await page.locator('#save').click();await page.waitForURL(/\?script=/);assert.notEqual(page.url(),firstUrl);
 const scripts=await page.evaluate(()=>fetch('/api/account/bots').then(r=>r.json()));assert.equal(scripts.length,3);
 assert.ok(scripts.every(b=>Object.keys(b.files).every(name=>name.endsWith('.js'))));
 await page.locator('#test').click();await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:60000});
 assert.equal(await page.locator('#status[role=status]').textContent(),'Script finished.');
 assert.match(await page.locator('#output').textContent(),/Searched once/);
 const stranger=await browser.newPage();await stranger.goto(firstUrl);
 await stranger.waitForFunction(()=>document.querySelector('#project-message').textContent.includes('Sign in'));
 assert.equal(await stranger.locator('#project-workspace').isVisible(),false);
 assert.equal((await stranger.request.get(url+'/api/account/bots')).status(),401);
 await register(stranger,url,'OtherScriptAuthor');await stranger.goto(firstUrl);
 await stranger.waitForFunction(()=>document.querySelector('#project-message').textContent.includes('not in your account'));
 assert.equal(await stranger.locator('#project-workspace').isVisible(),false);
 const invalid=await page.request.put(url+'/api/account/bots',{headers:{origin:url},data:{name:'Wrong language',role:'random',seed:'random',files:{'main.ts':'export default {};'}}});
 assert.equal(invalid.status(),400);
 await page.screenshot({path:'/tmp/neohack-workshop-javascript.png',fullPage:true});
});

test('workshop chooser keeps its heading in view, scrolls on mobile and opens the editor',async t=>{
 const {page,url}=await fixture(t);await page.setViewportSize({width:1280,height:800});await page.goto(url+'/bots');
 await page.locator('#picker-saved:disabled').waitFor();
 for(const width of [1280,390]) {
  await page.setViewportSize({width,height:800});
  const heading=await page.locator('.ide-heading').boundingBox();assert.ok(heading.x>=0&&heading.x+heading.width<=width);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#example-observer').scrollIntoViewIfNeeded();assert.equal(await page.locator('#example-observer').isVisible(),true);
 }
 await page.locator('#new-script').click();await page.locator('.cm-content').waitFor();
 assert.equal(await page.evaluate(()=>window.scrollY),0,'opening a script returns to its toolbar');
 assert.equal(await page.locator('#project-picker').isVisible(),false);
 await page.locator('#choose-project').click();await page.locator('#project-picker').waitFor();
 assert.equal(await page.locator('#picker-saved').isDisabled(),true);
});

test('workshop inputs and private source survive a page close during a backup outage',{timeout:120000},async t=>{
 const {page,context,url}=await fixture(t);await register(page,url,'OfflineAuthor');
 const failed=[];page.on('requestfailed',r=>failed.push(new URL(r.url()).pathname));
 await page.goto(url+'/');
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});
 await page.goto(url+'/bots?example=curious-imp');await page.waitForSelector('.cm-content');
 const main=`import {defineBot} from 'neonethack'; export default defineBot({name:'Offline imp',initialize({hero,log}){log('Retain this private offline note');hero.addEventListener('turn',async()=>{await hero.wait();hero.stop();});}});`;
 await page.locator('.cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText(main);
 await page.locator('#role').selectOption('valkyrie');await page.locator('#seed-mode').selectOption('fixed');await page.locator('#seed').fill('9');
 await context.route('**/api/**',route=>route.abort('internetdisconnected'));
 await page.locator('#test').click();await page.waitForFunction(()=>!document.querySelector('#test').disabled).catch(async e=>{throw Error(await page.locator('#status[role=status]').textContent()+'; '+await page.locator('#output').textContent()+'; '+failed.join(','),{cause:e});});
 assert.equal(await page.locator('#status[role=status]').textContent(),'Script finished.');
 assert.match(await page.locator('#output').textContent(),/Retain this private offline note/);
 // Terminate all page callbacks before any upload succeeds, keeping only IDB.
 await page.close();const reopened=await context.newPage();
 await reopened.goto(url+'/bots');await reopened.waitForSelector('#project-picker');
 await context.unroute('**/api/**');await reopened.evaluate(()=>window.dispatchEvent(new Event('online')));
 // The online event must recover the owner-bound source even though account
 // discovery failed while this new page was offline.
 const runs=await waitForRuns(reopened,r=>r.some(v=>v.sourceHash&&v.count>=2));
 assert.equal(runs.length,1);
 const source=await reopened.evaluate(id=>fetch('/api/account/runs/'+id+'/source').then(r=>r.json()),runs[0].id);
 assert.equal(JSON.parse(source.artifact).files['main.js'],main);
 const notes=await reopened.evaluate(id=>fetch('/api/account/runs/'+id+'/journal').then(r=>r.json()),runs[0].id);
 assert.ok(notes.entries.some(e=>e.text==='Retain this private offline note'));
 const manifest=await reopened.evaluate(async link=>(await fetch(link)).json(),runs[0].replayUrl);assert.equal(manifest.format,'neonethack.inputs');assert.ok(manifest.count>=2);
});
