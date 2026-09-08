import type { CloudAdventure } from "./cloud";
import type { Request } from "/runtime/typescript/client.js";

export type Adventure = CloudAdventure & {
  pending?: Request;
  localStore?: string;
  savedAt?: number;
};
function validate(value: unknown): asserts value is Adventure {
  const s = value as Adventure;
  if (
    !s ||
    typeof s.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(s.id) ||
    typeof s.name !== "string" ||
    typeof s.role !== "string" ||
    typeof s.turn !== "number" ||
    typeof s.ended !== "boolean" ||
    (s.seed !== undefined &&
      (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > 4294967295)) ||
    (s.localStore !== undefined &&
      !/^[A-Za-z0-9_-]{1,64}$/.test(s.localStore)) ||
    (s.savedAt !== undefined && !Number.isFinite(s.savedAt)) ||
    (s.pending &&
      (s.pending.version !== 1 ||
        !s.pending.params ||
        !("sessionId" in s.pending.params) ||
        s.pending.params.sessionId !== s.id ||
        !("requestId" in s.pending.params) ||
        typeof s.pending.params.requestId !== "string"))
  )
    throw Error("The adventure list is damaged. It has not been replaced.");
}
/** Each run owns one metadata key, so simultaneous tabs never replace one
 * another's list. Existing published saves retain their original store. */
export function readAdventures(
  key: string,
  originalStore: string,
): Adventure[] {
  const saves = new Map<string, Adventure>();
  const original = localStorage.getItem(key);
  if (original) {
    const rows: unknown = JSON.parse(original);
    if (!Array.isArray(rows))
      throw Error("The adventure list is damaged. It has not been replaced.");
    for (const row of rows) {
      validate(row);
      saves.set(row.id, {
        ...row,
        localStore: row.localStore ?? originalStore,
      });
    }
  }
  const prefix = key + ":";
  for (let i = 0; i < localStorage.length; i++) {
    const entry = localStorage.key(i)!;
    if (!entry.startsWith(prefix)) continue;
    const row: unknown = JSON.parse(localStorage.getItem(entry)!);
    validate(row);
    if (entry !== prefix + row.id)
      throw Error("The adventure metadata belongs to a different run.");
    saves.set(row.id, row);
  }
  return [...saves.values()].sort(
    (a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0),
  );
}
export function writeAdventure(key: string, save: Adventure) {
  validate(save);
  save.savedAt = Date.now();
  localStorage.setItem(key + ":" + save.id, JSON.stringify(save));
}
export function changedAdventure(key: string, value: string): Adventure {
  const save: unknown = JSON.parse(value);
  validate(save);
  if (!key.endsWith(":" + save.id))
    throw Error("The adventure metadata belongs to a different run.");
  return save;
}
