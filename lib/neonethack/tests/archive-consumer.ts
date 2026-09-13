// Typechecked in a fresh npm consumer against installed declarations only.
// This function is not executed; archive-consumer.mjs tests real gameplay.
import { Neonethack, type Transport, type Snapshot } from 'neonethack';
import { createNative, type NativeOptions } from 'neonethack/native';
import { createWasm, type WasmOptions } from 'neonethack/wasm';
import { registerWebMcp, type WebMcpContext } from 'neonethack/webmcp';
import { SceneReader, SceneProjector, type SceneFrame, type DecisionFrame, type AgentScene } from 'neonethack/mcp';
import { tools } from 'neonethack/mcp/tools';
import type { Identity, Request } from 'neonethack/types';
import catalog from 'neonethack/protocol' with { type: 'json' };

export async function consume(transport: Transport, native: NativeOptions,
  wasm: WasmOptions, context: WebMcpContext): Promise<Snapshot> {
  const api: Neonethack = createNative(native);
  const browser: Neonethack = await createWasm(wasm);
  const identity: Identity = { name: 'Types', seed: 42, role: 'valkyrie' };
  const game = await api.create(identity);
  const frame: Snapshot = await game.move('north');
  const request: Request = { version: 1, method: 'protocol.describe', params: {} };
  await transport.send(request);
  const registration = await registerWebMcp(transport, context);
  registration.dispose();
  for (const tool of tools) tool.name.toUpperCase();
  for (const method of catalog.methods) method.name.toUpperCase();
  await browser.close();
  await api.close();
  return frame;
}

export function consumeScene(frame: SceneFrame): DecisionFrame {
  const reader = new SceneReader(), projector = new SceneProjector();
  const result: DecisionFrame = reader.apply(frame);
  const scene: AgentScene | null = result.scene;
  if (scene && result.basis) {
    const input = reader.arguments(result.basis.sessionId, {includeWorld:true});
    input.viewId.toUpperCase();
    const update: SceneFrame = projector.project(result, input.viewId);
    return reader.apply(update);
  }
  return result;
}
