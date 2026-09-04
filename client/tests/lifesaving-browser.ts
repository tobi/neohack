import { mkdir, writeFile } from "node:fs/promises";
import { browserTab } from "../../tools/cdp";
import { LIFESAVING_IDENTITY } from "../../mcp/tests/lifesaving-fixture";
const base = process.env.APP_URL ?? "http://127.0.0.1:3312",
  out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/lifesaving/browser";
await mkdir(out, { recursive: true });
const b = await browserTab(`${base}/play`, 1400, 1000),
  report: any = {};
try {
  await b.evaluate(`customElements.whenDefined('explorer-view')`);
  report.warning = await b.evaluate(`(async()=>{
  window.app=document.querySelector('explorer-view');await app.invoke('new_game',${JSON.stringify(LIFESAVING_IDENTITY)});await app.move('west');
  const floor=app.obs.here.items.find(i=>i.category==='amulet');await app.act({action:'pickup',item:{id:floor.id}});window.amulet=app.obs.inventory.find(i=>i.category==='amulet');await app.act({action:'equip',item:{id:amulet.id}});window.equippedTurn=app.obs.turn;
  const food=app.obs.inventory.find(i=>i.category==='food'&&i.label.includes('food ration'));await app.act({action:'eat',item:{id:food.id}});await app.act({action:'eat',item:{id:food.id}});
  if(app.decision?.kind!=='confirmation'||app.decision.about!=='Continue eating?')throw Error('No real choking-risk warning');
  const decision=app.decision.id,turn=app.obs.turn;await app.leave();await app.resume();await app.updateComplete;if(app.decision?.id!==decision||app.obs.turn!==turn)throw Error('Warning did not survive resume');return {turn,decision};
 })()`);
  await b.screenshot(`${out}/warning.png`);
  report.saved = await b.evaluate(`(async()=>{
  [...app.shadowRoot.querySelectorAll('.decision button')].find(b=>b.textContent.trim()==='Confirm').click();for(let i=0;i<100&&app.busy;i++)await new Promise(r=>setTimeout(r,20));await app.updateComplete;
  const fact=app.envelope.events.find(e=>e.type==='lifeSaved');if(app.error||app.envelope.ended||app.envelope.end||!app.ready||!fact||fact.cause!=='choking'||app.obs.vitals.health<=0||app.obs.inventory.some(i=>i.id===amulet.id))throw Error('Rescue was lost or treated as terminal');
  if(!app.messages.some(m=>m.text.startsWith('Life saved · T11')))throw Error('Structured rescue notice missing');window.rescuedTurn=app.obs.turn;await app.inspect('self');await app.updateComplete;return {turn:app.obs.turn,health:app.obs.vitals.health,fact,ready:app.ready};
 })()`);
  await b.screenshot(`${out}/survived.png`);
  report.replay = await b.evaluate(`(async()=>{
  await app.act({action:'wait'});if(app.obs.turn!==rescuedTurn+1||app.envelope.ended)throw Error('Rescued world cannot continue');const id=app.saved;await app.leave();let calls=0;const tool=app.api.tool.bind(app.api);app.api.tool=(...args)=>{calls++;return tool(...args)};
  await app.watch(id);await app.seek(app.recording.index.find(r=>r.turn===equippedTurn).sequence);if(!app.obs.inventory.some(i=>i.id===amulet.id)||app.messages.some(m=>m.text.startsWith('Life saved')))throw Error('Future rescue leaked backwards');
  await app.seek(app.recording.index.find(r=>r.turn===rescuedTurn).sequence);if(app.envelope.ended||app.obs.inventory.some(i=>i.id===amulet.id)||!app.messages.some(m=>m.text.startsWith('Life saved · T11')))throw Error('Recorded rescue changed');await app.act({action:'wait'});if(calls)throw Error('Rescue replay invoked engine');return {frames:app.recording.index.length,coreCalls:calls};
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
