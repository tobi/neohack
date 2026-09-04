// neonethack-mcp core bridge: one long-lived cli/nhxcli child owns every
// session (games, input log, replay, decisions, observations). This file
// only transports JSON lines; all world semantics live in libneonethack.
//
//   NHXCLI              -- path to the bridge binary (default mcp/bin/nhxcli)
//   ENGINE_CMD          -- engine binary (default ../upstream/playground/nethack)
//   PLAYGROUND_TEMPLATE -- engine data template (default ../upstream/playground)
//   SESSIONS_DIR        -- session roots (default ../sessions)
// Calls serialize: the bridge answers in request order.
import { spawn, type Subprocess } from "bun";
import { dirname, resolve } from "node:path";

const HERE = import.meta.dir;
const ROOT = resolve(HERE, "../..");
const BRIDGE = process.env.NHXCLI ?? resolve(HERE, "../bin/nhxcli");
const ENGINE = process.env.ENGINE_CMD ?? resolve(ROOT, "upstream/playground/nethack");
const TEMPLATE = process.env.PLAYGROUND_TEMPLATE ?? resolve(ROOT, "upstream/playground");
const SESSIONS = process.env.SESSIONS_DIR ?? resolve(ROOT, "sessions");

let proc: Subprocess | null = null;
let outBuf = "";
let decoder = new TextDecoder();
let diagnostics = "";
let waiters: Array<{ ok: (v: unknown) => void; bad: (e: Error) => void }> = [];
let starting: Promise<void> | null = null;

function pump(data: Uint8Array, child: Subprocess): void {
  if (proc !== child) return;
  outBuf += decoder.decode(data, { stream: true });
  let idx: number;
  while ((idx = outBuf.indexOf("\n")) >= 0) {
    const line = outBuf.slice(0, idx).replace(/\r$/, "");
    outBuf = outBuf.slice(idx + 1);
    if (!line.trim()) continue;
    const w = waiters.shift();
    if (!w) continue;
    try {
      w.ok(JSON.parse(line));
    } catch (e) {
      w.bad(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

function ensureCore(): Promise<void> {
  if (proc) return Promise.resolve();
  if (starting) return starting;
  starting = (async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dirname(BRIDGE), { recursive: true }).catch(() => {});
    proc = spawn([BRIDGE, ENGINE, TEMPLATE, SESSIONS], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const child = proc;
    outBuf = ""; decoder = new TextDecoder(); diagnostics = "";
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const errReader = (child.stderr as ReadableStream<Uint8Array>).getReader();
    const errDecoder = new TextDecoder();
    (async () => {
      try {
        for (;;) { const {done,value} = await errReader.read(); if (done) break;
          if (proc === child && value) diagnostics = (diagnostics + errDecoder.decode(value, {stream:true})).slice(-8192);
        }
      } catch { /* retiring process */ }
    })();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) pump(value, child);
        }
      } finally {
        if (proc !== child) return;
        const pending = waiters; waiters = [];
        proc = null; starting = null;
        for (const w of pending) w.bad(new Error(`core bridge exited: ${diagnostics}`));
      }
    })().catch(() => {});
  })();
  return starting;
}

let tail: Promise<unknown> = Promise.resolve();

export function callCore(req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const run = tail.then(async () => {
    await ensureCore();
    if (!proc) throw new Error("core bridge did not start");
    return new Promise<Record<string, unknown>>((ok, bad) => {
      const child = proc!;
      const timer = setTimeout(() => {
        if (proc !== child) return;
        const pending = waiters; waiters = [];
        proc = null; starting = null;
        child.kill();
        for (const w of pending) w.bad(new Error("Core timed out; execution outcome is uncertain. Resume the world before another action."));
      }, 45000);
      waiters.push({
        ok: (v) => { clearTimeout(timer); ok(v as Record<string, unknown>); },
        bad: (e) => { clearTimeout(timer); bad(e); },
      });
      try {
        (child.stdin as unknown as { write: (s: string) => void }).write(JSON.stringify(req) + "\n");
      } catch (e) {
        clearTimeout(timer);
        waiters.pop();
        bad(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<Record<string, unknown>>;
}
