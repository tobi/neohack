import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
async function fixture(
  t,
  { insecure = false, touch = false, webmcp = false, setup } = {},
) {
  const server = spawn("bun", ["server.ts"], {
    cwd: root,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => server.kill("SIGTERM"));
  const url = await new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(
      () => reject(Error(`Server did not start: ${log}`)),
      10000,
    );
    const data = (chunk) => {
      log += chunk;
      const match = /NEONETHACK READY (http:\/\/127\.0\.0\.1:\d+)/.exec(log);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    server.stdout.on("data", data);
    server.stderr.on("data", data);
    server.on("error", reject);
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(Error(`Server exited ${code}: ${log}`));
    });
  });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
    headless: true,
    chromiumSandbox: true,
    args: [
      ...(webmcp ? ["--enable-experimental-web-platform-features"] : []),
      ...(insecure
        ? [
            "--host-resolver-rules=MAP pixel-preview.test 127.0.0.1",
            "--no-proxy-server",
          ]
        : []),
    ],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
    reducedMotion: "reduce",
    hasTouch: touch,
  });
  const page = await context.newPage();
  const errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (req) =>
    requests.push({ method: req.method(), url: req.url() }),
  );
  if (setup) await setup(page, context);
  await mkdir(`${root}/test-results`, { recursive: true });
  await page.goto(
    insecure ? url.replace("127.0.0.1", "pixel-preview.test") : url,
  );
  await page.getByRole("button", { name: "Begin your adventure" }).waitFor();
  if (!insecure)
    await page.waitForFunction(
      () => !document.querySelector("#new-adventure").disabled,
    );
  return { page, context, url, errors, requests };
}
// Exercise Chromium's real tool registry and invocation path, never app callbacks.
// Current Chrome exposes agent automation through the CDP WebMCP domain;
// Chromium 148 exposes its earlier native testing interface instead.
async function nativeWebMcp(page, t, session) {
  const native = await rawNativeWebMcp(page, t, session);
  const { methods } = await import("../../../lib/neonethack/dist/mcp/agent-data.js");
  const deadline = Date.now() + 5000;
  for (;;) {
    const registered = new Set((await native.list()).map(tool => tool.name));
    const missing = methods.filter(tool => !registered.has(tool.name));
    if (!missing.length) break;
    if (Date.now() >= deadline)
      throw Error("Native WebMCP registry not ready: " + missing.map(tool => tool.name).join(", "));
    // CDP enable completion does not mean that toolsAdded has been delivered.
    // Poll only discovery; never retry an invocation or an uncertain game input.
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return { ...native, call: async (...args) => {
    const result = await native.call(...args);
    if (result.structuredContent) {
      if (result.isError && result.structuredContent.error?.code === 'cancelled' && result.content?.length === 0) {
        assert.equal(result.structuredContent.error.message, 'Tool call cancelled before submission.');
      } else {
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      }
    }
    return result;
  } };
}
async function agentSnapshot(page) {
  const state = await snapshot(page);
  if(!state)return null;
  const {requestId,...frame}=state;return frame;
}
async function rawNativeWebMcp(page, t, session) {
  const cdp = session ?? await page.context().newCDPSession(page);
  t.after(() => cdp.detach().catch(() => {}));
  const registered = new Map();
  const key = tool => tool.frameId + ":" + tool.name;
  cdp.on("WebMCP.toolsAdded", ({ tools }) => {
    for (const tool of tools) registered.set(key(tool), tool);
  });
  cdp.on("WebMCP.toolsRemoved", ({ tools }) => {
    for (const tool of tools) registered.delete(key(tool));
  });
  try {
    await cdp.send("WebMCP.enable");
  } catch (error) {
    if (!String(error).includes("'WebMCP.enable' wasn't found")) throw error;
    assert.equal(await page.evaluate(() => typeof navigator.modelContextTesting?.executeTool), "function",
      "browser must provide a native WebMCP automation interface");
    return {
      list: () => page.evaluate(() => (navigator.modelContextTesting?.listTools() ?? []).map(tool =>
        ({ ...tool, inputSchema: JSON.parse(tool.inputSchema) }))),
      call: (method, args = {}) => page.evaluate(async ({ method, args }) =>
        JSON.parse(await navigator.modelContextTesting.executeTool(
          method.replaceAll(".", "_"), JSON.stringify(args))), { method, args }),
    };
  }
  return {
    list: async () => {
      // Read currently delivered events. Later registration can still be pending.
      await cdp.send("Runtime.evaluate", { expression: "void 0" });
      return [...registered.values()];
    },
    call: async (method, args = {}) => {
      const name = method;
      const tool = [...registered.values()].find(tool => tool.name === name);
      if (!tool) throw Error("Tool not found: " + name);
      let invocationId, timer, listener;
      const early = [];
      const completion = new Promise((resolve, reject) => {
        listener = event => {
          if (!invocationId) { early.push(event); return; }
          if (event.invocationId !== invocationId) return;
          if (event.status === "Completed") resolve(event.output);
          else reject(Error(event.errorText ?? "Native WebMCP invocation " + event.status));
        };
        cdp.on("WebMCP.toolResponded", listener);
        timer = setTimeout(() => reject(Error("Native WebMCP invocation timed out: " + name)), 30000);
      });
      // Observe early failures while invokeTool itself is still pending; the
      // awaited original promise below still propagates every completion error.
      completion.catch(() => {});
      try {
        ({ invocationId } = await cdp.send("WebMCP.invokeTool", {
          frameId: tool.frameId, toolName: name, input: args,
        }));
        for (const event of early) listener(event);
        const output = await completion;
        return typeof output === "string" ? JSON.parse(output) : output;
      } finally {
        clearTimeout(timer);
        cdp.off("WebMCP.toolResponded", listener);
      }
    },
  };
}

const snapshot = (page) =>
  page.evaluate(() => document.querySelector("pixel-nethack").snapshot);
const ready = (page) =>
  page.waitForFunction(
    () =>
      document.querySelector("pixel-nethack").getAttribute("aria-busy") ===
      "false",
  );

test("welcome creator link stays small, accessible and clear of controls", { timeout: 60_000 }, async (t) => {
  const { page, context, errors } = await fixture(t);
  const link = page.getByRole("link", { name: "@tobi on X (opens in a new tab)" });
  assert.equal(await link.textContent(), "@tobi");
  assert.equal(await link.getAttribute("href"), "https://x.com/tobi");
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.deepEqual((await link.getAttribute("rel")).split(" ").sort(), ["noopener", "noreferrer"]);
  for (const [name, width, height] of [["desktop", 1440, 1050], ["mobile", 390, 844], ["landscape", 844, 390]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await link.isVisible(), true);
    const bounds = await link.boundingBox();
    assert.ok(bounds.width >= 44 && bounds.height >= 44, "small text retains a touch target");
    assert.ok(width - bounds.x - bounds.width >= 8 && width - bounds.x - bounds.width <= 20);
    assert.ok(height - bounds.y - bounds.height >= 8 && height - bounds.y - bounds.height <= 20);
    const controls = await page.locator("#welcome-actions").boundingBox();
    assert.ok(bounds.x >= controls.x + controls.width || bounds.x + bounds.width <= controls.x || bounds.y >= controls.y + controls.height || bounds.y + bounds.height <= controls.y, `${name}: link must not overlap intro controls`);
    assert.equal(await link.evaluate(el => document.elementFromPoint(el.getBoundingClientRect().x + el.clientWidth / 2, el.getBoundingClientRect().y + el.clientHeight / 2) === el), true);
    assert.equal(await link.evaluate(el => getComputedStyle(el).fontSize), "11px");
    await page.screenshot({ path: `${root}/test-results/creator-link-${name}.png` });
  }
  // Exercise keyboard activation without contacting the external service.
  await context.route("https://x.com/tobi", route => route.fulfill({ contentType: "text/html", body: "<title>@tobi</title>" }));
  await link.focus();
  assert.equal(await link.evaluate(el => el.matches(":focus-visible")), true);
  const [popup] = await Promise.all([page.waitForEvent("popup"), link.press("Enter")]);
  await popup.waitForLoadState();
  assert.equal(popup.url(), "https://x.com/tobi");
  await popup.close();
  assert.equal(await snapshot(page), null);
  await page.setViewportSize({ width: 1440, height: 1050 });
  await create(page);
  assert.equal(await link.isVisible(), false, "gameplay controls stay unobstructed");
  assert.deepEqual(errors, []);
});

test("plain HTTP remote origins explain secure access before starting WASM", async (t) => {
  const { page, errors, requests } = await fixture(t, { insecure: true });
  await ready(page);
  assert.equal(await page.evaluate(() => window.isSecureContext), false);
  assert.match(
    await page.locator("#error").innerText(),
    /Open the game over HTTPS/,
  );
  assert.match(
    await page.locator("#error").innerText(),
    /forward the server port to localhost/,
  );
  assert.equal(await page.locator("#new-adventure").isDisabled(), true);
  assert.equal(await snapshot(page), null);
  assert.match(
    await page.locator("#save-status").textContent(),
    /Browser saves unavailable/,
  );
  assert.equal(
    requests.some((request) => request.url.includes("core-worker.mjs")),
    false,
  );
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  assert.deepEqual(errors, []);
});
async function create(page, role = "valkyrie", seed = 42, keepStory = false) {
  await page.getByRole("button", { name: "Begin your adventure" }).click();
  await page.getByLabel("YOUR NAME", { exact: true }).fill("Ada");
  await page.locator(`input[name=role][value=${role}]`).check();
  await page
    .getByText("Choose a world seed (optional)", { exact: true })
    .click();
  await page
    .getByLabel("A number for a repeatable starting world")
    .fill(String(seed));
  await page.getByRole("button", { name: "Enter the dungeon" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("pixel-nethack").snapshot?.observation.turn === 1,
  );
  await ready(page);
  if (!keepStory && await page.locator("#journal-scroll").isVisible())
    await page.getByRole("button", { name: "Return to the adventure", exact: true }).click();
}

function openRun(state) {
  const you = state.observation.you;
  return [
    ["ArrowRight", "east", 1, 0],
    ["ArrowLeft", "west", -1, 0],
    ["ArrowDown", "south", 0, 1],
    ["ArrowUp", "north", 0, -1],
  ]
    .map(([key, direction, dx, dy]) => {
      let length = 0;
      while (
        length < 15 &&
        state.observation.world.some(
          (cell) =>
            cell.x === you.x + dx * (length + 1) &&
            cell.y === you.y + dy * (length + 1) &&
            ["floor", "corridor"].includes(cell.terrain.type) &&
            !cell.occupant,
        )
      )
        length++;
      return { key, direction, dx, dy, length };
    })
    .sort((a, b) => b.length - a.length)[0];
}

test(
  "hold keyboard or direction pad to walk, then stop on release, wall, menu and blur",
  { timeout: 30000 },
  async (t) => {
    const { page, errors } = await fixture(t);
    await page.getByRole("button", { name: "Begin your adventure" }).click();
    const name = page.getByLabel("YOUR NAME", { exact: true });
    await name.fill("");
    await name.focus();
    await page.keyboard.down("h");
    await page.keyboard.down("h");
    await page.keyboard.up("h");
    assert.equal(
      await name.inputValue(),
      "hh",
      "text fields retain native key repetition",
    );
    await page.keyboard.press("Escape");
    await create(page);
    const first = await snapshot(page),
      run = openRun(first);
    assert.ok(run.length >= 3, "real perceived room provides a straight run");
    await page.keyboard.down(run.key);
    await page.waitForFunction(
      (turn) =>
        document.querySelector("pixel-nethack").snapshot.observation.turn >=
        turn + 3,
      first.observation.turn,
    );
    await page.keyboard.up(run.key);
    await ready(page);
    const stopped = await snapshot(page);
    await page.waitForTimeout(350);
    assert.deepEqual(
      await snapshot(page),
      stopped,
      "release cannot leave queued repeat steps",
    );

    const padRun = openRun(stopped);
    assert.ok(padRun.length >= 2);
    const pad = page.getByRole("button", {
      name: `Move ${padRun.direction}`,
      exact: true,
    });
    await pad.hover();
    await page.mouse.down();
    await page.waitForFunction(
      (turn) =>
        document.querySelector("pixel-nethack").snapshot.observation.turn >=
        turn + 2,
      stopped.observation.turn,
    );
    await page.mouse.up();
    await ready(page);
    const pointerStopped = await snapshot(page);
    await page.waitForTimeout(350);
    assert.deepEqual(
      await snapshot(page),
      pointerStopped,
      "pointer release must not produce a second click action",
    );

    const wallRun = openRun(pointerStopped);
    await page.keyboard.down(wallRun.key);
    await page.waitForFunction(() => {
      const app = document.querySelector("pixel-nethack");
      return !app.movement.inFlight && !app.movement.held;
    });
    await ready(page);
    const wall = await snapshot(page);
    assert.equal(wall.outcome.positionChanged, false);
    await page.keyboard.down(wallRun.key); // native autorepeat must not restart it
    await page.waitForTimeout(350);
    assert.deepEqual(
      await snapshot(page),
      wall,
      "holding into a wall stops sending input",
    );
    await page.keyboard.up(wallRun.key);

    await page.keyboard.down(openRun(wall).key);
    await ready(page);
    await page.getByLabel("Game menu", { exact: true }).click();
    await page.getByRole("button", { name: "Field guide" }).click();
    await ready(page);
    const menu = await snapshot(page);
    await page.waitForTimeout(350);
    assert.deepEqual(
      await snapshot(page),
      menu,
      "opening a menu stops held walking",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.up(openRun(wall).key);
    const blurRun = openRun(menu);
    await page.keyboard.down(blurRun.key);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await ready(page);
    const blurred = await snapshot(page);
    await page.waitForTimeout(350);
    assert.deepEqual(
      await snapshot(page),
      blurred,
      "focus loss cancels repeats and pending taps",
    );
    await page.keyboard.up(blurRun.key);
    assert.deepEqual(errors, []);
  },
);

test("rapid taps buffer only one step while a real engine request is delayed", async (t) => {
  const { page, errors } = await fixture(t);
  await create(page);
  const first = await snapshot(page),
    run = openRun(first);
  await page.evaluate(async () => {
    const { WasmTransport } = await import("/runtime/typescript/wasm.js");
    const original = WasmTransport.prototype.send;
    window.moveProbe = { active: 0, maximum: 0, calls: 0 };
    WasmTransport.prototype.send = async function (request) {
      if (request.method !== "game.move") return original.call(this, request);
      const p = window.moveProbe;
      p.calls++;
      p.active++;
      p.maximum = Math.max(p.maximum, p.active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 180));
        return await original.call(this, request);
      } finally {
        p.active--;
      }
    };
  });
  await page.keyboard.press(run.key);
  await page.keyboard.press(run.key);
  await page.keyboard.press(run.key);
  await page.keyboard.press(run.key);
  await page.waitForFunction(
    (turn) =>
      document.querySelector("pixel-nethack").snapshot.observation.turn ===
      turn + 2,
    first.observation.turn,
  );
  await ready(page);
  await page.waitForTimeout(350);
  assert.equal(
    (await snapshot(page)).observation.turn,
    first.observation.turn + 2,
  );
  assert.deepEqual(await page.evaluate(() => window.moveProbe), {
    active: 0,
    maximum: 1,
    calls: 2,
  });
  assert.deepEqual(errors, []);
});

test("held walking stops after a committed move whose response is lost", async (t) => {
  const { page } = await fixture(t);
  await create(page);
  const run = openRun(await snapshot(page));
  await page.evaluate(async () => {
    const { WasmTransport } = await import("/runtime/typescript/wasm.js");
    const original = WasmTransport.prototype.send;
    window.moveCalls = 0;
    WasmTransport.prototype.send = async function (request) {
      const result = await original.call(this, request);
      if (request.method === "game.move") {
        window.moveCalls++;
        throw Error("Test: committed move response lost");
      }
      return result;
    };
  });
  await page.keyboard.down(run.key);
  await page.locator("#recovery").waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.moveCalls), 1);
  assert.equal(
    await page
      .getByRole("button", { name: "Search", exact: true })
      .isDisabled(),
    true,
  );
  const pending = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem(document.querySelector("pixel-nethack").indexKey + ":" + document.querySelector("pixel-nethack").current.id)).pending,
  );
  assert.equal(pending.method, "game.move");
  await page.keyboard.up(run.key);
});

