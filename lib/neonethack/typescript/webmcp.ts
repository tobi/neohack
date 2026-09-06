import { CompactResponses } from "../mcp/compact.js";
import { tools, toolMethods } from "../mcp/tools.js";
import type { Request } from "./types.js";
import type { Transport } from "./client.js";

/** Structural types for current document.modelContext and early navigator builds. */
export interface WebMcpContext {
  registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean };
      execute(
        input: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<unknown>;
    },
    options?: { signal: AbortSignal },
  ): void | Promise<void>;
  unregisterTool?(name: string): void;
}
export interface WebMcpRegistration {
  supported: boolean;
  toolCount: number;
  dispose(): void;
}

/** Register the complete MCP catalog. The caller owns transport/storage and UI
 * serialization. Arguments are forwarded unchanged; C remains the validator.
 * An aborted caller cannot undo submitted engine input. Always settle that input
 * and its receipt, and never manufacture a replacement request ID.
 */
export async function registerWebMcp(
  transport: Pick<Transport, "send">,
  context: WebMcpContext | undefined = (
    globalThis.document as
      | (Document & { modelContext?: WebMcpContext })
      | undefined
  )?.modelContext ??
    (
      globalThis.navigator as
        | (Navigator & { modelContext?: WebMcpContext })
        | undefined
    )?.modelContext,
): Promise<WebMcpRegistration> {
  if (!context?.registerTool)
    return { supported: false, toolCount: 0, dispose() {} };
  const compact = new CompactResponses();
  const controller = new AbortController();
  const registered: string[] = [];
  const dispose = () => {
    controller.abort();
    for (const name of registered.splice(0)) context.unregisterTool?.(name);
  };
  try {
    for (const tool of tools) {
      await context.registerTool(
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: tool.annotations.readOnlyHint },
          execute: async (input, options) => {
            try {
              if (controller.signal.aborted || options?.signal?.aborted)
                throw Error("Tool call cancelled before submission.");
              const response = await transport.send({
                version: 1,
                method: toolMethods.get(tool.name)!,
                params: structuredClone(input),
              } as Request);
              const projected = compact.project(response, toolMethods.get(tool.name)!);
              return {
                isError: "error" in response && response.error != null,
                structuredContent: projected,
                content: [],
              };
            } catch (error) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: toolMethods.get(tool.name) === "session.create"
                      ? `Creation reply unavailable; a session may already exist. Do not resubmit session.create: it has no retry ID. Recover the detached invocation or discover the current session in the owning page, then observe it. ${error instanceof Error ? error.message : String(error)}`
                      : `Tool failed; execution may be uncertain. Retry only the exact requestId and payload, never a new action. ${error instanceof Error ? error.message : String(error)}`,
                  },
                ],
              };
            }
          },
        },
        { signal: controller.signal },
      );
      registered.push(tool.name);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { supported: true, toolCount: registered.length, dispose };
}

export { CompactObservationReader } from "../mcp/compact.js";
