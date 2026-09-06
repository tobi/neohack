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
 await page.goto(url+'/bots');await page.waitForFunction(()=>document.querySelector('#author').textContent.includes('BotAuthor'));
 await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Bot saved.');
 await page.locator('#role').selectOption('valkyrie');await page.locator('#seed-mode').selectOption('fixed');await page.locator('#seed').fill('42');
 await page.locator('#test').click();
 await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:90000}).catch(async e=>{throw Error((await page.locator('#status[role=status]').textContent())+'\n'+errors.join('\n'),{cause:e});});
 assert.match(await page.locator('#status[role=status]').textContent(),/Script finished|Test budget reached/);
 assert.ok(await page.evaluate(()=>document.querySelector('neohack-world').snapshot.observation.turn>1));
 await page.screenshot({path:'/tmp/neohack-bots.png',fullPage:true});
 const runs=await page.evaluate(()=>fetch('/api/account/runs').then(r=>r.json()));assert.equal(runs.length,1);assert.ok(runs[0].count>=2);
 await page.goto(url+'/login');await page.getByRole('button',{name:/Replay \d+ frames/}).click();await page.waitForFunction(()=>!document.querySelector('#playback').hidden,{},{timeout:10000}).catch(async e=>{throw Error(await page.locator('#status[role=status]').textContent(),{cause:e});});
 const first=await page.evaluate(()=>document.querySelector('#replay').snapshot);await page.locator('#scrub').fill(String(runs[0].count-1));const last=await page.evaluate(()=>document.querySelector('#replay').snapshot);assert.ok(last.revision>first.revision);
 await page.screenshot({path:'/tmp/neohack-login.png',fullPage:true});
 const actualErrors=errors.filter(e=>!e.includes('401')&&!e.includes('400')&&!e.includes('409'));assert.deepEqual(actualErrors,[]);
});
test('sandbox blocks network access and Stop terminates an infinite loop', {timeout:120000},async t=>{
 const {page,url,errors}=await fixture(t);await page.goto(url+'/bots');await page.waitForSelector('.cm-content');
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

test('signed-in human play records real frames and other accounts cannot read them', {timeout:60000},async t=>{
 const {page,url,browser}=await fixture(t);await register(page,url,'HumanAuthor');await page.goto(url);
 await page.waitForFunction(()=>!document.querySelector('#new-adventure').disabled);
 await page.getByRole('button',{name:'Begin your adventure',exact:true}).click();await page.getByLabel('YOUR NAME',{exact:true}).fill('Human run');await page.locator('input[name=role][value=valkyrie]').check();await page.getByRole('button',{name:'Enter the dungeon →',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.observation&&document.querySelector('pixel-nethack').getAttribute('aria-busy')==='false');
 await page.evaluate(async()=>{const app=document.querySelector('pixel-nethack');await app.run(()=>app.game.search());});
 await page.waitForFunction(()=>document.querySelector('#account-recording').textContent==='Replay saved');
 const runs=await page.evaluate(()=>fetch('/api/account/runs').then(r=>r.json()));assert.equal(runs.length,1);assert.ok(runs[0].count>=2);assert.equal(runs[0].name,'Human run');assert.equal(runs[0].control,'interactive');assert.equal(runs[0].automated,false);
 const other=await browser.newPage();await register(other,url,'OtherAuthor');
 assert.equal(await other.evaluate(async id=>(await fetch('/api/account/runs/'+id+'/frames')).status,runs[0].id),404);
});

test('HTTP workshop explains unavailable Web Crypto before loading the engine', {timeout:30000},async t=>{
 const {page,url,errors}=await fixture(t,{insecure:true});const requests=[];page.on('request',r=>requests.push(r.url()));
 await page.goto(url.replace('localhost','workshop-preview.test')+'/bots');await page.waitForSelector('.cm-content');
 assert.equal(await page.evaluate(()=>!!crypto.subtle),false);
 await page.locator('#test').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('HTTPS or localhost'));
 assert.equal(requests.some(u=>u.includes('/runtime/')),false);
 assert.equal(await page.locator('#secure-context').isVisible(),true);
 assert.equal(errors.some(e=>e.includes("reading 'digest'")),false);
});

test('IDE defaults, random project persistence, in-place top-rail login and resizing', {timeout:60000},async t=>{
 const {page,url}=await fixture(t);await page.goto(url+'/bots');await page.waitForSelector('.cm-content');
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
 const {page,url}=await fixture(t);await page.goto(url+'/bots');await page.waitForSelector('.cm-content');
 await page.locator('.cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText('export default {name:\"Test bot\",initialize({hero,game}) { hero.addEventListener("turn", async()=>{ for(let i=0;i<1001;i++) await game.observe(); }); }}');
 await page.locator('#test').click();await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:50000});
 assert.equal(await page.locator('#status[role=status]').textContent(),'Test budget reached (1000 calls).');
});

test('hero API has real TypeScript completions, documentation, diagnostics and multi-file execution', {timeout:120000}, async t=>{
 const {page,url}=await fixture(t);await page.goto(url+'/bots');await page.waitForSelector('.cm-content');
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
   const files={'main.ts':"import { defineBot, Hero } from 'neonethack';\nimport { heading } from './strategy';\nexport default defineBot({name:\"Test bot\",initialize({hero}) { hero.addEventListener('turn', async()=>{await hero.go(heading);hero.stop();}); }});",'strategy.ts':"import { direction } from 'neonethack'; export const heading = direction.northWest;"};
   const ask=(kind,position,name)=>new Promise(resolve=>{worker.onmessage=e=>resolve(e.data);worker.postMessage({id:1,kind,files,file:'main.ts',position,name});});
   const clean=await ask('diagnostics');const original=files['main.ts'];files['main.ts']="import {defineBot} from 'neonethack'; defineBot({initialize(){}});";const unnamed=await ask('diagnostics');files['main.ts']=original;files['strategy.ts']='export const heading = 123;';const bad=await ask('diagnostics');
   files['main.ts']="import { Hero, defineBot } from 'neonethack'; defineBot({name:\"Test bot\",initialize({hero}) { hero.";
   const detail=await ask('detail',files['main.ts'].length,'go');
   files['main.ts']="import {defineBot,type ScriptState} from 'neonethack'; export default defineBot({name:'Typed state',initialize({hero}){ const state:ScriptState={mode:'run'}; hero.controls.button({id:'pause',label:'Pause',onClick:()=>null}); hero.controls.checkbox({id:'bold',label:'Bold',checked:true,onChange:checked=>({state:{bold:checked}})}); hero.addEventListener('stateChange',({detail})=>{if(detail.from==='run' && detail.to===null) return false;}); hero.addEventListener('beforeLoot',async({detail})=>{await detail.select(detail.decision.options.filter(o=>o.suggested).map(o=>o.id));return {state};}); }});";
   const stateTypes=await ask('diagnostics');
   files['main.ts']="import {defineBot} from 'neonethack';defineBot({name:'Bad state',initialize({hero}){hero.setState(123);}});";
   const badState=await ask('diagnostics');
   worker.terminate();return {clean,bad,detail,unnamed,stateTypes,badState};
 });
 assert.deepEqual(language.stateTypes.result,[]);assert.ok(language.badState.result.some(d=>d.message.includes('123')));assert.deepEqual(language.clean.result,[]);assert.ok(language.unnamed.result.some(d=>d.message.includes("name")));assert.ok(language.bad.result.some(d=>d.message.includes('123')));assert.match(language.detail.result.docs,/ONE step/);
 await page.locator('#tabs').getByRole('tab',{name:'strategy.ts'}).click();
 await replace("import { direction } from 'neonethack'; export const heading = direction.north;");
 await page.locator('#tabs').getByRole('tab',{name:'main.ts'}).click();
 await replace(prefix+"import { heading } from './strategy';\nexport default defineBot({name:\"Test bot\",initialize({hero, log}){ hero.addEventListener('turn', async()=>{log('hungry',hero.isHungry()); log('enemies',hero.sense(entities.Enemy).length); await hero.go(heading); log('hero turn',hero.snapshot.observation.turn);hero.stop();}); }});");
 await page.locator('#role').selectOption('valkyrie');await page.locator('#seed-mode').selectOption('fixed');await page.locator('#seed').fill('42');await page.locator('#test').click();
 await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:90000});
 assert.equal(await page.locator('#status[role=status]').textContent(),'Script finished.');
 assert.match(await page.locator('#output').textContent(),/hungry false/);assert.match(await page.locator('#output').textContent(),/hero turn/);
 await page.screenshot({path:'/tmp/neohack-hero-workshop.png',fullPage:true});
});

