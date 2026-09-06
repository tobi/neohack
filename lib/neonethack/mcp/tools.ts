// Browser-safe definitions shared by stdio MCP and WebMCP. No native imports.
import { catalog } from "./protocol-data.js";
import { tools } from "./tool-data.js";
import type { Method } from "../typescript/types.js";

/** Tool definitions and C validation are generated from the same catalog. */
export { tools, instructions } from "./tool-data.js";
export { compactResponseSchema } from "./protocol-data.js";

export const toolMethods = new Map(
  tools.map((tool) => [
    tool.name,
    catalog.methods.find(method => method.name.replaceAll('.', '_') === tool.name)!.name as Method,
  ]),
);
