// Presentation fixtures test GPU/DOM behavior, never NetHack game rules.
import { mkdir, writeFile } from "node:fs/promises";
import { browserTab } from "../../tools/cdp";
const base = process.env.APP_URL ?? "http://127.0.0.1:3312",
  out = process.env.EVIDENCE_DIR ?? "/tmp/ascent/viewer-lifecycle/renderer",
  demo = process.env.COMPONENT_DEMO ?? "/component-demo.html",
  bundle = process.env.COMPONENT_BUNDLE ?? "/dist/standalone/nh-map3d.js";
await mkdir(out, { recursive: true });
const report: any = {};
const b = await browserTab(`${base}${demo}?empty=1`, 1400, 1000);
try {
  await b.evaluate(`customElements.whenDefined('nh-map3d')`);
  await b.evaluate(`(()=>{
  window.map=document.querySelector('nh-map3d');
  window.waitMap=async(predicate)=>{const end=performance.now()+10000;while(!predicate()){if(performance.now()>end)throw Error('Map wait timed out: '+JSON.stringify(map.debug()));await new Promise(r=>setTimeout(r,16))}};
  window.fixture=(width=10,height=8,turn=1)=>{const world=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++)world.push({x,y,terrain:{type:x===0||y===0||x===width-1||y===height-1?'wall':'floor'}});const at=(x,y)=>world.find(c=>c.x===x&&c.y===y);at(2,2).occupant={kind:'self',mark:'@'};at(2,2).terrain.type='stairsUp';at(3,2).occupant={kind:'ally',mark:'d',color:3};at(5,3).occupant={kind:'creature',mark:'e',color:2};return {turn,location:{id:'fixture'},you:{x:2,y:2},world,inventory:[]}};
  window.fail=(message)=>{throw Error(message)};
  window.originalContext=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:originalContext.call(this,type,...args)};
  map.worldKey='fixture';map.observation=fixture();
 })()`);
  report.initialFailure = await b.evaluate(`(async()=>{
  await map.updateComplete;
  if(!map.fallback||map.renderer||map.debug().state!=='failed'||map.shadowRoot.querySelectorAll('[role=gridcell]').length!==80)fail('Initial failure has no usable grid');
  window.selected=[];map.addEventListener('tile-select',e=>selected.push(e.detail));
  map.shadowRoot.querySelector('.grid').focus();return map.debug();
 })()`);
  for (const key of ["ArrowRight", "Enter"]) {
    await b.call("Input.dispatchKeyEvent", { type: "keyDown", key });
    await b.call("Input.dispatchKeyEvent", { type: "keyUp", key });
  }
  report.keyboard = await b.evaluate(
    `(async()=>{await map.updateComplete;if(selected.at(-1)?.x!==3||selected.at(-1)?.y!==2)fail('Keyboard grid selection failed');return {selected:selected.at(-1),active:map.shadowRoot.querySelector('#cursor-cell')?.getAttribute('aria-label')}})()`,
  );
  await b.screenshot(`${out}/fallback.png`);
  report.retry = await b.evaluate(`(async()=>{
  HTMLCanvasElement.prototype.getContext=originalContext;
  window.originalObservation=JSON.stringify(map.observation);const retry=[...map.shadowRoot.querySelectorAll('button')].find(b=>b.textContent.trim()==='Retry 3D');if(!retry||retry.disabled)fail('No usable retry control');retry.click();
  await map.updateComplete;await waitMap(()=>map.debug().renderedFrames>0&&!map.debug().animationScheduled);
  if(map.fallback||map.shadowRoot.querySelectorAll('.viewport canvas').length!==1)fail('Retry did not create exactly one canvas');
  if(JSON.stringify(map.observation)!==originalObservation)fail('Renderer mutated observation');return map.debug();
 })()`);
  report.partialFailure = await b.evaluate(`(async()=>{
    map.show2D();HTMLCanvasElement.prototype.getContext=function(type,...args){const ctx=originalContext.call(this,type,...args);if(type==='webgl2')window.partialGL=ctx;return type==='2d'?null:ctx};
    if(map.retry3D())fail('Partial initialization incorrectly reported success');await map.updateComplete;
    if(map.renderer||map.debug().textures||map.debug().materials||!partialGL.isContextLost())fail('Partial construction leaked resources');
    const failed=map.debug();HTMLCanvasElement.prototype.getContext=originalContext;map.retry3D();await map.updateComplete;await waitMap(()=>map.debug().state==='ready');return failed;
  })()`);
  report.losses = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    await b.evaluate(`(async()=>{
   window.oldCanvas=map.renderer.domElement;window.oldRenderer=map.renderer;window.oldFrames=map.debug().renderedFrames;
   window.lostExtension=map.renderer.getContext().getExtension('WEBGL_lose_context');if(!lostExtension)fail('Context-loss extension unavailable');
   await new Promise(resolve=>{oldCanvas.addEventListener('webglcontextlost',resolve,{once:true});lostExtension.loseContext()});
   await map.updateComplete;if(!map.fallback||!map.debug().contextLost||map.debug().animationScheduled)fail('Lost context kept rendering');
   map.observation=fixture(7,5,${cycle + 2});await map.updateComplete;
   if(map.shadowRoot.querySelectorAll('[role=gridcell]').length!==35)fail('Fallback used stale data');
  })()`);
    report.losses.push(
      await b.evaluate(`(async()=>{
   lostExtension.restoreContext();await waitMap(()=>map.renderer&&map.renderer!==oldRenderer&&map.debug().state==='ready'&&map.debug().renderedFrames>oldFrames);
   if(map.fallback||map.debug().contextLost||map.debug().tiles!==35||map.shadowRoot.querySelectorAll('.viewport canvas').length!==1)fail('Context restoration failed');
   return map.debug();
  })()`),
    );
  }
  report.manual = await b.evaluate(`(async()=>{
  const gl=map.renderer.getContext();map.show2D();await map.updateComplete;
  if(map.renderer||!map.fallback||!gl.isContextLost()||map.debug().textures||map.debug().materials)fail('2D did not release GPU resources');
  const before=map.debug().renderedFrames;map.remove();await new Promise(r=>setTimeout(r,80));document.body.append(map);await map.updateComplete;
  if(map.renderer||!map.fallback||map.debug().renderedFrames!==before)fail('Reconnect ignored manual 2D preference');
  map.retry3D();await map.updateComplete;await waitMap(()=>map.debug().renderedFrames>before);return map.debug();
 })()`);
  report.renderFailure = await b.evaluate(`(async()=>{
  map.renderer.render=()=>{throw Error('Injected render failure')};map.rotate();await waitMap(()=>map.debug().state==='failed');await map.updateComplete;
  if(!map.fallback||map.renderer||!map.failure.includes('Injected'))fail('Render failure escaped');
  const failed=map.debug();map.retry3D();await map.updateComplete;await waitMap(()=>map.debug().state==='ready');return failed;
 })()`);
  report.detach = await b.evaluate(`(async()=>{
  const before=map.debug().renderedFrames;const gl=map.renderer.getContext();map.remove();await new Promise(r=>setTimeout(r,80));
  const detached=map.debug();if(detached.renderer||detached.actors||detached.textures||detached.materials||detached.animationScheduled||detached.renderedFrames!==before||!gl.isContextLost())fail('Detach leaked resources');
  document.body.append(map);await map.updateComplete;await waitMap(()=>map.debug().state==='ready'&&map.debug().renderedFrames>before);return detached;
 })()`);
  report.hidden = await b.evaluate(`(async()=>{
    const before=map.debug().renderedFrames;map.style.display='none';map.worldKey='after-hidden';map.observation=fixture(10,8,9);await map.updateComplete;
    await new Promise(r=>setTimeout(r,100));if(map.debug().animationScheduled||map.debug().renderedFrames!==before)fail('Hidden map kept drawing');
    map.style.display='block';await waitMap(()=>map.debug().renderedFrames>before);
    if(map.debug().tiles!==80||Math.abs(map.camera.aspect-map.clientWidth/map.clientHeight)>.001)fail('Shown map did not reframe current data');
    return map.debug();
  })()`);
  await b.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  report.motion = await b.evaluate(`(async()=>{
  await waitMap(()=>map.debug().reducedMotion);const next=fixture(7,5,10);delete next.world.find(c=>c.x===2&&c.y===2).occupant;next.world.find(c=>c.x===2&&c.y===3).occupant={kind:'self',mark:'@'};next.you={x:2,y:3};map.observation=next;await map.updateComplete;
  const actor=map._actors.get('self');if(!actor.group.position.equals(actor.to))fail('Reduced motion interpolated an actor');await waitMap(()=>!map.debug().animationScheduled);
  const before=map.debug().renderedFrames;await new Promise(r=>setTimeout(r,100));if(map.debug().renderedFrames!==before)fail('Idle renderer still draws continuously');return map.debug();
 })()`);
  report.cache = await b.evaluate(`(async()=>{
  for(let i=0;i<24;i++){const next=fixture(7,5,20+i);const enemy=next.world.find(c=>c.occupant?.kind==='creature');enemy.occupant.mark=String.fromCodePoint(256+i);enemy.occupant.color=i%16;map.observation=next;await map.updateComplete;await new Promise(r=>requestAnimationFrame(r));if(map.debug().textures>5||map.debug().materials>60)fail('Glyph/material cache grew without bound')}
  return map.debug();
 })()`);
  report.complex = await b.evaluate(`(async()=>{
  const many=fixture(200,100,50);for(let i=0;i<600;i++)many.world[i].objects=[{mark:'!',color:i%16}];map.worldKey='large';map.observation=many;await map.updateComplete;await map.updateComplete;
  if(!map.fallback||map.renderer||map.debug().state!=='limited')fail('Complex scene was not bounded');
  const grid=map.shadowRoot.querySelector('.grid');if(!grid||map.shadowRoot.querySelectorAll('[role=gridcell]').length>1920)fail('Fallback allocated unbounded cells');
  grid.focus();grid.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,composed:true,cancelable:true}));await map.updateComplete;
  if(!map.shadowRoot.querySelector('#cursor-cell')?.getAttribute('aria-label').startsWith('199, 99'))fail('Bounded grid cannot reach final tile');return map.debug();
 })()`);
  report.large = await b.evaluate(`(async()=>{
  const start=performance.now(),before=map.debug().renderedFrames;map.observation=fixture(200,100,51);await map.updateComplete;await waitMap(()=>map.renderer&&map.debug().renderedFrames>before);map.fit();await waitMap(()=>!map.debug().animationScheduled);
  if(map.debug().tiles!==20000||map.fallback)fail('Large simple map did not render');
  let extent=0;for(const x of [-.5,199.5])for(const y of [-.5,2])for(const z of [-.5,99.5]){const p=map.camera.position.clone().set(x,y,z).project(map.camera);extent=Math.max(extent,Math.abs(p.x),Math.abs(p.y));}
  if(extent>.95)fail('Fit clips the known map: '+extent);
  return {milliseconds:performance.now()-start,projectedExtent:extent,...map.debug()};
 })()`);
  await b.screenshot(`${out}/large.png`);
  report.liquids = await b.evaluate(`(async()=>{
    const data=fixture(200,100,60);for(const c of data.world)if(c.terrain.type==='floor')c.terrain.type=c.x%2?'water':'lava';
    const before=map.debug().renderedFrames;map.observation=data;await map.updateComplete;await waitMap(()=>map.debug().renderedFrames>before&&!map.debug().animationScheduled);
    if(map.fallback||map.debug().drawCalls>60)fail('Liquid terrain was not instanced');return map.debug();
  })()`);
  report.registration = await b.evaluate(
    `(async()=>{const first=await import(${JSON.stringify(bundle)});const second=await import(${JSON.stringify(bundle + "?duplicate=1")});if(first.NhMap3D!==second.NhMap3D||first.NhMap3D!==customElements.get('nh-map3d'))fail('Duplicate modules disagree about constructor');const other=new second.NhMap3D();return {tag:other.localName}})()`,
  );
  if (b.errors.length) throw Error(JSON.stringify(b.errors));
  if (
    b.requests.some(
      (r) =>
        r.method !== "GET" ||
        new URL(r.url).origin !== new URL(base).origin ||
        ![demo, bundle, bundle + ".map", "/favicon.ico"].includes(
          new URL(r.url).pathname,
        ),
    )
  )
    throw Error(
      "Standalone component loaded an app, game or remote dependency",
    );
  report.requests = b.requests;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  await b.screenshot(`${out}/failure.png`).catch(() => {});
} finally {
  await b.close();
}

