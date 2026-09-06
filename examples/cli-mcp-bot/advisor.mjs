#!/usr/bin/env node
// advisor.mjs — heuristic decision tree for the AI-driven NetHack player.
//
// Usage:   node advisor.mjs <observation.json>
//   where observation.json = { sessionId, revision, observation }  (latest game frame)
//
// Output:  JSON on stdout: { priority, tool, args, reason, context }
//          The AI agent reads this as a SUGGESTION and may override it.
//
// This is the battle-tested policy ladder from the retired player.mjs bot
// (9 runs of hard lessons), condensed. It sees only what the engine's
// perception layer exposes — never hidden map cells or item identity.

import { readFileSync } from 'fs';

const DIRS = [
  ['north', 0, -1], ['south', 0, 1], ['west', -1, 0], ['east', 1, 0],
  ['northwest', -1, -1], ['northeast', 1, -1], ['southwest', -1, 1], ['southeast', 1, 1],
];
const PASS_RE = /stairs|door/i;
const FOOD_RE = /ration|fortune cookie|candy bar|cram ration|banana|apple|orange|pear|melon|carrot|gunyoki|royal jelly/i;
const SAFE_CORPSE_RE = /lichen|wererat|jackal|kobold|goblin|newt|gecko|iguana|rat|orc|fox|coyote/i;
const BAD_CORPSE_RE = /cockatrice|chickatrice/;

function dirName(dx, dy) { for (const [n, ax, ay] of DIRS) if (ax === dx && ay === dy) return n; return null; }

// ---- world helpers (observation-scoped, stateless) ----
function isUnknown(k, map, h) {
  const c = h.get(k);                                  // hood is fresher: map can say "dark"
  if (c) return c.terrain?.type === 'dark' || c.visible === false;  // for already-revealed floor
  const w = map.get(k);
  if (w) return w.terrain?.type === 'dark';
  return true;
}
function passable(k, map, h) {
  const c = h.get(k);
  if (c) {
    if (c.movement?.relation === 'possiblePush') return false;          // boulder
    return c.walkable === true || (c.visible === true && /door/i.test(c.terrain?.type ?? ''));
  }
  const w = map.get(k);
  if (w) return w.terrain?.type === 'floor' || w.terrain?.type === 'corridor' || PASS_RE.test(w.terrain?.type ?? '');
  return false;
}
// NetHack movement: no diagonals through doorways; no corner cutting.
function stepOk(ax, ay, bx, by, map, h) {
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return false;
  if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && dx !== 0 && dy !== 0) {
    const typeOf = (x, y) => h.get(`${x},${y}`)?.terrain?.type ?? map.get(`${x},${y}`)?.terrain?.type;
    const walkT = t => t === 'floor' || t === 'corridor' || PASS_RE.test(t ?? '');
    const isDoorT = t => /door/i.test(t ?? '');
    if (isDoorT(typeOf(ax, ay)) || isDoorT(typeOf(bx, by))) return false;
    const unknownOrBlocked = (t) => t === undefined || t === 'dark' || t === 'wall' || !walkT(t);
    if (unknownOrBlocked(typeOf(ax + dx, ay)) && unknownOrBlocked(typeOf(ax, ay + dy))) return false;
  }
  return true;
}
// Multi-target BFS: first step toward the nearest of `targets` (or frontier candidates).
function bfsFirstStep(targets, me, map, h) {
  const tset = new Set(targets);
  if (!tset.size) return null;
  const start = `${me.x},${me.y}`;
  if (tset.has(start)) return null;
  const prev = new Map([[start, null]]);
  const q = [start];
  while (q.length) {
    const cur = q.shift();
    if (tset.has(cur)) {
      let step = cur, p = prev.get(cur);
      while (p !== start) { step = p; p = prev.get(p); if (p == null) break; }
      const [sx, sy] = step.split(',').map(Number);
      return [sx - me.x, sy - me.y];
    }
    const [cx, cy] = cur.split(',').map(Number);
    for (const [n, ax, ay] of DIRS) {
      const k = `${cx + ax},${cy + ay}`;
      if (prev.has(k) || !passable(k, map, h) || !stepOk(cx, cy, cx + ax, cy + ay, map, h)) continue;
      const c = h.get(k);
      if (c?.visible && c?.occupant && c.occupant.kind !== 'self') continue; // route around creatures
      prev.set(k, cur); q.push(k);
    }
  }
  return null;
}
function frontierTargets(me, map, h) {
  const out = [];
  for (const k of new Set([...map.keys(), ...h.keys()])) {
    if (!passable(k, map, h)) continue;
    const [x, y] = k.split(',').map(Number);
    for (const [n, ax, ay] of DIRS) {
      const nk = `${x + ax},${y + ay}`;
      if (isUnknown(nk, map, h)) { out.push(k); break; }
    }
  }
  return out;
}
function findStairs(map, h, want) {
  const type = want === 'down' ? 'stairsDown' : 'stairsUp';
  for (const k of [...h.keys(), ...map.keys()]) {
    const t = h.get(k)?.terrain?.type ?? map.get(k)?.terrain?.type;
    if (t === type) return k;
  }
  return null;
}

