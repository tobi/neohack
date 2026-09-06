// Browser-safe definitions shared by stdio MCP and WebMCP. No native imports.
import { catalog, compactResponseSchema } from "./protocol-data.js";
import type { Method } from "../typescript/types.js";

/** Tool definitions and C validation are generated from the same catalog. */
export const tools = catalog.methods.map((method) => ({
  name: method.name.replaceAll(".", "_"),
  description: method.description + (method.name === "session.observe" ? " Returns the complete perceived state, including neighborhood/action offers, as a standalone snapshot. No baseline required. Other observations are deltas: replace supplied fields, upsert world by x,y; update.remove/worldRemoved delete fields/cells. Match update.base to last update.id. Query session.actions for neighborhood offers." : ""),
  inputSchema: method.schema,
  outputSchema: compactResponseSchema,
  annotations: {
    readOnlyHint: method.readOnly === true,
    destructiveHint: method.readOnly !== true,
    idempotentHint: method.idempotent === true,
    openWorldHint: false,
  },
}));

export const toolMethods = new Map(
  tools.map((tool, index) => [
    tool.name,
    catalog.methods[index]!.name as Method,
  ]),
);
