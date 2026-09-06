import { catalog } from "./catalog.ts";

// Shared presentation only; the catalog and C driver own arguments and semantics.
export const mcpInstructions = "Create or resume a session. Use named game tools for intents; continue a standing decision with decision_answer or decision_cancel, never by repeating its initiating action. Never auto-confirm warnings or restart interrupted work. Item IDs and choice IDs come from returned candidates; eligibility reveals neither safety nor hidden properties. Gameplay/decision calls need a unique requestId and the latest expectedRevision. After uncertainty, retry only the exact ID and payload. Creation has no retry ID; do not blindly resubmit. Results use structuredContent: outcome, ordered events, perceived observation and at most one decision. Snapshot replaces state; delta replaces supplied fields and upserts world cells by x,y. update.remove deletes fields; update.worldRemoved deletes cells. Apply a delta only when update.base equals your last update.id; otherwise call session_observe for a full snapshot. session_actions supplies local action offers. Cached receipts may be historical; observe for current state.";

export const mcpTools = catalog.methods.map(method => ({
  name: method.name.replaceAll(".", "_"),
  // WebMCP has no server initialization instructions. Publish shared guidance
  // once on discovery so both registries remain self-contained and identical.
  description: method.description + (method.name === "protocol.describe" ? " " + mcpInstructions : ""),
  inputSchema: method.schema,
  // The response schema remains published separately. Repeating it on every
  // tool is optional in MCP and adds substantial discovery overhead.
  annotations: {
    readOnlyHint: method.readOnly === true,
    destructiveHint: method.readOnly !== true,
    idempotentHint: method.idempotent === true,
    openWorldHint: false,
  },
}));
