// Run with a candidate server using isolated SESSIONS_DIR and Chromium CDP.
// APP_URL defaults to localhost:3311. No hidden state or engine test commands.
import { mkdir, writeFile } from "node:fs/promises";
import { browserTab } from "../../tools/cdp";
const out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/takeover/browser";
await mkdir(out, { recursive: true });
const b = await browserTab(
  `${process.env.APP_URL ?? "http://127.0.0.1:3311"}/play`,
  1500,
  1000,
);
const report: any = {};
try {
  await b.evaluate(`customElements.whenDefined('explorer-view')`);
  report.live = await b.evaluate(`(async()=>{
  const app=document.querySelector('explorer-view');await app.updateComplete;
  const calls=[];const tool=app.api.tool.bind(app.api);app.api.tool=async(name,args)=>{calls.push({name,args});return tool(name,args)};
  let last;const invoke=app.invoke.bind(app);app.invoke=(...args)=>last=invoke(...args);
  const click=async(label)=>{const button=[...app.shadowRoot.querySelectorAll('button')].find(b=>b.textContent.trim()===label);if(!button||button.disabled)throw Error('No enabled button '+label);button.click();await last;await app.updateComplete;};
  await click('Enter the dungeon');const first=structuredClone(app.obs);
  if(!app.ready)throw Error('New game did not enable actions');
  app.shadowRoot.querySelector('nh-map3d').focusSelf();
  await app.move('south');await app.updateComplete;
  if(app.obs.turn!==first.turn+1)throw Error('Move did not advance');
  await click('Eat');if(app.decision?.kind!=='item')throw Error('No food choices');
  if(app.decision.options.some(o=>o.label.includes('spear')))throw Error('Spear offered as food');
  const ration=[...app.shadowRoot.querySelectorAll('.option')].find(b=>b.textContent.includes('food ration'));if(!ration)throw Error('No ration');ration.click();await last;await app.updateComplete;
  if(app.decision?.kind==='confirmation')await app.answer({confirm:true});
  if(app.decision)throw Error('Eating left an unhandled decision');
  await click('Pray');const turn=app.obs.turn;await click('Decline');if(app.obs.turn!==turn||app.decision)throw Error('Prayer decline restarted the action');
  await app.act({action:'kick',target:{direction:'north'}});if(app.decision?.kind==='confirmation')await app.answer({confirm:false});
  for(let i=0;i<5;i++)await app.move(i%2?'north':'south');
  const before={turn:app.obs.turn,you:app.obs.you};await app.leave();await app.resume();await app.updateComplete;
  if(JSON.stringify(before)!==JSON.stringify({turn:app.obs.turn,you:app.obs.you}))throw Error('Resume moved the explorer');
  if(calls.some(c=>c.name==='get_state'))throw Error('Play required extra state reads');
  window.__testCalls=calls;window.__testSession=app.saved;window.__testFirst=first;
  return {firstTurn:first.turn,currentTurn:app.obs.turn,inventory:app.obs.inventory,session:app.saved,renderer:app.shadowRoot.querySelector('nh-map3d').debug(),calls:calls.map(c=>c.name),error:app.error};
 })()`);
  await b.screenshot(`${out}/live-3d.png`);
  report.replay = await b.evaluate(`(async()=>{
  const app=document.querySelector('explorer-view');const count=window.__testCalls.length;const live=structuredClone(app.obs);
  await app.refreshRuns();await app.watch(window.__testSession);await app.updateComplete;
  if(app.mode!=='replay')throw Error('Replay did not open');
  if(app.obs.turn!==window.__testFirst.turn)throw Error('Replay did not start at initial perception');
  const frames=app.recording.index.length;
  await app.seek(frames-1);await app.seek(0);await app.seek(Math.min(3,frames-1));
  await app.act({action:'wait'});if(window.__testCalls.length!==count)throw Error('Replay sent a game action');
  if(app.ready)throw Error('Replay enabled game controls');
  const result={frames,playhead:app.playhead,turn:app.obs.turn,coreCalls:window.__testCalls.length-count,renderer:app.shadowRoot.querySelector('nh-map3d').debug(),error:app.error};
  window.__returnLive=()=>{app.showLive();if(JSON.stringify(app.obs)!==JSON.stringify(live))throw Error('Returning live replaced live world with replay state')};return result;
 })()`);
  await b.screenshot(`${out}/replay-3d.png`);
  await b.evaluate("window.__returnLive()");
  await b.call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await b.screenshot(`${out}/mobile-3d.png`);
  report.mobile = await b.evaluate(
    `({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})`,
  );
  if (report.mobile.scrollWidth > report.mobile.width)
    throw Error("Mobile layout overflows horizontally");
  report.errors = b.errors;
  if (b.errors.length) throw Error("Browser runtime exceptions");
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = String(e);
  report.errors = b.errors;
  await b.screenshot(`${out}/failure.png`).catch(() => {});
}
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
process.exit(report.passed ? 0 : 1);
