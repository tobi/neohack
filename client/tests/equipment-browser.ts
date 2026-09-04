import { mkdir, writeFile } from "node:fs/promises";
import { browserTab } from "../../tools/cdp";
const base = process.env.APP_URL ?? "http://127.0.0.1:3312",
  out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/equipment/browser";
await mkdir(out, { recursive: true });
const b = await browserTab(`${base}/play`, 1400, 1000),
  report: any = {};
try {
  await b.evaluate(`customElements.whenDefined('explorer-view')`);
  report.choice = await b.evaluate(`(async()=>{
  window.app=document.querySelector('explorer-view');app.role='wizard';app.hero='EquipmentTest';app.seed='42';await app.start();
  window.ringId=app.obs.inventory.find(i=>i.category==='ring').id;window.cloakId=app.obs.inventory.find(i=>i.category==='armor').id;
  await app.act({action:'equip'});await app.updateComplete;if(app.decision.options.length!==2||app.decision.options.some(o=>o.id===cloakId))throw Error('Equipment offered a worn cloak');
  const ring=app.obs.inventory.find(i=>i.id===ringId),option=[...app.shadowRoot.querySelectorAll('.decision .option')].find(b=>b.textContent.includes(ring.label));if(!option)throw Error('No rendered ring option');option.click();
  for(let i=0;i<100&&app.busy;i++)await new Promise(r=>setTimeout(r,20));await app.updateComplete;
  if(app.error||app.decision.kind!=='choice'||!app.decision.options.some(o=>o.label==='Left'))throw Error('Missing semantic hand choice: '+app.error);
  const decision=app.decision.id,turn=app.obs.turn;await app.leave();await app.resume();await app.updateComplete;if(app.decision.id!==decision||app.obs.turn!==turn)throw Error('Hand choice lost on resume');
  return {turn,decision:app.decision};
 })()`);
  await b.screenshot(`${out}/hand-choice.png`);
  report.remove = await b.evaluate(`(async()=>{
  const left=[...app.shadowRoot.querySelectorAll('.decision .option')].find(b=>b.textContent.trim()==='Left');left.click();for(let i=0;i<100&&app.busy;i++)await new Promise(r=>setTimeout(r,20));await app.updateComplete;
  const worn=id=>app.obs.inventory.find(i=>i.id===id).usage.includes('worn');if(app.error||!worn(ringId)||!worn(cloakId))throw Error('Ring was not equipped');window.wornTurn=app.obs.turn;
  const ring=app.obs.inventory.find(i=>i.id===ringId);[...app.shadowRoot.querySelectorAll('.inventory button')].find(b=>b.textContent.includes(ring.label)).click();await app.updateComplete;
  const remove=[...app.shadowRoot.querySelectorAll('.action-row button')].find(b=>b.textContent.trim()==='Remove');if(!remove||remove.disabled)throw Error('No usable Remove action');remove.click();for(let i=0;i<100&&app.busy;i++)await new Promise(r=>setTimeout(r,20));await app.updateComplete;
  if(app.error||worn(ringId)||!worn(cloakId)||app.obs.turn!==wornTurn+1)throw Error('Remove targeted wrong equipment: '+app.error);await app.inspect('self');await app.updateComplete;
  return {turn:app.obs.turn,ringWorn:worn(ringId),cloakWorn:worn(cloakId)};
 })()`);
  await b.screenshot(`${out}/ring-removed.png`);
  report.replay = await b.evaluate(`(async()=>{
  const id=app.saved;await app.leave();let calls=0;const tool=app.api.tool.bind(app.api);app.api.tool=(...args)=>{calls++;return tool(...args)};
  await app.watch(id);const worn=id=>app.obs.inventory.find(i=>i.id===id).usage.includes('worn');if(worn(ringId))throw Error('Future equipment leaked backwards');
  const middle=app.recording.index.find(r=>r.turn===wornTurn);await app.seek(middle.sequence);if(!worn(ringId)||!worn(cloakId))throw Error('Recorded equipment is missing');
  await app.seek(app.recording.index.length-1);if(worn(ringId)||!worn(cloakId))throw Error('Wrong final equipment');await app.act({action:'remove',item:{id:cloakId}});if(calls)throw Error('Replay changed equipment');return {frames:app.recording.index.length,coreCalls:calls};
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
