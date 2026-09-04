// Transport only. The core owns actions, targeting, selection, and game rules.
export class World {
  constructor(base = "") {
    this.base = base;
    this.sid = null;
    this.seq = 0;
  }
  async rpc(method, params = {}) {
    if (!this.sid && method !== "initialize")
      await this.rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "neonethack-explorer", version: "1" },
      });
    const response = await fetch(`${this.base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sid ? { "mcp-session-id": this.sid } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.seq, method, params }),
      signal: AbortSignal.timeout(40000),
    });
    if (response.status === 404) {
      this.sid = null;
      throw new Error(
        "Connection expired. Reconnect explicitly; no action was retried.",
      );
    }
    if (!response.ok) throw new Error(`World HTTP ${response.status}`);
    if (response.headers.has("mcp-session-id"))
      this.sid = response.headers.get("mcp-session-id");
    const reply = await response.json();
    if (reply.error) throw new Error(reply.error.message);
    return reply;
  }
  async tool(name, args = {}) {
    const reply = await this.rpc("tools/call", { name, arguments: args });
    const text = reply.result?.content?.find((c) => c.type === "text")?.text;
    if (!text) throw new Error("Missing world response");
    // Semantic rejections may include a usable observation and pending decision.
    // Return the entire envelope so the UI can display both error and recovery.
    return JSON.parse(text);
  }
  call(name, args) {
    return this.tool(name, args);
  }
  stepIn(identity) {
    return this.tool("new_game", identity);
  }
  look(sessionId) {
    return this.tool("get_state", { sessionId });
  }
  deed(sessionId, intent) {
    return this.tool("act", { sessionId, ...intent });
  }
  reenter(sessionId) {
    return this.tool("resume", { sessionId });
  }
  leave(sessionId) {
    return this.tool("end_session", { sessionId });
  }
}
