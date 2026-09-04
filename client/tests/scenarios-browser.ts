// Real level traversal and 3D replay reset; never synthesize a game map.
import { mkdir, writeFile } from "node:fs/promises";
import { browserTab } from "../../tools/cdp";
import { STAIRS_ROUTE } from "../../mcp/tests/scenario-fixtures";
const out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/stairs-browser";
await mkdir(out, { recursive: true });
const b = await browserTab(
  `${process.env.APP_URL ?? "http://127.0.0.1:3312"}/play`,
  1400,
  1000,
);
const report: any = {};
try {
  await b.evaluate(`customElements.whenDefined('explorer-view')`);
  report.scenario = await b.evaluate(`(async()=>{
  const app=document.querySelector('explorer-view');await app.updateComplete;
  let calls=0;const tool=app.api.tool.bind(app.api);app.api.tool=(...args)=>{calls++;return tool(...args)};
  app.seed='7';app.role='valkyrie';await app.start();
  const bad=await app.invoke('act',{sessionId:app.saved,action:'wait',unexpectedFlag:'must-not-be-dropped'});
  if(bad?.error?.code!=='invalidArgument'||app.obs.turn!==1)throw Error('MCP silently discarded an invalid field');
  const route=${JSON.stringify(STAIRS_ROUTE)};
  for(const direction of route)await app.move(direction);
  const level1=app.obs.location.id;
  if(app.obs.you.x!==64||app.obs.you.y!==3)throw Error('Did not reach real stairs');
  await app.act({action:'climb',direction:'down'});const level2=app.obs.location.id;
  if(level2===level1||app.obs.world.some(c=>c.x>=55))throw Error('Old terrain survived level change');
  await app.act({action:'climb',direction:'up'});
  if(app.obs.location.id!==level1||app.obs.world.find(c=>c.x===64&&c.y===3)?.terrain.type!=='stairsDown')throw Error('Return lost the stairs underfoot');
  const id=app.saved;await app.leave();const before=calls;await app.watch(id);
  for(const [frame,level] of [[route.length+1,level2],[route.length,level1],[route.length+2,level1],[route.length+1,level2]]){
   await app.seek(frame);await app.updateComplete;const map=app.shadowRoot.querySelector('nh-map3d');await map.updateComplete;
   const known=app.obs.world.filter(c=>!['unknown','dark'].includes(c.terrain?.type)).length;
   if(app.obs.location.id!==level||map.debug().tiles<known||map.debug().tiles>app.obs.world.length)throw Error('3D replay did not replace the map');
   if(level===level2&&app.obs.world.some(c=>c.x>=55))throw Error('Future/past terrain leaked into replay');
  }
  await app.act({action:'wait'});if(calls!==before)throw Error('Review submitted a game action');
  return {id,level1,level2,frames:app.recording.index.length,replayCoreCalls:calls-before,renderer:app.shadowRoot.querySelector('nh-map3d').debug()};
 })()`);
  await b.screenshot(`${out}/stairs-replay.png`);
  report.mealWarning = await b.evaluate(`(async()=>{
    const app=document.querySelector('explorer-view');app.showLive();app.role='tourist';app.seed='42';
    await app.invoke('new_game',{seed:42,name:'Meals',role:'tourist',race:'human',gender:'female',align:'neutral'});
    const ration=app.obs.inventory.find(i=>i.label.includes('food ration'));
    await app.act({action:'eat',item:{id:ration.id}});
    if(app.envelope.outcome.turnsElapsed!==6||app.envelope.outcome.status!=='completed')throw Error('Meal did not finish');
    await app.act({action:'eat',item:{id:ration.id}});await app.updateComplete;
    if(app.decision?.kind!=='confirmation'||!app.obs.inventory.some(i=>i.label.includes('partly eaten food ration')))throw Error('Warning has stale inventory');
    if(!app.shadowRoot.textContent.includes('partly eaten food ration'))throw Error('Partly eaten item not rendered');
    const decision=structuredClone(app.decision);await app.resume();await app.updateComplete;
    if(JSON.stringify(app.decision)!==JSON.stringify(decision))throw Error('Pending warning lost on resume');
    const map=app.shadowRoot.querySelector('nh-map3d');await map.updateComplete;
    const distance=map.camera.position.distanceTo(map.controls.target);
    if(map.worldKey!==app.saved||distance>18)throw Error('New world retained the previous world camera framing');
    return {session:app.saved,turn:app.obs.turn,decision,cameraDistance:distance};
  })()`);
  await b.screenshot(`${out}/meal-warning.png`);
  report.mealStopped = await b.evaluate(`(async()=>{
    const app=document.querySelector('explorer-view');await app.answer({confirm:false});await app.updateComplete;
    if(app.envelope.outcome.status!=='interrupted'||app.envelope.outcome.turnsElapsed!==2||app.decision)throw Error('Meal did not stop');
    await app.leave();const id=app.saved;let calls=0;const tool=app.api.tool.bind(app.api);app.api.tool=(...args)=>{calls++;return tool(...args)};
    await app.watch(id);await app.seek(app.recording.index.length-2);await app.updateComplete;
    if(app.envelope.outcome.status!=='interrupted'||!app.obs.inventory.some(i=>i.label.includes('partly eaten food ration')))throw Error('Replay lost the stopped meal');
    await app.act({action:'wait'});if(calls)throw Error('Meal replay invoked engine');
    return {status:app.envelope.outcome.status,turn:app.obs.turn,replayCoreCalls:calls};
  })()`);
  await b.screenshot(`${out}/meal-stopped.png`);
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
console.log(report);
process.exit(report.passed ? 0 : 1);
