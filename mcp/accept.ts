// Acceptance runner for API_DESING.md section 12. Each test drives the
// live world API over MCP stdio and asserts contract behavior. Run:
//   bun mcp/accept.ts
// A test fails by throwing; the runner reports pass/fail per test and
// exits nonzero on any failure. Tests share nothing: each opens its own
// world (deterministic seeds where the scenario allows).
import { spawn } from "bun";

const ROOT = new URL("..", import.meta.url).pathname;
const SERVER = new URL("./src/server.ts", import.meta.url).pathname;

const proc = spawn(["bun", SERVER], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: {
    ...process.env,
    SESSIONS_DIR: "/tmp/mcpaccept-sessions",
    ENGINE_CMD: `${ROOT}/upstream/playground/nethack`,
    PLAYGROUND_TEMPLATE: `${ROOT}/upstream/playground`,
  },
});

let seq = 0;
const waiters = new Map<number, (v: any) => void>();
let outBuf = "";
const reader = proc.stdout.getReader();
const pump = (async () => {
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    outBuf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = outBuf.indexOf("\n")) >= 0) {
      const line = outBuf.slice(0, idx);
      outBuf = outBuf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (typeof m.id === "number" && waiters.has(m.id)) {
          waiters.get(m.id)!(m);
          waiters.delete(m.id);
        }
      } catch {
        /* ignore */
      }
    }
  }
})();

function rpc(method: string, params: unknown = {}): Promise<any> {
  const id = ++seq;
  return new Promise((resolve) => {
    waiters.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

export const call = (name: string, args: unknown) =>
  rpc("tools/call", { name, arguments: args }).then((r) => {
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    return JSON.parse(r.result.content[0].text);
  });

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export interface TestCtx {
  call: typeof call;
  assert: typeof assert;
}

const tests: { name: string; fn: (t: TestCtx) => Promise<void>; skipped?: boolean }[] = [];

export const test = Object.assign(
  (name: string, fn: (t: TestCtx) => Promise<void>) => { tests.push({ name, fn }); },
  { skip: (name: string, fn: (t: TestCtx) => Promise<void>) => { tests.push({ name, fn, skipped: true }); } }
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await sleep(500);
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "accept", version: "0" } });
  // Tests register via dynamic import below.
  await import("./accept/index");
  let pass = 0, fail = 0, skipped = 0;
  for (const t of tests) {
    if (t.skipped) { console.log(`SKIP - ${t.name}`); skipped++; continue; }
    try {
      await t.fn({ call, assert });
      console.log(`ok - ${t.name}`);
      pass++;
    } catch (e) {
      console.log(`FAIL - ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped, ${tests.length} total`);
  proc.kill();
  process.exit(fail ? 1 : 0);
}

await main();
