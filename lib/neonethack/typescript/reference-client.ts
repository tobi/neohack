import { Game, type Answer, type Compass, type Item, type Snapshot } from './client.js';
import type { ActionsResponse } from './types.js';

/** Explicit player choices, never a policy or an automatic occupation loop. */
export type PlayerChoice =
  | { kind: 'move'; direction: Compass }
  | { kind: 'retreatStep'; direction: Compass }
  | { kind: 'search' | 'wait' | 'pray' }
  | { kind: 'eat' | 'equip' | 'wield'; item?: Item }
  | { kind: 'answer'; decisionId: string; answer: Answer }
  | { kind: 'cancel'; decisionId: string };
export interface Attempt {
  revision: number; turn: number; choice: PlayerChoice; outcome: Snapshot['outcome'];
  from: string; to: string;
}
const position = (s: Snapshot) => `${s.observation.location.id}:${s.observation.you?.x},${s.observation.you?.y}`;
const supportedDecisions = new Set(['item', 'target', 'confirmation', 'choice', 'text', 'position']);
const settledStatuses = new Set(['completed', 'needsChoice', 'blocked', 'cancelled', 'interrupted']);
const settled = (frame: Snapshot) => settledStatuses.has(frame.outcome?.status)
  && ![frame.storage, frame.recording].some(d => d && d.status !== 'ok');

/** A disclosed, currently attemptable ordinary step; it is not a safety oracle. */
export function isRetreatStep(query: ActionsResponse, state: Snapshot): boolean {
  const { cell, basis, inputGate } = query, here = state.observation.you;
  return query.sessionId === state.sessionId && basis.revision === state.revision
    && basis.levelId === state.observation.location.id && !!here
    && basis.origin.x === here.x && basis.origin.y === here.y
    && inputGate.state === 'ready' && cell.inBounds
    && cell.movement.relation === 'adjacent' && cell.movement.intent === 'step'
    && !cell.movement.knownRestriction && !cell.occupant && cell.walkable === true
    && (cell.terrain?.freshness === 'current' || cell.terrain?.freshness === 'remembered')
    && !cell.hazards?.length
    && cell.actions.some(a => a.method === 'game.move' && a.availability === 'attemptable');
}

/** Reference consumer: the caller owns this Game exclusively and renders view
 * before every choice. No callbacks execute arbitrary game rules or raw keys. */
export class ReferenceClient {
  private busy = false;
  private recoveryRequired = false;
  private attempts: Attempt[] = [];
  constructor(private readonly game: Game) {}
  get view() {
    const state = this.game.state;
    return {
      state, // Includes world appearance, freshness, self-state, events and end.
      decisionId: state.decision?.id ?? null,
      inputGate: state.observation.neighborhood?.status === 'available'
        ? state.observation.neighborhood.inputGate : { state: 'unavailable' as const },
      attempts: structuredClone(this.attempts),
      oscillating: this.oscillating,
      pendingRequest: this.game.pendingRequest,
    };
  }
  private get oscillating() {
    const a = this.attempts.slice(-3);
    return a.length === 3 && a.every(x => x.choice.kind === 'move' || x.choice.kind === 'retreatStep')
      && a[0]!.from !== a[0]!.to && a[0]!.from === a[1]!.to
      && a[0]!.to === a[1]!.from && a[1]!.from === a[2]!.to && a[1]!.to === a[2]!.from;
  }
  /** Explicit player acknowledgement; uncertain attempts never become map walls. */
  acknowledgeAttempts() { if (this.busy) throw Error('Input is in flight.'); this.attempts = []; }
  async choose(choice: PlayerChoice): Promise<Snapshot> {
    if (this.busy) throw Error('Input is in flight; inspect its result before choosing again.');
    const selected = structuredClone(choice), before = this.game.state, view = this.view;
    if (before.ended || before.end) throw Error('The game has ended.');
    if (this.recoveryRequired || this.game.pendingRequest || !settled(before))
      throw Error('Execution or storage needs recovery; no new input is permitted.');
    const decision = before.decision;
    if (decision) {
      if (!supportedDecisions.has(decision.kind)) throw Error('Unsupported decision; stop for a capable client.');
      if (view.inputGate.state !== 'decision' || view.inputGate.decisionId !== decision.id)
        throw Error('Decision gate is unavailable or inconsistent.');
      if ((selected.kind !== 'answer' && selected.kind !== 'cancel') || selected.decisionId !== decision.id)
        throw Error('Choose an explicit answer or cancellation for the current decision.id.');
      if (selected.kind === 'cancel' && !decision.cancellable) throw Error('This decision is not cancellable.');
    } else {
      if (view.inputGate.state !== 'ready') throw Error('No genuine ready input boundary.');
      if (selected.kind === 'answer' || selected.kind === 'cancel') throw Error('No standing decision.');
      if (this.oscillating && (selected.kind === 'move' || selected.kind === 'retreatStep'))
        throw Error('Movement oscillation: review attempts and explicitly acknowledge before more movement.');
    }
    this.busy = true;
    try {
      let after: Snapshot;
      switch (selected.kind) {
        case 'retreatStep': {
          const query = await this.game.actions({ direction: selected.direction });
          if (!isRetreatStep(query, before)) throw Error('Retreat step is not a disclosed ordinary step; choose another plan.');
          after = await this.game.move(selected.direction, { expectedRevision: before.revision }); break;
        }
        case 'move': after = await this.game.move(selected.direction); break;
        case 'search': after = await this.game.search(); break;
        case 'wait': after = await this.game.wait(); break;
        case 'pray': after = await this.game.pray(); break;
        case 'eat': after = await this.game.eat(selected.item); break;
        case 'equip': after = await this.game.equip(selected.item); break;
        case 'wield': after = await this.game.wield(selected.item); break;
        case 'answer': after = await this.game.answer(selected.decisionId, selected.answer); break;
        case 'cancel': after = await this.game.cancel(selected.decisionId); break;
      }
      this.attempts.push({ revision: after.revision, turn: after.observation.turn,
        choice: selected, outcome: structuredClone(after.outcome), from: position(before), to: position(after) });
      if (this.attempts.length > 16) this.attempts.shift();
      if (!settled(after)) this.recoveryRequired = true;
      return after;
    } finally { this.busy = false; }
  }
  /** Only receipt recovery: the Game retains the exact immutable request. A
   * successful historical receipt is followed by a free current observation. */
  async recover(): Promise<Snapshot> {
    if (this.busy) throw Error('Input is in flight.');
    this.busy = true;
    // Failed or unrecognized recovery must not authorize input merely because
    // Game kept a newer, otherwise valid snapshot instead of an old receipt.
    this.recoveryRequired = true;
    try {
      const receipt = await this.game.retry();
      if (this.game.pendingRequest || !settled(receipt)) throw Error('Receipt remains uncertain.');
      const current = await this.game.observe();
      if (!settled(current)) throw Error('Current observation remains uncertain.');
      this.recoveryRequired = false;
      return current;
    } finally { this.busy = false; }
  }
}
