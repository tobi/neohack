import { accountApi, type BotSource } from "./account-client";
import type { Snapshot } from "neonethack/types";
import type { ScriptJournalEntry } from "../../../lib/neonethack/typescript/script";
const dbName = "neohack-script-artifacts-v1";
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
async function open() {
  const r = indexedDB.open(dbName, 1);
  r.onupgradeneeded = () => {
    for (const name of ["runs", "notes", "counts", "uploads"])
      r.result.createObjectStore(name);
  };
  return request(r);
}
const complete = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? Error("Script storage failed"));
    tx.onerror = () => {};
  });
export type ScriptMetadata = {
  id: string;
  owner?: string;
  name: string;
  role: string;
  seed: number;
  buildId: string;
  source: BotSource;
  storeName: string;
  vault: string;
};
const live = new Map<string, ScriptRecorder>();
/** Private script provenance is separate from the public input archive. Source
 * is durable before initialization; notes append locally without network waits. */
export class ScriptRecorder {
  private tail = Promise.resolve();
  private flight?: Promise<boolean>;
  private count = 0;
  private first = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private failed = false;
  private finished = false;
  private constructor(
    private db: IDBDatabase,
    private metadata: ScriptMetadata,
    private publish: () => Promise<void>,
    private status: (text: string) => void,
  ) {
    live.set(metadata.id, this);
  }
  static async recover(
    owner: string | undefined,
    publish: (metadata: ScriptMetadata) => Promise<void>,
  ) {
    const db = await open();
    try {
      for (const metadata of await request(
        db.transaction("runs").objectStore("runs").getAll(),
      )) {
        if (
          live.has(metadata.id) ||
          (metadata.owner && metadata.owner !== owner)
        )
          continue;
        const cursor = await request(
          db.transaction("uploads").objectStore("uploads").get(metadata.id),
        );
        if (cursor?.done) continue;
        const instance = new ScriptRecorder(
          await open(),
          metadata,
          () => publish(metadata),
          () => {},
        );
        instance.finished = true;
        void instance.flush();
      }
    } finally {
      db.close();
    }
  }
  static async create(
    metadata: ScriptMetadata,
    publish: () => Promise<void>,
    status: (text: string) => void,
  ) {
    const db = await open(),
      tx = db.transaction(["runs", "counts"], "readwrite", {
        durability: "strict",
      }),
      done = complete(tx);
    tx.objectStore("runs").add(metadata, metadata.id);
    tx.objectStore("counts").add(0, metadata.id);
    await done;
    const recorder = new ScriptRecorder(db, metadata, publish, status);
    recorder.schedule();
    return recorder;
  }
  record(_frame: Snapshot) {
    this.schedule();
  }
  note(entry: ScriptJournalEntry) {
    const copy = structuredClone(entry),
      index = this.count++;
    this.tail = this.tail
      .then(async () => {
        const tx = this.db.transaction(["counts", "notes"], "readwrite", {
            durability: "strict",
          }),
          done = complete(tx);
        tx.objectStore("notes").add(copy, [this.metadata.id, index]);
        tx.objectStore("counts").put(index + 1, this.metadata.id);
        await done;
      })
      .catch(() => {
        this.failed = true;
        this.status("Script notes could not be saved locally.");
      });
    this.schedule();
  }
  private schedule() {
    this.first ||= Date.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.flush(),
      Math.max(0, Math.min(5000, this.first + 30000 - Date.now())),
    );
  }
  async settled() {
    await this.tail;
    this.finished = true;
    return !this.failed;
  }
  async flush() {
    if (this.flight) return this.flight;
    clearTimeout(this.timer);
    this.flight = (async () => {
      await this.tail;
      if (this.failed) return false;
      await this.publish();
      if (!this.metadata.owner) {
        const tx = this.db.transaction("uploads", "readwrite", {
            durability: "strict",
          }),
          done = complete(tx);
        tx.objectStore("uploads").put(
          { done: this.finished },
          this.metadata.id,
        );
        await done;
        this.first = 0;
        this.status("Run backed up · script saved here");
        return true;
      }
      const user = await accountApi();
      if (user.id !== this.metadata.owner) return false;
      const header = () =>
        Promise.all([
          request(
            this.db
              .transaction("uploads")
              .objectStore("uploads")
              .get(this.metadata.id),
          ),
          request(
            this.db
              .transaction("counts")
              .objectStore("counts")
              .get(this.metadata.id),
          ),
        ]).then(([cursor, count]) => ({
          ...this.metadata,
          ack: 0,
          sourceSaved: false,
          ...cursor,
          count,
        }));
      let current = await header();
      while (!current.sourceSaved || current.ack < current.count) {
        const entries = await request(
          this.db
            .transaction("notes")
            .objectStore("notes")
            .getAll(
              IDBKeyRange.bound(
                [current.id, current.ack],
                [current.id, Number.MAX_SAFE_INTEGER],
              ),
              32,
            ),
        );
        const result = await accountApi(
          "/runs/" + current.id + "/artifacts",
          {
            owner: current.owner,
            name: current.name,
            from: current.ack,
            entries,
            ...(!current.sourceSaved ? { source: current.source } : {}),
          },
          "PUT",
        );
        if (result.through !== current.ack + entries.length)
          throw Error("Script acknowledgement differs");
        const tx = this.db.transaction("uploads", "readwrite", {
            durability: "strict",
          }),
          done = complete(tx);
        tx.objectStore("uploads").put(
          {
            ack: result.through,
            sourceSaved: true,
            done: this.finished && result.through === current.count,
          },
          current.id,
        );
        await done;
        current = await header();
      }
      if (this.finished) {
        const tx = this.db.transaction("uploads", "readwrite", {
            durability: "strict",
          }),
          done = complete(tx);
        tx.objectStore("uploads").put(
          { ack: current.ack, sourceSaved: true, done: true },
          current.id,
        );
        await done;
      }
      this.first = 0;
      this.status("Run backed up · script source and notes private");
      return true;
    })()
      .catch(() => {
        this.status("Saved here");
        this.timer = setTimeout(() => void this.flush(), 30000);
        return false;
      })
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }
}
window.addEventListener("online", () => {
  for (const recorder of live.values()) void recorder.flush();
});
