// Real inventory/equipment/decision inspection, plus explicit replay race fixtures.
import { mkdir, writeFile } from "node:fs/promises";
import { browserTab } from "../../tools/cdp";
const base = process.env.APP_URL ?? "http://127.0.0.1:3312",
  out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/inspection/browser";
await mkdir(out, { recursive: true });
const b = await browserTab(`${base}/play`, 1400, 1000);
const report: any = {};
try {
  await b.evaluate(`customElements.whenDefined('explorer-view')`);
  report.self = await b.evaluate(`(async()=>{
  window.app=document.querySelector('explorer-view');app.hero='InspectionTest';app.seed='42';await app.start();await app.updateComplete;
  window.calls=[];const tool=app.api.tool.bind(app.api);app.api.tool=(name,args)=>{calls.push({name,args});return tool(name,args)};
  window.waitIdle=async()=>{const end=performance.now()+10000;while(app.busy){if(performance.now()>end)throw Error('Action timed out');await new Promise(r=>setTimeout(r,16))}await app.updateComplete};
  window.panel=async()=>{await app.updateComplete;const p=app.shadowRoot.querySelector('nh-inspection');if(!p)throw Error('No inspector');await p.updateComplete;return p};
  await app.inspect('self');const p=await panel();
  if(app.obs.turn!==1||app.envelope.outcome.turnsElapsed!==0||p.target!=='self')throw Error('Self inspection spent a turn');
  if(app.obs.perception?.equipment!=='current'||!p.shadowRoot.textContent.includes('wielded'))throw Error('Equipment facts not displayed');
  if(p.shadowRoot.activeElement?.tagName!=='H2')throw Error('Inspector did not receive keyboard focus');
  window.beforeKeys=calls.length;
  return {turn:app.obs.turn,perception:app.obs.perception,title:p.shadowRoot.querySelector('h2').textContent};
 })()`);
  await b.screenshot(`${out}/self.png`);
  await b.call("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown" });
  await b.call("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown" });
  await b.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" });
  await b.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape" });
  report.here = await b.evaluate(`(async()=>{
  await app.updateComplete;if(calls.length!==beforeKeys||app.inspection)throw Error('Inspection keyboard leaked an action or failed to close');
  const ration=app.obs.inventory.find(i=>i.category==='food');window.rationLabel=ration.label;
  await app.act({action:'drop',item:{id:ration.id}});const turn=app.obs.turn;await app.inspect('here');const p=await panel();
  if(app.obs.turn!==turn||!p.shadowRoot.textContent.includes(rationLabel))throw Error('Here did not show reported floor food');
  window.anchor={...app.obs.you};app.selectTile(app.obs.world.find(c=>c.x===anchor.x&&c.y===anchor.y));await app.move('south');
  const remote=await panel();if(!remote.shadowRoot.textContent.includes('Only map sightings')||remote.shadowRoot.textContent.includes(rationLabel))throw Error('Tile panel retained old underfoot contents');
  await app.inspect('here');const current=await panel();if(current.target!=='here'||current.observation.you.y!==app.obs.you.y)throw Error('Here did not follow the explorer');
  return {turn:app.obs.turn,anchor,you:app.obs.you};
 })()`);
  await b.screenshot(`${out}/here.png`);
  report.decision = await b.evaluate(`(async()=>{
  await app.act({action:'pray'});window.pending=structuredClone(app.decision);window.count=calls.length;window.turn=app.obs.turn;
  await app.inspect('self');const p=await panel();
  if(calls.length!==count||JSON.stringify(app.decision)!==JSON.stringify(pending)||!p.shadowRoot.textContent.includes('A decision is still waiting'))throw Error('Inspection disturbed the standing offer');
  return {decision:pending.kind,turn};
 })()`);
  await b.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" });
  await b.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape" });
  await b.call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    autoRepeat: true,
  });
  await b.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape" });
  await b.evaluate(
    `(async()=>{await app.updateComplete;if(calls.length!==count||app.decision?.id!==pending.id||!app.shadowRoot.activeElement?.closest('.decision'))throw Error('Closing inspector or held Escape answered/lost the decision');await app.answer({confirm:false});await app.leave();window.runId=app.saved;window.replayStart=calls.length;await app.watch(runId);})()`,
  );
  report.replay = await b.evaluate(`(async()=>{
  await app.inspect('here');if((await panel()).shadowRoot.textContent.includes(rationLabel))throw Error('Future floor item leaked into initial frame');
  const response=await fetch('/runs/'+runId+'/frames?from=0&limit=30'),frames=(await response.json()).frames;
  const dropped=frames.find(f=>f.request.action==='drop');if(!dropped)throw Error('No real drop checkpoint');window.dropFrame=dropped;
  await app.seek(dropped.sequence);if(!(await panel()).shadowRoot.textContent.includes(rationLabel))throw Error('Recorded floor food missing');
  app.selectTile(app.obs.world.find(c=>c.x===app.obs.you.x&&c.y===app.obs.you.y));await app.seek(0);
  if((await panel()).shadowRoot.textContent.includes(rationLabel))throw Error('Selected tile retained later-frame contents');
  const frameFn=app.recording.frame.bind(app.recording);let resolve;app.recording.frame=()=>new Promise(r=>resolve=r);
  const old=app.envelope,inflight=app.seek(dropped.sequence);await app.inspect('here');resolve(dropped);await inflight;app.recording.frame=frameFn;
  if(app.envelope!==old||app.seeking)throw Error('A late seek replaced the inspected frame');
  if(calls.length!==replayStart)throw Error('Replay inspection used the game API');
  return {frames:frames.length,coreCalls:calls.length-replayStart,turn:app.obs.turn};
 })()`);
  // Presentation-only fixtures: legacy metadata omission and a square absent
  // from an earlier frame. They make no claims about engine generation/physics.
  report.legacy = await b.evaluate(`(async()=>{
  const first=structuredClone(dropFrame);first.sequence=0;delete first.response.observation.perception;
  for(const i of first.response.observation.inventory)delete i.usage;
  first.response.observation.world=[{x:1,y:1,terrain:{type:'floor'}}];first.response.observation.you={x:1,y:1};first.response.observation.here={known:false,items:[{label:'unobserved floor item'}]};
  const later=structuredClone(first);later.sequence=1;later.response.observation.world.push({x:9,y:9,terrain:{type:'altar'},objects:[{label:'later-only object'}]});
  window.fixtureText=[first,later].map(JSON.stringify).join('\\n');await app.importRecording(new File([fixtureText],'inspection-fixture.jsonl'));
  await app.inspect('self');if(!(await panel()).shadowRoot.textContent.includes('Equipment use was not captured'))throw Error('Legacy equipment was guessed');
  await app.inspect('here');const here=(await panel()).shadowRoot.textContent;if(!here.includes('does not mean the square is empty')||here.includes('unobserved floor item'))throw Error('Unknown floor data was exposed');
  await app.seek(1);app.selectTile(app.obs.world.find(c=>c.x===9&&c.y===9));await app.seek(0);const p=await panel();
  if(!p.shadowRoot.textContent.includes('not present')||p.shadowRoot.textContent.includes('later-only object'))throw Error('Unknown square gained future information');
  let done;const reading=app.importRecording({size:fixtureText.length,text:()=>new Promise(r=>done=r)});app.showLive();done(fixtureText);await reading;
  if(app.mode!=='live')throw Error('Late file import replaced the returned live view');
  if(calls.length!==replayStart)throw Error('Fixture inspection used the engine');return {coreCalls:calls.length-replayStart,unknownPreserved:true};
 })()`);
  await b.call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await b.evaluate(
    `(async()=>{await app.watch(runId);await app.inspect('self');await app.updateComplete;})()`,
  );
  const heading = await b.evaluate(
    `(()=>{const r=app.shadowRoot.querySelector('nh-inspection').shadowRoot.querySelector('h2').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight}})()`,
  );
  if (heading.top < 0 || heading.bottom > heading.height)
    throw Error("Explicit inspection was not revealed on mobile");
  await b.screenshot(`${out}/mobile.png`);
  const size = await b.evaluate(
    `({width:innerWidth,scroll:document.documentElement.scrollWidth})`,
  );
  if (size.scroll > size.width)
    throw Error("Inspector overflowed mobile layout");
  if (b.errors.length) throw Error(JSON.stringify(b.errors));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  await b.screenshot(`${out}/failure.png`).catch(() => {});
} finally {
  await b.close();
}
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed ? 0 : 1);