(function main() {
const obsWrap = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const obs = obsWrap.observation ?? obsWrap;
const me = obs.you ?? { x: 0, y: 0 };
const map = new Map(); for (const c of obs.world ?? []) map.set(`${c.x},${c.y}`, c);
const h = new Map(); for (const c of obs.neighborhood?.cells ?? []) h.set(`${c.x},${c.y}`, c);
const vit = obs.vitals ?? {};
const hp = vit.maxHealth ? vit.health / vit.maxHealth : 1;
const hunger = (vit.hunger ?? '').trim();
const depth = parseInt((vit.depth ?? '1').trim()) || 1;
const cautious = depth >= 5;

// adjacent creatures (foes = non-self visible occupants)
const foes = (obs.neighborhood?.cells ?? []).filter(c =>
  c.visible && c.occupant && c.occupant.kind !== 'self' &&
  Math.abs(c.x - me.x) <= 1 && Math.abs(c.y - me.y) <= 1 && (c.x !== me.x || c.y !== me.y)
).map(c => ({ ...c.occupant, dx: c.x - me.x, dy: c.y - me.y, x: c.x, y: c.y }));
const anyVisible = [...h.values()].some(c => c.visible && c.occupant && c.occupant.kind !== 'self');
const items = obs.here?.items ?? [];
const inv = obs.inventory ?? [];
const starving = /(^|[^_])hungry|weak|faint/i.test(hunger) && !/not_hungry/i.test(hunger);

function ret(priority, tool, args, reason) {
  console.log(JSON.stringify({ priority, tool, args, reason, context: { hp: vit.health, maxHp: vit.maxHealth, depth, hunger, turn: obs.turn, foes: foes.length, pos: `${me.x},${me.y}` } }));
  process.exit(0);
}

// 1. standing decision — the protocol demands answering it first
if (obsWrap.decision) {
  return ret(1, 'decision_answer', { decisionId: obsWrap.decision.id, about: obsWrap.decision.about ?? '', cancellable: obsWrap.decision.cancellable ?? false },
    `Standing decision: ${obsWrap.decision.about ?? obsWrap.decision.kind}. Confirm eat/step-onto/stairs; pray-confirm if weak/hurt; decline quit.`);
}

// 2. starvation — the #1 killer
if (starving) {
  const food = inv.find(i => FOOD_RE.test(i.label ?? '')) ?? inv.find(i => SAFE_CORPSE_RE.test(i.label ?? '') && !BAD_CORPSE_RE.test(i.label ?? ''));
  if (food) ret(2, 'game_eat', { item: { id: food.id } }, `Hunger=${hunger}; eating ${food.label}`);
  if (/weak|faint/i.test(hunger)) ret(2, 'game_pray', {}, `Starving (${hunger}) — pray even with ${foes.length} foes adjacent`);
}

// 3. combat discipline
if (foes.length) {
  const weakest = foes[0];
  const dir = dirName(weakest.dx, weakest.dy);
  const attackGate = cautious ? 0.8 : 0.35;
  const fleeGate = cautious ? 0.75 : 0.35;
  const freeExit = () => {
    for (const [n, ax, ay] of DIRS) {
      const tk = `${me.x + ax},${me.y + ay}`;
      const c = h.get(tk);
      if (c?.walkable && !c.occupant && c.movement?.relation !== 'possiblePush' && !isUnknown(tk, map, h) === false) { /* unknown ok */ }
      if (c?.walkable && !c.occupant && c.movement?.relation !== 'possiblePush') {
        const threatened = foes.some(f => Math.abs(f.x - (me.x + ax)) <= 1 && Math.abs(f.y - (me.y + ay)) <= 1);
        if (!threatened) return n;
      }
    }
    return null;
  };
  if (hp < 0.15) {
    const exit = freeExit();
    if (exit) ret(3, 'game_move', { direction: exit }, `Fleeing at ${vit.health}/${vit.maxHealth} HP`);
    if (vit.health <= 12 || hp < 0.25) ret(3, 'game_pray', {}, `Death's door (${vit.health} HP), cornered — pray`);
    ret(3, 'game_move', { direction: dir }, 'Cornered at low HP — desperate attack');
  }
  if (foes.length >= 2) {
    const exit = freeExit();
    if (exit) ret(3, 'game_move', { direction: exit }, `${foes.length} monsters adjacent — disengage (floating-eye doctrine)`);
  }
  if (hp < fleeGate) {
    const exit = freeExit();
    if (exit) ret(3, 'game_move', { direction: exit }, `HP ${(hp * 100).toFixed(0)}% — retreat`);
    ret(3, 'game_move', { direction: dir }, 'Cornered — keep fighting');
  }
  if (hp >= attackGate || !cautious) ret(3, 'game_move', { direction: dir }, 'Adjacent monster — attack');
  const exit = freeExit();
  if (exit) ret(3, 'game_move', { direction: exit }, `HP ${(hp * 100).toFixed(0)}% below attack gate — withdraw`);
  ret(3, 'game_move', { direction: dir }, 'Attack anyway (no better option)');
}

// 4. loot underfoot
const pickable = items.filter(i => !BAD_CORPSE_RE.test(i.label ?? '') && !/boulder/i.test(i.label ?? ''));
if (pickable.length) {
  const pri = /ration|gold|food|armor|weapon|potion|scroll|ring|amulet|wand|spellbook|gem|piece/i;
  pickable.sort((a, b) => (pri.test(b.label ?? '') ? 1 : 0) - (pri.test(a.label ?? '') ? 1 : 0));
  ret(4, 'game_pickup', { item: { id: pickable[0].id } }, `Loot here: ${pickable[0].label}`);
}

// 5. regen when hurt and nothing visible
if (hp < 1 && !anyVisible) ret(5, 'game_wait', {}, `Regenerating ${vit.health}/${vit.maxHealth}`);

// 6. descend when stairs known and healthy
const stairsDown = findStairs(map, h, 'down');
if (stairsDown && hp >= 0.6 && !/weak|faint/i.test(hunger)) {
  const [sx, sy] = stairsDown.split(',').map(Number);
  if (sx === me.x && sy === me.y) ret(6, 'game_climb', { direction: 'down' }, 'On stairsDown — descending');
  const step = bfsFirstStep([stairsDown], me, map, h);
  if (step) ret(6, 'game_move', { direction: dirName(step[0], step[1]) }, 'Heading to stairsDown');
}

// 7. explore: nearest frontier (walkable cell adjacent to unknown)
const frontier = frontierTargets(me, map, h);
if (frontier.length) {
  const step = bfsFirstStep(frontier, me, map, h);
  if (step) ret(7, 'game_move', { direction: dirName(step[0], step[1]) }, `Exploring toward frontier (${frontier.length} open)`);
}

// 8. hunt a visible creature (breaks stalemates, gains XP)
const visFoes = (obs.neighborhood?.cells ?? []).filter(c => c.visible && c.occupant && c.occupant.kind === 'creature');
if (visFoes.length && hp >= attackGate) {
  visFoes.sort((a, b) => (Math.abs(a.x - me.x) + Math.abs(a.y - me.y)) - (Math.abs(b.x - me.x) + Math.abs(b.y - me.y)));
  const t = visFoes[0];
  if (Math.abs(t.x - me.x) <= 1 && Math.abs(t.y - me.y) <= 1) {
    ret(8, 'game_move', { direction: dirName(t.x - me.x, t.y - me.y) }, 'Attack visible monster');
  }
  const step = bfsFirstStep([`${t.x},${t.y}`], me, map, h);
  if (step) ret(8, 'game_move', { direction: dirName(step[0], step[1]) }, 'Hunting visible monster');
}

// 9. sealed level: search for secret doors and/or walk the perimeter (never plain-idle with unexplored map)
{
  const step = frontier.length ? bfsFirstStep(frontier, me, map, h) : null;
  if (!step) {
    // frontiers unreachable (boulders/secrets) or none: walk toward the farthest known walkable cell, else search in place
    const far = [...map.keys()].filter(k => {
      const t = map.get(k)?.terrain?.type;
      return t === 'floor' || t === 'corridor';
    }).sort((a, b) => {
      const [ax, ay] = a.split(',').map(Number), [bx, by] = b.split(',').map(Number);
      return (Math.abs(bx - me.x) + Math.abs(by - me.y)) - (Math.abs(ax - me.x) + Math.abs(ay - me.y));
    })[0];
    const stepFar = far ? bfsFirstStep([far], me, map, h) : null;
    if (stepFar && far) ret(9, 'game_move', { direction: dirName(stepFar[0], stepFar[1]) }, `No reachable frontier — relocating to ${far} to search there`);
    ret(9, 'game_search', {}, 'Sealed in — searching for secret passages (also consider boulder pushes)');
  }
}

// 10. nothing left to do
ret(10, 'game_wait', {}, 'Idle');
})();