test("authored directional motion follows real engine movement without spending idle turns", async (t) => {
  const { page, errors } = await fixture(t);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await create(page);
  const before = await snapshot(page);
  const moves = [
    ["east", 1, 0, "right"],
    ["west", -1, 0, "left"],
    ["north", 0, -1, "up"],
    ["south", 0, 1, "down"],
  ];
  const move = moves.find(([, dx, dy]) =>
    before.observation.world.some(
      (cell) =>
        cell.x === before.observation.you.x + dx &&
        cell.y === before.observation.you.y + dy &&
        cell.terrain.type === "floor" &&
        !cell.occupant,
    ),
  );
  assert.ok(move, "real initial room offers an observed adjacent floor");
  await page
    .getByRole("button", { name: `Move ${move[0]}`, exact: true })
    .click();
  await ready(page);
  const after = await snapshot(page);
  assert.equal(after.observation.you.x, before.observation.you.x + move[1]);
  assert.equal(after.observation.you.y, before.observation.you.y + move[2]);
  assert.equal(
    await page.locator("#dungeon").getAttribute("data-facing"),
    move[3],
  );
  assert.equal(
    await page.locator("#dungeon").getAttribute("data-motion"),
    "walk",
  );
  await page.waitForFunction(
    () => document.querySelector("#dungeon").dataset.motion === "idle",
  );
  const frame = await page.locator("#dungeon").getAttribute("data-frame");
  await page.waitForFunction(
    (frame) => document.querySelector("#dungeon").dataset.frame !== frame,
    frame,
  );
  assert.deepEqual(
    await snapshot(page),
    after,
    "animation cannot issue game input",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(
    () => document.querySelector("#dungeon").dataset.frame === "0",
  );
  assert.equal(await page.locator("#dungeon").getAttribute("data-frame"), "0");
  assert.equal(
    await page.locator("#dungeon").getAttribute("data-facing"),
    move[3],
  );
  const still = await page
    .locator("#dungeon")
    .evaluate((canvas) => canvas.toDataURL());
  await page.getByLabel("Game menu", { exact: true }).click();
  await page.getByRole("button", { name: "Show NetHack symbols" }).click();
  const symbols = await page
    .locator("#dungeon")
    .evaluate((canvas) => canvas.toDataURL());
  assert.notEqual(
    symbols,
    still,
    "visible creatures use art until symbols are requested",
  );
  assert.deepEqual(await snapshot(page), after, "symbol toggle costs no turns");
  assert.deepEqual(errors, []);
});

test("perception-only corridor and sprite study: directions, loot and static reduced motion", async (t) => {
  const { page } = await fixture(t);
  const report = await page.evaluate(async () => {
    // Isolated presentation fixture; never alters an engine session or save.
    const app = document.querySelector("pixel-nethack");
    const canvas = document.createElement("canvas");
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;inset:0;width:736px;height:416px;z-index:30;background:#171f23";
    host.id = "art-study";
    host.append(canvas);
    document.body.append(host);
    const map = new app.map.constructor(canvas, () => {});
    map.zoom = 2;
    const world = [];
    const add = (x, y, type) => {
      const cell = { x, y, terrain: { type, knowledge: "remembered" } };
      world.push(cell);
      return cell;
    };
    for (let y = 1; y < 10; y++)
      for (let x = 1; x < 13; x++)
        add(x, y, x === 1 || x === 12 || y === 1 || y === 9 ? "wall" : "floor");
    world.find((c) => c.x === 12 && c.y === 5).terrain.type = "openDoor";
    for (let x = 13; x < 19; x++) add(x, 5, "corridor");
    for (let y = 2; y < 9; y++) if (y !== 5) add(16, y, "corridor");
    add(17, 2, "corridor");
    add(18, 2, "corridor");
    add(19, 5, "stairsDown");
    for (const [i, mark] of [...'%$!?+)[=*/("'].entries()) {
      const cell = world.find(
        (c) => c.x === 3 + (i % 6) && c.y === 3 + Math.floor(i / 6) * 2,
      );
      cell.objects = [{ mark, color: [3, 11, 1, 7, 5, 7][i % 6] }];
    }
    for (const [i, mark] of [..."dfBrSo"].entries()) {
      const cell = world.find((c) => c.x === 3 + i && c.y === 7);
      cell.occupant = { kind: i === 0 ? "ally" : "creature", mark, color: 3 };
    }
    const observation = {
      location: { id: "art-study", depthLabel: "Study" },
      you: { x: 10, y: 5 },
      world,
    };
    map.update(observation, "valkyrie", "study:42");
    const facing = [],
      images = [],
      matchingArt = [];
    const source = new Image();
    for (const hero of ["valkyrie", "wizard", "ranger"]) {
    map.update(observation, hero, "study:42");
    source.src = `/art/${hero}-motion.png`;
    await source.decode();
    for (const [dx, dy] of [
      [-1, 0],
      [0, -1],
      [1, 0],
      [0, 1],
    ]) {
      map.update(
        {
          ...observation,
          you: { x: map.observation.you.x + dx, y: map.observation.you.y + dy },
        },
        hero,
        "study:42",
      );
      facing.push(canvas.dataset.facing);
      const sheet = document.createElement("canvas");
      sheet.width = 16;
      sheet.height = 32;
      sheet
        .getContext("2d")
        .drawImage(
          canvas,
          Math.floor(canvas.width / 32) * 16,
          Math.floor(canvas.height / 32) * 16 - 16,
          16,
          32,
          0,
          0,
          16,
          32,
        );
      images.push(sheet.toDataURL());
      // Independently audited source order: right, up, left, down.
      // Check opaque face pixels, not merely the renderer's direction label.
      const expected = document.createElement("canvas");
      expected.width = 16;
      expected.height = 32;
      const group = dx < 0 ? 2 : dx > 0 ? 0 : dy < 0 ? 1 : 3;
      expected
        .getContext("2d")
        .drawImage(source, group * 96, 0, 16, 32, 0, 0, 16, 32);
      const pixels = expected.getContext("2d").getImageData(0, 0, 16, 32).data;
      const actual = sheet.getContext("2d").getImageData(0, 0, 16, 32).data;
      matchingArt.push(
        pixels.every(
          (v, i) =>
            pixels[Math.floor(i / 4) * 4 + 3] !== 255 || v === actual[i],
        ),
      );
    }
    }
    source.src = "/art/valkyrie-motion.png";
    await source.decode();
    const boulder = world.find((cell) => cell.x === 6 && cell.y === 2);
    boulder.objects = [{ mark: "`", color: 7 }];
    // Render-only overlap fixture: a tall rock in front of the north wall.
    map.update(observation, "valkyrie", "study:42");
    const rockPixel = (dx, dy) => [
      ...canvas
        .getContext("2d")
        .getImageData(
          (6 - map.origin.x) * 16 + dx,
          (2 - map.origin.y) * 16 + dy,
          1,
          1,
        ).data,
    ];
    const crownOverWall = rockPixel(8, -3);
    const outsideTile = rockPixel(-3, 3);
    const ordered = canvas.toDataURL();
    map.update(
      { ...observation, world: [...world].reverse() },
      "valkyrie",
      "study:42",
    );
    const inputOrderStable = canvas.toDataURL() === ordered;
    // A nearer boulder covers an actor behind it; use the rock-only pixel as reference.
    const expectedRock = rockPixel(6, -3);
    map.update({ ...observation, you: { x: 6, y: 1 } }, "valkyrie", "study:42");
    const crownOverActor = rockPixel(6, -3);
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = source.width; sourceCanvas.height = source.height;
    const sourceContext = sourceCanvas.getContext("2d");
    sourceContext.drawImage(source, 0, 0);
    const expectedActor = [...sourceContext.getImageData(3 * 96 + 6, 29, 1, 1).data];
    map.update({ ...observation, you: { x: 6, y: 2 } }, "valkyrie", "study:42");
    const underfootActor = rockPixel(8, 8);
    const expectedUnderfootActor = [...sourceContext.getImageData(3 * 96 + 8, 24, 1, 1).data];
    map.update(observation, "valkyrie", "study:42");
    map.destroy();
    return {
      facing,
      uniqueDirections: new Set(images).size,
      matchingArt,
      crownOverWall,
      crownOverActor,
      expectedActor,
      expectedRock,
      underfootActor,
      expectedUnderfootActor,
      outsideTile,
      inputOrderStable,
      motion: canvas.dataset.motion,
      frame: canvas.dataset.frame,
    };
  });
  assert.deepEqual(report.facing, Array(3).fill(["left", "up", "right", "down"]).flat());
  assert.equal(report.uniqueDirections, 12);
  assert.deepEqual(
    report.matchingArt,
    Array(12).fill(true),
    "sprite pixels must face the requested screen direction",
  );
  assert.equal(report.motion, "idle");
  assert.equal(report.frame, "0");
  assert.deepEqual(
    report.crownOverWall,
    [181, 180, 160, 255],
    "boulder crown rises above the wall pass",
  );
  assert.equal(report.expectedActor[3], 255, "overlap test samples an opaque boot pixel");
  assert.deepEqual(
    report.crownOverActor,
    report.expectedRock,
    "nearer boulder pixels cover the actor behind it",
  );
  assert.equal(report.expectedUnderfootActor[3], 255);
  assert.deepEqual(report.underfootActor, report.expectedUnderfootActor, "the player remains above objects directly underfoot");
  assert.deepEqual(
    report.outsideTile,
    [41, 50, 50, 255],
    "boulder silhouette is wider than a floor tile",
  );
  assert.equal(
    report.inputOrderStable,
    true,
    "foreground depth cannot depend on observation array order",
  );
  await page
    .locator("#art-study")
    .screenshot({ path: `${root}/test-results/perceived-corridor.png` });
});

test(
  "real Bun/WASM adventure: onboarding, actions, choices, durable reload, ownership, responsive rendering",
  { timeout: 120000 },
  async (t) => {
    const { page, context, url, errors, requests } = await fixture(t);
    await page.screenshot({
      path: `${root}/test-results/welcome-desktop.png`,
      fullPage: true,
    });
    assert.equal(
      await page
        .locator("img")
        .evaluateAll((images) =>
          images.every((i) => i.complete && i.naturalWidth > 0),
        ),
      true,
    );
    await page.getByLabel("Game menu", { exact: true }).click();
    await page.getByRole("button", { name: "Field guide" }).click();
    assert.ok(
      await page
        .getByRole("heading", { name: "A small guide to a very big world." })
        .isVisible(),
    );
    await page.keyboard.press("Escape");
    await create(page);
    const first = await snapshot(page);
    assert.equal(first.observation.turn, 1);
    assert.ok(first.observation.you);
    assert.ok(await page.locator("#map-text").textContent());
    await page.screenshot({
      path: `${root}/test-results/game-desktop.png`,
      fullPage: true,
    });
    const turn = first.observation.turn;
    await page.locator("#dungeon").focus();
    await page.keyboard.down(".");
    await ready(page);
    await page.keyboard.down(".");
    await page.keyboard.up(".");
    await ready(page);
    assert.equal(
      (await snapshot(page)).observation.turn,
      turn + 1,
      "held keys must not repeat input",
    );
    const inspected = await snapshot(page);
    await page.keyboard.press("Shift+ArrowRight");
    await page.locator("#dungeon").click({ position: { x: 400, y: 250 } });
    assert.deepEqual(
      await snapshot(page),
      inspected,
      "panning and inspecting must cost no turns",
    );
    await page.getByLabel("Game menu", { exact: true }).click();
    await page.getByRole("button", { name: "Center on you" }).click();
    await page.getByLabel("Game menu", { exact: true }).click();
    await page.getByRole("button", { name: "Eat", exact: true }).click();
    await ready(page);
    const food = await snapshot(page);
    assert.equal(food.decision.kind, "item");
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(
      await snapshot(page),
      food,
      "movement must not answer a standing decision",
    );
    for (const item of food.decision.options)
      assert.ok(
        await page
          .getByRole("button", { name: item.label, exact: true })
          .isVisible(),
      );
    await page
      .getByRole("button", { name: "Cancel action", exact: true })
      .click();
    await ready(page);
    assert.equal(
      (await snapshot(page)).observation.turn,
      food.observation.turn,
    );
    await page
      .getByRole("button", { name: "More actions", exact: true })
      .click();
    await page.locator("#more-grid button").filter({ hasText: /^Pray$/ }).click();
    assert.equal((await snapshot(page)).decision, null);
    await page.getByRole("button", { name: "Continue to prayer", exact: true }).click();
    await ready(page);
    const prayer = await snapshot(page);
    assert.equal(prayer.decision.kind, "confirmation");
    await page.screenshot({
      path: `${root}/test-results/decision-desktop.png`,
      fullPage: true,
    });
    // Abrupt page loss, without sending a close/answer action.
    // Revisit the doorway; opening the bookmarked run URL resumes automatically.
    await page.goto(new URL("/", page.url()).href);
    await page.waitForFunction(
      () => !document.querySelector("#new-adventure").disabled,
    );
    await page
      .getByRole("button", { name: /^Continue previous run/ })
      .click();
    await ready(page);
    const resumed = await snapshot(page);
    assert.equal(resumed.sessionId, first.sessionId);
    assert.deepEqual(resumed.decision, prayer.decision);
    assert.deepEqual(resumed.observation, prayer.observation);
    await page
      .getByRole("button", { name: "No, not now", exact: true })
      .click();
    await ready(page);
    assert.equal(
      (await snapshot(page)).observation.turn,
      prayer.observation.turn,
    );
    assert.equal((await snapshot(page)).decision, null);
    // The same run transfers to the requested tab without competing writers.
    const competitor = await context.newPage();
    await competitor.goto(url);
    await competitor.waitForFunction(
      () => !document.querySelector("#new-adventure").disabled,
    );
    assert.equal(
      await competitor.locator("#error").isVisible(),
      false,
      "title tabs do not own saves",
    );
    await competitor
      .getByRole("button", { name: /^Continue previous run/ })
      .click();
    await competitor.waitForFunction(() => document.querySelector('pixel-nethack').snapshot?.observation);
    assert.equal((await snapshot(competitor)).sessionId, first.sessionId);
    assert.equal(await competitor.locator('#error').isVisible(), false);
    await page.getByRole('button', {name:'Play here',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('pixel-nethack').snapshot?.observation);
    await ready(page);
    await competitor.close();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `${root}/test-results/game-mobile.png`,
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "mobile layout must not overflow horizontally",
    );
    await page.getByRole("button", { name: "Backpack", exact: false }).click();
    const beforeBag = await snapshot(page);
    await page.locator("#panel-body .item-row").first().click();
    assert.ok(await page.locator("#item-actions").isVisible());
    await page.keyboard.press("Escape");
    assert.deepEqual(
      await snapshot(page),
      beforeBag,
      "item inspection costs no turns",
    );
    await page.locator("#close-panel").click();
    await page.getByLabel("Game menu", { exact: true }).click();
    await page
      .getByRole("button", { name: "Your adventures", exact: false })
      .click();
    await page
      .getByRole("button", { name: "Save & return to doorway", exact: true })
      .click();
    await ready(page);
    await page.screenshot({
      path: `${root}/test-results/welcome-mobile.png`,
      fullPage: true,
    });
    assert.equal(await snapshot(page), null);
    assert.deepEqual(errors, []);
    assert.ok(
      requests.length > 0 && requests.every((r) => r.method === "GET" ||
        /\/api\/(?:runs(?:\/[^/]+\/(?:inputs|checkpoint))?|errors|vaults\/[^/]+\/adventures)$/.test(new URL(r.url).pathname)),
      "gameplay stays in the browser; writes are background archives, metadata or diagnostics",
    );
    assert.ok(
      requests.every((r) => r.url.startsWith(url)),
      "no CDN, tracking or external runtime dependency",
    );
  },
);

test(
  "all thirteen starting paths create actual engine worlds with matching portraits",
  { timeout: 300000 },
  async (t) => {
    for (const role of ["valkyrie", "wizard", "ranger", "archeologist", "barbarian", "caveman", "healer", "knight", "monk", "priest", "rogue", "samurai", "tourist"]) {
      const { page, errors } = await fixture(t);
      await create(page, role, 42);
      const art = role;
      assert.ok((await page.locator("#portrait").getAttribute("src")).endsWith(`/art/${art}.png`));
      assert.equal(await page.evaluate(() => document.querySelector("pixel-nethack").map.hero), art);
      const state = await snapshot(page);
      assert.equal(state.ended, false);
      assert.ok(state.observation.inventory.length > 0);
      assert.equal(state.error, undefined);
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);

test(
  "a real committed turn with a lost response is recovered by its exact receipt after reload",
  { timeout: 60000 },
  async (t) => {
    const { page } = await fixture(t);
    await create(page);
    const first = await snapshot(page);
    await page.evaluate(async () => {
      const { WasmTransport } = await import("/runtime/typescript/wasm.js");
      const send = WasmTransport.prototype.send;
      WasmTransport.prototype.send = async function (request) {
        const response = await send.call(this, request);
        if (request.method === "game.wait") {
          WasmTransport.prototype.send = send;
          throw Error(
            "Test: response lost after the actual engine committed the turn",
          );
        }
        return response;
      };
    });
    await page
      .getByRole("button", { name: "Wait one turn", exact: true })
      .click();
    await ready(page);
    assert.ok(await page.locator("#recovery").isVisible());
    assert.equal(
      await page
        .getByRole("button", { name: "Search", exact: true })
        .isDisabled(),
      true,
    );
    const pending = await page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem(document.querySelector("pixel-nethack").indexKey + ":" + document.querySelector("pixel-nethack").current.id),
        ).pending,
    );
    assert.equal(pending.method, "game.wait");
    assert.equal(pending.params.sessionId, first.sessionId);
    // Revisit the doorway; opening the bookmarked run URL resumes automatically.
    await page.goto(new URL("/", page.url()).href);
    await page.waitForFunction(
      () => !document.querySelector("#new-adventure").disabled,
    );
    await page
      .getByRole("button", { name: /^Continue previous run/ })
      .click();
    await ready(page);
    const resumed = await snapshot(page);
    assert.equal(resumed.observation.turn, first.observation.turn + 1);
    assert.ok(await page.locator("#recovery").isVisible());
    await page.evaluate(async () => {
      const { WasmTransport } = await import("/runtime/typescript/wasm.js");
      const send = WasmTransport.prototype.send;
      window.checkedRequests = [];
      WasmTransport.prototype.send = function (request) {
        window.checkedRequests.push(structuredClone(request));
        return send.call(this, request);
      };
    });
    await page
      .getByRole("button", { name: "Check last action", exact: true })
      .click();
    await ready(page);
    assert.deepEqual(
      await page.evaluate(() =>
        window.checkedRequests.filter((r) => r.method === "game.wait"),
      ),
      [pending],
    );
    assert.equal(
      (await snapshot(page)).observation.turn,
      first.observation.turn + 1,
      "receipt recovery must not spend another turn",
    );
    assert.equal(await page.locator("#recovery").isVisible(), false);
    assert.equal(
      await page
        .getByRole("button", { name: "Search", exact: true })
        .isDisabled(),
      false,
    );
  },
);

test(
  "corrupt adventure metadata is reported without replacing it or creating a game",
  { timeout: 30000 },
  async (t) => {
    const { page } = await fixture(t);
    await page.evaluate(() => {
      const app = document.querySelector("pixel-nethack");
      localStorage.setItem("neohack-player", app.vault);
      localStorage.setItem(app.indexKey, "{damaged");
    });
    // Revisit the doorway; opening the bookmarked run URL resumes automatically.
    await page.goto(new URL("/", page.url()).href);
    await ready(page);
    assert.ok(await page.locator("#error").isVisible());
    assert.equal(await page.locator("#new-adventure").isDisabled(), true);
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem(document.querySelector("pixel-nethack").indexKey),
      ),
      "{damaged",
    );
    assert.equal(await snapshot(page), null);
  },
);

test(
  "Bun exposes only static public files and the public runtime",
  { timeout: 30000 },
  async (t) => {
    const { url, page, requests } = await fixture(t);
    const heroes = ["archeologist", "barbarian", "caveman", "healer", "knight", "monk", "priest", "rogue", "samurai", "tourist", "valkyrie", "wizard", "ranger"];
    const art = [
      "/art/bat.png", "/art/cat.png", "/art/dog.png",
      ...heroes.flatMap(name => [`/art/${name}.png`, `/art/${name}-motion.png`]),
    ].sort();
    assert.deepEqual(
      [...new Set(requests.map(({ url }) => new URL(url).pathname))]
        .filter((path) => path.startsWith("/art/"))
        .sort(),
      art,
      "the client actually loads every retained export, without public source metadata",
    );
    await page.evaluate(async (paths) => {
      await Promise.all(paths.map(async (path) => {
        const image = new Image();
        image.src = path;
        await image.decode();
      }));
    }, art);
    for (const path of [
      "/server.ts",
      "/package.json",
      "/art/bat.json",
      "/art/cat.json",
      "/art/dog.json",
      "/art/explorer.json",
      "/art/scholar.json",
      "/art/explorer-motion.json",
      "/art/scholar-motion.json",
      ...heroes.map(name => `/art/${name}-motion.json`),
      "/art/explorer.png", "/art/explorer-motion.png",
      "/art/scholar.png", "/art/scholar-motion.png",
      "/art/recipe.json",
      "/art/LimeZu-LICENSE.txt",
      "/build/runtime.json",
      "/runtime/wasm-packages/index.json",
      "/.env",
      "/runtime/../../AGENTS.md",
      "/runtime/../package.json",
      "/runtime/%2e%2e%2f%2e%2e%2fAGENTS.md",
    ]) {
      assert.equal((await fetch(url + path)).status, 404, path);
    }
    assert.equal(
      (await fetch(url + "/", { method: "POST", body: "{}" })).status,
      405,
    );
    const response = await fetch(url + "/runtime/wasm/neonethack-core.wasm");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/wasm/);
    assert.equal(
      (await fetch(url + "/style.css", { method: "HEAD" })).status,
      200,
    );
  },
);

test(
  "search and door results appear on the map; remembered floors stay dim and journals do not duplicate",
  { timeout: 30000 },
  async (t) => {
    const { page, errors } = await fixture(t);
    page.setDefaultTimeout(6000);
    await create(page);
    assert.equal(
      await page.locator(".action-bubble").count(),
      0,
      "no replay of the introduction",
    );
    const turn = (await snapshot(page)).observation.turn;
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await ready(page);
    const search = page
      .locator(".action-bubble")
      .filter({ hasText: "You search nearby." });
    await search.waitFor();
    assert.equal((await snapshot(page)).observation.turn, turn + 1);
    assert.equal(
      await search.evaluate((el) => getComputedStyle(el).animationName),
      "none",
    );
    const you = (await snapshot(page)).observation.you;
    assert.equal(await search.getAttribute("data-x"), String(you.x));
    await page.evaluate(() => document.querySelector("pixel-nethack").render());
    assert.equal(await page.locator(".action-bubble").count(), 1);
    await page.screenshot({ path: `${root}/test-results/search-bubble.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await search.scrollIntoViewIfNeeded();
    const bubbleBounds = await search.boundingBox();
    assert.ok(
      bubbleBounds.x >= 0 && bubbleBounds.x + bubbleBounds.width <= 390,
    );
    await page.screenshot({
      path: `${root}/test-results/search-bubble-mobile.png`,
    });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await search.waitFor({ state: "detached" });
    for (const direction of ["south", "south", "west", "west"]) {
      await page.evaluate(async (direction) => {
        const app = document.querySelector("pixel-nethack");
        await app.run(() => app.game.move(direction));
      }, direction);
    }
    assert.ok(await page.locator("#contextual-stairs button").filter({ hasText: "Open door · south" }).isVisible());
    await page.keyboard.press("o");
    await page.locator("#direction-target").waitFor();
    assert.equal(await page.locator(".action-bubble").count(), 0);
    await page.locator('[data-target-direction="south"]').click();
    await ready(page);
    const door = page.locator(".action-bubble").filter({ hasText: "kreeek…" });
    await door.waitFor();
    assert.equal(await door.getAttribute("data-x"), "16");
    assert.equal(await door.getAttribute("data-y"), "8");
    await page.screenshot({ path: `${root}/test-results/door-bubble.png` });
    for (let i = 0; i < 2; i++)
      await page.evaluate(async () => {
        const app = document.querySelector("pixel-nethack");
        await app.run(() => app.game.move("south"));
      });
    const fog = await page.evaluate(() => {
      const app = document.querySelector("pixel-nethack");
      const cell = app.snapshot.observation.world.find(
        (cell) =>
          cell.visible === false &&
          cell.terrain.type === "floor" &&
          !cell.occupant &&
          !cell.objects &&
          cell.y >= 5,
      );
      if (!cell) throw Error("No remembered floor");
      const map = app.map,
        canvas = document.querySelector("#dungeon");
      const sample = () => [
        ...canvas
          .getContext("2d")
          .getImageData(
            (cell.x - map.origin.x) * 16 + 8,
            (cell.y - map.origin.y) * 16 + 8,
            1,
            1,
          ).data,
      ];
      const dim = sample();
      const current = structuredClone(app.snapshot.observation);
      current.world.find((c) => c.x === cell.x && c.y === cell.y).visible =
        true;
      map.update(
        current,
        "valkyrie",
        `${app.current.seed}:${current.location.id}`,
      );
      const lit = sample();
      app.render();
      return { dim, lit };
    });
    assert.ok(
      fog.dim.slice(0, 3).reduce((a, b) => a + b, 0) <
        fog.lit.slice(0, 3).reduce((a, b) => a + b, 0),
      JSON.stringify(fog),
    );
    assert.ok(fog.dim[0] > 20, "remembered floor remains legible, not black");
    await page.screenshot({ path: `${root}/test-results/remembered-room.png` });
    await page.getByRole("button", { name: "Journal", exact: true }).click();
    assert.equal(
      await page
        .locator(".journal-entry")
        .filter({ hasText: "The door opens." })
        .count(),
      1,
    );
    assert.equal(
      await page
        .locator(".journal-entry")
        .filter({ hasText: "You search nearby." })
        .count(),
      1,
    );
    // Revisit the doorway; opening the bookmarked run URL resumes automatically.
    await page.goto(new URL("/", page.url()).href);
    await ready(page);
    await page
      .getByRole("button", { name: /^Continue previous run/ })
      .click();
    await ready(page);
    assert.equal(
      await page.locator(".action-bubble").count(),
      0,
      "resume does not replay bubbles",
    );
    assert.ok(
      (await snapshot(page)).observation.world.some(
        (cell) => cell.visible === false && cell.terrain.type === "floor",
      ),
    );
    assert.deepEqual(errors, []);
  },
);

test(
  "confirmed movement glides and sight fades without extra turns; reduced motion settles immediately",
  { timeout: 20000 },
  async (t) => {
    const { page, errors } = await fixture(t);
    await create(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const result = await page.evaluate(async () => {
      const app = document.querySelector("pixel-nethack");
      for (const direction of ["south", "south", "west", "west"])
        await app.run(() => app.game.move(direction));
      await app.run(() => app.game.open());
      await app.run(() =>
        app.game.answer(app.game.decision.id, {
          kind: "target",
          target: { direction: "south" },
        }),
      );
      await app.run(() => app.game.move("south"));
      const map = app.map;
      const travel = [0, 55, 110].map((ms) =>
        map.travel(map.travelStarted + ms),
      );
      const cell = app.snapshot.observation.world.find(
        (cell) =>
          cell.terrain.type === "floor" &&
          !cell.occupant &&
          !cell.objects &&
          map.fog.has(`${cell.x},${cell.y}`),
      );
      if (!cell) throw Error("No real sight transition occurred");
      const fade = map.fog.get(`${cell.x},${cell.y}`);
      const canvas = document.querySelector("#dungeon");
      const shades = [0, 120, 240].map((ms) => {
        const now = fade.started + ms;
        map.draw(now);
        const shift = map.travel(now);
        return [
          ...canvas
            .getContext("2d")
            .getImageData(
              (cell.x - map.origin.x) * 16 + 8 + shift.x,
              (cell.y - map.origin.y) * 16 + 8 + shift.y,
              1,
              1,
            ).data,
        ]
          .slice(0, 3)
          .reduce((a, b) => a + b, 0);
      });
      return { travel, shades, turn: app.snapshot.observation.turn };
    });
    assert.ok(Math.abs(result.travel[0].y) > Math.abs(result.travel[1].y));
    assert.deepEqual(result.travel[2], { x: 0, y: 0 });
    assert.ok(
      result.shades[0] > result.shades[1] &&
        result.shades[1] > result.shades[2],
      `Actual floor pixels should dim gradually: ${result.shades}`,
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    const settled = await page.evaluate(() => {
      const app = document.querySelector("pixel-nethack");
      return {
        shift: app.map.travel(app.map.travelStarted),
        turn: app.snapshot.observation.turn,
      };
    });
    assert.deepEqual(settled.shift, { x: 0, y: 0 });
    assert.equal(settled.turn, result.turn);
    assert.deepEqual(errors, []);
  },
);

test("neighborhood inspection is free, revision-bound, keyboard accessible and preserves tool choices", async (t) => {
  const { page, errors } = await fixture(t);
  await create(page);
  await ready(page);
  const before = await snapshot(page);
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Tile actions" }).waitFor();
  assert.equal((await snapshot(page)).revision, before.revision);
  await page
    .getByRole("dialog", { name: "Tile actions" })
    .getByRole("button", { name: "Search here" })
    .click();
  await ready(page);
  assert.equal(
    (await snapshot(page)).observation.turn,
    before.observation.turn + 1,
  );
  await page.evaluate(() => {
    const app = document.querySelector("pixel-nethack");
    const p = app.game.observation.you;
    app.inspectTile(p.x, p.y);
  });
  await page.evaluate(async () => {
    const app = document.querySelector("pixel-nethack");
    await app.game.wait();
  });
  await page
    .getByRole("dialog", { name: "Tile actions" })
    .getByRole("button", { name: "Search here" })
    .click();
  await ready(page);
  assert.match(await page.locator("#error").textContent(), /staleRevision/);
  assert.equal(
    (await snapshot(page)).observation.turn,
    before.observation.turn + 2,
  );
  assert.deepEqual(errors, []);
});

test("held locked-door bump opens a targeted panel once; touch inspection and lock survive reload", async (t) => {
  const { page, errors } = await fixture(t, { touch: true });
  await create(page, "valkyrie", 24);
  await ready(page);
  for (let i = 0; i < 8; i++)
    await page.evaluate(async () => {
      const app = document.querySelector("pixel-nethack");
      await app.run(() => app.game.move("east"));
    });
  const before = await snapshot(page);
  await page.keyboard.down("ArrowRight");
  const panel = page.getByRole("dialog", { name: "Tile actions" });
  await panel.waitFor();
  const after = await snapshot(page);
  assert.equal(after.outcome.reason, "lockedDoor");
  await page.waitForTimeout(450);
  await page.keyboard.up("ArrowRight");
  assert.equal((await snapshot(page)).revision, after.revision);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(await panel.getAttribute("data-x"), "45");
  assert.equal(await panel.getAttribute("data-y"), "14");
  assert.equal(
    await panel.getByRole("button", { name: "Use a tool…" }).isDisabled(),
    true,
  );
  await panel
    .getByRole("button", { name: "Close tile actions", exact: true })
    .click();
  const location = await page.evaluate(() => {
    const app = document.querySelector("pixel-nethack"),
      map = app.map,
      rect = document.querySelector("#dungeon").getBoundingClientRect();
    return {
      x: rect.x + (45 - map.origin.x + 0.5) * 16 * map.zoom,
      y: rect.y + (14 - map.origin.y + 0.5) * 16 * map.zoom,
    };
  });
  await page.touchscreen.tap(location.x, location.y);
  await panel.waitFor();
  assert.equal((await snapshot(page)).revision, after.revision);
  await page.screenshot({ path: `${root}/test-results/locked-door-panel.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  const bounds = await panel.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.screenshot({
    path: `${root}/test-results/locked-door-mobile.png`,
  });
  // Revisit the doorway; opening the bookmarked run URL resumes automatically.
    await page.goto(new URL("/", page.url()).href);
  await page
    .getByRole("button", { name: /Continue/ })
    .first()
    .click();
  await ready(page);
  const restored = await snapshot(page);
  assert.equal(
    restored.observation.neighborhood.cells.find(
      (c) => c.x === 45 && c.y === 14,
    ).door.lock,
    "locked",
  );
  assert.deepEqual(errors, []);
});

test("walk-in welcome teaches directions, stops on release and opens creation only at the hall", async (t) => {
  const { page, errors } = await fixture(t, { touch: true });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const intro = () =>
    page.evaluate(() => ({
      ...document.querySelector("pixel-nethack").map.intro,
    }));
  const initial = await intro();
  await page.keyboard.press("ArrowRight");
  assert.equal((await intro()).x, initial.x + 8);
  assert.equal((await intro()).facing, 0, "authored right-facing group");
  await page.keyboard.press("ArrowLeft");
  assert.equal((await intro()).x, initial.x);
  assert.equal((await intro()).facing, 2, "authored left-facing group");
  await page.keyboard.down("ArrowUp");
  await page.waitForFunction(
    () => document.querySelector("pixel-nethack").map.intro.y < 184,
  );
  await page.keyboard.up("ArrowUp");
  const stopped = await intro();
  await page.waitForTimeout(350);
  assert.deepEqual(await intro(), stopped);
  assert.equal(await snapshot(page), null);
  assert.equal(await page.locator("#menu").getAttribute("open"), null);
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem(document.querySelector("pixel-nethack").indexKey),
    ),
    null,
  );
  await page.keyboard.down("ArrowUp");
  await page.waitForFunction(
    () => document.querySelector("#dungeon").dataset.portal === "entering",
  );
  assert.equal(
    await page.locator("#menu").getAttribute("open"),
    null,
    "character creation waits for the portal sequence",
  );
  assert.equal(
    await page.locator("pixel-nethack").getAttribute("class"),
    "portal-entering",
  );
  const atThreshold = await intro();
  await page.keyboard.press("ArrowLeft");
  assert.deepEqual(await intro(), atThreshold, "portal entry locks movement");
  await page.waitForTimeout(320);
  const portalProgress = Number(
    await page.locator("#dungeon").getAttribute("data-portal-progress"),
  );
  assert.ok(
    portalProgress > 0.2 && portalProgress < 0.9,
    `portal progress should be mid-sequence, received ${portalProgress}`,
  );
  await page.screenshot({ path: `${root}/test-results/portal-entry.png` });
  await page.locator("#create-form").waitFor();
  await page.keyboard.up("ArrowUp");
  assert.equal(
    await page.locator("#dungeon").getAttribute("data-portal"),
    "idle",
  );
  assert.equal(await page.locator("pixel-nethack").getAttribute("class"), "");
  assert.equal(
    await snapshot(page),
    null,
    "walking is decorative, not engine input",
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    (y) => document.querySelector("pixel-nethack").map.intro.y === y,
    initial.y,
  );
  assert.equal((await intro()).y, initial.y, "cancel restores the approach");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const north = page.getByRole("button", {
    name: "Walk north toward the entrance",
  });
  for (let i = 0; i < 14; i++) await north.tap();
  await page.locator("#create-form").waitFor();
  assert.equal(await snapshot(page), null);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Begin your adventure" }).click();
  await page.locator("#create-form").waitFor();
  assert.equal(await page.locator("dialog[open]").count(), 1);
  await page.keyboard.press("Escape");
  const size = await page.locator(".map-viewport").boundingBox();
  assert.equal(size.width, 390);
  const rail = await page.locator('neohack-rail').boundingBox();
  assert.equal(size.y, rail.y + rail.height);
  assert.equal(size.y + size.height, 844);
  assert.deepEqual(errors, []);
});

