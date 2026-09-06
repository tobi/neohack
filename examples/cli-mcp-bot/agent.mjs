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
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
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
const STEP_BUDGET = parseInt(process.env.STEP_BUDGET ?? '1000', 10);
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
log(`connecting neonethack MCP stdio server (model ${MODEL} @ ${BASE_URL})...`);
const transport = new StdioClientTransport({
  command: 'node',
  args: [join(LIB, 'dist/mcp/cli.js'), ENGINE, DATA, SESSIONS],
  env: { ...process.env, NEONETHACK_EXECUTABLE: EXECUTABLE },
  cwd: LIB,
});
const client = new Client({ name: 'nethack-ai', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

async function callBridge(tool, params) {
  const r = await client.callTool({ name: tool, arguments: params });
  let text = r?.content?.map(c => c.text ?? '').join('') ?? '';
  if (!text && r?.structuredContent) text = JSON.stringify(r.structuredContent);
  return text;
}

// The server exposes the same 27 game tools natively (session_create,
// game_move, decision_answer, ...).
let mcpTools = [];
{
  const { tools: listed } = await client.listTools();
  mcpTools = listed;
}
log(`tools discovered: ${mcpTools.length}`);

let opCount = 0;
const tools = {};
for (const t of mcpTools) {
  tools[t.name] = dynamicTool({
    description: (t.description ?? '').slice(0, 3500),
    inputSchema: jsonSchema(t.inputSchema ?? { type: 'object', properties: {} }),
    execute: async (args) => {
      opCount++;
      try {
        let text = await callBridge(t.name, args ?? {});
        const turn = text.match(/"turn"\s*:\s*(\d+)/)?.[1];
        const depth = text.match(/"depth"\s*:\s*("?\s*\d+)|(\d+)/)?.[0];
        const sid = text.match(/"sessionId"\s*:\s*"([^"]+)"/)?.[1];
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
        } else {
          log(`op#${opCount} ${t.name} turn=${turn ?? '?'} depth=${depth ?? '?'}`);
        }
        // skill guard 1: interactions without game-turn advancement
        if (t.name.startsWith('game_') || t.name.startsWith('session_')) {
          const turnNum = parseInt(turn ?? 'NaN');
          if (Number.isNaN(turnNum) || turnNum === lastTurnSeen) stalledOps++;
          else { stalledOps = 0; lastTurnSeen = turnNum; }
          if (stalledOps >= 10) {
            saveJson(DEATH_F, { cause: 'skills: 10 interactions without advancing the game', turn: turnNum ?? null, depth: depth ?? null, at: new Date().toISOString() });
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
