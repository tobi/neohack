// Prepare a real, isolated recording, retire its engine, then review the
// preserved-copy salvage in the browser with the engine API forbidden.
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { browserTab } from "../../tools/cdp";
import { TestBridge, testDirectory } from "../../mcp/tests/bridge-harness";
import { salvageRun } from "../../mcp/src/salvage";
const out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/salvage/browser",
  base = process.env.APP_URL ?? "http://127.0.0.1:3312";
await mkdir(out, { recursive: true });
const root = testDirectory("salvage-browser"),
  native = new TestBridge(root);
let id: string;
try {
  const g = await native.newGame();
  id = g.sessionId;
  await native.call("act", {
    sessionId: id,
    action: "wait",
    requestId: "once",
  });
} finally {
  await native.close();
}
const source = join(root, id!, "perceptions.jsonl");
await appendFile(source, '{"sequence":2');
const original = await readFile(source);
const bundle = await salvageRun(
  root,
  id!,
  join(testDirectory("salvage-browser-output"), "bundle"),
  { confirm: true },
);
const review = await readFile(
  join(bundle.destination, bundle.review!.file),
  "utf8",
);
const b = await browserTab(`${base}/play`, 1400, 1000),
  report: any = { bundle: bundle.destination };
try {
  await b.evaluate(`customElements.whenDefined('explorer-view')`);
  report.review = await b.evaluate(`(async()=>{
  const app=document.querySelector('explorer-view');let calls=0;app.api.tool=()=>{calls++;throw Error('Salvage review invoked an engine')};
  await app.importRecording(new File([${JSON.stringify(review)}],'salvaged.nh-run.jsonl'));await app.updateComplete;
  if(app.error||app.recording.integrity.state!=='partial'||app.recording.index.length!==2)throw Error('Salvage import failed');
  await app.seek(1);if(app.obs.turn!==2)throw Error('Wrong final boundary');await app.seek(0);if(app.obs.turn!==1)throw Error('Future state leaked backwards');
  await app.act({action:'wait'});await app.inspect('self');await app.updateComplete;
  const notice=app.shadowRoot.querySelector('.recording-notice')?.textContent;
  if(!notice?.includes('Salvaged read-only prefix')||app.ready||calls)throw Error('Missing warning or live controls');
  return {frames:app.recording.index.length,turn:app.obs.turn,notice,coreCalls:calls};
 })()`);
  await b.screenshot(`${out}/salvaged-prefix.png`);
  if (b.errors.length) throw Error(JSON.stringify(b.errors));
  if (b.requests.some((r) => r.url.includes("/mcp")))
    throw Error("Unexpected engine API traffic");
  if (!(await readFile(source)).equals(original))
    throw Error("Review changed original bytes");
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
