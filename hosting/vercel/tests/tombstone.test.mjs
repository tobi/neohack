import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../../../lib/neonethack/tests/native-fixture.mjs';
import {createTestHarness} from './server.mjs';
import {chromium} from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';

test('confirmed engine death replaces the hero, and seeking back restores the hero', {timeout:120000}, async t=>{
  // Same ordinary seeded choking scenario as the core lifesaving contract tests.
  const {api}=await fixture(t);
  const game=await api.create({seed:4386,name:'Tombstone',role:'tourist',race:'human',gender:'female',align:'neutral'});
  const first=structuredClone(game.state);
  await game.move('west');
  const amulet=game.observation.here.items.find(i=>i.category==='amulet');assert.ok(amulet);
  await game.pickup({id:amulet.id});await game.wait();
  const food=game.observation.inventory.find(i=>i.category==='food'&&i.label.includes('food ration'));assert.ok(food);
  await game.eat({id:food.id});await game.eat({id:food.id});
  assert.equal(game.decision?.kind,'confirmation');
  await game.answer(game.decision.id,{kind:'confirmation',confirm:true});
  assert.equal(game.state.end?.kind,'death');
  const last=structuredClone(game.state);assert.ok(last.observation.you);
  const server=createTestHarness();const {url}=await server.listen();
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});
  t.after(async()=>{await browser.close();await server.close();});
  const page=await browser.newPage({reducedMotion:'reduce'});
  await page.goto(new URL('/component',url).href);
  await page.waitForFunction(()=>!!document.querySelector('neohack-world')?.loadReplay);
  await page.evaluate(({first,last})=>{const w=document.querySelector('neohack-world');w.parentElement.classList.remove('world-stage');w.style.height='420px';w.setAttribute('role','tourist');w.removeAttribute('static');w.setAttribute('controls','');w.loadReplay([first,last]);w.seek(1);},{first,last});
  await page.waitForFunction(()=>document.querySelector('neohack-world').shadowRoot.querySelector('canvas').dataset.motion==='still');
  const canvas=page.locator('neohack-world canvas');
  assert.equal(await canvas.getAttribute('data-hero'),'tombstone');
  assert.match(await canvas.getAttribute('aria-label'),/tombstone/);
  assert.deepEqual(await page.evaluate(()=>document.querySelector('neohack-world').snapshot),last,'presentation does not mutate the terminal receipt');
  await page.locator('neohack-world').screenshot({path:'/tmp/neohack-tombstone.png'});
  await page.evaluate(()=>document.querySelector('neohack-world').seek(0));
  await page.waitForFunction(()=>document.querySelector('neohack-world').shadowRoot.querySelector('canvas').dataset.motion==='idle');
  assert.equal(await canvas.getAttribute('data-hero'),'hero');
  for(const kind of ['quit','ascended','escaped','disconnected','engineError','unknown']){
    await page.evaluate(({last,kind})=>{last.end.kind=kind;document.querySelector('neohack-world').snapshot=last;},{last,kind});
    assert.equal(await canvas.getAttribute('data-hero'),'hero',kind);
  }
  await page.evaluate(last=>{last.ended=false;document.querySelector('neohack-world').snapshot=last;},last);
  assert.equal(await canvas.getAttribute('data-hero'),'hero');
  await page.evaluate(last=>{last.observation.you=null;document.querySelector('neohack-world').snapshot=last;},last);
  assert.notEqual(await canvas.getAttribute('data-hero'),'tombstone');
});
