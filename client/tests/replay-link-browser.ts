// Open an existing archive directly, including a deep link. No game actions.
import { mkdir, writeFile } from "node:fs/promises";
import { browserTab } from "../../tools/cdp";
const run = process.env.REPLAY_RUN,
  frame = Number(process.env.REPLAY_FRAME ?? 0);
if (!run || !/^[A-Za-z0-9_-]{1,64}$/.test(run) || !Number.isSafeInteger(frame))
  throw Error("Set REPLAY_RUN and optional REPLAY_FRAME");
const out =
  process.env.EVIDENCE_DIR ?? "/tmp/ascent/reconstruction/replay-link";
await mkdir(out, { recursive: true });
const b = await browserTab(
  `${process.env.APP_URL ?? "http://127.0.0.1:3000"}/play?run=${run}&frame=${frame}`,
  1500,
  1050,
);
const report: any = { run, frame };
try {
  await b.evaluate(`customElements.whenDefined('explorer-view')`);
  report.view = await b.evaluate(
    `(async()=>{const app=document.querySelector('explorer-view');await app.updateComplete;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{observer.disconnect();reject(Error(app.error||'Replay link timed out'))},20000);const check=()=>{if(app.recording&&app.playhead===${frame}&&!app.seeking&&app.envelope){clearTimeout(timer);observer.disconnect();resolve()}};const observer=new MutationObserver(check);observer.observe(app.shadowRoot,{subtree:true,childList:true,characterData:true});check()});await app.updateComplete;return {mode:app.mode,ready:app.ready,turn:app.obs.turn,you:app.obs.you,frames:app.recording.index.length,provenance:app.envelope.provenance,renderer:app.shadowRoot.querySelector('nh-map3d').debug(),error:app.error}})()`,
  );
  await b.screenshot(`${out}/replay.png`);
  report.view.renderer = await b.evaluate(
    `document.querySelector('explorer-view').shadowRoot.querySelector('nh-map3d').debug()`,
  );
  const speed = await b.evaluate(
    `(()=>{const a=document.querySelector('explorer-view');return {state:a.speed,shown:a.shadowRoot.querySelector('select[aria-label="Playback speed"]').value}})()`,
  );
  if (String(speed.state) !== speed.shown)
    throw Error("Playback speed control disagrees with state");
  if (!report.view.renderer.drawCalls) throw Error("3D renderer did not draw");
  report.requests = b.requests;
  report.errors = b.errors;
  if (report.view.mode !== "replay" || report.view.ready)
    throw Error("Deep link is not read-only replay");
  if (
    b.requests.some(
      (r) => r.method !== "GET" || new URL(r.url).pathname === "/mcp",
    )
  )
    throw Error("Opening a recording caused a mutation or engine request");
  if (b.errors.length) throw Error("Browser errors");
  report.passed = true;
} catch (e) {
  report.error = String(e);
  report.passed = false;
}
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
process.exit(report.passed ? 0 : 1);
