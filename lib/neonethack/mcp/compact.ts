import type { Response } from "../typescript/types.js";

/** Presentation only. Engine responses/receipts and UI observations stay full. */
export class CompactResponses {
  private previous?: Record<string, any>;
  private sequence = 0;
  project(response: Response, method: string): Record<string, any> {
    const result = structuredClone(response) as Record<string, any>;
    // tools/list already supplies the catalog. Avoid returning it a second time.
    if (result.catalog) delete result.catalog;
    if (!result.observation) return result;
    if (method !== "session.observe") delete result.observation.neighborhood;
    const old = this.previous;
    const snapshot = method === "session.observe" || method === "session.resume" ||
      !old || old.sessionId !== result.sessionId || result.revision < old.revision ||
      old.observation.location.id !== result.observation.location.id;
    this.previous = structuredClone(result);
    const id = ++this.sequence;
    if (snapshot) {
      result.update = { kind: "snapshot", id };
      return result;
    }
    const before = old.observation, after = result.observation;
    const observation: Record<string, any> = {};
    const remove = Object.keys(before).filter(key => !(key in after));
    const equal = (field: string, left: any, right: any) => {
      // knowledge carries observedTurn, which advances on every ordinary turn;
      // compare the disclosed content without that marker so a static block is
      // not re-sent in full each delta. The baseline keeps the last knowledge;
      // perception.knowledge and knowledge.observedTurn signal currency.
      if (field === "knowledge" && left && right && typeof left === "object" && typeof right === "object") {
        left = { ...left }; delete left.observedTurn;
        right = { ...right }; delete right.observedTurn;
      }
      return JSON.stringify(left) === JSON.stringify(right);
    };
    for (const [key, value] of Object.entries(after)) {
      if (key !== "world" && !equal(key, value, before[key])) observation[key] = value;
    }
    const key = (cell: any) => `${cell.x},${cell.y}`;
    const cells = new Map(before.world.map((cell: any) => [key(cell), cell]));
    const current = new Set(after.world.map(key));
    const changed = after.world.filter((cell: any) => JSON.stringify(cell) !== JSON.stringify(cells.get(key(cell))));
    const worldRemoved = before.world.filter((cell: any) => !current.has(key(cell))).map((cell: any) => [cell.x, cell.y]);
    if (changed.length) observation.world = changed;
    result.observation = observation;
    result.update = { kind: "delta", id, base: id - 1, ...(remove.length ? { remove } : {}), ...(worldRemoved.length ? { worldRemoved } : {}) };
    return result;
  }
}

/** Materialize compact observations. Keep one reducer per MCP connection.
 * A missing/out-of-order delta throws; resynchronize with session.observe.
 * This is presentation state, never authority to repeat engine input.
 */
export class CompactObservationReader {
  private last?: Record<string, any>;
  apply(response: Record<string, any>): Record<string, any> {
    const result = structuredClone(response);
    if (!result.update) return result;
    const { update } = result;
    if (update.kind === "delta") {
      if (!this.last || this.last.update.id !== update.base || this.last.sessionId !== result.sessionId)
        throw Error("Missing observation baseline; call session.observe to resynchronize.");
      const observation = structuredClone(this.last.observation);
      for (const key of update.remove ?? []) delete observation[key];
      for (const [key, value] of Object.entries(result.observation)) if (key !== "world") observation[key] = value;
      const cells = new Map<string, any>(observation.world.map((cell: any) => [`${cell.x},${cell.y}`, cell]));
      for (const [x, y] of update.worldRemoved ?? []) cells.delete(`${x},${y}`);
      for (const cell of result.observation.world ?? []) cells.set(`${cell.x},${cell.y}`, cell);
      observation.world = [...cells.values()].sort((a, b) => a.y - b.y || a.x - b.x);
      result.observation = observation;
    } else if (update.kind !== "snapshot") throw Error("Unknown observation update kind");
    this.last = structuredClone(result);
    delete result.update;
    return result;
  }
}
