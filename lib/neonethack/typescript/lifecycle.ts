import type { Game } from './client.js';
import type { Snapshot } from './types.js';
/** Internal ownership of an event-driven game. No engine policy lives here. */
type Controller = { beforeInput(): void; scheduled(promise: Promise<unknown>): void; accepted(frame: Snapshot): void };
const controllers = new WeakMap<Game, Controller>();
export function attachController(game: Game, controller: Controller): () => void {
  if (controllers.has(game)) throw Error('This game already has an active lifecycle.');
  controllers.set(game, controller);
  return () => { if (controllers.get(game) === controller) controllers.delete(game); };
}
export function beforeInput(game: Game): void { controllers.get(game)?.beforeInput(); }
export function accepted(game: Game, frame: Snapshot): void { controllers.get(game)?.accepted(frame); }

export function scheduled(game: Game, promise: Promise<unknown>): void { controllers.get(game)?.scheduled(promise); }
