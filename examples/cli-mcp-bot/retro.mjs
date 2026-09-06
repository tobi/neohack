#!/usr/bin/env node
// retro.mjs — after every agent session: analyze the log, let the LLM improve
// the system prompt (system-prompt.md) and the advisor (advisor.mjs), validate,
// and git-commit the result. Failures revert cleanly (git + syntax checks).
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { readFileSync, writeFileSync, appendFileSync, existsSync, copyFileSync, unlinkSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';

import { dirname, join as joinPath, resolve } from 'path';
import { fileURLToPath } from 'url';
const BOT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.NEONETHACK_ROOT ?? resolve(BOT_DIR, '../..');
const AIDIR = BOT_DIR;
const LOG = `${AIDIR}/logs/retro.log`;
const BOT_REL = process.env.NEONETHACK_BOT_REL ?? 'examples/cli-mcp-bot';

if (!existsSync(`${AIDIR}/logs`)) mkdirSync(`${AIDIR}/logs`, { recursive: true });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}
function git(args) {
  try { return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }); } catch { return ''; }
}
function sh(cmd) { try { return execFileSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 15000 }); } catch { return ''; } }

// ---- gather session evidence ----
const logText = existsSync(`${AIDIR}/ai-agent.log`) ? readFileSync(`${AIDIR}/logs/agent.log`, 'utf8') : '';
const lines = logText.split('\n').filter(l => l.includes('op#'));
const opsByTool = {};
let deaths = 0, errors = 0, maxTurn = 0, maxDepth = 0;
for (const l of lines) {
  const tool = l.match(/op#\d+ (\S+)/)?.[1] ?? '?';
  opsByTool[tool] = (opsByTool[tool] ?? 0) + 1;
  if (l.includes('<<DEATH>>')) deaths++;
  if (l.includes('ERROR')) errors++;
  maxTurn = Math.max(maxTurn, parseInt(l.match(/turn=(\d+)/)?.[1] ?? '0'));
  maxDepth = Math.max(maxDepth, parseInt(l.match(/depth=(\d+)/)?.[1] ?? '0'));
}
const deathCauses = existsSync(`${AIDIR}/state/last-death.json`) ? readFileSync(`${AIDIR}/state/last-death.json`, 'utf8') : '(none recorded)';
const tail = lines.slice(-40).join('\n');
const advisorLines = logText.split('\n').filter(l => l.includes('advisor:')).slice(-20).join('\n');
const lastRun = existsSync(`${AIDIR}/state/last-run.json`) ? readFileSync(`${AIDIR}/state/last-run.json`, 'utf8') : '{}';

// session summary written by the agent on exit if available
const stats = {
  ops: lines.length, deaths, errors, maxTurn, maxDepth,
  opsByTool,
  deathCauses,
  recentOps: tail,
  recentAdvisor: advisorLines,
};
console.log(`retro: ops=${stats.ops} deaths=${deaths} errors=${stats.errors} maxTurn=${stats.maxTurn} maxDepth=${stats.maxDepth}`);
appendFileSync(LOG, `\n## session ${new Date().toISOString()} — ops=${stats.ops} deaths=${deaths} maxTurn=${stats.maxTurn} maxDepth=${stats.maxDepth}\n`);

// nothing to learn from an empty session
if (stats.ops < 10) { console.log('retro: session too short, skipping'); process.exit(0); }

// ---- LLM retrospective ----
const systemPrompt = existsSync(`${AIDIR}/system-prompt.md`) ? readFileSync(`${AIDIR}/system-prompt.md`, 'utf8') : '';
const advisorSrc = existsSync(`${AIDIR}/advisor.mjs`) ? readFileSync(`${AIDIR}/advisor.mjs`, 'utf8') : '';
const t0 = Date.now();

const openai = createOpenAI({ baseURL: 'https://llm.tail250b8.ts.net/v1', apiKey: 'dummy' });
const instruction = `You are the coach of an autonomous NetHack-playing bot (Valkyrie "Ada"). After every session you may improve its doctrine.

Current system prompt (doctrine shown to the playing LLM):
---
${systemPrompt}
---

Current advisor heuristic (decision tree, JS): ${advisorSrc.length} chars. Key branches: starvation->pray/eat safe corpses; 2+ adjacent foes or long fight -> disengage; hp thresholds for attack/flee (0.8/0.75 at depth>=5, 0.35/0.35 shallow); loot pickup; regen-wait only when hood empty; descend at hp>=60%; frontier explore; hunt; search/relocate when sealed; idle last. CLI contract: argv[1]=observation.json, stdout=JSON {priority, tool, args, reason, context}.

Session evidence:
${JSON.stringify(stats, null, 1).slice(0, 6000)}

Recent ops log:
${tail.slice(0, 4000)}

Death causes:
${String(deathCauses).slice(0, 400)}

Advisor behavior sample:
${advisorLines.slice(0, 1500)}

TASK: Improve the bot. Output EXACTLY this format (plain text with markers, no code fences):
SUMMARY: <one sentence describing what you changed and why>
<<<SYSTEM-PROMPT
<the FULL improved doctrine text (same overall structure; you may add/adjust rules, keep it under 500 words, keep protocol rules intact, keep the advisor FYI paragraph)>
SYSTEM-PROMPT>>>
<<<ADVISOR
<OPTIONAL: the FULL improved advisor.mjs source — include only if a heuristic change is clearly warranted; keep the same CLI contract: argv[1]=observation.json, stdout=JSON {priority, tool, args, reason, context}; single self-contained node script>
ADVISOR>>>`;

let parsed = null;
try {
  const res = await generateText({
    model: openai.chat('current'),
    prompt: instruction,
    maxOutputTokens: 8000,
    abortSignal: AbortSignal.timeout(240000),
  });
  const text = (res.text ?? '');
  console.log(`retro: LLM responded (${((Date.now() - t0) / 1000).toFixed(0)}s, ${text.length} chars)`);
  parsed = {
    summary: text.match(/SUMMARY:\s*([^\n]+)/)?.[1] ?? 'no summary',
    newSystemPrompt: text.match(/<<<SYSTEM-PROMPT\n([\s\S]*?)SYSTEM-PROMPT>>>/)?.[1]?.trim(),
    newAdvisor: text.match(/<<<ADVISOR\n([\s\S]*?)ADVISOR>>>/)?.[1]?.trim(),
  };
  if (!parsed.newSystemPrompt) { console.log('retro: no SYSTEM-PROMPT marker in output'); process.exit(0); }
} catch (e) {
  console.log(`retro: LLM call/parse failed: ${String(e.message ?? e).slice(0, 200)}`);
  process.exit(0);
}
if (!parsed?.summary || !parsed?.newSystemPrompt) { console.log('retro: no usable output'); process.exit(0); }

// ---- apply with validation ----
copyFileSync(`${AIDIR}/system-prompt.md`, `${AIDIR}/system-prompt.md.bak`);
copyFileSync(`${AIDIR}/advisor.mjs`, `${AIDIR}/advisor.mjs.bak`);
let applied = [];
try {
  if (parsed.newSystemPrompt && parsed.newSystemPrompt.length > 200) {
    writeFileSync(`${AIDIR}/system-prompt.md`, parsed.newSystemPrompt.trim() + '\n');
    applied.push('system-prompt.md');
  }
  if (parsed.newAdvisor && /session|observation/.test(parsed.newAdvisor) && parsed.newAdvisor.length > 1000) {
    writeFileSync(`${AIDIR}/advisor.mjs`, parsed.newAdvisor);
    execFileSync('node', ['--check', `${AIDIR}/advisor.mjs`]); // throws on syntax error
    applied.push('advisor.mjs');
  }
} catch (e) {
  console.log(`retro: validation failed (${String(e.message ?? e).slice(0, 120)}) — reverting`);
  copyFileSync(`${AIDIR}/system-prompt.md.bak`, `${AIDIR}/system-prompt.md`);
  copyFileSync(`${AIDIR}/advisor.mjs.bak`, `${AIDIR}/advisor.mjs`);
  applied = [];
}

if (applied.length) {
  const msg = `retro: ${parsed.summary.slice(0, 160)}`;
  try {
    execFileSync('git', ['-C', ROOT, 'add', '--', BOT_REL]);
    execFileSync('git', ['-C', ROOT, 'commit', '-m', msg, '--', BOT_REL]);
    appendFileSync(LOG, `applied: ${applied.join(', ')} — ${msg}\n`);
    console.log(`retro committed: ${msg}`);
  } catch (e) { console.log('retro: git commit skipped'); }
} else {
  appendFileSync(LOG, 'no changes applied\n');
  console.log('retro: no changes applied');
}
// cleanup backups
try { unlinkSync(`${AIDIR}/system-prompt.md.bak`); unlinkSync(`${AIDIR}/advisor.mjs.bak`); } catch {}
