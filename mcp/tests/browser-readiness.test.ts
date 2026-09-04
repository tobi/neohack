import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testDirectory } from "./bridge-harness";
import { waitForOwnedBrowser } from "../../tools/browser-readiness";

test("Chrome readiness retries transient HTTP startup, never browser identity", async () => {
  const profile = testDirectory("cdp-readiness");
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return requests < 3
        ? new Response("Starting", { status: 503 })
        : Response.json({
            webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/owned-1`,
          });
    },
  });
  try {
    await writeFile(
      join(profile, "DevToolsActivePort"),
      `${server.port}\n/devtools/browser/owned-1\n`,
    );
    expect(
      await waitForOwnedBrowser(profile, () => false, {
        timeoutMs: 1000,
        pollMs: 1,
      }),
    ).toBe(`http://127.0.0.1:${server.port}`);
    expect(requests).toBe(3);
    await writeFile(
      join(profile, "DevToolsActivePort"),
      `${server.port}\n/devtools/browser/different\n`,
    );
    await expect(
      waitForOwnedBrowser(profile, () => false, { timeoutMs: 1000, pollMs: 1 }),
    ).rejects.toThrow("not owned");
  } finally {
    server.stop(true);
  }
});
test("Chrome readiness has a total bound and rejects an exited owner", async () => {
  const profile = testDirectory("cdp-dead");
  await expect(
    waitForOwnedBrowser(profile, () => true, { timeoutMs: 100 }),
  ).rejects.toThrow("exited");
  await expect(
    waitForOwnedBrowser(profile, () => false, { timeoutMs: 25, pollMs: 1 }),
  ).rejects.toThrow("deadline");
});
