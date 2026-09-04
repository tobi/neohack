import { mkdir, writeFile } from "node:fs/promises";
import { browserTab } from "../../tools/cdp";
const base = process.env.APP_URL ?? "http://127.0.0.1:3312",
  out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/lifesaving/study-browser";
await mkdir(out, { recursive: true });
const b = await browserTab(`${base}/play`, 1400, 1000),
  report: any = {};
try {
  await b.evaluate(`customElements.whenDefined('explorer-view')`);
  report.interruption = await b.evaluate(`(async()=>{
  window.app=document.querySelector('explorer-view');await app.invoke('new_game',{seed:2,name:'Study',role:'wizard',race:'human',gender:'female',align:'neutral'});
  window.book=app.obs.inventory.find(i=>i.label.includes('spellbook of jumping'));
  await app.act({action:'read',item:{id:book.id}});const decision=app.decision.id;await app.leave();await app.resume();await app.updateComplete;
  if(app.decision?.id!==decision)throw Error('Pending study consent was lost');
  [...app.shadowRoot.querySelectorAll('.decision button')].find(b=>b.textContent.trim()==='Confirm').click();
  for(let i=0;i<100&&app.busy;i++)await new Promise(r=>setTimeout(r,20));await app.updateComplete;
  if(app.error||app.envelope.outcome.status!=='interrupted'||app.obs.turn!==5||!app.envelope.events.some(e=>e.type==='actionResult'&&e.action==='read'&&e.status==='interrupted'))throw Error('Real interrupted study was not reported');
  await app.look();if(app.decision||app.obs.turn!==5)throw Error('Inspection restarted the occupation');
  return {turn:app.obs.turn,status:'interrupted'};
 })()`);
  await b.screenshot(`${out}/interrupted.png`);
  report.completion = await b.evaluate(`(async()=>{
  await app.act({action:'wait'});await app.act({action:'read',item:{id:book.id}});if(app.decision?.kind!=='confirmation')throw Error('Study restarted without new consent');
  await app.answer({confirm:true});await app.updateComplete;
  if(app.error||app.envelope.outcome.status!=='completed'||app.envelope.outcome.turnsElapsed!==5)throw Error('Explicit restarted study did not finish');return {turn:app.obs.turn,elapsed:app.envelope.outcome.turnsElapsed};
 })()`);
  report.replay = await b.evaluate(`(async()=>{
  const id=app.saved;await app.leave();let calls=0;const tool=app.api.tool.bind(app.api);app.api.tool=(...args)=>{calls++;return tool(...args)};
  await app.watch(id);const middle=app.recording.index.find(row=>row.turn===5);await app.seek(middle.sequence);
  if(app.envelope.outcome.status!=='interrupted')throw Error('Interrupted frame changed');await app.seek(0);if(app.obs.turn!==1)throw Error('Future study leaked backwards');await app.seek(app.recording.index.length-1);await app.act({action:'read',item:{id:book.id}});if(calls)throw Error('Study replay invoked engine');return {frames:app.recording.index.length,coreCalls:calls};
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
