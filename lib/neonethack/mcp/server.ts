import { CompactResponses } from "./compact.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import catalog from "../protocol/catalog.json" with { type: "json" };
import { NativeTransport, type NativeOptions } from "../typescript/native.js";
import type { Transport } from "../typescript/client.js";
import type { Request } from "../typescript/types.js";

import { tools, instructions } from "./tools.js";
export { tools } from "./tools.js";

export function createMcpServer(transport: Transport): Server {
  const compact = new CompactResponses();
  const server = new Server({ name: "neonethack", version: "1.0.0-alpha.1" }, {
    capabilities: { tools: {} },
    instructions,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const index = tools.findIndex(tool => tool.name === request.params.name);
    if (index < 0) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    const method = catalog.methods[index]!;
    try {
      // Do not sanitize or drop unknown arguments: C validates all of them.
      const response = await transport.send({ version: 1, method: method.name, params: request.params.arguments ?? {} } as Request);
      return {
        isError: "error" in response && response.error != null,
        structuredContent: compact.project(response, method.name),
        content: [],
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: `Transport failed; execution may be uncertain. Do not repeat with a new requestId. ${error instanceof Error ? error.message : String(error)}` }] };
    }
  });
  return server;
}

export async function serveStdio(options: NativeOptions): Promise<void> {
  const core = new NativeTransport(options);
  const server = createMcpServer(core);
  server.onclose = () => { void core.close(); };
  await server.connect(new StdioServerTransport());
}

export { CompactObservationReader } from "./compact.js";
