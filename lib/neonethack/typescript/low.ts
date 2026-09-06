import { tools as canonicalTools, toolMethods } from '../mcp/tools.js';
import type { Method, MethodParams, Request, Response } from './types.js';

type ToolNameOf<M extends string> = M extends `${infer A}.${infer B}` ? `${A}_${B}` : M;
export type ToolName = ToolNameOf<Method>;
export type ToolParams = { [M in Method as ToolNameOf<M>]: MethodParams[M] };
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}
export const tools: readonly ToolDefinition[] = canonicalTools;

/** Exact protocol calls: caller supplies session, revision and request IDs.
 * No retries, automatic answers, or game policy. Transport permissions still apply.
 */
export class LowLevel {
  readonly tools = tools;
  constructor(private readonly transport: { send(request: Request): Promise<Response> }) {}
  request<M extends Method>(method: M, params: MethodParams[M]): Promise<Response> {
    return this.transport.send({ version: 1, method, params } as Request);
  }
  call<N extends ToolName>(name: N, params: ToolParams[N]): Promise<Response> {
    const method = toolMethods.get(name);
    if (!method) throw new Error(`Unknown tool: ${name}`);
    return this.transport.send({ version: 1, method, params } as Request);
  }
}
export default LowLevel;