test(
  "native WebMCP exposes navigation tools and shares durable engine state with the HUD",
  { timeout: 60000 },
  async (t) => {
    const { page, errors } = await fixture(t, { webmcp: true });
    await page.waitForFunction(
      () => document.querySelector("pixel-nethack").dataset.webmcp === "ready",
    );
    const { methods } = await import("../../../lib/neonethack/dist/mcp/agent-data.js");
    const tools=methods.map(m=>({name:m.name,description:m.description,inputSchema:m.schema}));
    const snapshotPart=({summary,operationId,historical,navigation,creatures,requestId,presentation,reply,cancel,...frame})=>{
      const {neighborhood,...observation}=frame.observation;
      return {...frame,observation,events:frame.events.filter(e=>!(e.type==='saw'&&e.kind==='terrain'&&(e.mark==='\\u0000'||e.mark==='\u0000')))};
    };
    const sharedSnapshot=async()=>{const frame=await agentSnapshot(page);return frame?snapshotPart(frame):null;};
    const native = await nativeWebMcp(page, t);
    const registered = await native.list();
    assert.deepEqual(
      registered.map((t) => t.name).sort(),
      tools.map((t) => t.name).sort(),
    );
    for (const tool of tools) {
      const native = registered.find((t) => t.name === tool.name);
      assert.equal(native.description, tool.description);
      assert.deepEqual(native.inputSchema, tool.inputSchema);
    }
    const call = native.call;
    assert.equal((await call("help")).isError, false);
    assert.equal(await agentSnapshot(page), null);
    const created = await call("create", {
      name: "Mira",
      role: "valkyrie",
      race: "human",
      gender: "female",
      align: "lawful",
      seed: 42,
    });
    assert.equal(created.isError, false);
    let state = created.structuredContent;
    assert.deepEqual(await sharedSnapshot(), snapshotPart(state));
    assert.equal(state.presentation.kind,'compact');
    const humanBeforeQuery = await agentSnapshot(page);
    const full=(await call('observe',{sessionId:state.sessionId})).structuredContent;
    assert.deepEqual(await agentSnapshot(page), humanBeforeQuery, 'observation preserves the human action outcome and events');
    assert.deepEqual(full.observation, humanBeforeQuery.observation, 'explicit observation returns the entire shared HUD scene');
    assert.deepEqual(full.decision, humanBeforeQuery.decision);
    assert.equal(full.revision, humanBeforeQuery.revision);
    assert.equal(await page.locator("#hero-name").textContent(), "Mira");
    assert.equal(
      await page.locator(".map-viewport").evaluate((el) => el.clientHeight),
      1050 - (await page.locator('neohack-rail').boundingBox()).height,
    );
    await page.screenshot({
      path: `${root}/test-results/fullscreen-hud-desktop.png`,
    });
    const args = (requestId, extra = {}) => ({
      sessionId: state.sessionId,
      ...extra,
    });
    const prayerArgs = args("web-pray");
    const prayer = await call("pray", prayerArgs);
    state = prayer.structuredContent;
    assert.equal(state.decision.kind, "confirmation");
    await page.locator("#decision[open]").waitFor();
    await page.waitForTimeout(200);
    assert.deepEqual(
      await sharedSnapshot(),
      snapshotPart(state),
      "warnings await an explicit answer",
    );
    const decline = await call(
      "answer",
      args("web-decline", {
        decisionId: state.decision.id,
        value: false,
      }),
    );
    state = decline.structuredContent;
    assert.equal(state.decision, null);
    const waitArgs = args("web-wait");
    state = (await call("wait", waitArgs)).structuredContent;
    const next = (await call("wait", args("web-next"))).structuredContent;
    assert.deepEqual(
      snapshotPart((await call("receipt",{sessionId:state.sessionId,operationId:state.operationId})).structuredContent),
      snapshotPart(state),
      "exact receipt retry",
    );
    assert.deepEqual(
      await sharedSnapshot(),
      snapshotPart(next),
      "old receipts never rewind the HUD",
    );
    state = next;
    await page.evaluate(async()=>{const app=document.querySelector('pixel-nethack');await app.run(()=>app.game.wait());});
    const human=await agentSnapshot(page);
    const stale=await call('wait',{sessionId:state.sessionId});
    assert.equal(stale.isError,true);
    assert.equal((await agentSnapshot(page)).revision,human.revision);
    state=(await call('observe',{sessionId:state.sessionId})).structuredContent;
    const actions = await call("inspect", {
      sessionId: state.sessionId,
      target: "here",
    });
    assert.equal(actions.isError, false);
    assert.equal((await agentSnapshot(page)).revision, state.revision);
    await page.evaluate(async () => {
      const { WasmTransport } = await import("/runtime/typescript/wasm.js");
      const original = WasmTransport.prototype.send;
      WasmTransport.prototype.send = async function (request) {
        const response = await original.call(this, request);
        if (request.method === "game.wait") {
          WasmTransport.prototype.send = original;
          throw Error("Test WebMCP lost receipt after committed input");
        }
        return response;
      };
    });
    const uncertain = args("web-lost");
    assert.equal((await call("wait", uncertain)).isError, true);
    await page.locator("#recovery").waitFor({ state: "visible" });
    const wrong = await call("wait", args("web-wrong-retry"));
    assert.equal(wrong.isError, true);
    assert.equal(wrong.structuredContent.error.code,"uncertainExecution");
    const recovered = await call("recover",{sessionId:state.sessionId});
    assert.equal(recovered.isError, false);
    assert.equal(
      recovered.structuredContent.observation.turn,
      state.observation.turn + 1,
    );
    state = recovered.structuredContent;
    assert.deepEqual(await sharedSnapshot(), snapshotPart(state));
    assert.deepEqual((await agentSnapshot(page)).observation,state.observation,'recovered receipt includes the complete neighborhood');
    await page.locator("#recovery").waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `${root}/test-results/fullscreen-hud-mobile.png`,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= innerHeight,
      ),
      true,
    );
    await call("suspend", { sessionId: state.sessionId });
    assert.equal(await agentSnapshot(page), null);
    const resumed = await call("resume", {
      sessionId: state.sessionId,
    });
    assert.equal(resumed.isError, false);
    assert.equal(
      (await agentSnapshot(page)).observation.turn,
      state.observation.turn,
    );
    await page.evaluate(() => document.querySelector("pixel-nethack").remove());
    // Chromium 148 drops native unregister-algorithm handles during GC
    // (model_context.cc registerTool ignores AddAlgorithm's returned handle).
    // Retired callbacks must reject before touching the closed transport even
    // when that browser retains descriptors. Navigation clears the registry.
    let retired;
    try { retired = await call("help"); }
    catch (error) { retired = { removed: /Tool not found/.test(String(error)) }; }
    assert.ok(
      retired.removed ||
        (retired.isError &&
          retired.structuredContent?.error?.code === 'cancelled' &&
          /cancelled before submission/.test(retired.structuredContent.error.message)),
    );
    await page.goto("about:blank");
    assert.equal((await native.list()).length, 0);
    assert.deepEqual(errors, []);
  },
);

test('native WebMCP waits for registration while the title is already interactive', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const workers = [];
  const { page, errors } = await fixture(t, {
    webmcp: true,
    setup: async page => {
      page.on('worker', worker => workers.push(worker.url()));
      await page.route('**/runtime/typescript/wasm.js', async route => {
        await held;
        await route.continue();
      });
    },
  });
  let settled = false;
  const opening = nativeWebMcp(page, t);
  // Observe failures without swallowing them; the awaited promise below owns them.
  opening.then(() => { settled = true; }, () => { settled = true; });
  try {
    await page.waitForTimeout(100);
    assert.equal(settled, false, 'an interactive title is not a ready tool registry');
    assert.equal(await snapshot(page), null);
    assert.equal(workers.length, 0, 'waiting for discovery cannot start a game');
    release();
    const native = await opening;
    const created = await native.call("create", { name: 'Registry audit', role: 'valkyrie', seed: 9 });
    assert.equal(created.isError, false);
    assert.equal((await snapshot(page)).sessionId, created.structuredContent.sessionId);
    assert.equal((await snapshot(page)).observation.turn, 1);
    assert.deepEqual(errors, []);
  } finally {
    release();
    await opening.catch(() => {});
  }
});

test('native WebMCP waits for actual registry events after CDP enable completes', { timeout: 15000 }, async t => {
  const { page, errors } = await fixture(t, { webmcp: true });
  await page.waitForFunction(() => document.querySelector('pixel-nethack').dataset.webmcp === 'ready');
  const session = await page.context().newCDPSession(page);
  const enabled = Promise.withResolvers(), arrived = Promise.withResolvers(), held = [];
  let released = false, invokes = 0, settled = false;
  const release = () => { released = true; for (const deliver of held.splice(0)) deliver(); };
  const gated = {
    on(name, listener) {
      session.on(name, name === 'WebMCP.toolsAdded' ? event => {
        if (released) listener(event); else held.push(() => listener(event));
        arrived.resolve();
      } : listener);
    },
    off: (name, listener) => session.off(name, listener),
    detach: () => session.detach(),
    async send(name, params) {
      if (name === 'WebMCP.invokeTool') invokes++;
      try {
        const result = await session.send(name, params);
        if (name === 'WebMCP.enable') enabled.resolve(true);
        return result;
      } catch (error) {
        if (name === 'WebMCP.enable') {
          if (String(error).includes("'WebMCP.enable' wasn't found")) enabled.resolve(false);
          else enabled.reject(error);
        }
        throw error;
      }
    },
  };
  const opening = nativeWebMcp(page, t, gated);
  opening.then(() => { settled = true; }, () => { settled = true; });
  try {
    if (!await enabled.promise) { t.skip('This Chromium provides the earlier native testing interface, not CDP WebMCP.'); return; }
    await arrived.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'enable completion alone cannot make the registry ready');
    assert.equal(invokes, 0);
    assert.equal(await snapshot(page), null);
    release();
    const native = await opening;
    const created = await native.call("create", { name: 'Event audit', role: 'valkyrie', seed: 9 });
    assert.equal(invokes, 1, 'one invocation after the real native events arrive');
    assert.equal(created.isError, false);
    assert.equal((await snapshot(page)).sessionId, created.structuredContent.sessionId);
    assert.equal((await snapshot(page)).observation.turn, 1);
    assert.deepEqual(errors, []);
  } finally {
    release();
    await opening.catch(() => {});
  }
});

test('native WebMCP rejects an old confirmation after a human opens a different question', async t => {
  const { page, errors } = await fixture(t, { webmcp: true });
  const { call } = await nativeWebMcp(page, t);
  const created = await call("create", { name: 'Decision audit', role: 'valkyrie', race: 'human', gender: 'female', align: 'lawful', seed: 9 });
  const sessionId = created.structuredContent.sessionId;
  const prayer = (await call("pray", { sessionId })).structuredContent;
  assert.equal(prayer.decision.kind, 'confirmation');
  await page.getByRole('button', { name: 'No, not now', exact: true }).click();
  await ready(page);
  await page.getByLabel('Game menu', { exact: true }).click();
  await page.getByRole('button', { name: 'Abandon run', exact: true }).click();
  await ready(page);
  const quit = (await call("observe", { sessionId })).structuredContent;
  assert.notEqual(quit.decision.id, prayer.decision.id);
  const stale = await call("answer", { sessionId, decisionId: prayer.decision.id, value: true });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, 'staleDecision');
  assert.equal(stale.structuredContent.operationId, undefined);
  const unchanged = await snapshot(page);
  assert.equal(unchanged.ended, false);
  assert.equal(unchanged.revision, quit.revision);
  assert.equal(unchanged.observation.turn, quit.observation.turn);
  assert.deepEqual(unchanged.decision, quit.decision);
  assert.equal((await call("cancel", { sessionId, decisionId: quit.decision.id })).isError, false);
  assert.equal((await snapshot(page)).decision, null);
  assert.deepEqual(errors, []);
});

test(
  "title remains interactive during library downloads and acquires no store until entry",
  { timeout: 30000 },
  async (t) => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const workers = [];
    const { page, requests, errors } = await fixture(t, {
      setup: async (page) => {
        page.on("worker", (worker) => workers.push(worker.url()));
        await page.route("**/runtime/typescript/wasm.js", async (route) => {
          await held;
          await route.continue();
        });
      },
    });
    assert.equal(await snapshot(page), null);
    assert.equal(workers.length, 0);
    assert.deepEqual(
      await page.evaluate(async () => (await navigator.locks.query()).held),
      [],
    );
    const before = await page.evaluate(
      () => document.querySelector("pixel-nethack").map.intro.x,
    );
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page.evaluate(
        () => document.querySelector("pixel-nethack").map.intro.x,
      ),
      before + 8,
    );
    release();
    await page.waitForFunction(
      () => document.querySelector("pixel-nethack").warmed !== null,
    );
    await page.evaluate(async () =>
      document.querySelector("pixel-nethack").warmed,
    );
    assert.ok(
      requests.some((r) => r.url.endsWith("neonethack-engine.wasm")),
      "WASM downloaded on title",
    );
    assert.equal(workers.length, 0, "warmup must not instantiate the engine");
    assert.deepEqual(
      await page.evaluate(async () => (await navigator.locks.query()).held),
      [],
    );
    await create(page);
    assert.ok(workers.some((url) => url.endsWith("core-worker.mjs")));
    const companions = (await snapshot(page)).observation.world.filter(
      (c) => c.occupant?.kind === "ally",
    );
    assert.ok(companions.length);
    assert.ok(
      companions.every((c) => typeof c.occupant.appearance === "string"),
      "visible pet has its engine appearance without attacking",
    );
    await page.evaluate(
      ({ x, y }) => document.querySelector("pixel-nethack").inspectTile(x, y),
      companions[0],
    );
    const card = page.getByRole("dialog", { name: "Tile actions" });
    assert.equal(
      await card.locator("strong").textContent(),
      companions[0].occupant.appearance,
    );
    assert.equal(await card.locator(".tile-relation").textContent(), "Ally");
    assert.ok(
      await card.getByRole("button", { name: "Move toward ally" }).isVisible(),
    );
    await page.screenshot({ path: `${root}/test-results/companion-card.png` });
    assert.deepEqual(errors, []);
  },
);

test(
  "a waiting title tab refreshes adventure metadata after acquiring the store",
  { timeout: 30000 },
  async (t) => {
    const { page, context, url } = await fixture(t);
    const waiting = await context.newPage();
    await waiting.goto(url);
    await waiting.waitForFunction(
      () => !document.querySelector("#new-adventure").disabled,
    );
    await create(page);
    const first = (await snapshot(page)).sessionId;
    await page.close();
    await create(waiting, "wizard", 21);
    const saves = await waiting.evaluate(() =>
      document.querySelector("pixel-nethack").saves.map(save => JSON.parse(localStorage.getItem(document.querySelector("pixel-nethack").indexKey + ":" + save.id))),
    );
    assert.equal(saves.length, 2);
    assert.ok(saves.some((save) => save.id === first));
  },
);

test(
  "ground loot is free to read, pickup targets its item, and pet swapping stays quiet",
  { timeout: 30000 },
  async (t) => {
    const { page, errors } = await fixture(t);
    await create(page);
    const dropped = await page.evaluate(async () => {
      const app = document.querySelector("pixel-nethack");
      const item = app.game.observation.inventory.find(
        (item) => item.category === "food",
      );
      if (!item) throw Error("Actual starting food required");
      await app.run(() => app.game.drop({ id: item.id }));
      return {
        item: app.game.observation.here.items[0],
        revision: app.game.state.revision,
        foodCount: app.game.observation.inventory
          .filter((item) => item.category === "food")
          .reduce((sum, item) => sum + item.quantity, 0),
      };
    });
    await page
      .getByRole("complementary", { name: "On the ground", exact: true })
      .waitFor();
    assert.equal(
      (await snapshot(page)).revision,
      dropped.revision,
      "displaying loot sends no inspect action",
    );
    await page
      .getByRole("button", {
        name: "Pick up " + dropped.item.label,
        exact: true,
      })
      .click();
    await ready(page);
    assert.equal((await snapshot(page)).observation.here.items.length, 0);
    assert.equal(
      (await snapshot(page)).observation.inventory
        .filter((item) => item.category === "food")
        .reduce((sum, item) => sum + item.quantity, 0),
      dropped.foodCount + dropped.item.quantity,
      "pickup may merge stacks and issue new references",
    );
    assert.equal(await page.locator("#ground-loot").isVisible(), false);
    // A fresh seeded adventure starts beside the actual pet.
    await page.evaluate(async () => {
      const app = document.querySelector("pixel-nethack");
      await app.game.close();
      app.game = await app.api.create({
        name: "Companion",
        seed: 42,
        role: "valkyrie",
        race: "human",
        gender: "female",
        align: "lawful",
      });
      app.current = null;
      app.render();
      const n = app.game.observation.neighborhood;
      const pet = n.cells.find(
        (cell) =>
          cell.occupant?.kind === "ally" &&
          cell.movement.relation === "adjacent",
      );
      if (!pet) throw Error("Actual adjacent pet required");
      const move = pet.actions.find((offer) => offer.key === "move");
      await app.run(() => app.executeOffer(app.game, move, n.basis.revision));
    });
    const state = await snapshot(page);
    assert.ok(
      state.events.some(
        (event) =>
          event.type === "heard" && /^You swap places with /.test(event.text),
      ),
      "real pet-swap narration required",
    );
    assert.equal(
      await page
        .locator(".action-bubble")
        .filter({ hasText: /swap places/ })
        .count(),
      0,
    );
    assert.deepEqual(errors, []);
  },
);