test('automated history retains exact source, construction autoloot and executable name', {timeout:90000}, async t=>{
 const {page,url,browser}=await fixture(t);await register(page,url,'SourceAuthor');
 await page.goto(url+'/bots');await page.waitForSelector('.cm-content');
 const replace=async code=>{await page.locator('.cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText(code);};
 const main=`import {defineBot} from 'neonethack';
import {message} from './strategy';
export default defineBot({name:'Archive imp',autoloot:{enabled:true,itemTypes:['gold'],arrows:false,leaveCorpses:true,leaveKnownCursed:true,lootPatterns:['ration'],ignorePatterns:['corpse']},initialize({hero,log}) {
 log(message); log('rules',hero.snapshot.observation.automaticPickup);
 hero.addEventListener('turn',async()=>{await hero.wait();hero.stop();});
}});`;
 const helper="export const message='original helper';";
 await page.locator('#tabs').getByRole('tab',{name:'strategy.ts'}).click();await replace(helper);
 await page.locator('#tabs').getByRole('tab',{name:'main.ts'}).click();await replace(main);
 await page.locator('#bot-name').fill('Different project label');
 await page.locator('#test').click();await replace('// edited after Test was clicked');
 await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:60000});
 assert.equal(await page.locator('#status[role=status]').textContent(),'Script finished.');
 assert.match(await page.locator('#output').textContent(),/original helper/);
 const runs=await page.evaluate(()=>fetch('/api/account/runs').then(r=>r.json()));
 assert.equal(runs.length,1);const run=runs[0];assert.equal(run.name,'Archive imp');assert.equal(run.automated,true);assert.equal(run.control,'bot');
 const saved=await page.evaluate(id=>fetch(`/api/account/runs/${id}/source`).then(r=>r.json()),run.id);
 const source=JSON.parse(saved.artifact);assert.equal(source.files['main.ts'],main);assert.equal(source.files['strategy.ts'],helper);
 assert.match(source.compiledFiles['main.ts'],/require\("neonethack"\)/);assert.equal(source.compiler.name,'typescript');assert.equal(source.entrypoint,'main.ts');
 assert.deepEqual(source.autoloot,{enabled:true,itemTypes:['gold'],arrows:false,leaveCorpses:true,leaveKnownCursed:true,lootPatterns:['ration'],ignorePatterns:['corpse']});
 const {createHash}=await import('node:crypto');assert.equal(saved.sha256,createHash('sha256').update(saved.artifact).digest('hex'));
 await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Bot saved.');
 const rejected=await page.evaluate(async ({run,source})=>{
   const frames=await fetch(`/api/account/runs/${run.id}/frames`).then(r=>r.json());
   const frame=structuredClone(frames.frames.at(-1));frame.revision=run.revision+1;
   const append=extra=>fetch(`/api/account/runs/${run.id}/frames`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...run,index:run.count,frame,...extra})}).then(r=>r.status);
   return [await append({source}),await append({name:'Renamed imp'}),await append({control:'interactive'})];
 },{run,source});assert.deepEqual(rejected,[409,409,409]);
 await page.goto(url+'/login');await page.getByRole('button',{name:'View bot source'}).click();
 await page.getByText(main,{exact:true}).waitFor();assert.match(await page.locator('#runs').textContent(),/Automated bot/);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(await page.evaluate(id=>fetch(`/api/account/runs/${id}/source`).then(r=>r.json()),run.id),saved);
 const other=await browser.newPage();await register(other,url,'SourceOther');
 assert.equal(await other.evaluate(async id=>(await fetch(`/api/account/runs/${id}/source`)).status,run.id),404);
});

