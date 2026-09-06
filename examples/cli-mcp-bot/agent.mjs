#!/usr/bin/env node
// agent.mjs — LLM-driven NetHack player.
//
// Plays the neonethack C engine through the neonethack MCP stdio server
// (lib/neonethack/dist/mcp/cli.js) with a Vercel AI SDK model behind any
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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { generateText, stepCountIs, dynamicTool, jsonSchema } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

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
const EXECUTABLE = process.env.NEONETHACK_EXECUTABLE ?? join(LIB, 'build/native/neonethack');
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
process.once('exit', releaseLock);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { releaseLock(); process.exit(128 + (signal === 'SIGINT' ? 2 : 15)); });
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

// ---- MCP: the neonethack MCP stdio server hosts the C engine directly ----
// Prefer the compiled server at ~/.local/bin/neohack-mcp (bun build --compile
// dist/mcp/cli.js); falls back to `node dist/mcp/cli.js` from the checkout.
const MCP_BIN = process.env.NEONETHACK_MCP ?? (existsSync(join(homedir(), '.local/bin/neohack-mcp')) ? join(homedir(), '.local/bin/neohack-mcp') : join(LIB, 'dist/mcp/cli.js'));
const useNodeScript = MCP_BIN.endsWith('.js');
log(`connecting neonethack MCP stdio server (${MCP_BIN}, model ${MODEL} @ ${BASE_URL})...`);
const transport = new StdioClientTransport({
  command: useNodeScript ? 'node' : MCP_BIN,
  args: useNodeScript ? [MCP_BIN, ENGINE, DATA, SESSIONS] : [ENGINE, DATA, SESSIONS],
  env: { ...process.env, NEONETHACK_EXECUTABLE: EXECUTABLE },
  cwd: LIB,
});
const client = new Client({ name: 'nethack-ai', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

async function callBridge(tool, params) {
  const r = await client.callTool({ name: tool, arguments: params });
  const structuredContent = r?.structuredContent ?? null;
  const contentText = r?.content?.map(c => c.text ?? '').join('') ?? '';
  // structuredContent is authoritative. Text content can be empty, prose, or
  // a compatibility rendering and must not be regex-parsed as protocol data.
  const text = structuredContent ? JSON.stringify(structuredContent) : contentText;
  return {
    text,
    structuredContent,
    isError: r?.isError === true || Boolean(structuredContent?.error),
    error: structuredContent?.error ?? null,
  };
}

// The server exposes the same 27 game tools natively (session_create,
// game_move, decision_answer, ...).
let mcpTools = [];
{
  const { tools: listed } = await client.listTools();
  mcpTools = listed;
}
log(`tools discovered: ${mcpTools.length}`);

// A new MCP server has no in-memory active session. Load the saved recording
// before asking the model to act. Stale IDs are cleared; contention is fatal.
if (lastSessionId) {
  const resumed = await callBridge('session_resume', { sessionId: lastSessionId });
  if (resumed.isError) {
    const code = resumed.error?.code ?? 'unknownError';
    const message = resumed.error?.message ?? resumed.text.slice(0, 300);
    if (code === 'sessionBusy') {
      log(`startup failed: ${code}: ${message}`);
      await client.close();
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
  try { await client.close(); } catch {}
}