test("early creatures stay small beside the hero and known appearances clear question marks", async (t) => {
  const { page } = await fixture(t);
  const checks = await page.evaluate(async () => {
    const app = document.querySelector("pixel-nethack");
    const host = document.createElement("div");
    host.id = "creature-study";
    host.style.cssText =
      "position:fixed;left:0;top:0;width:1024px;height:512px;z-index:30;background:#171f23";
    const canvas = document.createElement("canvas");
    host.append(canvas);
    document.body.append(host);
    const map = new app.map.constructor(canvas, () => {});
    map.zoom = 4;
    const species = [
      "newt",
      "jackal",
      "lichen",
      "goblin",
      "kobold",
      "sewer rat",
      "giant rat",
    ];
    const marks = [":", "d", "F", "o", "k", "r", "r"];
    const world = [];
    for (let x = 1; x <= 16; x++)
      for (let y = 1; y <= 4; y++)
        world.push({
          x,
          y,
          visible: true,
          terrain: { type: "floor", knowledge: "remembered" },
        });
    species.forEach((appearance, i) => {
      world.find((c) => c.x === 2 + i * 2 && c.y === 3).occupant = {
        kind: "creature",
        mark: marks[i],
        appearance,
        color: 3,
      };
    });
    const dog = world.find((c) => c.x === 8 && c.y === 1);
    dog.occupant = {
      kind: "ally",
      mark: "d",
      appearance: "little dog",
      color: 15,
    };
    // Large loot overlaps its actor but retains an exposed crown beyond the actor footprint.
    dog.objects = [{ mark: "`", color: 7 }];
    const observation = {
      location: { id: "creature-study", depthLabel: "Art" },
      you: { x: 9, y: 1 },
      world,
    };
    map.update({ ...observation, world: world.map(cell =>
      cell.y === 3 ? { ...cell, occupant: undefined } : cell)
    }, "valkyrie", "creatures:42");
    const context = canvas.getContext("2d");
    const before = context.getImageData(0, 0, canvas.width, canvas.height).data;
    map.update(observation, "valkyrie", "creatures:42");
    const after = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const sizes = species.map((name, i) => {
      const ox = (2 + i * 2 - map.origin.x) * 16;
      const oy = (3 - map.origin.y) * 16;
      const changed = [];
      for (let dy = -24; dy < 16; dy++) for (let dx = -8; dx < 24; dx++) {
        const offset = ((oy + dy) * canvas.width + ox + dx) * 4;
        if ([0, 1, 2, 3].some(channel => before[offset + channel] !== after[offset + channel]))
          changed.push([dx, dy]);
      }
      return { name, width: Math.max(...changed.map(p => p[0])) - Math.min(...changed.map(p => p[0])) + 1,
        height: Math.max(...changed.map(p => p[1])) - Math.min(...changed.map(p => p[1])) + 1 };
    });
    const pixel = (x, y, dx, dy) => [
      ...canvas
        .getContext("2d")
        .getImageData(
          (x - map.origin.x) * 16 + dx,
          (y - map.origin.y) * 16 + dy,
          1,
          1,
        ).data,
    ];
    const crownWithActor = pixel(8, 1, 8, -3);
    const known = pixel(8, 1, 12, -6);
    delete dog.occupant.appearance;
    map.draw();
    const unknown = pixel(8, 1, 12, -6);
    dog.occupant.appearance = "little dog";
    map.draw();
    map.destroy();
    return { known, unknown, crownWithActor, sizes };
  });
  for (const size of checks.sizes) {
    assert.ok(size.width > 0 && size.width <= 12, size.name + " stays within a small footprint");
    assert.ok(size.height > 0 && size.height <= 12, size.name + " stays shorter than the hero");
  }
  for (const name of ["newt", "lichen", "sewer rat"])
    assert.ok(checks.sizes.find(s => s.name === name).height <= 6, name + " is a low creature");
  assert.ok(checks.sizes.find(s => s.name === "giant rat").height > checks.sizes.find(s => s.name === "sewer rat").height);
  assert.deepEqual(
    checks.unknown,
    [241, 223, 172, 255],
    "unavailable appearance has a separate question badge",
  );
  assert.notDeepEqual(
    checks.known,
    checks.unknown,
    "appearance removes the badge",
  );
  assert.deepEqual(
    checks.crownWithActor,
    [181, 180, 160, 255],
    "ground loot is still drawn with an occupant",
  );
  await page
    .locator("#creature-study")
    .screenshot({ path: `${root}/test-results/early-creatures.png` });
});

test(
  "uniquely observed creature steps glide while uncertain changes settle directly",
  { timeout: 30000 },
  async (t) => {
    const { page } = await fixture(t);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const motion = await page.evaluate(() => {
      const app = document.querySelector("pixel-nethack");
      const canvas = document.createElement("canvas");
      const host = document.createElement("div");
      host.id = "motion-study";
      host.style.cssText =
        "position:fixed;inset:0;width:480px;height:320px;background:#171f23";
      host.append(canvas);
      document.body.append(host);
      let inspections = 0;
      const map = new app.map.constructor(canvas, () => inspections++);
      map.zoom = 2;
      const makeWorld = () => {
        const world = [];
        for (let y = 1; y <= 8; y++)
          for (let x = 1; x <= 12; x++)
            world.push({
              x,
              y,
              terrain: { type: "floor", knowledge: "remembered" },
            });
        return world;
      };
      const at = (world, x, y) =>
        world.find((cell) => cell.x === x && cell.y === y);
      const beforeWorld = makeWorld();
      at(beforeWorld, 4, 4).occupant = {
        kind: "ally",
        mark: "d",
        color: 3,
        appearance: "little dog",
      };
      // Two indistinguishable public descriptions cannot be paired safely.
      for (const x of [7, 9])
        at(beforeWorld, x, 4).occupant = {
          kind: "creature",
          mark: "r",
          color: 3,
          appearance: "sewer rat",
        };
      at(beforeWorld, 3, 7).occupant = {
        kind: "creature",
        mark: "B",
        color: 1,
        appearance: "bat",
      };
      at(beforeWorld, 10, 7).occupant = {
        kind: "creature",
        mark: "o",
        color: 2,
        appearance: "goblin",
      };
      const observation = (world) => ({
        location: { id: "motion-study", depthLabel: "Study" },
        you: { x: 6, y: 6 },
        world,
      });
      map.update(observation(beforeWorld), "valkyrie", "motion:42");

      const afterWorld = makeWorld();
      at(afterWorld, 5, 4).occupant = structuredClone(
        at(beforeWorld, 4, 4).occupant,
      );
      for (const x of [8, 10])
        at(afterWorld, x, 4).occupant = {
          kind: "creature",
          mark: "r",
          color: 3,
          appearance: "sewer rat",
        };
      // The bat disappears, this newt appears, and the goblin is too far away.
      at(afterWorld, 2, 2).occupant = {
        kind: "creature",
        mark: ":",
        color: 2,
        appearance: "newt",
      };
      at(afterWorld, 7, 7).occupant = structuredClone(
        at(beforeWorld, 10, 7).occupant,
      );
      map.update(observation(afterWorld), "valkyrie", "motion:42");
      const keys = [...map.actorMotions.keys()];
      const started = map.actorMotions.get("5,4").started;
      const petCell = at(afterWorld, 5, 4);
      const halfway = map.actorPosition(petCell, started + 70);
      map.draw(started + 70);
      const settled = map.actorPosition(petCell, started + 140);
      const remaining = map.actorMotions.size;
      map.destroy();
      return { keys, halfway, settled, remaining, inspections };
    });
    assert.deepEqual(motion.keys, ["5,4"]);
    assert.deepEqual(motion.halfway, { x: 4.75, y: 4, hop: 1 });
    assert.deepEqual(motion.settled, { x: 5, y: 4, hop: 0 });
    assert.equal(motion.remaining, 0);
    assert.equal(motion.inspections, 0, "rendering cannot issue game input");
    await page
      .locator("#motion-study")
      .screenshot({ path: `${root}/test-results/creature-motion-2x.png` });

    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await page.evaluate(() => {
      const app = document.querySelector("pixel-nethack");
      const canvas = document.createElement("canvas");
      const host = document.createElement("div");
      host.style.cssText = "width:320px;height:240px";
      host.append(canvas);
      document.body.append(host);
      const map = new app.map.constructor(canvas, () => {});
      const firstWorld = [4, 5].map((x) => ({
        x,
        y: 4,
        terrain: { type: "floor", knowledge: "remembered" },
      }));
      const frame = (world) => ({
        location: { id: "reduced-study", depthLabel: "Study" },
        you: { x: 4, y: 4 },
        world,
      });
      firstWorld[0].occupant = { kind: "ally", mark: "d", color: 3 };
      map.update(frame(firstWorld), "valkyrie", "reduced:42");
      const secondWorld = structuredClone(firstWorld);
      delete secondWorld[0].occupant;
      secondWorld[1].occupant = { kind: "ally", mark: "d", color: 3 };
      map.update(frame(secondWorld), "valkyrie", "reduced:42");
      const count = map.actorMotions.size;
      map.destroy();
      host.remove();
      return count;
    });
    assert.equal(reduced, 0);
  },
);

