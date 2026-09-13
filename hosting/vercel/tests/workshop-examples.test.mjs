import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "../../../web/neohack.dev/node_modules/playwright-core/index.mjs";
import {
  catalog,
  exampleProject,
} from "../../../examples/workshop/projects.js";
import { createTestHarness } from "./server.mjs";

// Exercise the actual chooser, copied helper files and opaque WASM sandbox.
test(
  "every catalog example opens its exact JavaScript project and runs in the browser",
  { timeout: 180000 },
  async (t) => {
    const server = createTestHarness();
    const { url } = await server.listen();
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
      headless: true,
      chromiumSandbox: true,
    });
    t.after(async () => {
      await browser.close();
      await server.close();
    });
    const page = await browser.newPage();
    const errors = [];
    // Each next example intentionally discards the previous fixed run settings.
    page.on("dialog", (dialog) => dialog.accept());
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(new URL("/bots", url).href);
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll("#example-list button").length === count,
      catalog.length,
    );
    for (const example of catalog) {
      const project = await exampleProject(example);
      await page
        .locator("#example-list button")
        .filter({ has: page.getByText(example.name, { exact: true }) })
        .click();
      assert.equal(new URL(page.url()).searchParams.get("example"), example.id);
      assert.equal(await page.locator("#save").textContent(), "Save my copy");
      assert.deepEqual(
        await page.locator("#tabs [role=tab]").allTextContents(),
        Object.keys(project.files),
      );
      for (const [file, source] of Object.entries(project.files)) {
        await page
          .locator("#tabs")
          .getByRole("tab", { name: file, exact: true })
          .click();
        // Copy uses CodeMirror's full document, including unmounted lines.
        await page.locator(".cm-content").click();
        await page.keyboard.press("Control+a");
        const actual = await page.evaluate(() => {
          const clipboard = new DataTransfer();
          document.querySelector(".cm-content").dispatchEvent(
            new ClipboardEvent("copy", {
              bubbles: true,
              cancelable: true,
              clipboardData: clipboard,
            }),
          );
          return clipboard.getData("text/plain");
        });
        assert.equal(actual, source);
      }
      const diagnostics = await page.evaluate(async (files) => {
        const worker = new Worker("/build/bot-language.js", { type: "module" });
        try {
          const results = {};
          for (const file of Object.keys(files))
            results[file] = await new Promise((resolve) => {
              worker.onmessage = (event) => resolve(event.data);
              worker.postMessage({ id: 1, kind: "diagnostics", files, file });
            });
          return results;
        } finally {
          worker.terminate();
        }
      }, project.files);
      for (const [file, diagnosticsForFile] of Object.entries(diagnostics)) {
        assert.equal(diagnosticsForFile.error, undefined);
        assert.deepEqual(
          diagnosticsForFile.result,
          [],
          example.id + "/" + file,
        );
      }
      await page
        .locator("#tabs")
        .getByRole("tab", { name: "main.js", exact: true })
        .click();
      await page.locator("#role").selectOption("valkyrie");
      await page.locator("#seed-mode").selectOption("fixed");
      await page.locator("#seed").fill("7");
      await page.locator("#test").click();
      await page.waitForFunction(
        () => !document.querySelector("#test").disabled,
        null,
        { timeout: 90000 },
      );
      const status = await page.locator("#status[role=status]").textContent();
      assert.match(
        status,
        /Script finished|Test budget reached/,
        `${example.id}: ${status}`,
      );
      const final = await page.evaluate(
        () => document.querySelector("#bot-world").snapshot,
      );
      assert.ok(final.observation.turn > 1);
      const depth = final.observation.knowledge.levels.find(
        (level) => level.id === final.observation.location.id,
      )?.depth;
      if (example.id === "cartographer") assert.equal(depth, 1);
      if (example.id === "curious-imp") assert.ok(depth >= 2);
      // Seed 7 now reaches the second level within the browser's fixed
      // 1000-call budget; deeper progress continues when the budget is raised.
      if (example.id === "steady-fighter") assert.ok(depth >= 2);
      t.diagnostic(
        `${example.id}: turn ${final.observation.turn}, depth ${depth}`,
      );
      await page.locator("#choose-project").click();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: "/tmp/workshop-examples-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: "/tmp/workshop-examples-desktop.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
  },
);