test('invalid bot names and failed source persistence never initialize the bot', {timeout:90000},async t=>{
 const {page,url}=await fixture(t);await register(page,url,'SourceFailure');await page.goto(url+'/bots');await page.waitForSelector('.cm-content');
 const replace=async code=>{await page.locator('.cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText(code);};
 await replace(`export default {initialize({log}){log('MUST NOT RUN')}}`);
 await page.locator('#test').click();await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:60000});
 assert.match(await page.locator('#status[role=status]').textContent(),/needs a name/);
 assert.doesNotMatch(await page.locator('#output').textContent(),/MUST NOT RUN/);
 await page.route('**/api/account/runs/*/frames',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"test storage failure"}'}));
 await replace(`export default {name:'Failure imp',initialize({log}){log('MUST NOT RUN')}}`);
 await page.locator('#test').click();await page.waitForFunction(()=>!document.querySelector('#test').disabled,{},{timeout:60000});
 assert.match(await page.locator('#status[role=status]').textContent(),/Could not save bot source/);
 assert.doesNotMatch(await page.locator('#output').textContent(),/MUST NOT RUN/);
 assert.deepEqual(await page.evaluate(()=>fetch('/api/account/runs').then(r=>r.json())),[]);
});

test('script controls, null silence and private journal survive a real workshop run', {timeout:120000},async t=>{
  const {page,context,browser,url}=await fixture(t);await register(page,url,'StateAuthor');
  await page.goto(url+'/bots');await page.waitForSelector('.cm-content');
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
