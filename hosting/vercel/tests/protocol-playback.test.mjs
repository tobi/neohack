import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "../../../web/neohack.dev/node_modules/playwright-core/index.mjs";
import { createTestHarness, publicStoreFor } from "./server.mjs";
import { gunzipSync } from "node:zlib";
import { createServer } from "node:http";

test(
  "real game uploads inputs, plays from static CDN objects and restores on a fresh device",
  { timeout: 120000 },
  async (t) => {
    const server = createTestHarness(),
      { url } = await server.listen();
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
      headless: true,
      chromiumSandbox: true,
    });
    t.after(async () => {
      await browser.close();
      await server.close();
    });
    const context = await browser.newContext(),
      page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url.href);
    await page.waitForFunction(
      () => !document.querySelector("#new-adventure").disabled,
    );
    await page
      .getByRole("button", { name: "Begin your adventure", exact: true })
      .click();
    await page.getByLabel("YOUR NAME", { exact: true }).fill("Input Chronicle");
    await page.locator("input[name=role][value=valkyrie]").check();
    await page
      .getByText("Choose a world seed (optional)", { exact: true })
      .click();
    await page.getByLabel("A number for a repeatable starting world").fill("9");
    await page
      .getByRole("button", { name: "Enter the dungeon →", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("pixel-nethack").snapshot?.observation &&
        document.querySelector("pixel-nethack").getAttribute("aria-busy") ===
          "false",
    );
    await page.keyboard.press("Escape");
    const result = await page.evaluate(async () => {
      const app = document.querySelector("pixel-nethack");
      await app.publicRecorder.flush();
      for (let i = 0; i < 4; i++) await app.run(() => app.game.wait());
      await app.publicRecorder.flush();
      const header = await app.inputTransport.recordingInfo(app.game.id);
      const checkpoint = await app.inputTransport.checkpoint(header.count);
      checkpoint.preview = app.snapshot;
      const { encodeCheckpoint } = await import(
        "/runtime/wasm/" + app.inputTransport.buildId + "/checkpoint-codec.mjs"
      );
      const encoded = await encodeCheckpoint(checkpoint);
      const uploaded = await fetch("/api/runs/" + app.game.id + "/checkpoint", {
        method: "PUT",
        headers: {
          authorization: "Bearer " + app.vault,
          "x-checkpoint-index": String(header.count),
          "x-content-sha256": encoded.sha256,
        },
        body: encoded.bytes,
      });
      if (!uploaded.ok)
        throw Error(
          "Fixture checkpoint publication failed: " + uploaded.status,
        );
      for (let i = 0; i < 4; i++) await app.run(() => app.game.wait());
      const saved = await app.publicRecorder.flush();
      return {
        saved,
        state: app.snapshot,
        manifest: app.publicRecorder.manifest,
        recording: app.current.recording,
      };
    });
    assert.equal(result.recording, "inputs");
    assert.equal(result.saved, true);
    const manifest = await (await fetch(result.manifest)).json();
    assert.equal(manifest.format, "neonethack.inputs");
    assert.ok(manifest.count >= 9);
    const cdn = publicStoreFor(server.store);
    for (const chunk of manifest.chunks) {
      const object = await cdn.read(
        "replays/" + manifest.id + "/" + chunk.path,
      );
      const payload = JSON.parse(gunzipSync(object.value));
      assert.ok(
        payload.records.every((r) => r.request && !r.observation && !r.frame),
      );
    }
    assert.ok(
      ![...server.store.docs.keys()].some((key) =>
        /^replays\/.*\.json$/.test(key),
      ),
      "no secondary full-scene archive was written",
    );
    const replayContext = await browser.newContext(),
      viewer = await replayContext.newPage(),
      requests = [];
    assert.ok(manifest.chunks.length >= 2);
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    await replayContext.route(
      new URL(manifest.chunks[1].path, result.manifest).href,
      async (route) => {
        await gate;
        await route.continue();
      },
    );
    viewer.on("request", (r) => requests.push(new URL(r.url()).pathname));
    await viewer.goto(new URL("/dashboard?run=" + manifest.id, url).href);
    await viewer.waitForFunction(
      () => document.querySelector("neohack-world")?.snapshot?.observation,
    );
    assert.ok(
      await viewer.evaluate(
        () =>
          document.querySelector("neohack-world").snapshot.observation.turn >=
          1,
      ),
      "the first scene is playable while later inputs remain unavailable",
    );
    release();
    const played = await viewer.evaluate(async (count) => {
      const world = document.querySelector("neohack-world");
      world.pause();
      await world.seek(count - 1);
      return world.snapshot;
    }, manifest.count);
    assert.deepEqual(
      played,
      result.state,
      "CDN inputs reconstruct the same canonical response",
    );
    const checkpoint = manifest.checkpoints[0];
    assert.ok(checkpoint);
    let checkpointReads = 0;
    const checkpointUrl = new URL(checkpoint.path, result.manifest).href;
    await replayContext.route(checkpointUrl, async (route) => {
      checkpointReads++;
      await route.continue();
    });
    const cached = await viewer.evaluate(async (count) => {
      const world = document.querySelector("neohack-world");
      await world.seek(count - 1);
      return world.snapshot;
    }, manifest.count);
    assert.equal(checkpointReads, 1);
    assert.deepEqual(
      cached,
      result.state,
      "a real CDN checkpoint and its suffix reproduce the complete response",
    );
    await replayContext.unroute(checkpointUrl);
    await replayContext.route(checkpointUrl, (route) =>
      route.fulfill({ status: 200, body: Buffer.from("damaged checkpoint") }),
    );
    const fallback = await viewer.evaluate(async (count) => {
      const world = document.querySelector("neohack-world");
      await world.seek(count - 1);
      return world.snapshot;
    }, manifest.count);
    assert.deepEqual(
      fallback,
      result.state,
      "invalid optional CDN cache falls back to the verified creation/input log",
    );
    assert.deepEqual(
      requests.filter((path) => path.startsWith("/api/")),
      [],
      "watching makes no dynamic API request, upload or account lookup",
    );
    // Hold a real decoded response at the component boundary. Detachment must
    // invalidate it even when it completes after the viewer has been removed.
    const detached=await viewer.evaluate(async()=>{
      const world=document.querySelector('neohack-world'),player=world.inputPlayback;
      let release,ready;const gate=new Promise(r=>release=r),started=new Promise(r=>ready=r);
      const seek=player.seek.bind(player);
      player.seek=async index=>{const frame=await seek(index);ready();await gate;return frame;};
      const pending=world.seek(0);await started;
      const before=world.snapshot;let frames=0;world.addEventListener('frame',()=>frames++);
      world.remove();release();await pending;
      return {before,after:world.snapshot,frames,retained:!!world.inputPlayback};
    });
    assert.deepEqual(detached.after,detached.before,'a late decoded input cannot update a removed viewer');
    assert.equal(detached.frames,0);assert.equal(detached.retained,false);
    const embed = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<!doctype html><script type="module" src="${url.origin}/component/neohack.js"></script><neohack-world src="${result.manifest}" controls style="height:400px"></neohack-world>`,
      );
    });
    await new Promise((r) => embed.listen(0, "127.0.0.1", r));
    t.after(() => embed.close());
    const external = await browser.newPage(),
      embedErrors = [];
    external.on("pageerror", (e) => embedErrors.push(String(e)));
    external.on("console", (m) => {
      if (m.type() === "error") embedErrors.push(m.text());
    });
    await external.goto("http://127.0.0.1:" + embed.address().port);
    await external
      .waitForFunction(
        () => document.querySelector("neohack-world")?.snapshot?.observation,
      )
      .catch(async (e) => {
        throw Error(
          embedErrors.join("\n") +
            "\n" +
            (await external.evaluate(
              () =>
                document.querySelector("neohack-world")?.shadowRoot
                  ?.textContent,
            )),
          { cause: e },
        );
      });
    assert.equal(
      await external.evaluate(
        () => document.querySelector("neohack-world").snapshot.sessionId,
      ),
      manifest.id,
    );
    assert.deepEqual(embedErrors, []);
    await external.close();
    const bookmark = page.url();
    await context.close();
    const restoredContext = await browser.newContext(),
      restored = await restoredContext.newPage();
    await restoredContext.route("**/replays/**/manifest.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...manifest, count: 0, chunks: [] }),
      }),
    );
    await restored.goto(bookmark);
    await restored.waitForFunction(
      () =>
        document.querySelector("pixel-nethack").snapshot?.observation &&
        document.querySelector("pixel-nethack").getAttribute("aria-busy") ===
          "false",
    );
    const after = await restored.evaluate(
      () => document.querySelector("pixel-nethack").snapshot,
    );
    assert.deepEqual(after.observation, result.state.observation);
    assert.deepEqual(after.decision, result.state.decision);
    assert.equal(after.revision, result.state.revision);
    await restoredContext.setOffline(true);
    await restored.evaluate(async () => {
      const app = document.querySelector("pixel-nethack");
      await app.run(() => app.game.wait());
    });
    const offline = await restored.evaluate(
      () => document.querySelector("pixel-nethack").snapshot,
    );
    assert.ok(
      offline.revision > after.revision,
      "offline movement remains available",
    );
    await restoredContext.setOffline(false);
    const synced = await restored.evaluate(async () =>
      document.querySelector("pixel-nethack").publicRecorder.flush(),
    );
    assert.equal(synced, true);
    assert.deepEqual(errors, []);
  },
);

test(
  "installed offline shell reloads and resumes locally, creates another run, then synchronizes after reconnect",
  { timeout: 120000 },
  async (t) => {
    const server = createTestHarness(),
      { url } = await server.listen();
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
      headless: true,
      chromiumSandbox: true,
    });
    t.after(async () => {
      await browser.close();
      await server.close();
    });
    const context = await browser.newContext(),
      page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url.href);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise((r) =>
          navigator.serviceWorker.addEventListener("controllerchange", r, {
            once: true,
          }),
        );
    });
    const shell = await page.evaluate(async () => ({
      controlled: !!navigator.serviceWorker.controller,
      manifest: await (await fetch("/manifest.webmanifest")).json(),
      keys: await caches.keys(),
    }));
    assert.ok(shell.controlled);
    assert.equal(shell.manifest.display, "standalone");
    assert.ok(shell.keys.some((k) => k.startsWith("neohack-shell-")));
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(
      () => !document.querySelector("#new-adventure").disabled,
    );
    await page
      .getByRole("button", { name: "Begin your adventure", exact: true })
      .click();
    await page
      .getByLabel("YOUR NAME", { exact: true })
      .fill("Offline Traveler");
    await page
      .getByRole("button", { name: "Enter the dungeon →", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("pixel-nethack").snapshot?.observation &&
        document.querySelector("pixel-nethack").getAttribute("aria-busy") ===
          "false",
    );
    await page.keyboard.press("Escape");
    const before = await page.evaluate(async () => {
      const app = document.querySelector("pixel-nethack");
      await app.run(() => app.game.wait());
      return app.snapshot;
    });
    const bookmark = page.url();
    await page.reload();
    await page.waitForFunction(
      () =>
        document.querySelector("pixel-nethack").snapshot?.sessionId &&
        document.querySelector("pixel-nethack").getAttribute("aria-busy") ===
          "false",
    );
    const after = await page.evaluate(
      () => document.querySelector("pixel-nethack").snapshot,
    );
    assert.equal(after.sessionId, before.sessionId);
    assert.deepEqual(after.observation, before.observation);
    assert.deepEqual(after.decision, before.decision);
    await context.setOffline(false);
    const flushed = await page.evaluate(async () => {
      const app = document.querySelector("pixel-nethack");
      return app.publicRecorder.flush();
    });
    assert.equal(flushed, true);
    assert.deepEqual(errors, []);
    assert.equal(page.url(), bookmark);
  },
);
