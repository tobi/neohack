// One append-only, per-run input journal. A turn never reads earlier entries.
// The intent transaction commits before C receives input; completion is a
// separate immutable row. A missing completion is an uncertain reserved input.
const request = (value) =>
  new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? Error("Journal transaction aborted"));
    tx.onerror = () => {};
  });
export async function openProtocolStore(name) {
  const opening = indexedDB.open("neonethack-inputs-v1:" + name, 1);
  opening.onupgradeneeded = () => {
    for (const key of ["runs", "inputs", "commits", "uploads", "checkpoints"])
      opening.result.createObjectStore(key);
  };
  const db = await request(opening);
  const read = (store, key) =>
    request(db.transaction(store).objectStore(store).get(key));
  function write(stores, change) {
    const tx = db.transaction(stores, "readwrite", { durability: "strict" }),
      finished = done(tx);
    change(tx);
    return finished;
  }
  return {
    header: (id) => read("runs", id),
    async headers() {
      return request(db.transaction("runs").objectStore("runs").getAll());
    },
    async create(header) {
      await write(["runs"], (tx) =>
        tx.objectStore("runs").add(header, header.id),
      );
    },
    async updateHeader(header) {
      await write(["runs"], (tx) =>
        tx.objectStore("runs").put(header, header.id),
      );
    },
    async reserve(id, index, record) {
      await write(["inputs"], (tx) =>
        tx.objectStore("inputs").add(record, [id, index]),
      );
    },
    async commit(header, index, digest) {
      await write(["commits", "runs"], (tx) => {
        tx.objectStore("commits").add(digest, [header.id, index]);
        tx.objectStore("runs").put(header, header.id);
      });
    },
    // Only restoration and background upload read a bounded range of inputs.
    async range(id, from, limit = 256) {
      const tx = db.transaction(["inputs", "commits"]),
        range = IDBKeyRange.bound([id, from], [id, Number.MAX_SAFE_INTEGER]);
      const [inputs, commits, keys] = await Promise.all([
        request(tx.objectStore("inputs").getAll(range, limit)),
        request(tx.objectStore("commits").getAll(range, limit)),
        request(tx.objectStore("commits").getAllKeys(range, limit)),
      ]);
      if (commits.length > inputs.length)
        throw Error("Local input journal has orphaned completions");
      return inputs.map((entry, i) => {
        if (entry.index !== from + i)
          throw Error("Local input journal has a missing input");
        if (keys[i] && (keys[i][0] !== id || keys[i][1] !== entry.index))
          throw Error("Local input journal has a missing completion");
        return { ...entry, ...commits[i] };
      });
    },
    upload: (id) => read("uploads", id),
    async acknowledge(id, value) {
      await write(["uploads"], (tx) =>
        tx.objectStore("uploads").put(value, id),
      );
    },
    checkpoint: (id) => read("checkpoints", id),
    async saveCheckpoint(id, value) {
      await write(["checkpoints"], (tx) =>
        tx.objectStore("checkpoints").put(value, id),
      );
    },
    close: () => db.close(),
  };
}
