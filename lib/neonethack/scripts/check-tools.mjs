#!/usr/bin/env node
/** Executable contract audit. Never calls gameplay tools against a remote page. */
import { isDeepStrictEqual } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { catalog } from '../protocol/catalog.ts';
import { mcpTools } from '../protocol/mcp.ts';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');

/** Order is irrelevant; duplicate names and any schema/description drift are not. */
export function compareTools(expected, actual) {
  if (!Array.isArray(actual)) return ['discovery did not return a tool array'];
  const errors = [], names = new Set();
  for (const tool of actual) {
    if (names.has(tool.name)) errors.push(`duplicate: ${tool.name}`);
    names.add(tool.name);
    const wanted = expected.find(t => t.name === tool.name);
    if (!wanted) { errors.push(`extra: ${tool.name}`); continue; }
    for (const field of ['description', 'inputSchema']) {
      if (!isDeepStrictEqual(tool[field], wanted[field])) errors.push(`${tool.name}: ${field} differs`);
    }
    // WebMCP only standardizes readOnlyHint; compare every annotation it exposes.
    if (tool.annotations?.readOnlyHint !== wanted.annotations.readOnlyHint) errors.push(`${tool.name}: readOnlyHint differs`);
    for (const [key, value] of Object.entries(tool.annotations ?? {})) {
      if (!isDeepStrictEqual(value, wanted.annotations[key])) errors.push(`${tool.name}: annotation ${key} differs`);
    }
  }
  for (const tool of expected) if (!names.has(tool.name)) errors.push(`missing: ${tool.name}`);
  return errors;
}

