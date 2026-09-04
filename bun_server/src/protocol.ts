// NDJSON helpers + engine input-request matcher.
// Engine speaks JSON-RPC 2.0 over stdio, one object per line. An "input
// request" (a prompt the server auto-answers during resume replay) is
// exactly: {"jsonrpc":"2.0","id":N,"method":"input","params":{"kind":...}}.
// persist_* engine requests are answered by the disk store, not the log.

export function toLine(obj: unknown): string {
  return JSON.stringify(obj);
}

export function tryParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function isInputRequest(line: string): boolean {
  // Exact match on the real engine shape — no heuristics:
  //   {"jsonrpc":"2.0","id":N,"method":"input","params":{"kind":"..."}}
  const msg = tryParse(line) as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return false;
  return msg["method"] === "input" && typeof msg["id"] === "number";
}

// Split a stdout chunk into complete lines, keeping the remainder.
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((p) => p.replace(/\r$/, "")).filter((p) => p.length > 0), rest };
}
