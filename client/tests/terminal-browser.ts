// An actual lethal game, terminal UI, and backward/forward read-only review.
import { mkdir, writeFile } from "node:fs/promises";
import { browserTab } from "../../tools/cdp";
const out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/terminal-browser";
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
    const app=document.querySelector('explorer-view'); await app.updateComplete;
    let calls=0,last;const tool=app.api.tool.bind(app.api);app.api.tool=(...args)=>{calls++;return tool(...args)};
    const invoke=app.invoke.bind(app);app.invoke=(...args)=>last=invoke(...args);
    const click=async(text)=>{const button=[...app.shadowRoot.querySelectorAll('button')].find(b=>b.textContent.trim()===text);if(!button||button.disabled)throw Error('No enabled button '+text);button.click();await last;await app.updateComplete};
    app.seed='42';app.role='valkyrie';await click('Enter the dungeon');
    for(let i=0;i<20&&!app.envelope.ended;i++){await click('Pray');if(app.decision?.kind!=='confirmation')throw Error('Missing consent');await click('Confirm')}
    const end=structuredClone(app.envelope.end),id=app.saved;
    if(!app.envelope.ended||end?.kind!=='death'||app.obs.vitals.health!==0||app.ready||app.decision)throw Error('Invalid terminal UI');
    if(!app.shadowRoot.querySelector('.panel.end')?.textContent.includes(end.cause))throw Error('Death cause is not visible');
    const before=calls;await app.watch(id);const lastFrame=app.recording.index.length-1;
    await app.seek(lastFrame);await app.updateComplete;
    if(JSON.stringify(app.envelope.end)!==JSON.stringify(end))throw Error('Replay lost terminal facts');
    await app.seek(0);await app.updateComplete;
    if(app.envelope.ended||app.shadowRoot.querySelector('.panel.end'))throw Error('Death leaked backwards into the initial frame');
    await app.seek(lastFrame);await app.act({action:'wait'});await app.updateComplete;
    if(calls!==before)throw Error('Replay invoked the game engine');
    return {id,end,frames:lastFrame+1,replayCoreCalls:calls-before,ready:app.ready};
  })()`);
  await b.screenshot(`${out}/terminal-replay.png`);
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