test(
  "confirmed injury gets a brief impact and small shake; reduced motion disables both",
  { timeout: 30000 },
  async (t) => {
    const { page } = await fixture(t);
    await create(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const evidence = await page.evaluate(async () => {
      const app = document.querySelector("pixel-nethack");
      for (
        let i = 0;
        i < 6 &&
        !app.game.observation.neighborhood.cells.some(
          (c) =>
            c.movement.relation === "adjacent" && c.terrain?.type === "wall",
        );
        i++
      ) {
        await app.run(() => app.game.move("north"));
      }
      const wall = app.game.observation.neighborhood.cells.find(
        (c) => c.movement.relation === "adjacent" && c.terrain?.type === "wall",
      );
      if (!wall) throw Error("A publicly observed adjacent wall is required");
      const direction = [
        "northwest",
        "north",
        "northeast",
        "west",
        null,
        "east",
        "southwest",
        "south",
        "southeast",
      ][(wall.dy + 1) * 3 + wall.dx + 1];
      let hurt = false;
      for (let i = 0; i < 16 && !hurt; i++) {
        const before = Number(app.game.observation.vitals.health);
        await app.run(() => app.game.kick(direction));
        hurt = Number(app.game.observation.vitals.health) < before;
      }
      return {
        hurt,
        impacts: document.querySelectorAll(".combat-impact.hurt").length,
        animations: app.map.canvas.getAnimations().length,
      };
    });
    assert.equal(
      evidence.hurt,
      true,
      "actual engine injury, not a fabricated damage event",
    );
    assert.equal(evidence.impacts, 1);
    assert.equal(evidence.animations, 1);
    await page.waitForFunction(() => !document.querySelector(".combat-impact"));
    await page.emulateMedia({ reducedMotion: "reduce" });
    const quiet = await page.evaluate(async () => {
      const app = document.querySelector("pixel-nethack");
      const before = app.game.state;
      // Exercise the presentation of the actual injured receipt under reduced motion.
      const previous = structuredClone(before);
      previous.revision--;
      previous.observation.vitals.health =
        Number(before.observation.vitals.health) + 1;
      app.map.showMessages(previous, before);
      return {
        impacts: document.querySelectorAll(".combat-impact").length,
        animations: app.map.canvas.getAnimations().length,
      };
    });
    assert.deepEqual(quiet, { impacts: 0, animations: 0 });
  },
);

test("on-map targeting cancels and answers actual kicks; recent notes expand", { timeout: 30000 }, async t => {
  const { page } = await fixture(t);
  await create(page);
  await page.getByRole("button", { name: "Search", exact: false }).first().click();
  await ready(page);
  assert.ok(await page.locator("#recent-messages p").count() > 0);
  await page.getByRole("button", { name: "Expand journal" }).click();
  assert.equal(await page.locator("#journal-preview").isVisible(), false);
  await page.locator("#close-panel").click();
  assert.equal(await page.locator("#journal-preview").isVisible(), true);
  await page.evaluate(() => document.querySelector("pixel-nethack").action("kick"));
  await page.locator("#direction-target").waitFor();
  assert.equal(await page.locator("#decision[open]").count(), 0);
  assert.equal(await page.locator("[data-target-direction]").count(), 8);
  const before = await snapshot(page);
  await page.screenshot({ path: root + "/test-results/kick-target-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: root + "/test-results/kick-target-mobile.png" });
  const bounds = await page.locator("#direction-target").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.keyboard.press("Escape");
  await ready(page);
  assert.equal((await snapshot(page)).observation.turn, before.observation.turn);
  await page.evaluate(() => document.querySelector("pixel-nethack").action("kick"));
  await page.locator("#direction-target").waitFor();
  await page.locator('[data-target-direction="north"]').focus();
  await page.keyboard.press("Enter");
  await ready(page);
  assert.equal(await page.locator("#direction-target").count(), 0);
});

test("consecutive journal repeats share counts across preview, drawer and receipt rerenders", async (t) => {
  const { page } = await fixture(t);
  await create(page);
  await page.evaluate(async () => {
    const app = document.querySelector("pixel-nethack");
    for (let i = 0; i < 4; i++) await app.run(() => app.game.search());
  });
  const preview = page.locator("#recent-messages p").filter({ hasText: "You search nearby." });
  assert.equal(await preview.count(), 1);
  assert.equal(await preview.locator(".journal-repeat").textContent(), "×4");
  await page.evaluate(async () => {
    const app = document.querySelector("pixel-nethack");
    app.render(); app.render();
    await app.run(() => app.game.refresh());
  });
  assert.equal(await preview.locator(".journal-repeat").textContent(), "×4");
  await page.getByRole("button", { name: "Expand journal" }).click();
  const entry = page.locator(".journal-entry").filter({ hasText: "You search nearby." });
  assert.equal(await entry.count(), 1);
  assert.equal(await entry.locator(".journal-repeat").getAttribute("aria-label"), "Repeated 4 times");
  await page.locator("#close-panel").click();
  await page.evaluate(async () => {
    const app = document.querySelector("pixel-nethack");
    await app.run(() => app.game.climb("down"));
    for (let i = 0; i < 2; i++) await app.run(() => app.game.search());
  });
  assert.equal(await preview.count(), 2, "intervening engine narration splits groups");
  assert.deepEqual(await preview.locator(".journal-repeat").allTextContents(), ["×4", "×2"]);
});

test("contextual stairs use the current engine offer at 70 percent on desktop and mobile", async (t) => {
  const { page } = await fixture(t, { touch: true });
  await create(page);
  const stairs = page.locator("#contextual-stairs button");
  await stairs.waitFor();
  assert.equal(await stairs.textContent(), "Leave");
  for (const size of [{ width: 1440, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    // Resizing asks for a fresh contextual offer; its previous button can be
    // detached between layout and the asynchronous offer response.
    const bounds = await (await page.waitForFunction(({width,height}) => {
      const rect = document.querySelector('#contextual-stairs button')?.getBoundingClientRect();
      return rect && rect.height >= 56 && Math.abs(rect.x+rect.width/2-width/2)<2 && Math.abs(rect.y+rect.height/2-height*.7)<2
        ? {x:rect.x,y:rect.y,width:rect.width,height:rect.height} : null;
    }, size)).jsonValue();
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - size.width / 2) < 2);
    assert.ok(Math.abs(bounds.y + bounds.height / 2 - size.height * .7) < 2);
    assert.ok(bounds.height >= 56);
    await page.screenshot({ path: `${root}/test-results/stairs-${size.width}.png` });
  }
  await page.evaluate(async () => {
    const app = document.querySelector("pixel-nethack");
    const stale = document.querySelector("#contextual-stairs button");
    await app.run(() => app.game.move("east"));
    const revision = app.game.state.revision;
    stale.click();
    if (app.game.state.revision !== revision || app.busy) throw Error("Stale stairs offer executed");
  });
  assert.equal(await stairs.count(), 0, "walking off stairs removes the offer");
  await page.evaluate(async () => {
    const app = document.querySelector("pixel-nethack");
    await app.run(() => app.game.move("west"));
  });
  await stairs.waitFor();
  await stairs.tap();
  await page.waitForFunction(() => document.querySelector("pixel-nethack").game.decision);
  assert.equal(await stairs.count(), 0, "standing decision removes the contextual action");
  assert.equal(await page.evaluate(() => document.querySelector("pixel-nethack").game.state.outcome.action), "climb");
});

test("fresh engine perception supplies floor beneath initially seen loot and companion", async (t) => {
  const { page } = await fixture(t);
  await create(page);
  const state = await snapshot(page);
  const loot = state.observation.world.find(cell => cell.x === 17 && cell.y === 7);
  const pet = state.observation.world.find(cell => cell.x === 19 && cell.y === 6);
  assert.ok(loot.objects.length > 0, "seeded object actually present");
  assert.equal(pet.occupant.kind, "ally");
  assert.equal(loot.terrain.type, "floor");
  assert.equal(pet.terrain.type, "floor");
});

test('hero names stay clear of the level label at phone and desktop widths', async t => {
  const { page } = await fixture(t, { webmcp: true });
  const { call } = await nativeWebMcp(page, t);
  for (const name of ['Browser Container', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcde']) {
    const created = await call("create", { name, role: 'valkyrie', seed: 4 });
    assert.equal(created.isError, false);
    for (const width of [320, 390, 800, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      const label = await page.locator('#hero-name').boundingBox();
      const level = await page.locator('#hero-level').boundingBox();
      assert.ok(label.x + label.width <= level.x, `hero name clears the level label at ${width}px`);
      assert.equal(await page.locator('#hero-name').textContent(), name, 'accessible name remains complete');
      if (name === 'Browser Container' && (width === 390 || width === 1440)) {
        await page.screenshot({ path: `${root}/test-results/hero-name-${width}.png` });
      }
    }
    await call("suspend", { sessionId: created.structuredContent.sessionId });
  }
});

test('counted-action journal batches stay compact on phones and preserve full journal text', async t => {
  const { page } = await fixture(t, { webmcp: true });
  const { call } = await nativeWebMcp(page, t);
  const created = await call("create", { name: 'Journal audit', role: 'valkyrie', seed: 4 });
  const sessionId = created.structuredContent.sessionId;
  const rested = await call("rest", { sessionId, turns: 800 });
  assert.equal(rested.isError, false);
  const entry = page.locator('#recent-messages .journal-inline').filter({ hasText: 'Count:' }).last();
  const text = await entry.textContent();
  assert.ok(text.includes('\n'), 'real counted action supplies a multiline event batch');
  for (const viewport of [{ width: 390, height: 844 }, { width: 740, height: 390 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    const row = entry.locator('..');
    const box = await row.boundingBox();
    const lineHeight = await row.evaluate(el => parseFloat(getComputedStyle(el).lineHeight));
    const lines = viewport.width <= 600 || viewport.height <= 500 ? 1 : 2;
    assert.ok(box.height <= lines * lineHeight + 1, 'ordinary preview batches stay bounded');
    await page.screenshot({ path: `${root}/test-results/journal-batch-${viewport.width}.png` });
    await page.getByRole('button', { name: 'Collapse recent messages', exact: true }).click();
    assert.equal(await page.locator('#recent-messages').isVisible(), false);
    const collapsed = await page.locator('#journal-preview').boundingBox();
    assert.ok(collapsed.height <= 44, 'collapsed preview contains only its controls');
    assert.equal((await snapshot(page)).revision, rested.structuredContent.revision);
    await page.getByRole('button', { name: 'Expand recent messages', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Expand journal', exact: true }).click();
  const full = page.locator('.journal-entry .journal-inline').filter({ hasText: 'Count:' }).last();
  assert.equal(await full.textContent(), text, 'full journal keeps the complete original batch');
  assert.equal(await full.evaluate(el => getComputedStyle(el).whiteSpace), 'pre-line');
});

test("mobile journal preview is on by default and collapses without consuming a turn", async t => {
  const { page } = await fixture(t, { touch: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await create(page);
  const hud=await page.locator(".hero-hud").boundingBox();
  assert.ok(hud.height<125,"routine HUD leaves room for the dungeon");
  assert.doesNotMatch(await page.locator(".hero-hud").textContent(),/not_hungry|unencumbered/);
  const toggle = page.locator("#toggle-journal-preview");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  const preview = await page.locator("#journal-preview").boundingBox();
  const worldTop = (await page.locator('.map-viewport').boundingBox()).y;
  assert.ok(preview.y >= hud.y+hud.height,"journal does not overlap the HUD");
  assert.ok(preview.y - worldTop >= 128 && preview.y - worldTop + preview.height < 300);
  const turn = (await snapshot(page)).observation.turn;
  await toggle.tap();
  assert.equal(await page.locator("#recent-messages").isVisible(), false);
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal((await snapshot(page)).observation.turn, turn);
  await page.evaluate(async () => { const app = document.querySelector("pixel-nethack"); await app.run(() => app.game.search()); });
  assert.equal(await page.locator("#recent-messages").isVisible(), false);
  await toggle.tap();
  assert.equal(await page.locator("#recent-messages").isVisible(), true);
  await page.screenshot({ path: `${root}/test-results/journal-mobile-compact.png` });
  await page.getByRole("button", { name: "Expand journal", exact: true }).tap();
  assert.equal(await page.locator(".rightbar").isVisible(), true);
});

test("additional encounters including hobbits have distinct small art and preserve unknown appearances", async (t) => {
  const { page, errors } = await fixture(t);
  const report = await page.evaluate(async () => {
    const app = document.querySelector("pixel-nethack");
    const host = document.createElement("section");
    host.id = "encounter-art-study";
    host.style.cssText = "position:absolute;left:0;top:0;width:1024px;z-index:40;padding:16px;box-sizing:border-box;background:#171f23;color:#e8d7ab;display:grid;grid-template-columns:repeat(3,1fr);gap:12px;font:16px system-ui";
    document.body.append(host);
    const canvas = document.createElement("canvas");
    const mapHost = document.createElement("div");
    mapHost.style.cssText = "position:fixed;width:800px;height:480px;left:0;top:0;visibility:hidden";
    mapHost.append(canvas); document.body.append(mapHost);
    const map = new app.map.constructor(canvas, () => {});
    map.zoom = 2;
    const world = [];
    for (let y = 0; y <= 8; y++) for (let x = 0; x <= 12; x++)
      world.push({ x, y, visible: true, terrain: { type: "floor", knowledge: "remembered" } });
    const target = world.find(c => c.x === 8 && c.y === 4);
    const observation = { location: { id: "encounter-study", depthLabel: "Study" }, you: { x: 5, y: 4 }, world };
    const encounters = [["grid bug", "x"], ["giant ant", "a"], ["killer bee", "a"], ["cave spider", "s"],
      ["gecko", ":"], ["garter snake", "S"], ["fox", "d"], ["coyote", "d"], ["floating eye", "e"],
      ["gas spore", "e"], ["acid blob", "b"], ["brown mold", "F"], ["hobbit", "h"]];
    const crop = (pixels = false) => {
      const out = document.createElement("canvas"); out.width = 24; out.height = 32;
      out.getContext("2d").drawImage(canvas, (8-map.origin.x)*16-4, (4-map.origin.y)*16-16, 24, 32, 0, 0, 24, 32);
      return pixels ? out.getContext("2d").getImageData(0, 0, 24, 32).data : out.toDataURL();
    };
    const results = [];
    for (const [appearance, mark] of encounters) {
      delete target.occupant;
      map.update(observation, "valkyrie", "encounters:42");
      const empty = crop(true);
      // Same known category/color, only the public apparent species differs.
      target.occupant = { kind: "creature", mark, appearance: "unpictured creature", color: 3 };
      map.update(observation, "valkyrie", "encounters:42");
      const fallback = crop();
      target.occupant.appearance = appearance; map.draw();
      const art = crop();
      const painted = crop(true), changed = [];
      for (let p = 0; p < painted.length; p += 4)
        if ([0, 1, 2, 3].some(channel => painted[p + channel] !== empty[p + channel]))
          changed.push([(p / 4) % 24, Math.floor(p / 4 / 24)]);
      const width = Math.max(...changed.map(p => p[0])) - Math.min(...changed.map(p => p[0])) + 1;
      const height = Math.max(...changed.map(p => p[1])) - Math.min(...changed.map(p => p[1])) + 1;
      results.push({ appearance, distinct: art !== fallback, art, width, height });
      const card = document.createElement("article");
      card.style.cssText = "border:1px solid #48534a;padding:10px;background:#25312d";
      const title = document.createElement("h3"); title.textContent = appearance; title.style.margin = "0 0 12px";
      const view = document.createElement("canvas"); view.width=80; view.height=48;
      view.style.cssText = "width:320px;height:192px;max-width:100%;image-rendering:pixelated";
      view.getContext("2d").drawImage(canvas,(5-map.origin.x)*16-8,(4-map.origin.y)*16-24,80,48,0,0,80,48);
      card.append(title,view);host.append(card);
      delete target.occupant.appearance;map.draw();
      const unknown = crop();
      target.occupant.appearance = "unpictured creature";map.draw();
      // Unknown and unpictured stay category art; only the knowledge badge differs.
      results.at(-1).unknownBadge = unknown !== crop();
    }
    map.destroy(); mapHost.remove();
    return results;
  });
  for (const result of report) {
    assert.ok(result.width > 0 && result.width <= 14, result.appearance + " fits its native footprint");
    assert.ok(result.height > 0 && result.height <= 12, result.appearance + " remains small including hover clearance");
    assert.ok(result.distinct, result.appearance + " has species art instead of its generic category");
    assert.ok(result.unknownBadge, result.appearance + " does not suppress missing-appearance feedback");
  }
  assert.equal(new Set(report.map(r => r.art)).size, 13);
  assert.deepEqual(errors, []);
  await page.locator("#encounter-art-study").screenshot({ path: `${root}/test-results/encounter-art.png` });
});

test("dungeon loading scene covers creation and previous-run resume without extra input", { timeout: 30000 }, async t => {
  const { page, errors } = await fixture(t);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  assert.equal(await page.locator("#continue-adventure").isVisible(), false);
  const delayEntry = () => page.evaluate(() => {
    const app = document.querySelector("pixel-nethack");
    const connect = app.connectRuntime.bind(app);
    app.connectRuntime = async (...args) => {
      await new Promise(resolve => { globalThis.releaseEntry = resolve; });
      return connect(...args);
    };
  });
  await delayEntry();
  await page.getByRole("button", { name: "Begin your adventure" }).click();
  const chosenName = await page.getByLabel("YOUR NAME", {exact:true}).inputValue();
  await page.getByRole("button", { name: "Enter the dungeon" }).click();
  await page.waitForFunction(() => typeof globalThis.releaseEntry === "function");
  const loading = page.locator("#dungeon-loading");
  assert.equal(await loading.isVisible(), true);
  assert.equal(await snapshot(page), null);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ArrowUp");
  assert.equal(await loading.isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${root}/test-results/dungeon-loading-mobile.png` });
  await page.evaluate(() => globalThis.releaseEntry());
  await ready(page);
  const first = await snapshot(page);
  assert.equal(first.observation.turn, 1);
  assert.equal(await loading.isVisible(), false);
  // Revisit the doorway; opening the bookmarked run URL resumes automatically.
    await page.goto(new URL("/", page.url()).href);
  await page.locator("#continue-adventure").waitFor();
  assert.equal((await page.locator("#continue-adventure").innerText()).replace(/\s+/g," "), `Continue previous run ${chosenName} · Turn 1`);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await delayEntry();
  await page.locator("#continue-adventure").click();
  await page.waitForFunction(() => typeof globalThis.releaseEntry === "function");
  assert.equal(await loading.isVisible(), true);
  assert.equal(await page.locator("#loading-title").innerText(), "Returning to the dungeon");
  assert.equal(await page.locator(".arch-near").evaluate(node => getComputedStyle(node).animationName), "none");
  await page.evaluate(() => globalThis.releaseEntry());
  await ready(page);
  assert.equal((await snapshot(page)).sessionId, first.sessionId);
  assert.equal((await snapshot(page)).observation.turn, first.observation.turn);
  assert.equal(await loading.isVisible(), false);
  assert.deepEqual(errors, []);
});

test("failed dungeon entry removes the loading scene and exposes the error", async t => {
  const { page } = await fixture(t);
  await page.evaluate(() => {
    document.querySelector("pixel-nethack").connectRuntime = async () => { throw Error("Entry fixture failure"); };
  });
  await page.getByRole("button", { name: "Begin your adventure" }).click();
  await page.getByRole("button", { name: "Enter the dungeon" }).click();
  await ready(page);
  assert.equal(await page.locator("#dungeon-loading").isVisible(), false);
  assert.match(await page.locator("#error").innerText(), /Entry fixture failure/);
  assert.equal(await snapshot(page), null);
});

test("typing and choosing a class in a menu cannot answer a standing direction", { timeout: 30000 }, async t => {
  const { page, errors } = await fixture(t);
  await create(page);
  await page.evaluate(() => document.querySelector("pixel-nethack").action("kick"));
  await page.locator("#direction-target").waitFor();
  const standing = await snapshot(page);
  await page.getByLabel("Game menu", { exact: true }).click();
  await page.getByRole("button", { name: "Your adventures", exact: true }).click();
  await page.getByRole("button", { name: "Start a new adventure", exact: true }).click();
  const name = page.getByLabel("YOUR NAME", { exact: true });
  await name.fill("");
  await name.pressSequentially("hjkl yubn");
  await page.locator("input[name=role]").first().focus();
  await page.keyboard.press("ArrowDown");
  await ready(page);
  assert.equal(await name.inputValue(), "hjkl yubn");
  assert.deepEqual(await snapshot(page), standing, "menu input must not answer or cancel the engine decision");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.locator('[data-target-direction="north"]').focus();
  await page.keyboard.press("Escape");
  await ready(page);
  assert.equal((await snapshot(page)).decision, null);
  assert.equal((await snapshot(page)).observation.turn, standing.observation.turn);
  assert.deepEqual(errors, []);
});

test("saving a standing warning returns to an unowned title and another tab resumes it", { timeout: 30000 }, async t => {
  const { page, context, url, errors } = await fixture(t);
  await create(page);
  await page.evaluate(() => document.querySelector("pixel-nethack").action("pray"));
  await page.getByRole("button", { name: "Continue to prayer", exact: true }).click();
  await page.locator("#decision[open]").waitFor();
  const standing = await snapshot(page);
  assert.equal(standing.decision.kind, "confirmation");
  await page.getByRole("button", { name: "Save & return to doorway", exact: true }).click();
  await ready(page);
  assert.equal(await snapshot(page), null);
  assert.equal(await page.evaluate(() => document.querySelector("pixel-nethack").api), null, "the title must release the store, not just the world");
  const peer = await context.newPage();
  await peer.goto(url);
  await peer.getByRole("button", { name: /^Continue previous run/ }).click();
  await peer.locator("#decision[open]").waitFor();
  await ready(peer);
  const resumed = await snapshot(peer);
  assert.equal(resumed.sessionId, standing.sessionId);
  assert.deepEqual(resumed.decision, standing.decision);
  assert.deepEqual(resumed.observation, standing.observation);
  assert.deepEqual(errors, []);
});

test("removing the client during runtime opening closes the late store owner", { timeout: 30000 }, async t => {
  const { page, context, url } = await fixture(t);
  const result = await page.evaluate(async () => {
    const app = document.querySelector("pixel-nethack");
    await app.preparation;
    const createWasm = app.runtime.wasm.createWasm;
    let acquired, release, closes = 0;
    const owned = new Promise(resolve => { acquired = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    app.runtime = { ...app.runtime, wasm: { ...app.runtime.wasm, createWasm: async options => {
      const wasm = await createWasm(options);
      const close = wasm.close.bind(wasm);
      wasm.close = async () => { closes++; await close(); };
      acquired();
      await gate;
      return wasm;
    } } };
    const opening = app.connectRuntime().then(() => "opened", error => String(error));
    await owned;
    app.remove();
    release();
    const status = await opening;
    return { status, closes, adopted: app.api !== null };
  });
  assert.match(result.status, /closed/i);
  assert.equal(result.closes, 1);
  assert.equal(result.adopted, false);
  const peer = await context.newPage();
  await peer.goto(url);
  await create(peer);
  assert.equal((await snapshot(peer)).observation.turn, 1, "another client can acquire the store");
});

test("idle WebMCP discovery and closed adventures release storage for another tab", { timeout: 60000 }, async t => {
  const { page, context, url, errors } = await fixture(t, { webmcp: true });
  await page.waitForFunction(() => document.querySelector("pixel-nethack").dataset.webmcp === "ready");
  const { call } = await nativeWebMcp(page, t);
  const owned = () => page.evaluate(async () => (await navigator.locks.query()).held.some(lock => lock.name === `neonethack:v1:${document.querySelector("pixel-nethack").storeName}`));
  assert.equal((await call("help")).isError, false);
  assert.equal(await owned(), false, "discovery must not leave a title worker owning the store");
  // Exercise the C rejection through the client transport directly: the native
  // WebMCP schema validator can reject malformed input before opening storage.
  const rejected = await page.evaluate(() => document.querySelector("pixel-nethack").webRequest({
    version: 1, method: "session.create", params: { unexpected: true },
  }));
  assert.ok(rejected.error);
  assert.equal(await owned(), false, "a rejected start must not keep an idle owner either");
  const created = await call("create", { name: "Agent", role: "valkyrie", seed: 42 });
  assert.equal(created.isError, false);
  const sid = created.structuredContent.sessionId;
  const warning = await call("pray", { sessionId: sid });
  assert.equal(warning.isError, false);
  assert.equal(warning.structuredContent.decision.kind, "confirmation");
  const fullWarning=await call('receipt',{sessionId:sid,operationId:warning.structuredContent.operationId});
  assert.equal(fullWarning.isError,false);
  assert.equal((await call("suspend", { sessionId: sid })).isError, false);
  assert.equal(await snapshot(page), null);
  assert.equal(await owned(), false, "closing an agent adventure must release its worker's store lock");
  const peer = await context.newPage();
  await peer.goto(url);
  await peer.getByRole("button", { name: /^Continue previous run/ }).click();
  await peer.locator("#decision[open]").waitFor();
  await ready(peer);
  assert.equal((await agentSnapshot(peer)).sessionId, sid);
  assert.deepEqual((await agentSnapshot(peer)).decision, warning.structuredContent.decision);
  assert.deepEqual((await agentSnapshot(peer)).observation, fullWarning.structuredContent.observation);
  assert.deepEqual(errors, []);
});

test("illustrated dogs remain sprites and focus feedback has no map rectangle", { timeout: 30000 }, async t => {
  const { page } = await fixture(t);
  await create(page);
  const dog = await page.evaluate(() => {
    const app = document.querySelector("pixel-nethack"), map = app.map;
    const c = document.querySelector("#dungeon").getContext("2d");
    const images = [], letters = [];
    const draw = c.drawImage.bind(c), text = c.fillText.bind(c);
    c.drawImage = (...args) => { images.push(args[0].src ?? ""); return draw(...args); };
    c.fillText = (...args) => { letters.push(args[0]); return text(...args); };
    const you = app.snapshot.observation.you;
    // Presentation fixture: a currently perceived canine, independent of which
    // pet a generated world chooses. No game request or saved state is changed.
    const world = app.snapshot.observation.world.filter(cell => cell.x !== you.x + 1 || cell.y !== you.y);
    world.push({ x: you.x + 1, y: you.y, visible: true, terrain: { type: "floor", knowledge: "remembered" }, occupant: { kind: "ally", mark: "d", color: 3, appearance: "little dog" } });
    map.update({ ...app.snapshot.observation, world }, "valkyrie", "dog-art");
    const result = { dogDrawn: images.some(src => src.endsWith('/art/dog.png')), letterDrawn: letters.includes('d'), symbols: map.symbols };
    c.drawImage = draw; c.fillText = text;
    return result;
  });
  assert.deepEqual(dog, { dogDrawn: true, letterDrawn: false, symbols: false });
  await page.locator("#dungeon").focus();
  assert.equal(await page.locator("#dungeon").evaluate(el => getComputedStyle(el).outlineStyle), "none");
  await page.locator(".hud-menu > summary").click();
  const mode = page.getByRole("button", { name: "Show NetHack symbols", exact: true });
  assert.equal(await mode.textContent(), "Art");
  await mode.click();
  const art = page.getByRole("button", { name: "Show illustrated map", exact: true });
  assert.equal(await art.textContent(), "Symbols");
  await art.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await art.evaluate(el => getComputedStyle(el).outlineStyle), "none");
  assert.ok(await art.evaluate(el => getComputedStyle(el).textDecorationLine.includes("underline")));
  await art.click();
  assert.equal(await page.evaluate(() => document.querySelector("pixel-nethack").map.symbols), false);
  await page.screenshot({ path: `${root}/test-results/default-heroes-and-dog.png` });
});

test("welcome explains all three paths on desktop and mobile", { timeout: 60000 }, async (t) => {
  const { page, errors } = await fixture(t);
  const paths = page.locator('#welcome-paths');
  assert.equal(await paths.locator('article').count(), 3);
  assert.match(await paths.innerText(), /JSON protocol/);
  assert.equal(await page.locator('.rail-github').getAttribute('href'), 'https://github.com/tobi/neohack');
  await page.waitForFunction(() => document.querySelector('#package-status').textContent.includes('Game downloaded'));
  const world = await page.locator('.map-viewport').boundingBox();
  const rail = await paths.boundingBox();
  assert.ok(world.x + world.width <= rail.x);
  await page.screenshot({path: `${root}/test-results/welcome-paths-desktop.png`});
  await page.setViewportSize({width:390,height:844});
  await paths.getByRole('heading', {name:'Have your Agent play'}).scrollIntoViewIfNeeded();
  assert.ok(await paths.getByRole('heading', {name:'Have your Agent play'}).isVisible());
  assert.equal(await page.evaluate(() => document.querySelector('pixel-nethack').scrollWidth <= innerWidth), true);
  await page.screenshot({path: `${root}/test-results/welcome-paths-mobile.png`});
  await page.locator('#new-adventure').scrollIntoViewIfNeeded();
  await page.setViewportSize({width:1440,height:1050});
  await create(page);
  assert.equal(await paths.isVisible(), false);
  assert.deepEqual(errors, []);
});

test('welcome renders the native example and GitHub remains available in the game menu', async t => {
  const { page, errors } = await fixture(t);
  const snippet = page.locator('.welcome-code code');
  assert.match(await snippet.innerText(), /import Nethack from 'neonethack';/);
  assert.match(await snippet.innerText(), /new Nethack\(\)/);
  assert.ok(await snippet.locator('.code-keyword').count() > 3);
  await snippet.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${root}/test-results/welcome-native-example.png` });
  await page.getByLabel('Game menu', { exact: true }).click();
  const github = page.locator('.menu-github[href="https://github.com/tobi/neohack"]');
  assert.equal(await github.isVisible(), true);
  assert.equal(await github.getAttribute('href'), 'https://github.com/tobi/neohack');
  await page.keyboard.press('Escape');
  await create(page);
  await page.getByLabel('Game menu', { exact: true }).click();
  assert.equal(await github.isVisible(), true);
  assert.equal(await page.locator('#welcome-paths').isVisible(), false);
  assert.deepEqual(errors, []);
});

test("creation keeps its submit action visible while all thirteen classes scroll", async (t) => {
  const { page } = await fixture(t);
  for (const viewport of [{ width: 762, height: 1086 }, { width: 390, height: 640 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "Begin your adventure" }).click();
    const submit = page.locator("#create-form button[type=submit]");
    const visible = async () => {
      await submit.waitFor({ state: "visible" });
      const box = await submit.boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height);
      assert.equal(await submit.evaluate(el => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), true);
    };
    await visible();
    await page.locator('input[name="role"]').last().check();
    await page.locator('.seed-details summary').click();
    await page.locator('#world-seed').fill('42');
    await visible();
    await page.locator('.create-fields').evaluate(el => { el.scrollTop = 0; });
    await visible();
    await page.screenshot({ path: resolve(root, `test-results/create-${viewport.width}.png`) });
    await page.locator('#menu .close-dialog').click();
  }
});

test("Classic directions move and s searches", async (t) => {
  const { page } = await fixture(t);
  await create(page);
  await page.evaluate(async () => {
    const { WasmTransport } = await import('/runtime/typescript/wasm.js');
    const original = WasmTransport.prototype.send;
    window.keyRequests = [];
    WasmTransport.prototype.send = function(request) {
      window.keyRequests.push(request);
      return original.call(this, request);
    };
  });
  for (const [key, direction] of [['k','north'],['h','west'],['j','south'],['l','east'],['y','northwest'],['u','northeast'],['b','southwest'],['n','southeast']]) {
    await page.keyboard.press(key);
    await ready(page);
    const requests = await page.evaluate(() => window.keyRequests.splice(0));
    assert.ok(requests.some(r => r.method === 'game.move' && r.params.direction === direction), JSON.stringify(requests));
  }
  await page.keyboard.press('s');
  await ready(page);
  assert.ok((await page.evaluate(() => window.keyRequests.splice(0))).some(r => r.method === 'game.search'));
  await page.keyboard.press('Shift+H');
  await ready(page);
  const running = await page.evaluate(() => window.keyRequests.splice(0));
  assert.equal(running.filter(r => r.method === 'game.run' && r.params.direction === 'west').length, 1);
  assert.equal(running.some(r => r.method === 'game.move'), false);
  // No legacy F search or G pickup, and browser shortcuts must not move.
  const before = (await snapshot(page)).revision;
  await page.keyboard.press('g');
  await page.keyboard.press('Control+h');
  await page.keyboard.press('Escape');
  assert.equal((await snapshot(page)).revision, before);
  await page.keyboard.press('w');
  await page.locator('#decision[open]').waitFor();
  const standing = await snapshot(page);
  await page.keyboard.press('Shift+L');
  assert.equal((await snapshot(page)).revision, standing.revision);
  assert.ok((await page.evaluate(() => window.keyRequests)).some(r => r.method === 'game.wield'));

});

test('nearby ASCII stays above the pad and abandoning requires an engine confirmation', async t => {
  const { page } = await fixture(t);
  await create(page);
  const before = await snapshot(page);
  const mini = page.locator('#nearby-ascii');
  const rows = (await mini.textContent()).split('\n');
  assert.equal(rows.length, 9);
  assert.ok(rows.every(row => row.length === 15));
  assert.equal(rows[4][7], '@');
  assert.equal(await page.locator('.action-grid [data-action="down"]').count(), 0);
  for (const viewport of [{ width: 1440, height: 1050 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.fonts.ready);
    const map = await mini.boundingBox();
    const pad = await page.locator('.direction-pad').boundingBox();
    assert.ok(map.y >= 0 && map.y + map.height <= pad.y);
    assert.ok(map.x >= 0 && map.x + map.width <= viewport.width);
    assert.equal(await mini.evaluate(el => getComputedStyle(el).fontFamily.includes('JetBrains Mono')), true);
    assert.equal(await page.evaluate(() => document.fonts.check('12px "JetBrains Mono"')), true);
    await page.screenshot({ path: resolve(root, `test-results/ascii-hud-${viewport.width}.png`) });
  }
  assert.equal((await snapshot(page)).observation.turn, before.observation.turn);
  await page.getByLabel('Game menu', { exact: true }).click();
  await page.getByRole('button', { name: 'Abandon run', exact: true }).click();
  await page.locator('#decision[open]').waitFor();
  assert.equal((await snapshot(page)).decision.kind, 'confirmation');
  assert.equal((await snapshot(page)).ended, false);
  await page.getByRole('button', { name: 'No, not now', exact: true }).click();
  await ready(page);
  assert.equal((await snapshot(page)).ended, false);
  await page.getByLabel('Game menu', { exact: true }).click();
  await page.getByRole('button', { name: 'Abandon run', exact: true }).click();
  await page.getByRole('button', { name: 'Yes, continue', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('pixel-nethack').snapshot?.ended);
  assert.equal((await snapshot(page)).end.kind, 'quit');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('pixel-nethack').snapshot?.ended);
  assert.equal((await snapshot(page)).end.kind, 'quit');
});

test('empty item actions are disabled for free and a fountain enables Drink underfoot', async t => {
  const { page } = await fixture(t);
  await create(page, 'valkyrie', 3);
  const before = await snapshot(page);
  assert.equal(before.observation.inventory.some(item => item.category === 'potion'), false);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  const drink = page.locator('#more-grid button').filter({ hasText: /^Drink/ });
  const zap = page.locator('#more-grid button').filter({ hasText: /^Zap a wand/ });
  assert.equal(await drink.isDisabled(), true);
  assert.equal(await zap.isDisabled(), true);
  assert.match(await drink.textContent(), /No eligible items/);
  assert.equal((await snapshot(page)).revision, before.revision);
  await page.locator('#menu .close-dialog').click();
  await page.keyboard.press('h');
  await ready(page);
  const current = await snapshot(page);
  assert.equal(current.observation.neighborhood.cells.find(c => !c.dx && !c.dy).terrain.type, 'fountain');
  const contextualDrink = page.locator('#contextual-stairs button').filter({ hasText: 'Drink from fountain' });
  await contextualDrink.click();
  await page.locator('#decision[open]').waitFor();
  assert.match(await page.locator('#decision-about').textContent(), /fountain/i);
  assert.equal((await snapshot(page)).observation.turn, current.observation.turn);
  await page.getByRole('button', { name: 'No, not now', exact: true }).click();
  await ready(page);
  assert.equal(await page.locator('#error').isVisible(), false);
});

test('wheel zoom and middle drag move only the camera and preserve tile picking', async t => {
  const { page } = await fixture(t);
  await create(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const before = await snapshot(page);
  await page.mouse.move(800, 400);
  const zoom = await page.evaluate(() => document.querySelector('pixel-nethack').map.zoom);
  await page.mouse.wheel(0, -180);
  await page.waitForFunction(z => document.querySelector('pixel-nethack').map.zoom > z, zoom);
  await page.waitForFunction(() => !document.querySelector('pixel-nethack').map.zoomFrame);
  const enlarged = await page.evaluate(() => document.querySelector('pixel-nethack').map.zoom);
  assert.ok(enlarged <= 4);
  await page.mouse.wheel(0, 160);
  await page.waitForFunction(z => document.querySelector('pixel-nethack').map.zoom < z, enlarged);
  await page.waitForFunction(() => !document.querySelector('pixel-nethack').map.zoomFrame);
  const origin = await page.evaluate(() => ({ ...document.querySelector('pixel-nethack').map.origin }));
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(880, 448, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  const moved = await page.evaluate(() => ({ ...document.querySelector('pixel-nethack').map.origin }));
  assert.ok(moved.x < origin.x && moved.y < origin.y);
  assert.equal(await page.locator('.tile-actions').count(), 0);
  assert.equal(await page.locator('#dungeon').evaluate(el => el.classList.contains('panning')), false);
  const point = await page.evaluate(() => {
    const app = document.querySelector('pixel-nethack'), map = app.map;
    const box = document.querySelector('#dungeon').getBoundingClientRect();
    const you = app.snapshot.observation.you;
    return { x: box.x + (you.x - map.origin.x + .5) * 16 * map.zoom, y: box.y + (you.y - map.origin.y + .5) * 16 * map.zoom, you };
  });
  await page.mouse.click(point.x, point.y);
  await page.locator('.tile-actions').waitFor();
  assert.equal(Number(await page.locator('.tile-actions').getAttribute('data-x')), point.you.x);
  assert.equal(Number(await page.locator('.tile-actions').getAttribute('data-y')), point.you.y);
  assert.equal((await snapshot(page)).revision, before.revision);
  assert.equal((await snapshot(page)).observation.turn, before.observation.turn);
  await page.screenshot({ path: resolve(root, 'test-results/camera-zoom-pan.png') });
});

test('the title gate starts lit and clicking it walks into character creation', async t => {
  const { page } = await fixture(t);
  const gate = page.getByRole('button', { name: 'Walk into the glowing gate and create an adventurer' });
  await gate.waitFor();
  assert.equal(await page.evaluate(() => {
    const canvas = document.querySelector('#dungeon');
    const x = Math.floor(canvas.width / 2), y = Math.floor(canvas.height / 2 - 128) + 60;
    return Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data).slice(0, 3).join(',');
  }), '243,221,160');
  await page.screenshot({ path: resolve(root, 'test-results/glowing-title-gate.png') });
  await gate.click();
  await page.locator('#create-form').waitFor();
  assert.equal(await page.locator('#create-form').count(), 1);
  assert.equal(await page.evaluate(() => document.querySelector('pixel-nethack').snapshot == null), true);
});

test('detection scroll map browsing supports keyboard Help, cursor, Done and durable resume', { timeout: 90_000 }, async t => {
  const {page, errors} = await fixture(t);
  await create(page,'wizard',7);
  await page.getByRole('button', {name:'More actions',exact:true}).click();
  await page.locator('#more-grid button').filter({hasText:/^Read/}).click();
  await page.locator('#decision[open]').waitFor();
  await page.locator('#decision-body button').filter({hasText:'scroll of food detection'}).click();
  await ready(page);
  const viewed = await snapshot(page);
  assert.equal(viewed.decision.kind,'position');
  await page.keyboard.press('h'); await ready(page);
  assert.equal((await snapshot(page)).decision.cursor.x,viewed.decision.cursor.x-1);
  assert.equal((await snapshot(page)).observation.turn,viewed.observation.turn);
  await page.keyboard.press('?'); await ready(page);
  const helped = await snapshot(page);
  assert.equal(helped.decision.kind,'position');
  assert.ok(helped.events.some(e=>e.type==='heard' && /cursor/.test(e.text)));
  await page.locator('#direction-target summary').click();
  assert.match(await page.locator('#direction-target details').innerText(),/cursor/);
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.decision?.kind==='position');
  await ready(page);
  assert.deepEqual((await snapshot(page)).decision,helped.decision);
  await page.locator('#direction-target').getByRole('button',{name:'Done',exact:true}).click();
  await ready(page);
  assert.equal((await snapshot(page)).decision,null);
  assert.equal((await snapshot(page)).observation.turn,viewed.observation.turn+1);
  assert.deepEqual(errors,[]);
});


test('backpack actions use current engine item IDs and show wielded equipment', async t => {
  const { page } = await fixture(t);
  await create(page);
  const before = await snapshot(page);
  const weapon = before.observation.inventory.find(item => item.usage?.includes('wielded'));
  assert.ok(weapon);
  assert.ok((await page.locator('.weapon-line').textContent()).includes(weapon.label));
  await page.getByRole('button', {name: /Backpack/}).click();
  const food = before.observation.inventory.find(item => item.actions?.includes('eat'));
  assert.ok(food);
  const rows = page.locator('.inventory-entry');
  assert.equal(await rows.count(), before.observation.inventory.length);
  for (let i = 0; i < before.observation.inventory.length; i++) {
    const item = before.observation.inventory[i];
    const row=page.locator('[data-item-id="'+item.id+'"]');
    assert.equal(await row.count(),1);
    const quick=await row.locator('[data-item-action]').evaluateAll(bs=>bs.map(b=>b.dataset.itemAction));
    assert.ok(quick.length<=2);assert.ok(quick.every(action=>item.actions.includes(action)));
    assert.equal(await row.locator('.equipment-assignment').textContent(), item.equipmentSlots.length ? item.equipmentSlots.map(slot=>({weapon:'Main hand',shield:'Shield',alternateWeapon:'Alternate weapon',quiver:'Quiver'}[slot] ?? slot)).join(' · ') : 'Carried');
  }
  const foodRow=page.locator('[data-item-id="'+food.id+'"]');
  await foodRow.locator('.item-row').click();
  assert.deepEqual(await page.locator('#item-actions [data-item-action]').evaluateAll(bs=>bs.map(b=>b.dataset.itemAction)),food.actions);
  await page.keyboard.press('Escape');
  assert.equal((await snapshot(page)).revision, before.revision);
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: root + '/test-results/character-sheet-mobile.png'});
  for (const button of await page.locator('.inventory-actions button:visible').all()) {
    assert.equal(await button.locator('svg[aria-hidden="true"]').count(), 1);
    assert.equal(await button.textContent(), '');
    assert.ok(await button.getAttribute('aria-label'));
    assert.ok(await button.getAttribute('title'));
    const box = await button.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, 'icon retains a touch-sized target');
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({path: root + '/test-results/backpack-actions-mobile.png'});
  await page.getByRole('button', {name: 'Drop ' + food.label, exact: true}).click();
  await ready(page);
  const dropped = await snapshot(page);
  assert.equal(dropped.outcome.action, 'drop');
  assert.ok(dropped.observation.here.items.some(item => item.label === food.label));
  assert.equal(dropped.observation.inventory.some(item => item.id === food.id), false);
});

test('status cues explain prayer without spending a turn or promising safety', async t => {
  const { page } = await fixture(t);
  await create(page);
  const before = await snapshot(page);
  await page.locator('[data-action="pray"]').click();
  await page.getByRole('heading', {name: 'Prayer is a plea for help.'}).waitFor();
  assert.match(await page.locator('#menu-content').textContent(), /cannot tell whether prayer is safe/);
  assert.equal((await snapshot(page)).revision, before.revision);
  await page.getByRole('button', {name: 'Not now', exact: true}).click();
  assert.deepEqual(await snapshot(page), before);
  // Presentation-only health/hunger states; item, prayer and door behavior use real engine scenarios.
  await page.evaluate(() => {
    const app = document.querySelector('pixel-nethack');
    app.game.current = structuredClone(app.game.state);
    const v = app.game.current.observation.vitals;
    v.health = 3; v.maxHealth = 20; v.hunger = 'weak';
    app.render();
  });
  assert.equal(await page.locator('.hero-hud').getAttribute('data-urgency'), 'danger');
  assert.ok(await page.locator('[data-action="eat"]').evaluate(b => b.classList.contains('action-cue')));
  assert.ok(await page.locator('[data-action="pray"]').evaluate(b => b.classList.contains('action-cue')));
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 844});
    await page.screenshot({path: root + '/test-results/approachability-' + width + '.png'});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.evaluate(() => {
    const app = document.querySelector('pixel-nethack');
    app.game.current = structuredClone(app.game.state);
    const v = app.game.current.observation.vitals;
    v.health = 20; v.maxHealth = 20; v.hunger = 'not_hungry';
    app.render();
  });
  assert.equal(await page.locator('.hero-hud').getAttribute('data-urgency'), 'normal');
  assert.equal(await page.locator('.action-cue').count(), 0);
});


test('nearby door controls execute the offered direction and refresh after opening', async t => {
  const {page} = await fixture(t);
  await create(page);
  for (const direction of ['south', 'south', 'west', 'west']) {
    await page.evaluate(async direction => {
      const app = document.querySelector('pixel-nethack');
      await app.run(() => app.game.move(direction));
    }, direction);
  }
  const open = page.locator('#contextual-stairs button').filter({hasText: 'Open door · south'});
  await open.click();
  await ready(page);
  assert.equal((await snapshot(page)).outcome.action, 'open');
  assert.equal((await snapshot(page)).decision, null);
  assert.equal(await open.count(), 0);
  await page.locator('#contextual-stairs button').filter({hasText: 'Close door · south'}).click();
  await ready(page);
  assert.equal((await snapshot(page)).outcome.action, 'close');
  assert.ok(await open.isVisible());
 });

test('opt-in sound decodes local clips, follows real steps, and never repeats receipts', {timeout:30000}, async t => {
  const {page, errors, requests} = await fixture(t);
  await create(page);
  assert.equal(requests.filter(r => r.url.endsWith('.ogg')).length, 0);
  await page.evaluate(() => {
    window.soundStarts = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) { window.soundStarts++; return start.apply(this,args); };
  });
  await page.getByLabel('Game menu',{exact:true}).click();
  await page.getByRole('button',{name:'Sound: off',exact:true}).click();
  await page.getByRole('button',{name:'Sound: on',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Sound: on',exact:true}).getAttribute('aria-pressed'),'true');
  const decoded = await page.evaluate(() => {
    const sound = document.querySelector('pixel-nethack').map.sound;
    return [...sound.buffers.values()].map(b => ({duration:b.duration, peak:Math.max(...b.getChannelData(0).slice(0,48000).map(Math.abs))}));
  });
  assert.equal(decoded.length,4);
  assert.ok(decoded.every(b => b.duration > 0.05 && b.duration < 4 && b.peak > 0.01));
  await page.getByLabel('Game menu',{exact:true}).click();
  const evidence = await page.evaluate(async () => {
    const app=document.querySelector('pixel-nethack');
    for (const direction of ['north','east','south','west']) {
      const before=app.game.state;
      await app.run(() => app.game.move(direction));
      if (window.soundStarts) {
        const after=app.game.state, count=window.soundStarts;
        app.map.showMessages(before,after);
        app.map.showMessages(before,after);
        return {count, replay:window.soundStarts, moved:after.outcome.positionChanged};
      }
    }
    throw Error('Fixture did not produce an audible confirmed step');
  });
  assert.ok(evidence.moved);
  assert.equal(evidence.count,evidence.replay);
  const hidden = await page.evaluate(async () => {
    const app=document.querySelector('pixel-nethack');
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
    document.dispatchEvent(new Event('visibilitychange'));
    const active=app.map.sound.active.size, before=window.soundStarts;
    const previous=app.game.state;
    await app.run(()=>app.game.move('south'));
    const after=app.game.state;
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    app.map.showMessages(previous,after);
    return {active,before,after:window.soundStarts};
  });
  assert.equal(hidden.active,0);
  assert.equal(hidden.before,hidden.after);
  await page.getByLabel('Game menu',{exact:true}).click();
  await page.getByRole('button',{name:'Sound: on',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Sound: off',exact:true}).getAttribute('aria-pressed'),'false');
  assert.equal(await page.evaluate(() => document.querySelector('pixel-nethack').map.sound.active.size),0);
  assert.deepEqual(errors,[]);
});

test('failed audio loading stays muted and can retry without spending a turn', async t => {
  const {page,errors} = await fixture(t);
  await create(page);
  const before=await snapshot(page);
  await page.route('**/audio/*.ogg', route=>route.fulfill({status:503,body:'Unavailable'}));
  await page.getByLabel('Game menu',{exact:true}).click();
  await page.getByRole('button',{name:'Sound: off',exact:true}).click();
  await page.getByRole('button',{name:'Sound: off',exact:true}).waitFor();
  assert.equal((await snapshot(page)).revision,before.revision);
  assert.equal(await page.evaluate(()=>document.querySelector('pixel-nethack').map.sound.enabled),false);
  await page.unroute('**/audio/*.ogg');
  await page.getByRole('button',{name:'Sound: off',exact:true}).click();
  await page.getByRole('button',{name:'Sound: on',exact:true}).waitFor();
  assert.equal((await snapshot(page)).revision,before.revision);
  assert.deepEqual(errors,[]);
});

test('live map uses all seeded environment profiles and restores them on revisit', async t => {
  const {page,errors}=await fixture(t);
  const result=await page.evaluate(()=>{
    const app=document.querySelector('pixel-nethack');
    const host=document.createElement('div');host.style.cssText='position:fixed;inset:0;width:800px;height:480px;background:#171f23';
    const canvas=document.createElement('canvas');host.append(canvas);document.body.append(host);
    const map=new app.map.constructor(canvas,()=>{});map.zoom=2;
    const world=[];
    for(let y=1;y<=9;y++)for(let x=1;x<=14;x++)world.push({x,y,visible:true,terrain:{type:y===1||y===9||x===1||x===14?'wall':'floor'}});
    world.find(c=>c.x===7&&c.y===9).terrain={type:'closedDoor',orientation:'horizontal'};
    const observation={location:{id:'public-level',depthLabel:'Study'},you:{x:6,y:5},world};
    const seen={}, proofs=[];
    for(let i=0;i<40&&Object.keys(seen).length<3;i++){
      const seed=`${i}:public-level`;
      map.update(observation,'valkyrie',seed);
      const type=canvas.dataset.environment, pixels=canvas.toDataURL();
      if(seen[type])continue;
      seen[type]=seed;
      map.update({...observation,world:[...world].reverse()},'valkyrie',seed);
      if(canvas.toDataURL()!==pixels)throw Error('order changed environment');
      map.update(observation,'valkyrie','another-level');
      map.update(observation,'valkyrie',seed);
      if(canvas.toDataURL()!==pixels)throw Error('revisit changed environment');
      if(type!=='dungeon'){
        map.layoutType='dungeon';map.draw();
        if(canvas.toDataURL()===pixels)throw Error('selected environment not used in live pixels');
      }
      proofs.push(type);
    }
    map.destroy();host.remove();return proofs.sort();
  });
  assert.deepEqual(result,['cave','dungeon','dungeon-damp']);
  assert.deepEqual(errors,[]);
});

test('automatic pickup editor stages changes, saves live and future settings, and restores actual run settings', async t => {
  const {page,errors} = await fixture(t);
  await create(page);
  const defaults = {enabled:true,itemTypes:['gold'],arrows:true,leaveCorpses:true,leaveKnownCursed:true};
  const key = 'neonethack.pixel.automatic-pickup.v1';
  assert.deepEqual((await snapshot(page)).observation.automaticPickup,defaults);
  const initialPref = await page.evaluate(key=>localStorage.getItem(key),key);
  await page.getByRole('button',{name:/^Backpack/}).click();
  await page.getByRole('button',{name:'Automatic pickup · Gold + arrows',exact:true}).click();
  const form = page.locator('#pickup-settings-form');
  await form.getByRole('checkbox',{name:'Food',exact:true}).check();
  await form.getByRole('checkbox',{name:'Also collect arrows',exact:true}).uncheck();
  await form.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),initialPref);
  assert.deepEqual((await snapshot(page)).observation.automaticPickup,defaults);
  await page.getByRole('button',{name:'Backpack',exact:false}).click();
  await page.getByRole('button',{name:'Automatic pickup · Gold + arrows',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await form.getByRole('checkbox',{name:'Food',exact:true}).check();
  await form.getByRole('button',{name:'All types',exact:true}).click();
  assert.equal(await form.getByRole('checkbox',{name:'Leave corpses',exact:true}).isChecked(),true);
  await form.getByRole('button',{name:'Reset defaults',exact:true}).click();
  assert.equal(await form.getByRole('checkbox',{name:'Food',exact:true}).isChecked(),false);
  await form.getByRole('checkbox',{name:'Food',exact:true}).check();
  await form.getByRole('checkbox',{name:'Automatic pickup',exact:true}).uncheck();
  assert.equal(await form.getByRole('checkbox',{name:'Food',exact:true}).isChecked(),true,'Off retains filters');
  await form.getByRole('checkbox',{name:'Automatic pickup',exact:true}).check();
  await form.getByLabel('Loot patterns',{exact:true}).fill('ration\nDAGGER');
  await form.getByLabel('Ignore patterns',{exact:true}).fill('corpse\ncursed');
  await form.getByRole('checkbox',{name:'Review before collecting',exact:true}).check();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const before = await snapshot(page);
  await page.screenshot({path:root+'/test-results/automatic-pickup-mobile.png'});
  await form.getByRole('button',{name:'Save settings',exact:true}).click(); await ready(page);
  const saved = {...defaults,itemTypes:['gold','food'],lootPatterns:['ration','DAGGER'],ignorePatterns:['corpse','cursed'],review:true};
  assert.deepEqual((await snapshot(page)).observation.automaticPickup,saved);
  assert.equal((await snapshot(page)).observation.turn,before.observation.turn);
  const prefs = await page.evaluate(key=>localStorage.getItem(key),key);
  assert.deepEqual(JSON.parse(prefs),{version:1,settings:saved});
  await page.evaluate(({key,defaults})=>localStorage.setItem(key,JSON.stringify({version:1,settings:{...defaults,enabled:false}})),{key,defaults});
  await page.reload(); await ready(page);
  await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.observation.automaticPickup);
  assert.deepEqual((await snapshot(page)).observation.automaticPickup,saved,'resume uses journaled settings, not browser defaults');
  await page.evaluate(({key,prefs})=>localStorage.setItem(key,prefs),{key,prefs});
  await page.evaluate(async()=>{const app=document.querySelector('pixel-nethack');await app.run(()=>app.returnToDoorway());});
  await create(page,'ranger');
  assert.deepEqual((await snapshot(page)).observation.automaticPickup,saved,'second fresh run loads remembered preferences');
  assert.deepEqual(errors,[]);
});

for (const storage of ['invalid','unavailable']) test(`automatic pickup ${storage} preferences fall back without blocking creation`, async t => {
  const {page,errors} = await fixture(t,{setup:async page=>{
    await page.addInitScript(storage=>{
      const key='neonethack.pixel.automatic-pickup.v1';
      if (storage === 'invalid') localStorage.setItem(key,JSON.stringify({version:1,settings:{enabled:true,itemTypes:[]}}));
      else {
        const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
        Storage.prototype.getItem=function(k){if(k===key)throw new DOMException('Unavailable','SecurityError');return get.call(this,k);};
        Storage.prototype.setItem=function(k,v){if(k===key)throw new DOMException('Unavailable','QuotaExceededError');return set.call(this,k,v);};
      }
    },storage);
  }});
  await create(page);
  assert.deepEqual((await snapshot(page)).observation.automaticPickup,{enabled:true,itemTypes:['gold'],arrows:true,leaveCorpses:true,leaveKnownCursed:true});
  if(storage==='unavailable') assert.match(await page.locator('#error').textContent(),/preferences could not be remembered/);
  assert.deepEqual(errors,[]);
});

test('underfoot chest opens a container dialog, shows contents and transfers chosen items across reload', async t => {
  const {page, errors} = await fixture(t);
  await create(page, 'valkyrie', 4);
  const open = page.locator('#contextual-stairs button').filter({hasText: /^Open container$/});
  for (const direction of ['north','north','east','east']) {
    await page.evaluate(async direction => {
      const app = document.querySelector('pixel-nethack');
      await app.run(() => app.game.move(direction));
    }, direction);
  }
  assert.equal(await open.count(), 0, 'a visible adjacent chest has no underfoot action');
  await page.evaluate(async () => {
    const app = document.querySelector('pixel-nethack');
    await app.run(() => app.game.move('east'));
    const stale = [...document.querySelectorAll('#contextual-stairs button')].find(b => b.textContent === 'Open container');
    if (!stale) throw Error('Missing container action');
    await app.run(() => app.game.move('west'));
    const revision = app.game.state.revision;
    stale.click();
    if (app.busy || app.game.state.revision !== revision) throw Error('Stale container offer executed');
    await app.run(() => app.game.move('east'));
  });
  const closed = await snapshot(page);
  assert.equal(closed.observation.here.items.length, 1);
  await open.click();
  await page.locator('#decision[open]').waitFor();
  assert.equal(await open.count(), 0);
  await page.getByRole('button', {name:'Look inside', exact:true}).click();
  await ready(page);
  assert.match(await page.getByLabel('Container details').textContent(), /purple-red potion/);
  assert.equal((await snapshot(page)).observation.here.items.length, 1, 'contents are not floor loot');
  await page.screenshot({path: root + '/test-results/chest-inspect.png'});
  const taking = await snapshot(page);
  assert.equal(taking.decision.containerPhase, 'transfer');
  // Stress the presentation with a long list; cloned rows never submit input.
  await page.evaluate(()=>{const list=document.querySelector('.container-items');for(let i=0;i<40;i++){const row=list.querySelector('label').cloneNode(true);row.dataset.layoutProbe='';list.append(row);}});
  for(const viewport of [{width:1100,height:650},{width:390,height:640},{width:740,height:390}]) {
    await page.setViewportSize(viewport);
    const layout=await page.evaluate(()=>{
      const dialog=document.querySelector('#decision'),button=document.querySelector('.transfer-actions .primary');
      const rect=button.getBoundingClientRect(),list=document.querySelector('.container-items');
      list.scrollTop=list.scrollHeight;
      return {outerOverflow:dialog.scrollHeight-dialog.clientHeight,top:rect.top,bottom:rect.bottom,height:innerHeight,innerScroll:list.scrollTop};
    });
    assert.ok(layout.outerOverflow<=1,JSON.stringify(layout));
    assert.ok(layout.top>=0&&layout.bottom<=layout.height,JSON.stringify(layout));
    assert.ok(layout.innerScroll>0,'long list scrolls without moving the dialog');
  }
  await page.evaluate(()=>document.querySelectorAll('[data-layout-probe]').forEach(row=>row.remove()));
  await page.setViewportSize({width:1440,height:1050});

  assert.equal(await page.getByRole('button', {name:'Apply transfers', exact:true}).isDisabled(), true);
  await page.reload();
  await page.locator('#decision[open]').waitFor();
  await ready(page);
  assert.deepEqual((await snapshot(page)).decision, taking.decision);
  assert.equal(await page.locator('.container-notes').count(), 0, 'resume narration is not container contents');
  await page.setViewportSize({width:390, height:844});
  await page.screenshot({path: root + '/test-results/chest-contents-mobile.png'});
  const beforeDraft = await snapshot(page);
  await page.getByRole('button', {name:'Take everything', exact:true}).click();
  await page.getByRole('group', {name:'Your backpack', exact:true}).getByLabel(/food ration/).check();
  assert.deepEqual(await snapshot(page), beforeDraft, 'drafting both directions sends no engine input');
  await page.getByRole('button', {name:'Clear selection', exact:true}).click();
  assert.equal(await page.getByRole('button', {name:'Apply transfers', exact:true}).isDisabled(), true);
  await page.getByRole('button', {name:'Take everything', exact:true}).click();
  await page.getByRole('group', {name:'Your backpack', exact:true}).getByLabel(/food ration/).check();
  await page.getByRole('button', {name:'Apply transfers', exact:true}).click();
  await ready(page);
  const taken = await snapshot(page);
  assert.equal(taken.decision, null);
  const potion = taken.observation.inventory.find(i => i.label === 'a purple-red potion');
  assert.ok(potion);
  assert.equal(taken.observation.inventory.some(i=>/food ration/.test(i.label)), false);
  assert.equal(taken.observation.here.items[0].id, closed.observation.here.items[0].id);
  await open.click();
  await ready(page);
  assert.equal((await snapshot(page)).decision.containerPhase, 'transfer');
  assert.equal(await page.getByRole('button', {name:'Look inside', exact:true}).count(), 0);
  await page.getByLabel(potion.label, {exact:true}).check();
  await page.getByRole('button', {name:'Apply transfers', exact:true}).click();
  await ready(page);
  assert.equal((await snapshot(page)).observation.inventory.some(i => i.id === potion.id), false);
  assert.equal((await snapshot(page)).observation.here.items.length, 1);
  assert.deepEqual(errors, []);
});


test("opening story is a complete, free, reopenable journal scroll", async t => {
  const {page, errors} = await fixture(t);
  await page.setViewportSize({width:390,height:844});
  await create(page, "barbarian", 42, true);
  const before = await snapshot(page);
  const heard = before.events.filter(e => e.type === "heard").map(e => e.text);
  assert.ok(heard.some(line => line.includes("Amulet")), "real engine opening story");
  assert.equal(await page.locator("#journal-scroll").isVisible(), true);
  const text = await page.locator("#scroll-text").textContent();
  assert.equal(text, before.events.find(e=>e.type==="passage" && e.text.includes("Amulet")).text, "complete engine text window including paragraph breaks");
  assert.ok(text.includes("from birth"));
  const footer = await page.locator("#finish-scroll").boundingBox();
  assert.ok(footer.y + footer.height <= 844, "reading controls stay visible on mobile");
  await page.keyboard.press("ArrowRight");
  assert.equal((await snapshot(page)).revision, before.revision);
  await page.screenshot({path:root+"/test-results/journal-scroll-mobile.png"});
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#journal-scroll").isVisible(), false);
  await page.evaluate(() => { const app=document.querySelector("pixel-nethack"); app.render(); app.render(); });
  assert.equal(await page.locator("#journal-scroll").isVisible(), false);
  await page.getByRole("button", {name:"Read journal scroll · turn 1", exact:true}).click();
  assert.equal(await page.locator("#scroll-text").textContent(), text);
  await page.getByRole("button", {name:"Return to the adventure",exact:true}).click();
  await page.getByRole("button",{name:"Expand journal",exact:true}).click();
  await page.locator(".journal-entry .journal-scroll-link").click();
  assert.equal(await page.locator("#scroll-text").textContent(), text);
  await page.getByRole("button",{name:"Close scroll",exact:true}).click();
  assert.equal((await snapshot(page)).revision,before.revision);
  assert.equal((await snapshot(page)).observation.turn,before.observation.turn);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("pixel-nethack").snapshot?.sessionId);
  await ready(page);
  assert.equal(await page.locator("#journal-scroll").isVisible(),false,"resume does not reopen the story");
  assert.deepEqual(errors,[]);
});

test('potion nickname dialog explains witnessed effects and generates only an editable suggestion', async t => {
  const {page,errors}=await fixture(t);
  await create(page,'valkyrie',34);
  await page.evaluate(async()=>{
    const app=document.querySelector('pixel-nethack');
    for(const direction of ['east','east','south'])await app.run(()=>app.game.move(direction));
    await app.run(()=>app.game.pickup({id:app.game.observation.here.items.find(i=>i.category==='potion').id}));
    await app.run(()=>app.game.drink({id:app.game.observation.inventory.find(i=>i.category==='potion').id}));
  });
  const pending=await snapshot(page);
  assert.equal(pending.decision.purpose,'consumedPotionNickname');
  assert.equal(await page.locator('#decision-title').textContent(),'Give this potion a nickname');
  assert.match(await page.locator('#decision-about').textContent(),/aren’t sure/);
  assert.match(await page.locator('.potion-narration').textContent(),/You drank the potion.*liquid fire/s);
  assert.equal(await page.getByLabel('Nickname',{exact:true}).inputValue(),'Ooph! This tastes like liquid fire!');
  assert.equal(await page.getByRole('button',{name:'Cancel action',exact:true}).count(),0);
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Generate nickname',exact:true}).click();
  assert.match(await page.getByLabel('Nickname',{exact:true}).inputValue(),/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  assert.deepEqual(await snapshot(page),pending,'generation sends no engine request');
  await page.screenshot({path:root+'/test-results/potion-nickname-mobile.png'});
  await page.getByLabel('Nickname',{exact:true}).fill('My strange drink');
  await page.getByRole('button',{name:'Use nickname',exact:true}).click(); await ready(page);
  assert.equal((await snapshot(page)).decision,null);
  assert.equal(await page.locator('#decision').isVisible(),false);
  assert.deepEqual(errors,[]);
});

test('character sheet follows actual equipment changes and distinguishes unknown assignments', async t=>{
  const {page}=await fixture(t);await create(page);
  const initial=await snapshot(page);
  const shield=initial.observation.inventory.find(i=>i.equipmentSlots?.includes('shield'));
  assert.ok(shield);
  await page.getByRole('button',{name:/Backpack/}).click();
  await page.screenshot({path:root+'/test-results/character-sheet-desktop.png'});
  assert.ok(await page.locator('#sheet-equipment').getByText(shield.label,{exact:true}).count());
  await page.getByRole('button',{name:'Remove '+shield.label,exact:true}).click();await ready(page);
  const after=await snapshot(page);
  assert.equal(after.decision,null);
  assert.deepEqual(after.observation.inventory.find(i=>i.id===shield.id).equipmentSlots,[]);
  assert.equal(await page.locator('#sheet-equipment [data-item-id="'+shield.id+'"]').count(),0);
  assert.equal(await page.locator('#sheet-bag [data-item-id="'+shield.id+'"]').count(),1);
  await page.locator('#sheet-bag [data-item-id="'+shield.id+'"] .item-row').click();
  await page.getByRole('button',{name:'Throw '+after.observation.inventory.find(i=>i.id===shield.id).label,exact:true}).click();await ready(page);
  assert.equal((await snapshot(page)).decision.kind,'target');
  assert.equal((await snapshot(page)).observation.turn,after.observation.turn);
  await page.keyboard.press('Escape');await ready(page);
  assert.ok((await snapshot(page)).observation.inventory.some(i=>i.id===shield.id));
  await page.getByRole('button',{name:/Backpack/}).click();
  // Render a deliberately incomplete perception; never infer assignments from labels.
  await page.evaluate(()=>{
    const app=document.querySelector('pixel-nethack');
    const frame=structuredClone(app.game.state);
    frame.observation.perception.equipment='unknown';
    for(const item of frame.observation.inventory){delete item.equipmentSlots;item.label+=' (being worn)';}
    app.game.current=frame;app.renderPanel();
  });
  assert.match(await page.locator('.character-sheet').textContent(),/not fully known/);
  assert.equal(await page.getByText(/unoccupied slots/).count(),0);
  assert.equal(await page.locator('#sheet-equipment .inventory-entry').count(),0);
  assert.equal(await page.locator('#sheet-bag .equipment-assignment').evaluateAll(es=>es.every(e=>e.textContent==='Assignment unknown')),true);
  await page.evaluate(()=>{
    const app=document.querySelector('pixel-nethack');const frame=structuredClone(app.game.state);
    frame.observation.perception.equipment='lastKnown';
    frame.observation.inventory[0].equipmentSlots=['leftRing','rightRing'];
    frame.observation.inventory[1].equipmentSlots=['cloak','bodyArmor','shirt'];
    app.game.current=frame;app.renderPanel();
  });
  assert.match(await page.locator('.character-sheet').textContent(),/Last known equipment/);
  assert.equal(await page.locator('#sheet-equipment .slot-item').count(),5);
  assert.ok(await page.getByText('Left ring · Right ring',{exact:true}).count());
  assert.ok(await page.getByText('Cloak · Body armor · Underlayer',{exact:true}).count());
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.getByText('Last known equipment. These assignments may have changed.',{exact:true}).isVisible(),true,'the backpack tab also explains stale assignments');
  await page.evaluate(()=>{
    const app=document.querySelector('pixel-nethack');const frame=structuredClone(app.game.state);
    frame.observation.inventory=[];frame.observation.perception.inventory='lastKnown';
    frame.observation.perception.equipment='current';app.game.current=frame;app.render();
  });
  assert.match(await page.locator('.weapon-line').textContent(),/Equipment unknown/);
  assert.equal(await page.getByText('Your backpack is empty.',{exact:true}).count(),0);
});

test('journal scrolls require four non-empty source lines, not trailing blanks or visual wrapping', async t=>{
  const {page}=await fixture(t);await create(page);
  const before=await snapshot(page);
  const entries=[
    'The bolt of lightning hits you!\n',
    'You swap places with your kitten.\n\n\n\n',
    'One\nTwo\nThree',
    'A very long single line '.repeat(30),
    'One\n\nTwo\nThree\nFour\n',
  ];
  await page.evaluate(entries=>{
    const app=document.querySelector('pixel-nethack');
    app.journal=entries.map((text,i)=>({text,turn:i+1,lastTurn:i+1,count:1,passage:i===4}));
    app.panel='journal';app.renderPanel();app.showPanel();
  },entries);
  const rows=page.locator('.journal-entry');
  assert.equal(await rows.count(),5);
  assert.equal(await rows.locator('.journal-scroll-link').count(),1);
  const scroll=page.getByRole('button',{name:'Read journal scroll · turn 5',exact:true});
  await scroll.click();
  assert.equal(await page.locator('#scroll-text').textContent(),entries[4]);
  await page.getByRole('button',{name:'Close scroll',exact:true}).click();
  assert.match(await rows.nth(4).textContent(),/The bolt of lightning hits you!/);
  assert.equal((await snapshot(page)).revision,before.revision);
});

test('new adventures suggest rerollable names and retain the chosen name across resume', async t=>{
  const {page}=await fixture(t);
  await page.getByRole('button',{name:'Begin your adventure'}).click();
  const input=page.getByLabel('YOUR NAME',{exact:true});
  const first=await input.inputValue();
  assert.match(first,/^[A-Z][a-z]+ [A-Z][a-z]+$/);assert.ok(first.length<=24);
  await page.getByRole('button',{name:'Generate another adventurer name',exact:true}).click();
  const chosen=await input.inputValue();assert.notEqual(chosen,first);
  await page.getByRole('button',{name:'Enter the dungeon →'}).click();
  await page.waitForFunction(()=>!!document.querySelector('pixel-nethack').snapshot);await ready(page);
  assert.equal(await page.locator('#hero-name').textContent(),chosen);
  if(await page.locator('#journal-scroll').isVisible())await page.getByRole('button',{name:'Close scroll',exact:true}).click();
  await page.reload();await page.waitForFunction(()=>!!document.querySelector('pixel-nethack').snapshot);await ready(page);
  assert.equal(await page.locator('#hero-name').textContent(),chosen);
});

test('a suspended cloud store does not block a fresh local adventure or erase its local resume', async t=>{
  const {page}=await fixture(t);let journalReads=0;
  await page.route('**/api/health',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Storage unavailable"}'}));
  page.on('request',request=>{if(/\/api\/vaults\/[^/]+$/.test(new URL(request.url()).pathname))journalReads++;});
  await create(page);
  const first=await snapshot(page);assert.ok(first.sessionId);
  assert.match(await page.locator('#cloud-status').textContent(),/Saved here/);
  assert.equal(journalReads,0);
  await page.reload();await page.waitForFunction(()=>!!document.querySelector('pixel-nethack').snapshot);await ready(page);
  assert.equal((await snapshot(page)).sessionId,first.sessionId);
  assert.equal((await snapshot(page)).revision,first.revision);
});

test('equipment drag uses a real candidate and leaves rejected items untouched',async t=>{
 const {page}=await fixture(t);await create(page);await page.getByRole('button',{name:/Backpack/}).click();
 assert.equal(await page.locator('#accessible-map').isVisible(),false);
 assert.match(await page.locator('.sheet-depth').textContent(),/^lvl: /);
 const initial=await snapshot(page);const shield=initial.observation.inventory.find(i=>i.equipmentSlots?.includes('shield'));
 await page.getByRole('button',{name:'Remove '+shield.label,exact:true}).click();await ready(page);
 const before=await snapshot(page);
 const food=before.observation.inventory.find(i=>i.category==='food');
 await page.locator('[data-item-id="'+food.id+'"] .item-row').dragTo(page.locator('[data-slot=helmet]'));
 assert.equal((await snapshot(page)).revision,before.revision);
 assert.equal(await page.locator('[data-slot=helmet]').getAttribute('class'),'equipment-slot');
 await page.locator('[data-item-id="'+shield.id+'"] .item-row').dragTo(page.locator('[data-slot=shield]'));await ready(page);
 const equipped=await snapshot(page);assert.ok(equipped.observation.inventory.find(i=>i.id===shield.id).equipmentSlots.includes('shield'));
 assert.ok(equipped.observation.turn>before.observation.turn);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('#sheet-equipment').isVisible(),true);assert.equal(await page.locator('#sheet-bag').isVisible(),true);
 await page.screenshot({path:root+'/test-results/equipment-drag-mobile.png'});
});

test('equipment guidance stays above automatic pickup across phone panel heights', async t => {
  const { page } = await fixture(t, { touch: true });
  await create(page);
  await page.getByRole('button', { name: /Backpack/ }).click();
  for (const height of [667, 741, 844, 932]) {
    await page.setViewportSize({ width: 390, height });
    const hint = await page.locator('.sheet-equip-feedback').boundingBox();
    const pickup = await page.locator('.pickup-shortcut').boundingBox();
    assert.ok(hint.y + hint.height <= pickup.y,
      `equipment guidance must not overlap automatic pickup at 390x${height}`);
    for (const tile of await page.locator('.equipment-slot').all()) {
      const box = await tile.boundingBox();
      assert.ok(box.height >= 44, 'equipment targets retain touch height');
      assert.ok(box.y + box.height <= hint.y, 'guidance stays below equipment');
    }
  }
});

test('free WebMCP observation preserves live touch equipment intent; input invalidates it', async t => {
  const { page } = await fixture(t, { touch: true, webmcp: true, setup: page => page.addInitScript(() => {
    globalThis.equipmentRequests = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...args) {
      if (message?.request) globalThis.equipmentRequests.push(message.request.method);
      return Reflect.apply(post, this, [message, ...args]);
    };
  }) });
  await page.setViewportSize({ width: 390, height: 667 });
  await create(page);
  await page.waitForFunction(() => document.querySelector('pixel-nethack').dataset.webmcp === 'ready');
  const { call } = await nativeWebMcp(page, t);
  await page.getByRole('button', { name: /^Backpack/ }).tap();
  let frame = await snapshot(page);
  const shieldId = frame.observation.inventory.find(item => item.equipmentSlots?.includes('shield')).id;
  const shield = frame.observation.inventory.find(item => item.id === shieldId);
  await page.getByRole('button', { name: 'Remove ' + shield.label, exact: true }).tap();
  await ready(page);
  frame = await snapshot(page);
  const unequipped = frame.observation.inventory.find(item => item.id === shieldId);
  const choose = page.getByRole('button', { name: 'Choose equipment slot for ' + unequipped.label, exact: true });
  await choose.tap();
  const selected = await choose.elementHandle();
  assert.equal(await choose.getAttribute('aria-pressed'), 'true');
  const dispatchStart = await page.evaluate(() => globalThis.equipmentRequests.length);
  const observed = await call("observe", { sessionId: frame.sessionId });
  assert.equal(observed.isError, false);
  const actions = await call("inspect", { sessionId: frame.sessionId, target: 'here' });
  assert.equal(actions.isError, false);
  const dispatched = await page.evaluate(start => globalThis.equipmentRequests.slice(start), dispatchStart);
  assert.deepEqual(dispatched, ['session.observe', 'session.actions']);
  assert.equal((await snapshot(page)).observation.turn, frame.observation.turn);
  assert.equal(observed.structuredContent.revision, frame.revision);
  assert.equal(await page.locator('.rightbar').isVisible(), true);
  assert.equal(await selected.evaluate(el => el.isConnected && document.activeElement === el), true,
    'the same focused selection control survives a free query');
  assert.equal(await choose.getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Equip selected item · Shield', exact: true }).tap();
  await ready(page);
  frame = await snapshot(page);
  assert.deepEqual(frame.observation.inventory.find(item => item.id === shieldId).equipmentSlots, ['shield'],
    'preserved callbacks still act on the live Game');
  await call("observe", { sessionId: frame.sessionId }); // Refresh agent revision after human equipment input.
  const dagger = frame.observation.inventory.find(item => item.equipmentSlots?.includes('alternateWeapon'));
  await page.getByRole('button', { name: 'Choose equipment slot for ' + dagger.label, exact: true }).tap();
  const oldSlot = await page.locator('[data-slot=weapon]').boundingBox();
  const quit = await call("quit", { sessionId: frame.sessionId });
  assert.equal(quit.isError, false);
  assert.ok(quit.structuredContent.decision);
  await page.touchscreen.tap(oldSlot.x + oldSlot.width / 2, oldSlot.y + oldSlot.height / 2);
  assert.equal((await snapshot(page)).revision, quit.structuredContent.revision);
  assert.deepEqual((await snapshot(page)).decision, quit.structuredContent.decision,
    'an old equipment touch cannot answer the standing question');
  await page.getByRole('button', { name: 'Cancel action', exact: true }).tap();
  await ready(page);
  await call("observe", { sessionId: frame.sessionId });
  await page.getByRole('button', { name: /^Backpack/ }).tap();
  await page.getByRole('button', { name: 'Choose equipment slot for ' + dagger.label, exact: true }).tap();
  const dropped = await call("drop", { sessionId: frame.sessionId, itemId: dagger.id });
  assert.equal(dropped.isError, false);
  assert.ok(dropped.structuredContent.revision > frame.revision);
  await page.getByRole('button', { name: /^Backpack/ }).tap();
  assert.equal(await page.locator('.selected-item').count(), 0);
  await page.touchscreen.tap(oldSlot.x + oldSlot.width / 2, oldSlot.y + oldSlot.height / 2);
  const after = await snapshot(page);
  assert.equal(after.revision, dropped.structuredContent.revision, 'old target touch cannot submit a new intent');
  assert.ok(!after.observation.inventory.some(item => item.id === dagger.id));
  if (await page.locator('#menu[open]').count())
    await page.getByRole('button', { name: 'Close dialog', exact: true }).tap();
  for (const tile of await page.locator('.equipment-slot').all()) {
    const box = await tile.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 667 && box.height >= 44);
  }
  await page.screenshot({ path: root + '/test-results/equipment-observe-phone.png' });
});

test('compact equipment targets remain visible while the bag scrolls; touch selection is free',async t=>{
 const {page}=await fixture(t,{touch:true});await page.setViewportSize({width:390,height:667});await create(page);await page.getByRole('button',{name:/Backpack/}).click();
 let frame=await snapshot(page),shield=frame.observation.inventory.find(i=>i.equipmentSlots?.includes('shield'));
 await page.getByRole('button',{name:'Remove '+shield.label,exact:true}).click();await ready(page);frame=await snapshot(page);shield=frame.observation.inventory.find(i=>i.id===shield.id);
 const before=await page.locator('.equipment-board').boundingBox();
 await page.locator('#sheet-bag').evaluate(el=>{el.scrollTop=el.scrollHeight;});
 const after=await page.locator('.equipment-board').boundingBox();assert.deepEqual(after,before,'scrolling the bag never moves equipment');
 for(const tile of await page.locator('.equipment-slot').all()){const b=await tile.boundingBox();assert.ok(b.y>=0&&b.y+b.height<=667,'all equipment targets fit the short phone viewport');}
 const selection=page.getByRole('button',{name:'Choose equipment slot for '+shield.label,exact:true});await selection.click();
 assert.equal((await snapshot(page)).revision,frame.revision,'selecting equipment has no engine input');
 assert.equal(await page.locator('[data-slot=helmet]').getAttribute('class'),'equipment-slot');
 await page.getByRole('button',{name:'Equip selected item · Shield',exact:true}).click();await ready(page);
 assert.deepEqual((await snapshot(page)).observation.inventory.find(i=>i.id===shield.id).equipmentSlots,['shield']);
 await page.screenshot({path:root+'/test-results/equipment-compact-phone.png'});
 await page.setViewportSize({width:1280,height:720});
 const panel=await page.locator('.character-panel').boundingBox();assert.ok(panel.height<=720);assert.ok(panel.width<=820);
 await page.screenshot({path:root+'/test-results/equipment-compact-desktop.png'});
});

for(const touch of [false,true])test(`destination selection previews a free C route and walks through the shared navigator (${touch?'mobile':'desktop'})`,async t=>{
  const {page,errors}=await fixture(t,{touch});if(touch)await page.setViewportSize({width:390,height:844});await create(page,'valkyrie',1);await ready(page);
  const selected=await page.evaluate(async()=>{
    const app=document.querySelector('pixel-nethack'),game=app.game;
    for(const cell of game.observation.world){
      const route=await game.route({x:cell.x,y:cell.y});
      if(route.distance>=2&&route.distance<=4){
        const before=game.state.revision;
        const bounds=app.map.canvas.getBoundingClientRect(),shift=app.map.travel(performance.now());
        return {seen:game.observation.world.filter(c=>c.occupant?.kind==="creature"),to:{x:cell.x,y:cell.y},before,distance:route.distance,x:bounds.left+((cell.x-app.map.origin.x)*16+8+shift.x)*app.map.zoom,y:bounds.top+((cell.y-app.map.origin.y)*16+8+shift.y)*app.map.zoom};
      }
    }
    throw Error('seed must offer a real multi-step walking route');
  });
  if(touch)await page.touchscreen.tap(selected.x,selected.y);else await page.mouse.click(selected.x,selected.y);
  const walk=page.getByRole('button',{name:'Walk here',exact:true});await walk.waitFor();
  await page.waitForFunction(()=>document.querySelector('pixel-nethack').map.route.length>=2);
  assert.equal((await snapshot(page)).revision,selected.before,'preview is a free query');
  await page.screenshot({path:`/tmp/neo33-route-preview-${touch?'mobile':'desktop'}.png`});
  if(touch)await page.evaluate(()=>{
    const app=document.querySelector('pixel-nethack'),original=app.game.route.bind(app.game);
    app.game.route=async(...args)=>{
      app.game.route=original;
      const result=await original(...args);
      await new Promise(resolve=>{app.releaseNavigationQuery=resolve;});return result;
    };
  });
  await walk.click();
  if(touch){
    await page.waitForFunction(()=>!!document.querySelector('pixel-nethack').releaseNavigationQuery);
    await page.getByRole('button',{name:'Stop walking',exact:true}).click();
    await page.evaluate(()=>document.querySelector('pixel-nethack').releaseNavigationQuery());
    await ready(page);
    assert.equal((await snapshot(page)).revision,selected.before,'Stop walking during route query sends no move');
    assert.match(await page.locator('#navigation-status').textContent(),/aborted/);
    assert.deepEqual(errors,[]);return;
  }
  await ready(page);
  const after=await snapshot(page);
  t.diagnostic(JSON.stringify(await page.evaluate(()=>({error:document.querySelector("#error").textContent,notice:document.querySelector("#inspect-text").textContent}))));
  if(after.observation.you.x!==selected.to.x || after.observation.you.y!==selected.to.y){
    assert.ok(after.observation.world.some(c=>c.occupant?.kind==='creature'&&!selected.seen.some(p=>p.x===c.x&&p.y===c.y&&p.occupant?.appearance===c.occupant.appearance)),'newly perceived creature stops the leg');
    assert.match(await page.locator('#inspect-text').textContent(),/Walking stopped: changed/);
    assert.ok(after.observation.turn<selected.distance+1,'changed scene stops before completing the requested route');
  }
  assert.ok(after.observation.turn>1);
  assert.equal(await page.evaluate(()=>document.querySelector('pixel-nethack').map.route.length),0);
  assert.deepEqual(errors,[]);
});

test('encyclopedia displays pinned lore without changing the adventure on desktop and phone', async t => {
  const {page, errors} = await fixture(t);
  await create(page);
  const before = await snapshot(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height:844});
    await page.getByLabel('Game menu', {exact:true}).click();
    await page.getByRole('button', {name:'Encyclopedia', exact:true}).click();
    const input=page.getByRole('textbox', {name:'Look up a name'});
    await input.fill('floating eye');
    await page.getByRole('button', {name:'Look up', exact:true}).click();
    await page.locator('.lore-entry:not([hidden])').waitFor();
    assert.ok((await page.locator('.lore-copy').innerText()).length>100);
    assert.deepEqual(await snapshot(page),before,'reading never changes the scene or standing decision');
    const box=await page.locator('.lore-search').boundingBox();
    assert.ok(box.x>=0&&box.x+box.width<=width,'search fits the viewport');
    const searchButton=await page.locator('.lore-search button').boundingBox();
    assert.ok(searchButton.height>=44&&searchButton.height<=48,'search remains compact with a full touch target');
    await input.fill('no-such-entry-in-this-book');
    await page.getByRole('button', {name:'Look up', exact:true}).click();
    await page.getByText('No entry for “no-such-entry-in-this-book”. Try another name.').waitFor();
    assert.deepEqual(await snapshot(page),before);
    await page.getByRole('button', {name:'Close dialog', exact:true}).click();
  }
  assert.deepEqual(errors,[]);
});

test('double-clicking a known square starts one bounded walking leg',async t=>{
  const {page,errors}=await fixture(t);await create(page);
  const target=await page.evaluate(async()=>{
    const app=document.querySelector('pixel-nethack'),game=app.game;
    for(const cell of game.observation.world){
      const route=await game.route({x:cell.x,y:cell.y});
      if(route.distance>=2&&route.distance<=4){
        const bounds=app.map.canvas.getBoundingClientRect(),shift=app.map.travel(performance.now());
        const original=game.go.bind(game);app.walkCalls=0;
        game.go=(...args)=>{app.walkCalls++;return original(...args);};
        return {revision:game.state.revision,x:bounds.left+((cell.x-app.map.origin.x)*16+8+shift.x)*app.map.zoom,y:bounds.top+((cell.y-app.map.origin.y)*16+8+shift.y)*app.map.zoom};
      }
    }
    throw Error('No known walking target');
  });
  await page.mouse.dblclick(target.x,target.y);
  await page.waitForFunction(()=>document.querySelector('pixel-nethack').walkCalls===1);
  await ready(page);
  assert.ok((await snapshot(page)).revision>target.revision);
  assert.equal(await page.evaluate(()=>document.querySelector('pixel-nethack').walkCalls),1);
  assert.deepEqual(errors,[]);
});

test('different tabs play independent runs offline and retain both metadata records', {timeout:60000}, async t => {
  const {page,context,url,errors} = await fixture(t);
  await create(page,'valkyrie',9);
  const first = await snapshot(page), bookmark = page.url();
  const peer = await context.newPage(); await peer.goto(url);
  await create(peer,'wizard',21);
  const second = await snapshot(peer), peerBookmark = peer.url();
  assert.notEqual(first.sessionId,second.sessionId);
  assert.notEqual(await page.evaluate(()=>document.querySelector('pixel-nethack').storeName),await peer.evaluate(()=>document.querySelector('pixel-nethack').storeName));
  await context.setOffline(true);
  await Promise.all([page,peer].map(tab => tab.evaluate(async()=>{
    const app=document.querySelector('pixel-nethack');
    for(let i=0;i<3;i++)await app.run(()=>app.game.wait());
  })));
  const advanced = await Promise.all([snapshot(page),snapshot(peer)]);
  assert.equal(advanced[0].observation.turn,first.observation.turn+3);
  assert.equal(advanced[1].observation.turn,second.observation.turn+3);
  for(const tab of [page,peer]){
    const entries=await tab.evaluate(()=>{
      const app=document.querySelector('pixel-nethack');
      return app.saves.map(s=>JSON.parse(localStorage.getItem(app.indexKey+':'+s.id)));
    });
    assert.equal(entries.length,2);
    for(const state of advanced)assert.equal(entries.find(s=>s.id===state.sessionId).turn,state.observation.turn);
    assert.equal(await tab.locator('#error').isVisible(),false);
  }
  // Bun has no service worker: reconnect for the document fetch, keep every API
  // unavailable so each run must be resumed entirely from its own local journal.
  await context.setOffline(false); await context.route('**/api/**',route=>route.abort());
  await Promise.all([page.goto(bookmark),peer.goto(peerBookmark)]);
  for(const [i,tab] of [page,peer].entries()){
    await tab.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.observation);await ready(tab);
    assert.deepEqual((await snapshot(tab)).observation,advanced[i].observation);
    assert.equal((await snapshot(tab)).sessionId,advanced[i].sessionId);
  }
  assert.deepEqual(errors,[]);
});

test('a bookmarked run hands off its standing decision and can be claimed back', {timeout:60000}, async t => {
  const {page,context,errors} = await fixture(t);
  await create(page);
  await page.evaluate(async()=>{const app=document.querySelector('pixel-nethack');await app.run(()=>app.game.pray());});
  const standing=await snapshot(page), bookmark=page.url();
  assert.equal(standing.decision.kind,'confirmation');
  const peer=await context.newPage(); await peer.goto(bookmark);
  await peer.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.decision);
  await page.getByRole('button',{name:'Play here',exact:true}).waitFor();
  assert.equal(await snapshot(page),null);
  assert.deepEqual((await snapshot(peer)).observation,standing.observation);
  assert.deepEqual((await snapshot(peer)).decision,standing.decision);
  assert.equal(await peer.locator('#error').isVisible(),false);
  await peer.evaluate(async()=>{const app=document.querySelector('pixel-nethack');await app.run(()=>app.game.cancel(app.game.decision.id));});
  const cancelled=await snapshot(peer);
  await page.getByRole('button',{name:'Play here',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.observation);await ready(page);
  assert.equal(await snapshot(peer),null);
  assert.deepEqual((await snapshot(page)).observation,cancelled.observation);
  assert.equal((await snapshot(page)).decision,null);
  assert.equal((await snapshot(page)).revision,cancelled.revision);
  await page.screenshot({path:`${root}/test-results/tab-handoff-active.png`});
  await peer.setViewportSize({width:390,height:844});
  await peer.screenshot({path:`${root}/test-results/tab-handoff-mobile.png`});
  assert.deepEqual(errors,[]);
});

test('tab handoff waits for an accepted input receipt and never repeats the action', {timeout:60000}, async t => {
  const {page,context,errors}=await fixture(t);
  await create(page,'valkyrie',9);const before=await snapshot(page),bookmark=page.url();
  await page.evaluate(()=>{
    const app=document.querySelector('pixel-nethack'),send=app.api.transport.send.bind(app.api.transport);
    app.api.transport.send=async request=>{
      const response=await send(request);
      if(request.method==='game.wait'){
        globalThis.acceptedTurn=response.observation.turn;
        await new Promise(resolve=>{globalThis.releaseReceipt=resolve;});
      }
      return response;
    };
    void app.run(()=>app.game.wait());
  });
  await page.waitForFunction(()=>typeof globalThis.releaseReceipt==='function');
  const peer=await context.newPage();await peer.goto(bookmark);
  await page.waitForFunction(()=>document.querySelector('pixel-nethack').yielding);
  assert.equal(await snapshot(peer),null,'second engine cannot enter during an unfinished input');
  await page.evaluate(()=>globalThis.releaseReceipt());
  await peer.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.observation);await ready(peer);
  const after=await snapshot(peer);
  assert.equal(after.observation.turn,before.observation.turn+1);
  assert.equal(after.revision,before.revision+1);
  const journal=await peer.evaluate(()=>{const app=document.querySelector('pixel-nethack');return app.inputTransport.recordingInfo(app.game.id);});
  assert.equal(journal.count,2,'creation and exactly one accepted wait');
  assert.equal(await snapshot(page),null);
  assert.deepEqual(errors,[]);
});

test('WebMCP in a transferred tab requires explicit resume before acting again',{timeout:60000},async t=>{
  const {page,context,errors}=await fixture(t,{webmcp:true});const {call}=await nativeWebMcp(page,t);
  const created=await call("create",{name:'Tab agent',role:'valkyrie',seed:9});
  assert.equal(created.isError,false);const sid=created.structuredContent.sessionId;
  const peer=await context.newPage();await peer.goto(page.url());
  await peer.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.sessionId);
  await page.getByRole('button',{name:'Play here',exact:true}).waitFor();
  const before=await snapshot(peer);
  const refused=await call("wait",{sessionId:sid});
  assert.equal(refused.isError,true);assert.match(JSON.stringify(refused),/moved to another tab/);
  assert.deepEqual(await snapshot(peer),before);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  const resumed=await call("resume",{sessionId:sid});assert.equal(resumed.isError,false);
  const waited=await call("wait",{sessionId:sid});assert.equal(waited.isError,false);
  assert.equal((await snapshot(page)).revision,before.revision+1,"the resumed agent submits exactly one new attempt");
  assert.equal(await snapshot(peer),null);assert.deepEqual(errors,[]);
});

test('comma picks up and s does not answer a direction decision', async t => {
  const {page} = await fixture(t);
  await create(page);
  await page.keyboard.press('d');
  await page.locator('#decision[open]').waitFor();
  // Choose through the actual decision controls, retaining its opaque item ID.
  const decision = (await snapshot(page)).decision;
  assert.equal(decision.kind, 'item');
  const label = decision.options[0].label;
  await page.locator('#decision').getByRole('button', {name:label, exact:true}).click();
  await ready(page);
  await page.keyboard.press(',');
  await ready(page);
  const pickup = await snapshot(page);
  assert.equal(pickup.outcome.action, 'pickup');
  if (pickup.decision) {
    await page.locator('#decision').getByRole('button', {name:/Cancel/}).click();
    await ready(page);
  }
  await page.keyboard.press('o');
  await page.locator('#direction-target').waitFor();
  const before = await snapshot(page);
  await page.keyboard.press('s');
  assert.equal((await snapshot(page)).revision, before.revision);
  await page.keyboard.press('h');
  await ready(page);
  assert.equal((await snapshot(page)).decision, null);
});

test('classic prefixes dispatch explicit protocol parameters and counts stay native', async t => {
  const {page} = await fixture(t);
  await create(page);
  await page.evaluate(async () => {
    const {WasmTransport} = await import('/runtime/typescript/wasm.js');
    const send = WasmTransport.prototype.send;
    window.prefixRequests = [];
    WasmTransport.prototype.send = function(request) {
      window.prefixRequests.push(structuredClone(request));
      return send.call(this, request);
    };
  });
  const inputs = () => page.evaluate(() => window.prefixRequests.splice(0).filter(r => r.method.startsWith('game.')));
  for (const [keys,method,params] of [
    [['m','h'],'game.moveWithoutAttack',{direction:'west'}],
    [['Shift+F','h'],'game.attack',{direction:'west'}],
    [['g','h'],'game.run',{direction:'west',mode:'untilInteresting',noPickup:false}],
    [['Shift+G','h'],'game.run',{direction:'west',mode:'pastBranches',noPickup:false}],
    [['m','g','h'],'game.run',{direction:'west',mode:'untilInteresting',noPickup:true}],
    [['m','Shift+G','h'],'game.run',{direction:'west',mode:'pastBranches',noPickup:true}],
    [['m','Shift+H'],'game.run',{direction:'west',mode:'normal',noPickup:true}],
    [['1','0','s'],'game.search',{turns:10}],
    [['2','0','.'],'game.rest',{turns:20}],
  ]) {
    const before = await snapshot(page);
    for (const key of keys.slice(0,-1)) await page.keyboard.press(key);
    assert.equal((await snapshot(page)).revision,before.revision);
    assert.equal(await page.locator('#keyboard-prefix').isVisible(),true,keys.join(' '));
    await page.keyboard.press(keys.at(-1)); await ready(page);
    const requests = await inputs(); assert.equal(requests.length,1,JSON.stringify(requests));
    assert.equal(requests[0].method,method);
    for (const [key,value] of Object.entries(params)) assert.equal(requests[0].params[key],value);
    assert.equal(await page.locator('#keyboard-prefix').isVisible(),false);
  }
  const before = (await snapshot(page)).revision;
  for (const key of ['1','0','0','1','s']) await page.keyboard.press(key);
  assert.equal((await snapshot(page)).revision,before);
  assert.deepEqual(await inputs(),[]);
  await page.keyboard.press('1'); await page.keyboard.press('0'); await page.keyboard.press('h');
  assert.equal((await snapshot(page)).revision,before);
  assert.deepEqual(await inputs(),[]);
  assert.match(await page.locator('#keyboard-prefix').textContent(),/No action taken/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('m'); await page.keyboard.press('Escape'); await page.keyboard.press('s'); await ready(page);
  assert.equal((await inputs())[0].method,'game.search');
  await page.keyboard.press('g');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await page.locator('#keyboard-prefix').isVisible(),false);
  await page.keyboard.press('o'); await page.locator('#direction-target').waitFor();
  const decision = await snapshot(page);
  for (const key of ['1','0','s','g','G','m','F']) await page.keyboard.press(key);
  assert.equal((await snapshot(page)).revision,decision.revision);
  assert.equal(await page.locator('#keyboard-prefix').isVisible(),false);
});

test('hero command box edits drafts and offers explicit accessible completions', async t => {
  const {page,errors}=await fixture(t); await create(page);
  const before=await snapshot(page);
  await page.keyboard.type('20');
  const input=page.getByRole('textbox',{name:'Command',exact:true});
  assert.equal(await input.inputValue(),'20');
  await page.keyboard.press('Enter');
  assert.equal((await snapshot(page)).revision,before.revision);
  await page.keyboard.press('Backspace');
  assert.equal(await input.inputValue(),'2');
  await page.keyboard.type('0');
  assert.match(await page.locator('#command-about').innerText(),/20 turns/);
  const geometry=await page.evaluate(()=>{
    const app=document.querySelector('pixel-nethack'),map=app.map,you=app.snapshot.observation.you;
    const canvas=document.querySelector('#dungeon').getBoundingClientRect(),box=document.querySelector('#keyboard-prefix').getBoundingClientRect();
    return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,
      foot:canvas.top+(you.y-map.origin.y+1)*16*map.zoom,
      center:canvas.left+(you.x-map.origin.x+.5)*16*map.zoom};
  });
  assert.ok(geometry.top>=geometry.foot);
  assert.ok(Math.abs((geometry.left+geometry.right)/2-geometry.center)<2);
  await page.screenshot({path:resolve(root,'test-results/command-count-desktop.png')});
  await input.fill('20sh');
  assert.equal(await input.getAttribute('aria-invalid'),'true');
  assert.equal((await snapshot(page)).revision,before.revision,'a pasted multi-command string never partially executes');
  await input.fill('20');
  await page.locator('[data-completion="20s"]').click(); await ready(page);
  assert.equal(await page.locator('#keyboard-prefix').isVisible(),false);
  assert.equal((await snapshot(page)).outcome.action,'search');
  const after=await snapshot(page);
  await page.keyboard.press('m');
  await page.locator('[data-completion="mg"]').click();
  assert.equal(await input.inputValue(),'mg');
  assert.match(await page.locator('#command-about').innerText(),/No pickup or fighting/);
  await page.keyboard.press('Tab');
  assert.equal((await snapshot(page)).revision,after.revision);
  await input.focus();
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(100);
  const box=await page.locator('#keyboard-prefix').boundingBox();
  assert.ok(box.x>=0 && box.x+box.width<=390 && box.y>=0 && box.y+box.height<=844);
  for(const button of await page.locator('#keyboard-prefix button').all()) {
    const rect=await button.boundingBox(); assert.ok(rect.height>=44);
  }
  await page.screenshot({path:resolve(root,'test-results/command-movement-mobile.png')});
  await page.keyboard.press('Escape');
  assert.equal((await snapshot(page)).revision,after.revision);
  await page.getByRole('button',{name:'More actions',exact:true}).click();
  await page.getByRole('button',{name:'Type a command',exact:true}).click();
  assert.equal(await input.inputValue(),'');
  await page.locator('[data-completion="F"]').click();
  assert.match(await page.locator('#command-about').innerText(),/Force one attack/);
  await page.keyboard.press('ArrowLeft'); await ready(page);
  assert.equal((await snapshot(page)).outcome.action,'attack');
  assert.equal(await page.locator('#keyboard-prefix').isVisible(),false);
  assert.deepEqual(errors,[]);
});

test('inspection stays docked, exposes lore, and keeps numbered actions explicit', async t => {
  const {page, errors} = await fixture(t);
  await create(page);
  const before = await snapshot(page);
  const pet = before.observation.world.find(cell => cell.occupant?.kind === 'ally');
  assert.ok(pet?.occupant.appearance);
  const inspect = point => page.evaluate(({x,y}) => document.querySelector('pixel-nethack').inspectTile(x,y), point);
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:844});
    await inspect(pet);
    const card=page.getByRole('dialog',{name:'Tile actions'});
    const origin=await card.boundingBox();
    const neighbor=await page.evaluate(({x,y}) => {
      const cells=document.querySelector('pixel-nethack').game.observation.neighborhood.cells;
      return [{key:'ArrowLeft',dx:-1},{key:'ArrowRight',dx:1}].find(d=>cells.some(c=>c.x===x+d.dx&&c.y===y));
    },pet);
    assert.ok(neighbor);
    await page.keyboard.press(neighbor.key);
    assert.equal(Number(await card.getAttribute('data-x')),pet.x+neighbor.dx);
    const moved=await card.boundingBox();
    assert.equal(moved.x,origin.x,'arrows do not move the card horizontally');
    assert.equal(moved.y,origin.y,'arrows do not move the card vertically');
    await page.keyboard.press(neighbor.dx===-1?'ArrowRight':'ArrowLeft');
    await page.keyboard.press('/');
    await page.locator('.lore-entry:not([hidden])').waitFor();
    assert.equal(await page.locator('#lore-query').inputValue(),pet.occupant.appearance);
    assert.deepEqual(await snapshot(page),before,'inspection and contextual lore spend no turns or decisions');
    await page.getByRole('button',{name:'Back to inspection'}).click();
    await card.waitFor();
    assert.equal(Number(await card.getAttribute('data-x')),pet.x);
    assert.equal(Number(await card.getAttribute('data-y')),pet.y);
    await page.waitForFunction(()=>document.querySelector('.tile-buttons button span')?.textContent==='Walk here');
    const unavailable=card.locator('.tile-buttons button:disabled').first();
    if(await unavailable.count()) {
      await page.keyboard.press(await unavailable.getAttribute('aria-keyshortcuts'));
      assert.deepEqual(await snapshot(page),before,'disabled shortcuts never send input');
    }
    await card.locator('.lore-link').click();
    await page.locator('.lore-entry:not([hidden])').waitFor();
    await page.keyboard.press('Escape');
    await card.waitFor();
    assert.ok((await card.locator('.lore-icon').boundingBox()).height>=44);
    const close=await card.getByRole('button',{name:'Close tile actions',exact:true}).boundingBox();
    assert.ok(close.x>=0&&close.x+close.width<=width&&close.height>=44);
    await page.screenshot({path:`${root}/test-results/inspection-lore-${width}.png`});
    await page.keyboard.press('Escape');
    assert.equal(await card.count(),0);
  }
  await inspect(before.observation.you);
  const search=page.getByRole('dialog',{name:'Tile actions'}).getByRole('button',{name:'Search here',exact:true});
  const key=await search.getAttribute('aria-keyshortcuts');
  assert.match(key,/^[1-9]$/);
  assert.equal(await search.locator('kbd').textContent(),key);
  await page.keyboard.press(key);
  await ready(page);
  assert.equal((await snapshot(page)).observation.turn,before.observation.turn+1,'one numbered shortcut performs one real action');
  assert.deepEqual(errors,[]);
});

