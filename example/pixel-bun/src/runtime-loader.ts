/** Download current code without constructing a worker or owning a save store. */
export async function loadRuntime() {
  const [client, wasm, webmcp] = await Promise.all([
    import("/runtime/typescript/client.js"),
    import("/runtime/typescript/wasm.js"),
    import("/runtime/typescript/webmcp.js"),
  ]);
  return { client, wasm, webmcp };
}

/** Warm the browser cache only. The runtime verifies the package on use. */
export async function warmPackage(signal: AbortSignal) {
  const base = "/runtime/wasm/";
  const response = await fetch(`${base}manifest.json`, { signal });
  if (!response.ok) throw Error("Cannot preload the game package.");
  const manifest = await response.json();
  if (
    manifest.version !== 1 ||
    typeof manifest.buildId !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.buildId) ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    !Object.keys(manifest.files).every((name) => /^[\w.-]+$/.test(name))
  )
    throw Error("Invalid preload manifest.");
  await Promise.all(
    Object.keys(manifest.files).map(async (name) => {
      const asset = await fetch(base + name, { signal, priority: "low" });
      if (!asset.ok) throw Error(`Cannot preload ${name}.`);
      await asset.arrayBuffer();
    }),
  );
}
