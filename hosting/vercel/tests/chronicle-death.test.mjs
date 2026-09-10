import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "../../../web/neohack.dev/node_modules/playwright-core/index.mjs";
import { createTestHarness, MemoryStorage, publicStoreFor } from "./server.mjs";
import { storyModelContext } from "../src/chronicle.ts";

/** The ordinary seeded choking death used by the tombstone tests, played in
 * the real pixel client so the death screen, the ledger record, the public
 * input archive and the chronicler work together. */
async function chokeToDeath(page, seed) {
  await page.goto(page.url());
  await page.waitForFunction(() => !document.querySelector("#new-adventure").disabled);
  await page.getByRole("button", { name: "Begin your adventure", exact: true }).click();

  await page.locator("input[name=role][value=tourist]").check();
  await page.getByText("Choose a world seed (optional)", { exact: true }).click();
  await page.getByLabel("A number for a repeatable starting world").fill(String(seed));
  await page.getByRole("button", { name: "Enter the dungeon →", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("pixel-nethack").snapshot?.observation && document.querySelector("pixel-nethack").getAttribute("aria-busy") === "false");
  await page.keyboard.press("Escape");
  return page.evaluate(async () => {
    const app = document.querySelector("pixel-nethack"), game = app.game;
    // The ledger record is client-reported; pretend this hero went deep enough.
    app.current.maxDepth = 3; app.current.maxLevel = 2;
    await app.run(() => game.move("west"));
    const amulet = game.observation.here.items.find((i) => i.category === "amulet");
    await app.run(() => game.pickup({ id: amulet.id }));
    await app.run(() => game.wait());
    const food = game.observation.inventory.find((i) => i.category === "food" && i.label.includes("food ration"));
    await app.run(() => game.eat({ id: food.id }));
    await app.run(() => game.eat({ id: food.id }));
    if (game.decision?.kind === "confirmation") await app.run(() => game.answer(game.decision.id, { kind: "confirmation", confirm: true }));
    return { id: game.id, end: game.state.end?.kind };
  });
}

test("the death screen offers to tell the tale once the recording is public, opens the story and the ledger keeps it", { timeout: 180000 }, async (t) => {
  const store = new MemoryStorage(), calls = [];
  const model = async (digest) => {
    calls.push(digest);
    return { raw: JSON.stringify({ title: "The Tourist Who Ate Twice", paragraphs: [
      { text: digest.hero.name + " was a Tourist who found an amulet and a food ration.", sources: [digest.events[0].id] },
      { text: "The second helping was the memorable one.", sources: [digest.events.at(-1).id] },
    ] }) };
  };
  const server = createTestHarness({ store, wrap: (fn) => storyModelContext.run(model, fn) });
  const { url } = await server.listen();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url.href);
  const { id, end } = await chokeToDeath(page, 4386);
  assert.equal(end, "death");
  await page.waitForSelector("#ended:not([hidden])");
  const tell = page.locator("#death-tell-tale");
  await tell.waitFor({ state: "visible", timeout: 60000 });
  assert.equal(await tell.textContent(), "Tell the tale");
  await tell.click();
  // The story opens at once as a draft and fills in while the server works.
  await page.waitForSelector("#menu[open] .chronicle-draft", { timeout: 90000 });
  await page.waitForSelector("#menu[open] .chronicle:not(.chronicle-draft)", { timeout: 90000 });
  assert.equal(calls.length, 1, "one model call");
  assert.equal(calls[0].events.at(-1).ending?.kind, "death", "the replayed evidence ends in the witnessed death");
  assert.ok(calls[0].events.some((e) => e.action === "eat"), "the evidence contains the fatal meals");
  assert.equal(await page.locator("#menu .chronicle-title").textContent(), "The Tourist Who Ate Twice");
  const term = page.locator("#menu .chronicle .lore-link", { hasText: "Tourist" });
  assert.ok(await term.count(), "witnessed names are dotted lookups");
  await term.first().click();
  await page.waitForSelector("#menu .chronicle-lore:not([hidden])");
  assert.match(await page.locator("#menu .chronicle-lore h3").textContent(), /tourist/i);
  assert.match(await page.locator("#death-share-status").textContent(), /written/);
  assert.ok(publicStoreFor(store).docs.has("chronicles/" + id + "/story.json"), "the tale is a public object");
  const stats = await (await fetch(new URL("/api/stats", url))).json();
  assert.equal(stats.best.find((r) => r.id === id)?.chronicleAvailable, true, "the ledger shows the icon for this run");
  assert.deepEqual(errors, []);
});

test("a shallow death offers no tale", { timeout: 180000 }, async (t) => {
  const server = createTestHarness({ store: new MemoryStorage() });
  const { url } = await server.listen();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true, chromiumSandbox: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(url.href);
  await page.waitForFunction(() => !document.querySelector("#new-adventure").disabled);
  await page.getByRole("button", { name: "Begin your adventure", exact: true }).click();

  await page.locator("input[name=role][value=tourist]").check();
  await page.getByText("Choose a world seed (optional)", { exact: true }).click();
  await page.getByLabel("A number for a repeatable starting world").fill("4386");
  await page.getByRole("button", { name: "Enter the dungeon →", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("pixel-nethack").snapshot?.observation && document.querySelector("pixel-nethack").getAttribute("aria-busy") === "false");
  await page.keyboard.press("Escape");
  const end = await page.evaluate(async () => {
    const app = document.querySelector("pixel-nethack"), game = app.game;
    await app.run(() => game.move("west"));
    const amulet = game.observation.here.items.find((i) => i.category === "amulet");
    await app.run(() => game.pickup({ id: amulet.id }));
    await app.run(() => game.wait());
    const food = game.observation.inventory.find((i) => i.category === "food" && i.label.includes("food ration"));
    await app.run(() => game.eat({ id: food.id }));
    await app.run(() => game.eat({ id: food.id }));
    if (game.decision?.kind === "confirmation") await app.run(() => game.answer(game.decision.id, { kind: "confirmation", confirm: true }));
    return game.state.end?.kind;
  });
  assert.equal(end, "death");
  await page.waitForSelector("#ended:not([hidden])");
  await page.waitForFunction(() => /Share this read-only replay/.test(document.querySelector("#death-share-status")?.textContent ?? ""), null, { timeout: 60000 });
  assert.equal(await page.locator("#death-tell-tale").isHidden(), true, "dungeon level 1 is too shallow for a chronicle");
});
