import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { root } from './native-fixture.mjs';
export const mcpExecutable = process.env.NEONETHACK_MCP_TEST_EXECUTABLE ?? `${root}/build/native/neonethack-mcp`;
export const HTTP_PROTOCOL_VERSION = '2026-07-28';
export async function startMcpHttp({ enginePath, dataPath, sessionsPath, bundled = false, mcpCommand = mcpExecutable, env }) {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const process = spawn(mcpCommand, ['--http', String(port), ...(bundled ? [sessionsPath] : [enginePath, dataPath, sessionsPath])], { stdio: 'pipe', env });
  const exited = once(process, 'exit');
  const lines = createInterface({ input: process.stderr });
  const ready = new Promise(resolve => lines.on('line', line => {
    if (line.includes('MCP listening')) resolve();
  }));
  await Promise.race([ready, exited.then(([code, signal]) => { throw Error(`MCP exited before listening: ${code}/${signal}`); })]);
  let closing;
  return { process, url: `http://127.0.0.1:${port}/mcp`, close: () => closing ??= (async () => {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGTERM');
    const [code, signal] = await exited;
    if (code !== 0 || signal) throw Error(`MCP shutdown failed: ${code}/${signal}`);
  })() };
}
