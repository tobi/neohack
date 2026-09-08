/** Download current API code without constructing a worker or owning a save store. */
export async function loadRuntime() {
  const [client, wasm, webmcp] = await Promise.all([
    import("/runtime/typescript/client.js"),
    import("/runtime/typescript/wasm.js"),
    import("/runtime/typescript/webmcp.js"),
  ]);
  return { client, wasm, webmcp };
}
export async function runtimePackage(buildId?: string, signal?: AbortSignal) {
  if (!buildId) {
    const controller=new AbortController(),abort=()=>controller.abort();
    const timer=setTimeout(abort,15000);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try {
      const response = await fetch('/runtime/wasm/current.json', {signal:controller.signal,cache:'no-cache'});
      if (!response.ok) throw Error('Cannot select the current game package.');
      const current = await response.json();
      if (current.version !== 1) throw Error('Invalid current game package metadata.');
      buildId = current.buildId;
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  if (typeof buildId !== 'string' || !/^[a-f0-9]{64}$/.test(buildId)) throw Error('Invalid game package identity.');
  return {buildId, base:`/runtime/wasm/${buildId}/`};
}
/** Warm precisely one immutable package; opening a new run selects current again. */
export async function warmPackage(signal: AbortSignal, requestedBuild?: string) {
  const {base,buildId} = await runtimePackage(requestedBuild,signal);
  const response = await fetch(`${base}manifest.json`, { signal });
  if (!response.ok) throw Error("Cannot preload the game package.");
  const manifest = await response.json();
  if (manifest.version !== 1 || manifest.buildId !== buildId || !manifest.files ||
      typeof manifest.files !== 'object' || !Object.keys(manifest.files).every(name=>/^[\w.-]+$/.test(name)))
    throw Error("Invalid preload manifest.");
  await Promise.all(Object.keys(manifest.files).map(async name=>{
    const asset = await fetch(base+name,{signal,priority:'low'});
    if(!asset.ok)throw Error(`Cannot preload ${name}.`);
    await asset.arrayBuffer();
  }));
}
