// A labeled, >128 MiB display fixture (not fabricated game-physics evidence).
// Review uses a dedicated CLI with no engine API and only public file access.
import { mkdir, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { browserTab } from "../../tools/cdp";
import { bundleFixture } from "../../mcp/tests/bundle-fixture";
import { startBundleCLI } from "../../mcp/tests/bundle-cli";
const out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/bundle-review/browser";
await mkdir(out, { recursive: true });
const fixture = await bundleFixture({ large: true });
const path = join(fixture.dest, "evidence/perceptions.jsonl");
const hash = async () => {
    const h = createHash("sha256");
    for await (const bytes of createReadStream(path)) h.update(bytes);
    return h.digest("hex");
  },
  before = await hash();
const server = await startBundleCLI(fixture.dest),
  b = await browserTab(server.url, 1400, 1000),
  report: any = {
    bundle: fixture.dest,
    bytes: fixture.result.integrity.validBytes,
    url: server.url,
  };
try {
  await b.evaluate(`customElements.whenDefined('explorer-view')`);
  report.review = await b.evaluate(`(async()=>{
  window.app=document.querySelector('explorer-view');for(let i=0;i<300&&!app.recording?.index?.length;i++)await new Promise(r=>setTimeout(r,20));await app.updateComplete;
  if(!app.readOnly||app.mode!=='replay'||app.ready||app.error)throw Error('Read-only shell failed: '+app.error);
  if(app.recording.index.length!==${fixture.frames})throw Error('Wrong frame count');
  let calls=0;app.api.tool=()=>{calls++;throw Error('Engine API called')};
  await app.start();await app.invoke('new_game',{});app.showLive();await app.reconstruct(app.recording.id);app.followReconstruction('unrelated-job');await app.act({action:'wait'});
  if(calls||app.mode!=='replay')throw Error('Read-only guards bypassed');
  const hidden=[...app.shadowRoot.querySelectorAll('.live-only')];if(!hidden.length||hidden.some(e=>getComputedStyle(e).display!=='none'))throw Error('Live controls remain visible');
  for(const frame of [app.recording.index.length-1,0,40,80,120,160,200,240,280,0]){await app.seek(frame);if(app.obs.vitals.title!=='Illustrative frame '+frame||app.playhead!==frame)throw Error('Wrong paged seek');}
  await app.inspect('self');await app.updateComplete;
  const notice=app.shadowRoot.querySelector('.recording-notice')?.textContent;if(!notice?.includes('Salvaged bundle')||!notice.includes('private evidence'))throw Error('Lost scope/integrity warning');
  if(app.envelope.provenance?.verification!=='unverified'||![...app.shadowRoot.querySelectorAll('.provenance-banner')].some(e=>e.textContent.includes('unverified')))throw Error('Lost reconstruction provenance');
  if(app.shadowRoot.querySelector('a[href*="raw=1"]'))throw Error('Raw evidence link exposed in public-only viewer');
  if(app.recording.pages.size>6||calls)throw Error('Unbounded cache or engine call');
  return {frames:app.recording.index.length,cachePages:app.recording.pages.size,notice,coreCalls:calls};
 })()`);
  await b.screenshot(`${out}/large-bundle.png`);
  if (
    b.requests.some((r) =>
      /\/mcp|\/reconstructions\/|\/reconstruct(?:\?|$)/.test(r.url),
    )
  )
    throw Error("Unexpected engine/management traffic");
  if (b.requests.some((r) => r.url.includes("/export")))
    throw Error("Viewer loaded an entire export instead of pages");
  if (!b.requests.some((r) => r.url.includes("/frames?")))
    throw Error("No paged requests observed");
  if (b.errors.length) throw Error(JSON.stringify(b.errors));
  if ((await hash()) !== before)
    throw Error("Read-only review changed evidence");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  await b.screenshot(`${out}/failure.png`).catch(() => {});
} finally {
  await b.close();
  await server.stop();
}
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(report);
process.exit(report.passed ? 0 : 1);
