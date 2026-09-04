import { expect, test } from "bun:test";
import { ROOT } from "./bridge-harness";

test("maintenance skips readable terminal snapshots and never resumes archived worlds", async () => {
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/runs")
        return Response.json({
          runs: ["dead", "live", "archive"].map((sessionId) => ({ sessionId })),
        });
      const rpc = await request.json();
      let result: any = {};
      if (rpc.method === "tools/call") {
        const { name, arguments: args } = rpc.params;
        calls.push(`${name}:${args.sessionId}`);
        const value =
          name === "get_state"
            ? args.sessionId === "archive"
              ? { error: { code: "unknownSession" } }
              : { ended: args.sessionId === "dead", observation: { turn: 9 } }
            : name === "end_session" && args.sessionId === "live"
              ? { ended: true, observation: { turn: 9 } }
              : { error: { code: "noGame" } };
        result = { content: [{ type: "text", text: JSON.stringify(value) }] };
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    },
  });
  try {
    const proc = Bun.spawn(
      [
        process.execPath,
        `${ROOT}/tools/drain-server.ts`,
        `http://127.0.0.1:${server.port}`,
        "--apply",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout).worlds).toEqual([
      { sessionId: "live", turn: 9, decision: null, saved: true, finalTurn: 9 },
    ]);
    expect(calls).toEqual([
      "get_state:dead",
      "get_state:live",
      "end_session:live",
      "get_state:archive",
    ]);
  } finally {
    server.stop(true);
  }
});
