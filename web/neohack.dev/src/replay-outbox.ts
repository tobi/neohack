import type { Snapshot } from "neonethack/types";
export type RecordingQueue = {
  frames: Snapshot[];
  index: number | null;
  bytes: number;
};
const empty = (): RecordingQueue => ({ frames: [], index: null, bytes: 0 });
async function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("neohack-public-recordings-v1", 2);
    r.onupgradeneeded = () => {
      for (const name of ["queues", "frames", "heads"])
        if (!r.result.objectStoreNames.contains(name))
          r.result.createObjectStore(name);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
/** The turn path writes one frame and a small counter, never clones prior frames. */
export async function appendReplayFrame(key: string, frame: Snapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify(frame)).length;
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["frames", "heads"], "readwrite"),
        frames = tx.objectStore("frames"),
        heads = tx.objectStore("heads");
      const r = heads.get(key),
        exists = frames.getKey([key, frame.revision]);
      let headReady = false,
        existsReady = false;
      const write = () => {
        if (!headReady || !existsReady) return;
        try {
          if (exists.result !== undefined) return;
          const head = r.result ?? { index: null, bytes: 0, count: 0 };
          if (head.count >= 500 || head.bytes + bytes > 32 * 1024 * 1024)
            throw Error(
              "Recording paused: local queue is full. Saved frames remain available.",
            );
          frames.put(frame, [key, frame.revision]);
          heads.put(
            { ...head, bytes: head.bytes + bytes, count: head.count + 1 },
            key,
          );
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
      r.onsuccess = () => {
        headReady = true;
        write();
      };
      exists.onsuccess = () => {
        existsReady = true;
        write();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(tx.error ?? Error("Recording storage interrupted"));
    });
  } finally {
    db.close();
  }
}
/** Publication reads the queue. Existing recordings are retained until acknowledged. */
export async function replayOutbox(
  key: string,
  change?: (queue: RecordingQueue) => void,
): Promise<RecordingQueue> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(
        ["queues", "frames", "heads"],
        change ? "readwrite" : "readonly",
      );
      const legacy = tx.objectStore("queues"),
        frames = tx.objectStore("frames"),
        heads = tx.objectStore("heads");
      const old = legacy.get(key),
        fresh = frames.getAll(
          IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]),
        ),
        head = heads.get(key);
      let ready = 0,
        value: RecordingQueue;
      const read = () => {
        if (++ready !== 3) return;
        try {
          const prior = old.result ?? empty();
          const all = [
            ...new Map(
              ([...prior.frames, ...fresh.result] as Snapshot[]).map(
                (frame) => [frame.revision, frame],
              ),
            ).values(),
          ].sort((a, b) => a.revision - b.revision);
          value = {
            frames: all,
            index: head.result?.index ?? prior.index,
            bytes: prior.bytes + (head.result?.bytes ?? 0),
          };
          if (change) {
            change(value);
            const retained = new Set(value.frames.map((f) => f.revision));
            for (const f of fresh.result)
              if (!retained.has(f.revision)) frames.delete([key, f.revision]);
            const remaining = prior.frames.filter((f: Snapshot) =>
              retained.has(f.revision),
            );
            const oldBytes = new TextEncoder().encode(
              JSON.stringify(remaining),
            ).length;
            if (remaining.length)
              legacy.put(
                { frames: remaining, index: value.index, bytes: oldBytes },
                key,
              );
            else legacy.delete(key);
            heads.put(
              {
                index: value.index,
                count: value.frames.length - remaining.length,
                bytes: Math.max(
                  0,
                  value.bytes - (remaining.length ? oldBytes : 0),
                ),
              },
              key,
            );
          }
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
      old.onsuccess = fresh.onsuccess = head.onsuccess = read;
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () =>
        reject(tx.error ?? Error("Recording storage interrupted"));
    });
  } finally {
    db.close();
  }
}
