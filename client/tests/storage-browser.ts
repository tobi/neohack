// Fault only this test's newly-created world in the isolated candidate root.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { browserTab } from "../../tools/cdp";
const base = process.env.APP_URL ?? "http://127.0.0.1:3312",
  root = process.env.BROWSER_SESSIONS_DIR;
if (
  !root ||
  !resolve(root).startsWith("/tmp/") ||
  new URL(base).port === "3000"
)
  throw Error("Use an isolated candidate /tmp root, never production");
const out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/private-integrity/browser";
await mkdir(out, { recursive: true });
const b = await browserTab(`${base}/play`, 1400, 1000);
const report: any = {};
let path: string | undefined, original: Buffer | undefined;
try {
  await b.evaluate(`customElements.whenDefined('explorer-view')`);
  const id = await b.evaluate(
    `(async()=>{window.app=document.querySelector('explorer-view');app.hero='StorageTest';app.seed='42';await app.start();await app.act({action:'pray'});if(app.decision?.kind!=='confirmation')throw Error('No real warning');window.storageTurn=app.obs.turn;return app.saved})()`,
  );
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw Error("Invalid test id");
  path = join(root, id, "meta.json");
  original = await readFile(path);
  if (JSON.parse(original.toString()).format !== "neonethack.session")
    throw Error("Candidate must run the new metadata boundary build");
  await writeFile(`${out}/original-meta.json`, original);
  await writeFile(path, original.subarray(0, original.length - 20));
  report.failure = await b.evaluate(`(async()=>{
  await app.answer({confirm:false});await app.updateComplete;
  if(app.ready||!app.uncertain||app.envelope.storage?.status!=='degraded'||app.obs.turn!==storageTurn)throw Error('Storage failure was not safely surfaced');
  const error=app.error;let calls=0;const tool=app.api.tool.bind(app.api);app.api.tool=(...args)=>{calls++;return tool(...args)};
  await app.act({action:'wait'});await app.watch(app.saved);app.showLive();await app.updateComplete;
  if(app.error!==error||!app.uncertain||app.ready||calls)throw Error('Review/return hid storage failure or issued a deed');
  await app.inspect('self');await app.updateComplete;
  if(calls||app.ready)throw Error('Inspection bypassed storage recovery');
  return {turn:app.obs.turn,status:app.status,error:app.error,calls};
 })()`);
  await b.screenshot(`${out}/storage-blocked.png`);
  if (
    !(await readFile(path)).equals(original.subarray(0, original.length - 20))
  )
    throw Error("Core overwrote corrupt metadata");
  if (b.errors.length) throw Error(JSON.stringify(b.errors));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  await b.screenshot(`${out}/failure.png`).catch(() => {});
} finally {
  // Restore only this fixture's bytes, then retire its blocked engine. The
  // native corruption latch deliberately persists until a clean ownership load.
  if (path && original) await writeFile(path, original);
  await b
    .evaluate(
      `(async()=>{if(window.app?.mode!=='live')app?.showLive();if(window.app?.envelope&&!app.envelope.ended)await app.leave()})()`,
    )
    .catch(() => {});
  await b.close();
}
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(report);
process.exit(report.passed ? 0 : 1);
