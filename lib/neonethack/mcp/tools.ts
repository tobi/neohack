// Browser-safe definitions shared by stdio MCP and WebMCP. No native imports.
import { catalog, responseSchema } from "./protocol-data.js";
import type { Method } from "../typescript/types.js";

/** Tool definitions and C validation are generated from the same catalog. */
export const tools = catalog.methods.map((method) => ({
  name: `neonethack_${method.name.replaceAll(".", "_")}`,
  description: method.description,
  inputSchema: method.schema,
  outputSchema: responseSchema,
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
