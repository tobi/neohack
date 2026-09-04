// UI reconstruction check against an explicitly isolated server. Sources are
// created through the real core, then copied into an input-only legacy fixture.
import { cp, rm, mkdir, writeFile } from "node:fs/promises";
import { TestBridge } from "../../mcp/tests/bridge-harness";
import { browserTab } from "../../tools/cdp";
const root = process.env.BROWSER_SESSIONS_DIR;
if (!root?.startsWith("/tmp/"))
  throw Error(
    "BROWSER_SESSIONS_DIR must be an isolated /tmp directory served by APP_URL",
  );
await mkdir(root, { recursive: true });
const source = `legacy-browser-${crypto.randomUUID().slice(0, 8)}`;
const engine = new TestBridge(root);
try {
  const g = await engine.newGame();
  await engine.call("act", {
    sessionId: g.sessionId,
    action: "move",
    direction: "south",
  });
  await engine.call("end_session", { sessionId: g.sessionId });
  await cp(`${root}/${g.sessionId}`, `${root}/${source}`, { recursive: true });
  for (const file of [
    "run.json",
    "perceptions.jsonl",
    "perceptions.index.jsonl",
  ])
    await rm(`${root}/${source}/${file}`);
} finally {
  await engine.close();
}
const out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/reconstruction/browser";
await mkdir(out, { recursive: true });
const b = await browserTab(
  `${process.env.APP_URL ?? "http://127.0.0.1:3312"}/play`,
  1500,
  1050,
);
const dialogs: string[] = [];
b.on("Page.javascriptDialogOpening", async (p) => {
  dialogs.push(p.message);
  await b.call("Page.handleJavaScriptDialog", { accept: true });
});
const report: any = { source };
try {
  await b.evaluate(`customElements.whenDefined('explorer-view')`);
  report.job = await b.evaluate(`(async()=>{
  const app=document.querySelector('explorer-view');await app.updateComplete;await app.refreshRuns();await app.updateComplete;
  window.__requests=[];const native=fetch.bind(window);window.fetch=(url,options)=>{window.__requests.push({url:String(url),method:options?.method??'GET'});return native(url,options)};
  const row=[...app.shadowRoot.querySelectorAll('.run-row')].find(b=>b.textContent.includes(${JSON.stringify(source)}));if(!row||row.disabled)throw Error('No reconstructable source row');row.click();
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{observer.disconnect();reject(Error('Reconstruction UI timed out'))},25000);const check=()=>{if(['completed','failed'].includes(app.reconstruction?.state)){clearTimeout(timer);observer.disconnect();resolve()}};const observer=new MutationObserver(check);observer.observe(app.shadowRoot,{subtree:true,childList:true,characterData:true});check();});
  if(app.reconstruction.state!=='completed')throw Error(JSON.stringify(app.reconstruction));await app.updateComplete;
  const before=window.__requests.length;let watched;const watch=app.watch.bind(app);app.watch=(...args)=>watched=watch(...args);
  const review=[...app.shadowRoot.querySelectorAll('button')].find(b=>b.textContent.trim()==='Review reconstruction');if(!review)throw Error('No review action');review.click();await watched;await app.seek(app.recording.index.length-1);await app.updateComplete;
  const playback=window.__requests.slice(before);if(playback.some(r=>r.method!=='GET'||r.url.includes('/mcp')))throw Error('Playback made an engine/management mutation');
  if(app.ready)throw Error('Derived replay enabled game controls');
  if(!app.shadowRoot.querySelector('.provenance-banner')?.textContent.includes('unverified'))throw Error('Missing provenance warning');
  return {state:app.reconstruction.state,frames:app.recording.index.length,turn:app.obs.turn,archiveId:app.reconstruction.archiveId,provenance:app.envelope.provenance,playbackRequests:playback,managementPosts:window.__requests.filter(r=>r.method==='POST'),error:app.error};
 })()`);
  await b.screenshot(`${out}/reconstructed.png`);
  report.dialogs = dialogs;
  report.errors = b.errors;
  if (!dialogs.some((s) => s.includes("unverified")))
    throw Error("No explicit unverified-reconstruction confirmation");
  if (b.errors.length) throw Error("Browser runtime errors");
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = String(e);
  report.errors = b.errors;
  await b.screenshot(`${out}/failed.png`).catch(() => {});
}
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
process.exit(report.passed ? 0 : 1);