test('item lore uses the displayed label and returns to the item without changing it', async t => {
  const {page,errors}=await fixture(t);await create(page);
  const before=await snapshot(page), item=before.observation.inventory[0];
  await page.evaluate(item=>document.querySelector('pixel-nethack').itemDetails(item),item);
  await page.locator('#menu-title .lore-link').click();
  await page.locator('.lore-entry:not([hidden])').waitFor();
  assert.equal(await page.locator('#lore-query').inputValue(),item.label);
  assert.deepEqual(await snapshot(page),before);
  await page.getByRole('button',{name:'Back to item'}).click();
  await page.locator('#item-actions').waitFor();
  assert.equal(await page.locator('#menu-title .lore-link').textContent(),item.label);
  assert.deepEqual(await snapshot(page),before);
  assert.deepEqual(errors,[]);
});

test('closing contextual lore ignores its late result and menu focus blocks inspection shortcuts', async t => {
  const {page,errors}=await fixture(t);await create(page);
  const before=await snapshot(page);
  const pet=before.observation.world.find(cell=>cell.occupant?.kind==='ally');
  await page.evaluate(async pet=>{
    const app=document.querySelector('pixel-nethack');
    const lookup=app.game.lookup.bind(app.game);
    app.game.lookup=async name=>{
      const result=await lookup(name);
      return new Promise(resolve=>{window.finishLore=()=>resolve(result);});
    };
    await app.inspectTile(pet.x,pet.y);
  },pet);
  await page.keyboard.press('/');
  await page.waitForFunction(()=>typeof window.finishLore==='function');
  await page.getByRole('button',{name:'Back to inspection'}).click();
  const card=page.getByRole('dialog',{name:'Tile actions'});await card.waitFor();
  await page.evaluate(()=>window.finishLore());
  assert.equal(await page.locator('.lore-entry').isVisible(),false);
  assert.equal(await card.getByRole('button',{name:'Close tile actions',exact:true}).evaluate(el=>el===document.activeElement),true,'late lore does not steal focus');
  await page.getByLabel('Game menu',{exact:true}).click();
  const action=card.getByRole('button',{name:'Move toward ally'});
  await page.keyboard.press(await action.getAttribute('aria-keyshortcuts'));
  assert.deepEqual(await snapshot(page),before,'menu focus cannot issue an inspection action');
  assert.deepEqual(errors,[]);
});
