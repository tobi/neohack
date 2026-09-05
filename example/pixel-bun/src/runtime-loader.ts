/** Download code without constructing a worker or acquiring a save-store lock. */
export async function loadRuntime() {
  const [client, wasm, webmcp, response] = await Promise.all([
    import("/runtime/typescript/client.js"),
    import("/runtime/typescript/wasm.js"),
    import("/runtime/typescript/webmcp.js"),
    fetch("/build/runtime.json"),
  ]);
  if (!response.ok) throw Error("The game package index is unavailable.");
  const packages: { currentBuildId: string; legacyBuildId: string } =
    await response.json();
  if (
    ![packages.currentBuildId, packages.legacyBuildId].every(
      (id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id),
    )
  )
    throw Error("The game package index is invalid.");
  return { client, wasm, webmcp, packages };
}

/** Warm the browser cache only. The runtime still verifies the package on use. */
export async function warmPackage(buildId: string, signal: AbortSignal) {
  const base = `/runtime/wasm-packages/${buildId}/`;
  const response = await fetch(`${base}manifest.json`, { signal });
  if (!response.ok) throw Error("Cannot preload the game package.");
  const manifest = await response.json();
  if (
    manifest.version !== 1 ||
    manifest.buildId !== buildId ||
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
