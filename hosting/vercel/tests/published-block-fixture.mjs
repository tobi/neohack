// Explicit older published storage format. New UI creation uses input journals;
// these scenarios still verify that an existing block-store run is preserved.
export async function createBlockRun(page, url) {
  await page.goto(url);
  const bookmark = await page.evaluate(async () => {
    const { createWasm } = await import("/runtime/typescript/wasm.js");
    const pkg = await (await fetch("/runtime/wasm/current.json")).json(),
      vault = crypto.randomUUID(),
      name = "neonethack-pixel-v2-" + vault;
    let branch;
    const api = await createWasm({
      storage: {
        kind: "indexeddb",
        name,
        replicaUrl: new URL("/api/vaults/" + vault, location.href).href,
        replicaBranches: true,
      },
      workerUrl: new URL(
        "/runtime/wasm/" + pkg.buildId + "/core-worker.mjs",
        location.href,
      ),
      onReplicaStatus: (s) => {
        if (s.branch) branch = s.branch;
      },
    });
    const game = await api.create({
      name: "Published fixture",
      seed: 9,
      role: "valkyrie",
    });
    const save = {
      id: game.id,
      name: "Published fixture",
      role: "valkyrie",
      seed: 9,
      seedSpecified: true,
      turn: game.observation.turn,
      ended: false,
      buildId: pkg.buildId,
    };
    await api.close();
    save.branch = branch;
    localStorage.setItem("neohack-player", vault);
    localStorage.setItem(name + ":adventures", JSON.stringify([save]));
    await fetch("/api/vaults/" + vault + "/adventures", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([save]),
    });
    const url = new URL(location.href);
    url.hash = new URLSearchParams({ run: save.id, vault }).toString();
    return url.href;
  });
  await page.goto(bookmark);
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelector("pixel-nethack").snapshot?.sessionId &&
      document.querySelector("pixel-nethack").getAttribute("aria-busy") ===
        "false",
  );
}
