#!/usr/bin/env node
// agent.mjs — LLM-driven NetHack player.
//
// Plays the neonethack C engine through the native neonethack MCP HTTP server
// (~/.local/bin/neohack-mcp --http) with a Vercel AI SDK model behind any
// OpenAI-compatible endpoint.
//
// Architecture (see README.md):
//   ai-runner.sh -> agent.mjs (this file, one session of STEP_BUDGET model steps)
//                 -> retro.mjs (LLM self-review, commits improvements)
//                 -> repeat
// A heuristic advisor (advisor.mjs) is run on every tool result and its
// suggestion is appended to what the model sees; the model may override it.
//
// Configuration comes from the environment (a git-ignored .env is loaded
// first; real environment variables win). See .env.example.

import { generateText, stepCountIs, dynamicTool, jsonSchema } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';

const BOT_DIR = dirname(fileURLToPath(import.meta.url));

// ---- .env (git-ignored; real environment variables take precedence) ----
const envFile = join(BOT_DIR, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---- configuration ----
const ROOT = process.env.NEONETHACK_ROOT ?? resolve(BOT_DIR, '../..');
const LIB = join(ROOT, 'lib/neonethack');
const ENGINE = process.env.NEONETHACK_ENGINE ?? join(LIB, 'engine/playground/nethack');
const DATA = process.env.NEONETHACK_DATA ?? join(LIB, 'engine/playground');
const SESSIONS = process.env.NEONETHACK_SESSIONS ?? join(BOT_DIR, 'sessions');
const STEP_BUDGET = parseInt(process.env.STEP_BUDGET ?? process.argv[2] ?? '1000', 10);
const BASE_URL = process.env.OPENAI_API_BASE ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
const API_KEY = process.env.OPENAI_API_KEY ?? 'dummy';
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.6-luna';

// State directory: everything the bot iterates on lives here — conversation,
// game state, observations, logs, the LLM-improved system-prompt.md and
// advisor.mjs. Point NEONETHACK_BOT_STATE elsewhere to run against a
// different working copy of the bot's "mind".
const STATE_DIR = process.env.NEONETHACK_BOT_STATE ?? join(BOT_DIR, 'state');
const LOG_DIR = join(STATE_DIR, 'logs');
const DOCTRINE_F = join(STATE_DIR, 'system-prompt.md');      // iterated by retro
const ADVISOR_F = join(STATE_DIR, 'advisor.mjs');            // iterated by retro
const BUNDLED_DOCTRINE = join(BOT_DIR, 'system-prompt.md');  // committed default
const BUNDLED_ADVISOR = join(BOT_DIR, 'advisor.mjs');        // committed default
const STATE_F = `${STATE_DIR}/game-state.json`;
const CONV_F = `${STATE_DIR}/conversation.json`;
const OBS_F = `${STATE_DIR}/last-obs.json`;
const DEATH_F = `${STATE_DIR}/last-death.json`;
const LASTRUN_F = `${STATE_DIR}/last-run.json`;
const LOG = `${LOG_DIR}/agent.log`;

for (const d of [STATE_DIR, LOG_DIR, SESSIONS]) mkdirSync(d, { recursive: true });

// A second agent pointed at the same state/session causes an MCP sessionBusy
// loop. Refuse concurrent ownership instead of wasting model calls.
let mcpServer = null;
const LOCK_DIR = join(STATE_DIR, 'agent.lock');
try {
  mkdirSync(LOCK_DIR);
} catch (e) {
  let owner = 'unknown';
  try { owner = readFileSync(join(LOCK_DIR, 'pid'), 'utf8').trim(); } catch {}
  let live = false;
  try { process.kill(Number(owner), 0); live = true; } catch {}
  if (live) {
    console.error(`Another agent (pid ${owner}) already owns state directory ${STATE_DIR}`);
    process.exit(2);
  }
  rmSync(LOCK_DIR, { recursive: true, force: true });
  mkdirSync(LOCK_DIR);
}
writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
const releaseLock = () => rmSync(LOCK_DIR, { recursive: true, force: true });
const releaseResources = () => {
  if (mcpServer?.exitCode === null) mcpServer.kill('SIGTERM');
  releaseLock();
};
process.once('exit', releaseResources);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { releaseResources(); process.exit(128 + (signal === 'SIGINT' ? 2 : 15)); });
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}
function loadJson(f, d) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } }
function saveJson(f, v) { writeFileSync(f, JSON.stringify(v, null, 2)); }

