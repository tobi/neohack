#!/usr/bin/env node
/** Executable contract audit. Never calls gameplay tools against a remote page. */
import { isDeepStrictEqual } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import Ajv from 'ajv/dist/2020.js';
import { catalog } from '../protocol/catalog.ts';
import { mcpTools } from '../protocol/mcp.ts';
import { agentMethods, agentOmitted, agentTools } from '../protocol/agent.ts';
import { mcpResponseSchema } from '../protocol/response.ts';

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
    for (const field of ['description', 'inputSchema', 'outputSchema']) {
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

/** A high-level vocabulary can differ, but every low operation needs an
 * explicit mapping or a stated reason for its absence. Runtime contract tests
 * prove the mappings execute; an omission may not also be covered. */
export function operationCoverage(operations, mappings, omitted = {}) {
  const known = new Set(operations.map(m => m.name)), covered = new Set(), errors = [];
  for (const mapping of mappings) for (const name of mapping.covers) {
    if (!known.has(name)) errors.push(`${mapping.name}: unknown operation ${name}`);
    covered.add(name);
  }
  for (const [name, reason] of Object.entries(omitted)) {
    if (!known.has(name)) errors.push(`omitted: unknown operation ${name}`);
    if (covered.has(name)) errors.push(`omitted operation is also covered: ${name}`);
    if (typeof reason !== 'string' || !reason.trim()) errors.push(`omitted without a reason: ${name}`);
  }
  for (const name of known) if (!covered.has(name) && !Object.hasOwn(omitted, name)) errors.push(`uncovered operation: ${name}`);
  return errors;
}

/** Check the advertised grammar without submitting input or changing fixtures. */
export function agentSchemaContract() {
  const errors = [], ajv = new Ajv({strict:false});
  const schemas = new Map(agentTools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
  const basis = {sessionId:'schema-probe', viewId:'view-probe'};
  function accepts(name, args, expected) {
    const validate = schemas.get(name);
    if (!validate || Boolean(validate(args)) !== expected) errors.push(`${name}: ${expected ? 'rejected valid' : 'accepted invalid'} arguments ${JSON.stringify(args)}`);
  }
  for (const tool of agentTools) {
    if (!isDeepStrictEqual(tool.outputSchema, mcpResponseSchema)) errors.push(tool.name+': missing DecisionFrame output schema');
  }
  for (const variant of agentMethods) {
    const schema=variant.schema;
    const guarded=!variant.readOnly&&!['session.create','session.resume','session.close','decision.answer','decision.cancel'].includes(variant.method);
    if(guarded&&!schema.required.includes('viewId'))errors.push(variant.method+': missing required viewId');
    if(variant.method.startsWith('decision.')&&!schema.required.includes('decisionId'))errors.push(variant.method+': missing exact decisionId');
  }
  for(const [name,selector] of [['travel',{mode:'step'}],...['attack','open','close','kick','chat'].map(action=>['interact',{action}])]){
    for(const target of [{direction:'east'},{position:{x:31,y:15}},{ref:'seen-17'},{symbol:'g',scope:'adjacent'}])accepts(name,{...basis,...selector,target},true);
    for(const target of ['east',{x:31,y:15},{direction:'self'},{symbol:'g',scope:'level'},{direction:'east',ref:'seen-17'}])accepts(name,{...basis,...selector,target},false);
    accepts(name,{sessionId:basis.sessionId,...selector,target:{direction:'east'}},false);
  }
  for(const action of ['fire','throw','zap']){
    for(const direction of ['self','up','down','east'])accepts('use',{...basis,action,target:{direction}},true);
    for(const target of ['self',{position:{x:31,y:15}},{ref:'seen-17'},{symbol:'g',scope:'adjacent'}])accepts('use',{...basis,action,target},false);
  }
  accepts('interact',{sessionId:basis.sessionId},true);
  accepts('interact',{sessionId:basis.sessionId,target:{symbol:'g',scope:'level'}},true);
  accepts('use',{sessionId:basis.sessionId,itemId:'item'},true);
  accepts('use',{sessionId:basis.sessionId,itemId:'item',quantity:1},false);
  accepts('use',{...basis,action:'cast',itemId:'item'},false);
  for(const mode of ['to','explore','descend']){
    const args={...basis,mode,...(mode==='to'?{to:{x:31,y:15}}:{})};
    accepts('travel',{...args,maxPlanningMs:0},true);
    accepts('travel',{...args,maxPlanningMs:-1},false);
    accepts('travel',{...args,timeoutMs:1000},false);
    accepts('travel',{...args,includeWorld:false,sinceViewId:'view-old'},true);
  }
  accepts('travel',{...basis,mode:'run',direction:'east',runMode:'pastBranches',noPickup:true},true);
  accepts('travel',{...basis,mode:'to',direction:'east'},false);
  accepts('respond',{sessionId:basis.sessionId,action:'answer',decisionId:'decision-exact',value:false},true);
  accepts('respond',{sessionId:basis.sessionId,action:'answer',decisionId:'decision-exact',value:[]},true);
  accepts('respond',{sessionId:basis.sessionId,action:'answer',value:false},false);
  accepts('respond',{sessionId:basis.sessionId,action:'cancel',decisionId:'decision-exact'},true);
  accepts('respond',{sessionId:basis.sessionId,action:'cancel',decisionId:'decision-exact',value:false},false);
  accepts('session',{action:'create',includeWorld:true},true);
  accepts('session',{sessionId:basis.sessionId,action:'quit'},false);
  const validateFrame = ajv.compile(mcpResponseSchema);
  const frame = {version:2,basis:null,control:{gate:'unavailable'},outcome:null,scene:null,decision:null,events:[],diagnostics:{}};
  if (!validateFrame(frame)) errors.push('DecisionFrame rejects a sessionless unavailable frame');
  const current = {...frame,basis:{...basis,revision:1,levelId:'level-1',turn:7},control:{gate:'ready'},
    outcome:{submission:'accepted',status:'planningLimit',actionsTaken:1,turnsElapsed:1,positionChanged:true,sceneChanged:true},
    scene:{kind:'snapshot',self:{position:{x:31,y:15},location:{},vitals:{}},nearby:{status:'unavailable'},entities:[],features:[],map:null,
      inventory:[],inventoryKnown:false,here:{},perception:{},end:null,world:[],knowledge:{}},
    result:{kind:'navigationLeg',reason:'planningLimit',queryCount:1,planningElapsedMs:1000},diagnostics:{anyExtension:{allowed:true}}};
  if (!validateFrame(current)) errors.push(`DecisionFrame rejects a current snapshot: ${ajv.errorsText(validateFrame.errors)}`);
  for (const gate of ['ready','decision','recoveryRequired','ownershipLost','ended','unavailable']) {
    if (!validateFrame({...current,control:{gate}})) errors.push(`DecisionFrame rejects gate ${gate}`);
  }
  for (const submission of ['accepted','rejected','unknown','notSubmitted']) {
    if (!validateFrame({...current,outcome:{...current.outcome,submission}})) errors.push(`DecisionFrame rejects submission ${submission}`);
  }
  const question = {id:'decision-exact',kind:'confirmation',cancellable:true,
    reply:{tool:'respond',arguments:{sessionId:basis.sessionId,decisionId:'decision-exact',action:'answer'},valueSchema:{type:'boolean'},instruction:'Choose explicitly.'},
    cancel:{tool:'respond',arguments:{sessionId:basis.sessionId,decisionId:'decision-exact',action:'cancel'}}};
  if (!validateFrame({...current,decision:question,control:{gate:'decision',decisionId:question.id}})) errors.push('DecisionFrame rejects nested decision syntax');
  if (validateFrame({...current,decision:{...question,reply:{...question.reply,arguments:{sessionId:basis.sessionId}}}})) errors.push('DecisionFrame permits reply without exact decisionId');
  if (validateFrame({...current,scene:{...current.scene,self:{...current.scene.self,turn:7}}})) errors.push('DecisionFrame permits duplicate turn in self');
  const {end: _end,...withoutEnd} = current.scene;
  if (validateFrame({...current,scene:withoutEnd})) errors.push('DecisionFrame permits a snapshot without end');
  for (const scene of [{kind:'delta',baseViewId:'view-old'},
    {kind:'delta',baseViewId:'view-old',world:[{x:31,y:15,terrain:{type:'floor'}}],worldRemoved:[{x:30,y:15}],remove:['knowledge']}]) {
    if (!validateFrame({...current,scene})) errors.push('DecisionFrame rejects a partial scene delta');
  }
  for (const scene of [{kind:'delta'}, {kind:'delta',baseViewId:'view-old',remove:['self']},
    {kind:'delta',baseViewId:'view-old',worldRemoved:[[30,15]]}]) {
    if (validateFrame({...current,scene})) errors.push('DecisionFrame permits an invalid delta baseline or removal');
  }
  for (const key of ['state','observation','messages','context','reply','receipt','ended','turn']) {
    if (validateFrame({...frame,[key]:{}})) errors.push(`DecisionFrame accepts legacy root ${key}`);
  }
  for (const key of ['basis','control','outcome','scene','decision','events','diagnostics']) {
    const incomplete = {...frame}; delete incomplete[key];
    if (validateFrame(incomplete)) errors.push(`DecisionFrame permits missing ${key}`);
  }
  if (validateFrame({...frame,version:1})) errors.push('DecisionFrame accepts legacy version');
  return errors;
}

export async function checkTools({ web, http, scripts = true } = {}) {
  const results = [];
  async function check(surface, run, expected = mcpTools) {
    try {
      const { tools, requests, note } = await run();
      const errors = compareTools(expected, tools);
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
  const coverageErrors = operationCoverage(catalog.methods, agentMethods, agentOmitted);
  const schemaErrors = agentSchemaContract();
  results.push({surface:'agent input/output schema contract', count:agentTools.length, ok:!schemaErrors.length, errors:schemaErrors});
  results.push({surface: 'agent operation mappings', count: catalog.methods.length, ok: !coverageErrors.length, errors: coverageErrors,
    note: `Declared coverage; engine-backed agent tests separately verify guards, navigation and recovery. Deliberately absent: ${Object.keys(agentOmitted).join(', ') || 'none'}.`});
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
  await check('webmcp (navigation registration)', async () => {
    const {registerWebMcp} = await import('neonethack/webmcp');
    const tools = [];
    const registration = await registerWebMcp({send: async () => {throw Error('Discovery must not submit engine input');}}, {registerTool: tool => tools.push(tool)});
    try { return {tools}; } finally {registration.dispose();}
  }, agentTools);
  const sessions = await mkdtemp(`${tmpdir()}/neohack-tool-parity-`);
  const options = { enginePath: `${root}/engine/playground/nethack`, dataPath: `${root}/engine/playground`, sessionsPath: sessions };
  try {
    await check(`cli mcp (Bun/WASM stdio discovery)`, async () => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const client = new Client({ name: 'tool-parity', version: '1' });
      try {
        await client.connect(new StdioClientTransport({ command: `${root}/dist/mcp/cli.js`, args: ['--sessions', sessions], stderr: 'pipe' }));
        const tools = []; let cursor;
        do { const page = await client.listTools(cursor ? { cursor } : {}); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
        return { tools };
      } finally { await client.close(); }
    }, agentTools);
    await check(`http mcp (Bun/WASM HTTP discovery)`, async () => {
      const { startMcpHttp, HTTP_PROTOCOL_VERSION: version } = await import('../tests/mcp-fixture.mjs');
      const external = http;
      const server = external ? null : await startMcpHttp(options);
      try {
        const response = await fetch(external ?? server.url, { method: 'POST', signal: AbortSignal.timeout(10000),
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
    }, agentTools);
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
            registerTool(tool) { registered.set(tool.name, { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations }); },
            unregisterTool(name) { registered.delete(name); },
          } });
        });
        await page.goto(web);
        await page.waitForFunction(() => document.querySelector('[data-webmcp="ready"]'), null, { timeout: 60000 });
        return { tools: await page.evaluate(() => [...globalThis.__parityTools.values()]) };
      } finally { await browser.close(); }
    }, agentTools);
  } finally { await rm(sessions, { recursive: true, force: true }); }
  return { expected: mcpTools.length, ok: results.every(r => r.ok), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run check:tools -- [--json] [--web https://neohack.dev] [--http http://127.0.0.1:3333/mcp]\nRequires the built library, WASM package, Node dependencies and Bun. Checks local exports and actual Bun/WASM stdio/HTTP. --web additionally audits live page registration without creating a game.');
  } else {
    for (let i = 0; i < args.length; i++) {
      if (['--web', '--http'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) { i++; continue; }
      if (args[i] !== '--json') throw Error(`Unknown or incomplete option: ${args[i]}`);
    }
    const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    const report = await checkTools({ web: value('--web'), http: value('--http') });
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Operation coverage: ${report.expected} low-level operations; distinct low-level and v2 agent catalogs`);
      for (const result of report.results) {
        console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.surface}: ${result.count ?? '?'} tools`);
        for (const error of result.errors) console.log(`  ${error}`);
        if (result.note) console.log(`  ${result.note}`);
      }
    }
    process.exitCode = report.ok ? 0 : 1;
  }
}