if (report.passed && process.env.COMPONENT_ONLY !== "1") {
  const live = await browserTab(`${base}/play`, 1400, 1000);
  try {
    await live.evaluate(`customElements.whenDefined('explorer-view')`);
    await live.evaluate(
      `(async()=>{const app=document.querySelector('explorer-view');app.hero='KeyboardTest';app.seed='42';await app.start();await app.updateComplete;const map=app.shadowRoot.querySelector('nh-map3d');await map.updateComplete;window.calls=0;const tool=app.api.tool.bind(app.api);app.api.tool=(...args)=>{calls++;return tool(...args)};map.renderer.domElement.focus()})()`,
    );
    for (const key of ["ArrowRight", "h", ".", "Enter"]) {
      await live.call("Input.dispatchKeyEvent", { type: "keyDown", key });
      await live.call("Input.dispatchKeyEvent", { type: "keyUp", key });
    }
    report.keyboardIsolation = await live.evaluate(
      `(async()=>{const app=document.querySelector('explorer-view');await app.updateComplete;if(calls||app.obs.turn!==1||!app.selectedTile)throw Error('Map inspection leaked game input');app.shadowRoot.querySelector('.controls').focus();return {mapCalls:calls,turn:app.obs.turn}})()`,
    );
    await live.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "ArrowDown",
    });
    await live.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "ArrowDown",
    });
    await live.evaluate(
      `(async()=>{const app=document.querySelector('explorer-view'),end=performance.now()+10000;while(app.busy){if(performance.now()>end)throw Error('Move timed out');await new Promise(r=>setTimeout(r,16))}if(calls!==1||app.obs.turn!==2)throw Error('Game keyboard zone did not move once');await app.act({action:'pray'});await app.updateComplete;if(app.decision?.kind!=='confirmation'||!app.shadowRoot.activeElement?.closest('.decision'))throw Error('Prayer fixture did not focus its dialog')})()`,
    );
    await live.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
    });
    await live.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape" });
    report.dialogEscape = await live.evaluate(
      `(async()=>{const app=document.querySelector('explorer-view'),end=performance.now()+10000;while(app.busy){if(performance.now()>end)throw Error('Cancel timed out');await new Promise(r=>setTimeout(r,16))}if(app.decision||app.obs.turn!==2||app.envelope.outcome.status!=='cancelled')throw Error('Focused dialog did not cancel on Escape');const result={turn:app.obs.turn,status:app.envelope.outcome.status};await app.leave();return result})()`,
    );
    if (live.errors.length) throw Error(JSON.stringify(live.errors));
  } catch (error) {
    report.passed = false;
    report.error = String(error);
    await live.screenshot(`${out}/input-failure.png`).catch(() => {});
  } finally {
    await live.close();
  }
}
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed ? 0 : 1);
