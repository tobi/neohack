import { mkdir, writeFile } from "node:fs/promises";
import { browserTab } from "../../tools/cdp";
const base = process.env.APP_URL ?? "http://127.0.0.1:3312",
  out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/menu-binding/browser";
await mkdir(out, { recursive: true });
const b = await browserTab(`${base}/play`, 1400, 1000),
  report: any = {};
try {
  await b.evaluate(`customElements.whenDefined('explorer-view')`);
  report.offer = await b.evaluate(`(async()=>{
  window.app=document.querySelector('explorer-view');app.hero='PickupTest';app.seed='42';await app.start();
  for(const name of ['food ration','dagger']){const item=app.obs.inventory.find(i=>i.label.includes(name));await app.act({action:'drop',item:{id:item.id}});if(app.error)throw Error(app.error);}
  await app.act({action:'pickup'});await app.updateComplete;
  if(app.decision?.kind!=='choice'||app.decision.options.length!==2||!app.decision.options.every(o=>Number.isInteger(o.id)))throw Error('No actionable two-object menu');
  window.pickupDecision=app.decision.id;window.pickupTurn=app.obs.turn;
  await app.leave();await app.resume();await app.updateComplete;
  if(app.decision?.id!==pickupDecision||app.obs.turn!==pickupTurn)throw Error('Menu did not survive save/resume');
  const emptyConfirm=[...app.shadowRoot.querySelectorAll('.decision button')].find(b=>b.textContent.includes('Confirm selection'));
  if(app.decision.selection.min!==1||!emptyConfirm?.disabled)throw Error('Empty selection was incorrectly enabled');
  return {turn:app.obs.turn,decision:app.decision};
 })()`);
  await b.screenshot(`${out}/pickup-menu.png`);
  report.pickup = await b.evaluate(`(async()=>{
  const option=[...app.shadowRoot.querySelectorAll('.decision .option')].find(b=>b.textContent.includes('food ration'));if(!option)throw Error('Missing rendered ration option');option.click();await app.updateComplete;
  const button=[...app.shadowRoot.querySelectorAll('.decision button')].find(b=>b.textContent.includes('Confirm selection'));if(!button||button.disabled)throw Error('Missing usable confirmation');button.click();
  for(let i=0;i<100&&app.busy;i++)await new Promise(r=>setTimeout(r,20));await app.updateComplete;
  if(app.error||app.decision||app.obs.turn!==pickupTurn+1||app.obs.here.items.length!==1||app.obs.here.items[0].category!=='weapon'||!app.obs.inventory.some(i=>i.category==='food'))throw Error('Rendered selection did not pick only the ration: '+app.error);
  return {turn:app.obs.turn,here:app.obs.here};
 })()`);
  await b.screenshot(`${out}/picked-food.png`);
  report.replay = await b.evaluate(`(async()=>{
  const id=app.saved;await app.leave();let calls=0;const tool=app.api.tool.bind(app.api);app.api.tool=(...args)=>{calls++;return tool(...args)};
  await app.watch(id);const menu=app.recording.index.findLast(row=>row.turn===pickupTurn);await app.seek(menu.sequence);
  // The latest T3 boundary includes the resumed menu, not any future inventory.
  if(app.obs.here.items.length!==2)throw Error('Pickup leaked backwards');await app.seek(app.recording.index.length-1);if(app.obs.here.items.length!==1)throw Error('Pickup missing in final frame');await app.act({action:'wait'});if(calls)throw Error('Replay invoked engine');return {coreCalls:calls,frames:app.recording.index.length};
 })()`);
  if (b.errors.length) throw Error(JSON.stringify(b.errors));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  await b.screenshot(`${out}/failure.png`).catch(() => {});
} finally {
  await b
    .evaluate(
      `(async()=>{if(window.app?.mode==='live'&&app.envelope&&!app.envelope.ended)await app.leave()})()`,
    )
    .catch(() => {});
  await b.close();
}
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(report);
process.exit(report.passed ? 0 : 1);