export async function checkTools({ web, http, scripts = true } = {}) {
  const results = [];
  async function check(surface, run) {
    try {
      const { tools, requests, note } = await run();
      const errors = compareTools(mcpTools, tools);
      if (requests) {
        if (requests.length !== catalog.methods.length) errors.push(`dispatch count: ${requests.length}, expected ${catalog.methods.length}`);
        for (const [i, method] of catalog.methods.entries()) {
          const expected = { version: 1, method: method.name, params: { parityProbe: i } };
          if (!isDeepStrictEqual(requests[i], expected)) errors.push(`dispatch differs: ${method.name}`);
        }
      }
      results.push({ surface, count: tools?.length ?? 0, ok: errors.length === 0, errors, ...(note ? { note } : {}) });
    } catch (error) { results.push({ surface, ok: false, errors: [error.message] }); }
  }
  // Deliberately invalid opaque probes only visit a recording transport, never C.
  const probe = async Low => {
    const requests = [];
    const low = new Low({ send: async request => { requests.push(structuredClone(request)); return {}; } });
    for (const [i, method] of catalog.methods.entries()) await low.call(method.name.replaceAll('.', '_'), { parityProbe: i });
    return { tools: low.tools, requests };
  };
  await check('javascript/low (package export)', async () => probe((await import('neonethack/low')).LowLevel));
  await check('javascript/high.low (package export)', async () => {
    const { Neonethack } = await import('neonethack/high');
    return probe(class { constructor(transport) { return new Neonethack({ ...transport, close: async () => {} }).low; } });
  });
  await check('webmcp (registration + dispatch)', async () => {
    const { registerWebMcp } = await import('neonethack/webmcp');
    const tools = [], requests = [];
    const registration = await registerWebMcp({ send: async request => { requests.push(structuredClone(request)); throw Error('Recording transport'); } }, { registerTool: tool => { tools.push(tool); } });
    try {
      for (const [i, method] of catalog.methods.entries()) await tools.find(t => t.name === method.name.replaceAll('.', '_'))?.execute({ parityProbe: i });
      return { tools, requests };
    } finally { registration.dispose(); }
  });
  const sessions = await mkdtemp(`${tmpdir()}/neohack-tool-parity-`);
  const options = { enginePath: `${root}/engine/playground/nethack`, dataPath: `${root}/engine/playground`, sessionsPath: sessions };
  try {
    await check('cli mcp (native stdio discovery)', async () => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const client = new Client({ name: 'tool-parity', version: '1' });
      try {
        await client.connect(new StdioClientTransport({ command: `${root}/build/native/neonethack-mcp`, args: Object.values(options), stderr: 'pipe' }));
        const tools = []; let cursor;
        do { const page = await client.listTools(cursor ? { cursor } : {}); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
        return { tools };
      } finally { await client.close(); }
    });
    await check('http mcp (native HTTP discovery)', async () => {
      const { startMcpHttp, HTTP_PROTOCOL_VERSION: version } = await import('../tests/mcp-fixture.mjs');
      const server = http ? null : await startMcpHttp(options);
      try {
        const response = await fetch(http ?? server.url, { method: 'POST', signal: AbortSignal.timeout(10000),
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': version, 'Mcp-Method': 'tools/list' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: {
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'tool-parity', version: '1' },
          } } }) });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (body.error) throw Error(JSON.stringify(body.error));
        return { tools: body.result.tools };
      } finally { await server?.close(); }
    });
    if (scripts) await check('webscripts (bundled worker module loader + dispatch)', async () => {
      const output = `${sessions}/worker.js`;
      execFileSync('bun', ['build', `${repo}/web/neohack.dev/src/bot-worker.ts`, '--target=browser', '--format=iife', '--outfile', output], { stdio: 'pipe', timeout: 30000 });
      const chunks = []; let failure;
      const context = vm.createContext({ self: {}, console: { log() {}, warn() {}, error() {} }, crypto: globalThis.crypto, structuredClone });
      vm.runInContext(await readFile(output, 'utf8'), context, { timeout: 10000 });
      const source = `const {LowLevel}=require('neonethack/low');
        const {Neonethack}=require('neonethack/high');
        const requests=[]; const low=new LowLevel({send:r=>{requests.push(r);return Promise.resolve({});}});
        const high=new Neonethack({send:async()=>({}),close:async()=>{}});
        const names=${JSON.stringify(catalog.methods.map(m => m.name.replaceAll('.', '_')))};
        names.forEach((name,i)=>low.call(name,{parityProbe:i}));
        const report=JSON.stringify({tools:low.tools,requests,highTools:high.low.tools}); for(let i=0;i<report.length;i+=1000) console.log(report.slice(i,i+1000));
        throw Error('Parity probe finished before bot initialization');`;
      await context.self.onmessage({ data: { files: { 'main.js': source }, initial: { sessionId: 'parity' } }, ports: [{ postMessage: message => { if (message.log) chunks.push(message.log.startsWith('[Script loading] ') ? message.log.slice(17) : message.log); if (message.failure) failure=message.failure; } }] });
      const report = chunks.length ? JSON.parse(chunks.join('')) : null;
      if (!report) throw Error('Worker did not expose the low/high package imports: ' + failure);
      const highErrors = compareTools(mcpTools, report.highTools);
      if (highErrors.length) throw Error(`webscripts high.low: ${highErrors.join('; ')}`);
      return { ...report, note: 'Complete vocabulary; workshop host permits only its own run and owns session.create.' };
    });
    if (web) await check(`live webmcp (${web})`, async () => {
      const { chromium } = await import('playwright-core');
      const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, chromiumSandbox: true });
      try {
        const page = await browser.newPage();
        await page.addInitScript(() => {
          const registered = new Map();
          globalThis.__parityTools = registered;
          Object.defineProperty(document, 'modelContext', { configurable: true, value: {
            registerTool(tool) { registered.set(tool.name, { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }); },
            unregisterTool(name) { registered.delete(name); },
          } });
        });
        await page.goto(web);
        await page.waitForFunction(() => document.querySelector('[data-webmcp="ready"]'), null, { timeout: 60000 });
        return { tools: await page.evaluate(() => [...globalThis.__parityTools.values()]) };
      } finally { await browser.close(); }
    });
  } finally { await rm(sessions, { recursive: true, force: true }); }
  return { expected: mcpTools.length, ok: results.every(r => r.ok), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run check:tools -- [--json] [--web https://neohack.dev] [--http http://127.0.0.1:3333/mcp]\nRequires native build, Node dependencies and Bun. Checks local exports and actual C stdio/HTTP. --web additionally audits live page registration without creating a game.');
  } else {
    for (let i = 0; i < args.length; i++) {
      if (['--web', '--http'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) { i++; continue; }
      if (args[i] !== '--json') throw Error(`Unknown or incomplete option: ${args[i]}`);
    }
    const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    const report = await checkTools({ web: value('--web'), http: value('--http') });
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Tool parity: ${report.expected} canonical tools`);
      for (const result of report.results) {
        console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.surface}: ${result.count ?? '?'} tools`);
        for (const error of result.errors) console.log(`  ${error}`);
        if (result.note) console.log(`  ${result.note}`);
      }
    }
    process.exitCode = report.ok ? 0 : 1;
  }
}
