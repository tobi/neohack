import type { Snapshot } from "neonethack/types";
export type RecordingQueue = {
  frames: Snapshot[];
  index: number | null;
  bytes: number;
};
/** Public presentation only. Private save journals never enter this database. */
export async function replayOutbox(
  key: string,
  change?: (queue: RecordingQueue) => void,
): Promise<RecordingQueue> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("neohack-public-recordings-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("queues");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("queues", change ? "readwrite" : "readonly"),
        store = tx.objectStore("queues"),
        request = store.get(key);
      let value: RecordingQueue;
      request.onsuccess = () => {
        value = request.result ?? { frames: [], index: null, bytes: 0 };
        try {
          if (change) {
            change(value);
            store.put(value, key);
          }
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () =>
        reject(tx.error ?? Error("Recording storage interrupted"));
    });
  } finally {
    db.close();
  }
}