const state = loadJson(STATE_F, { gameId: null, reqSeq: 0 });
let lastSessionId = state.gameId;
let deathSeen = false;
// skill guards: the bot "dies" when it stops making progress
let stalledOps = 0;   // consecutive interactions without game-turn advancement
let lastTurnSeen = null;
let toollessSteps = 0; // consecutive model steps without any tool call

// ---- MCP HTTP 2026-07-28 -------------------------------------------------
// The installed native target is stateless HTTP, not legacy stdio MCP. It
// uses server/discover and request metadata headers that SDK 1.x does not yet
// send, so use its small wire protocol directly.
const MCP_BIN = process.env.NEONETHACK_MCP ?? join(homedir(), '.local/bin/neohack-mcp');
const MCP_HTTP_PORT = parseInt(process.env.NEONETHACK_MCP_HTTP_PORT ?? '18765', 10);
const externalMcpUrl = process.env.NEONETHACK_MCP_HTTP_URL;
const MCP_HTTP_URL = externalMcpUrl ?? `http://127.0.0.1:${MCP_HTTP_PORT}/mcp`;
const MCP_PROTOCOL_VERSION = '2026-07-28';
const MCP_META = {
  'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};
let mcpServerError = '';

if (!externalMcpUrl) {
  if (!existsSync(MCP_BIN)) throw new Error(`MCP executable not found: ${MCP_BIN}`);
  log(`starting MCP HTTP target: ${MCP_BIN} --http ${MCP_HTTP_PORT}`);
  mcpServer = spawn(MCP_BIN, ['--http', String(MCP_HTTP_PORT), ENGINE, DATA, SESSIONS], {
    cwd: LIB,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  mcpServer.stderr.on('data', chunk => { mcpServerError = (mcpServerError + chunk).slice(-2000); });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (mcpServer.exitCode !== null) throw new Error(`MCP HTTP target exited: ${mcpServerError.trim()}`);
    try {
      const response = await fetch(MCP_HTTP_URL);
      if (response.status === 405) break; // Expected: HTTP MCP accepts POST only.
    } catch {}
    if (attempt === 49) throw new Error(`MCP HTTP target did not become ready at ${MCP_HTTP_URL}: ${mcpServerError.trim()}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

let rpcId = 0;
async function mcpRpc(method, params = {}, name = null) {
  const body = {
    jsonrpc: '2.0',
    id: ++rpcId,
    method,
    params: { ...params, _meta: { ...MCP_META, ...(params._meta ?? {}) } },
  };
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    'Mcp-Method': method,
  };
  if (name) headers['Mcp-Name'] = name;
  const response = await fetch(MCP_HTTP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) {
    const error = payload?.error ?? { code: `http${response.status}`, message: response.statusText };
    throw new Error(`${error.code}: ${error.message}`);
  }
  return payload.result;
}

async function callBridge(tool, params) {
  const r = await mcpRpc('tools/call', { name: tool, arguments: params }, tool);
  const structuredContent = r?.structuredContent ?? null;
  const contentText = r?.content?.map(c => c.text ?? '').join('') ?? '';
  const text = structuredContent ? JSON.stringify(structuredContent) : contentText;
  return {
    text,
    structuredContent,
    isError: r?.isError === true || Boolean(structuredContent?.error),
    error: structuredContent?.error ?? null,
  };
}

const discovery = await mcpRpc('server/discover');
if (!discovery?.supportedVersions?.includes(MCP_PROTOCOL_VERSION)) {
  throw new Error(`MCP target does not support ${MCP_PROTOCOL_VERSION}`);
}
const { tools: mcpTools = [] } = await mcpRpc('tools/list');
log(`connected MCP HTTP ${MCP_PROTOCOL_VERSION} at ${MCP_HTTP_URL}; tools discovered: ${mcpTools.length}`);

// A new MCP server has no in-memory active session. Load the saved recording
// before asking the model to act. Stale IDs are cleared; contention is fatal.
if (lastSessionId) {
  const resumed = await callBridge('session_resume', { sessionId: lastSessionId });
  if (resumed.isError) {
    const code = resumed.error?.code ?? 'unknownError';
    const message = resumed.error?.message ?? resumed.text.slice(0, 300);
    if (code === 'sessionBusy') {
      log(`startup failed: ${code}: ${message}`);
      if (mcpServer) mcpServer.kill('SIGTERM');
      process.exitCode = 2;
      throw new Error(`Session ${lastSessionId} is busy; stop the other agent before retrying`);
    }
    log(`saved session ${lastSessionId} unavailable (${code}: ${message}); starting a new adventure`);
    lastSessionId = null;
    state.gameId = null;
    saveJson(STATE_F, state);
    saveJson(CONV_F, []);
  } else {
    const turn = resumed.structuredContent?.observation?.turn ?? '?';
    log(`session resumed: ${lastSessionId} turn=${turn}`);
  }
}

let opCount = 0;
const tools = {};
for (const t of mcpTools) {
  tools[t.name] = dynamicTool({
    description: (t.description ?? '').slice(0, 3500),
    inputSchema: jsonSchema(t.inputSchema ?? { type: 'object', properties: {} }),
    execute: async (args) => {
      opCount++;
      try {
        let { text, structuredContent, isError: bridgeIsError, error: bridgeError } = await callBridge(t.name, args ?? {});
        const turn = structuredContent?.observation?.turn;
        const depth = structuredContent?.observation?.vitals?.depth;
        if (bridgeIsError) {
          const code = bridgeError?.code ?? 'toolError';
          const message = bridgeError?.message ?? text.slice(0, 300);
          log(`op#${opCount} ${t.name} ERROR ${code}: ${message}`);
          return `MCP error ${code}: ${message}`;
        }
        // Capture only a successful, structurally valid session id.
        const candidateSid = structuredContent?.sessionId;
        const sid = /^g-[A-Za-z0-9]+-[A-Za-z0-9]+-\d+-[A-Za-z0-9]+$/.test(candidateSid ?? '') ? candidateSid : undefined;
        if (sid && sid !== lastSessionId) {
          lastSessionId = sid;
          state.gameId = sid;
          saveJson(STATE_F, state);
          log(`session captured: ${sid}`);
        }
        // save the freshest observation for the heuristic advisor, then run it
        let advisorNote = '';
        try {
          const j = JSON.parse(text);
          const sc = j?.data?.output?.structuredContent ?? j;
          if (sc?.observation) {
            saveJson(OBS_F, { sessionId: sc.sessionId ?? lastSessionId, revision: sc.revision, decision: sc.decision ?? null, observation: sc.observation });
            try {
              const advisorSrc = existsSync(ADVISOR_F) ? ADVISOR_F : BUNDLED_ADVISOR;
              const out = execFileSync('node', [advisorSrc, OBS_F], { timeout: 5000, encoding: 'utf8' });
              advisorNote = `\n\nADVISOR (heuristic decision tree — strong prior from past deaths; you may override): ${out.trim().slice(0, 500)}`;
              const aj = JSON.parse(out);
              log(`advisor: p${aj.priority} ${aj.tool} — ${String(aj.reason).slice(0, 90)}`);
            } catch (e) {
              log(`advisor failed: ${String(e.message ?? e).slice(0, 120)}`);
            }
          }
          // shrink the text the model sees: drop the bulky remembered-map array
          // (the advisor does pathfinding on the full map in state/last-obs.json)
          const sc2 = j?.data?.output?.structuredContent ?? j;
          if (sc2?.observation?.world && Array.isArray(sc2.observation.world)) {
            const n = sc2.observation.world.length;
            sc2.observation.world = { stripped: `${n} remembered cells — full map handled by ADVISOR; unknown cells listed in neighborhood` };
          }
          text = JSON.stringify(sc2 ?? j);
        } catch {}
        if (/killed by|You die|died of|game.?over|ascended/i.test(text)) {
          const cause = text.match(/(killed by[^"\\]{0,80}|died of[^"\\]{0,80}|ascended[^"\\]{0,40})/i)?.[1] ?? 'unknown';
          saveJson(DEATH_F, { cause, turn: turn ?? null, depth: depth ?? null, at: new Date().toISOString() });
          log(`op#${opCount} ${t.name} turn=${turn ?? '?'} <<DEATH>> ${cause}`);
          deathSeen = true;
        } else if (turn !== undefined) {
          log(`op#${opCount} ${t.name} turn=${turn} depth=${depth ?? '?'}`);
        } else {
          log(`op#${opCount} ${t.name} ok revision=${structuredContent?.revision ?? '?'}`);
        }
        // Skill guard 1: only observation-bearing game interactions can prove
        // turn progress. Metadata tools such as session_actions are successful
        // without an observation and must not count as stalls.
        if ((t.name.startsWith('game_') || t.name.startsWith('session_')) && turn !== undefined) {
          const turnNum = Number(turn);
          if (turnNum === lastTurnSeen) stalledOps++;
          else { stalledOps = 0; lastTurnSeen = turnNum; }
          if (stalledOps >= 10) {
            saveJson(DEATH_F, { cause: 'skills: 10 interactions without advancing the game', turn: turnNum, depth: depth ?? null, at: new Date().toISOString() });
            log(`op#${opCount} ${t.name} <<SKILL-DEATH>> 10 interactions without advancing`);
            deathSeen = true;
          }
        }
        return (text + advisorNote).slice(0, 20000);
      } catch (e) {
        log(`op#${opCount} ${t.name} ERROR: ${String(e.message ?? e).slice(0, 200)}`);
        return `Tool error: ${String(e.message ?? e).slice(0, 500)}`;
      }
    },
  });
}

const openai = createOpenAI({ baseURL: BASE_URL, apiKey: API_KEY });
const model = openai.chat(MODEL);

// system prompt: LLM-editable doctrine in system-prompt.md + fixed session line
let doctrine = '';
try { doctrine = readFileSync(DOCTRINE_F, 'utf8'); } catch { doctrine = readFileSync(BUNDLED_DOCTRINE, 'utf8'); }
const system = `${doctrine}

SESSION: active session "${lastSessionId ?? 'UNKNOWN'}". Your first action: session_observe {"sessionId":"${lastSessionId ?? 'UNKNOWN'}"} to see the world. If it errors, try session_resume {"sessionId":"${lastSessionId ?? 'UNKNOWN'}"}.`;

const initialPrompt = state.gameId
  ? `Continue the active adventure (sessionId ${state.gameId}). Observe, then play turn after turn. Descend as deep as you can.`
  : 'Start a fresh adventure: session_create {"name":"Ada","role":"valkyrie"}, then play. Descend as deep as you can.';

// persistent conversation: survives process restarts, reset on death
let messages = loadJson(CONV_F, null);
if (Array.isArray(messages) && messages.length) {
  // sanitize: deep-truncate oversized strings (tool results can be large)
  const deepTrunc = (o, cap = 6000) => {
    if (typeof o === 'string') return o.length > cap ? o.slice(0, cap) + '[truncated]' : o;
    if (Array.isArray(o)) return o.map(x => deepTrunc(x, cap));
    if (o && typeof o === 'object') { const r = {}; for (const k in o) r[k] = deepTrunc(o[k], cap); return r; }
    return o;
  };
  messages = deepTrunc(JSON.parse(JSON.stringify(messages)));
  if (messages.length > 60) messages = messages.slice(-58);
  log(`continuing conversation (${messages.length} messages, deep-truncated)`);
} else {
  messages = [{ role: 'user', content: initialPrompt }];
  log('fresh conversation');
}
function resetConversation() { saveJson(CONV_F, []); }

let totalSteps = 0;

try {
  while (totalSteps < STEP_BUDGET) {
    const t0 = Date.now();
    log(`model turn starting (steps ${totalSteps}/${STEP_BUDGET})...`);
    const res = await generateText({
      model,
      system,
      messages,
      tools,
      stopWhen: stepCountIs(Math.min(60, STEP_BUDGET - totalSteps)),
    });
    log(`model turn done in ${((Date.now() - t0) / 1000).toFixed(1)}s (+${res.response.messages.length} msgs)`);
    for (const m of res.response.messages) {
      messages.push(m);
      totalSteps++;
      // skill guard 2: model steps without any tool call (talking instead of acting)
      const hasToolCall = m.role === 'assistant' && Array.isArray(m.content) && m.content.some(c => c.type === 'tool-call');
      if (hasToolCall) toollessSteps = 0; else toollessSteps++;
    }
    if (toollessSteps >= 20 && !deathSeen) {
      saveJson(DEATH_F, { cause: 'skills: 20 model steps without interacting with the environment', at: new Date().toISOString() });
      log(`<<SKILL-DEATH>> ${toollessSteps} model steps without a tool call`);
      deathSeen = true;
    }
    messages.push({ role: 'user', content: deathSeen ? 'A death occurred — if the adventure is over, start a NEW game (session_create {"name":"Ada","role":"valkyrie"}) and keep playing.' : 'Continue.' });
    if (messages.length > 60) {
      messages = [messages[0], ...messages.slice(-58)];
    }
    saveJson(CONV_F, messages);
    saveJson(LASTRUN_F, { finishedAt: new Date().toISOString(), totalSteps, deathSeen });
    if (deathSeen) { log('death detected — ending run (conversation reset)'); saveJson(CONV_F, []); break; }
    if (res.text) log(`model: ${res.text.slice(0, 300)}`);
  }
} catch (e) {
  log(`agent error: ${String(e.stack ?? e).slice(0, 800)}`);
} finally {
  log(`run complete: ${totalSteps} steps, session=${lastSessionId}`);
  state.gameId = lastSessionId;
  saveJson(STATE_F, state);
  if (mcpServer && mcpServer.exitCode === null) {
    mcpServer.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { mcpServer.kill('SIGKILL'); resolve(); }, 2000);
      mcpServer.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
