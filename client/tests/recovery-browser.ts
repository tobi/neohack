// Only corrupt this test's newly created, already-saved run in an isolated root.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { browserTab } from "../../tools/cdp";
const base = process.env.APP_URL ?? "http://127.0.0.1:3312";
const sessions = process.env.BROWSER_SESSIONS_DIR;
if (
  !sessions ||
  !resolve(sessions).startsWith("/tmp/") ||
  new URL(base).port === "3000"
)
  throw Error(
    "Recovery browser test requires an isolated /tmp session root and non-production port",
  );
const out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/archive-recovery/browser";
await mkdir(out, { recursive: true });
const b = await browserTab(`${base}/play`, 1400, 1000);
const report: any = {};
let path: string | undefined, original: Buffer | undefined;
try {
  await b.evaluate(`customElements.whenDefined('explorer-view')`);
  const id = await b.evaluate(
    `(async()=>{const app=document.querySelector('explorer-view');app.hero='RecoveryTest';app.seed='42';await app.start();await app.move('south');const id=app.saved;await app.leave();return id})()`,
  );
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw Error("Invalid test run id");
  path = join(sessions, id, "perceptions.jsonl");
  original = await readFile(path);
  const damaged = Buffer.concat([
    original,
    Buffer.from('{"sequence":3,"response":'),
  ]);
  await writeFile(`${out}/damaged-original.jsonl`, damaged);
  await writeFile(path, damaged);
  report.recovery = await b.evaluate(`(async()=>{
  const app=document.querySelector('explorer-view');let calls=0;const tool=app.api.tool.bind(app.api);app.api.tool=(...args)=>{calls++;return tool(...args)};
  await app.watch(${JSON.stringify(id)});await app.updateComplete;
  if(app.recording.integrity.state!=='partial'||!app.shadowRoot.querySelector('.recording-notice'))throw Error('Missing partial-recording warning');
  const frames=app.recording.index.length;await app.seek(frames-1);await app.seek(0);await app.act({action:'wait'});
  const exported=await (await fetch('/runs/'+${JSON.stringify(id)}+'/export')).text();
  if(!exported.startsWith('{"format":"neonethack.recordingManifest"'))throw Error('Export lost truncation provenance');
  await app.importRecording(new File([exported],'prefix.nh-run.jsonl'));await app.updateComplete;
  if(app.recording.integrity.state!=='partial'||!app.shadowRoot.querySelector('.recording-notice'))throw Error('Import hid the missing checkpoint');
  if(calls)throw Error('Recovery review invoked the engine');
  return {frames,state:app.recording.integrity.state,coreCalls:calls,notice:app.shadowRoot.querySelector('.recording-notice').textContent};
 })()`);
  await b.screenshot(`${out}/prefix-review.png`);
  if (!(await readFile(path)).equals(damaged))
    throw Error("Read-only review changed archive bytes");
  if (b.errors.length) throw Error(JSON.stringify(b.errors));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  await b.screenshot(`${out}/failure.png`).catch(() => {});
} finally {
  if (path && original) await writeFile(path, original); // Restore only this test's fault; evidence retains damaged bytes.
  await b.close();
}
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(report);
process.exit(report.passed ? 0 : 1);
