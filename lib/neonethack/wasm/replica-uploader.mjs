/** One durable immutable commit in flight. New local work waits behind its receipt. */
export class ReplicaUploader {
  constructor({
    store,
    url,
    revision = null,
    files = [],
    status = () => {},
    active = () => false,
    fetch: send = (...args) => globalThis.fetch(...args),
    idle = 5000,
    interval = 30000,
    timeout = 10000,
    backoff = 1000,
  }) {
    Object.assign(this, {
      store,
      url,
      revision,
      files,
      status,
      active,
      send,
      idle,
      interval,
      timeout,
      backoff,
    });
    this.pending = false;
    this.closed = false;
    this.failed = false;
    this.flight = null;
    this.timer = null;
    this.failures = 0;
    this.due = 0;
    this.retryAt = 0;
    this.queuedAt = null;
  }
  schedule() {
    clearTimeout(this.timer);
    if (!this.closed && !this.failed)
      this.timer = setTimeout(
        () => void this.upload(),
        Math.max(0, this.due - Date.now(), this.retryAt - Date.now()),
      );
  }
  queue() {
    if (this.closed || this.failed) return;
    this.pending = true;
    this.queuedAt ??= Date.now();
    this.due = Math.min(Date.now() + this.idle, this.queuedAt + this.interval);
    if (!this.flight && !this.failures) this.status("queued");
    this.schedule();
  }
  async upload(flush = false) {
    if (this.flight) return this.flight;
    if (this.closed || this.failed || !this.pending) return;
    if (!flush && Date.now() < Math.max(this.due, this.retryAt)) {
      this.schedule();
      return;
    }
    if (this.active()) {
      this.timer = setTimeout(() => void this.upload(flush), 100);
      return;
    }
    this.pending = false;
    this.queuedAt = null;
    this.flight = (async () => {
      // An uncertain acknowledgement must never cause a new commit ID/body.
      let commit = await this.store.replicaOutbox();
      if (!commit) {
        const snapshot = await this.store.snapshot(
          new Set(this.files.flatMap(([, f]) => f.blocks)),
        );
        if (JSON.stringify(snapshot.files) === JSON.stringify(this.files)) {
          this.status("saved");
          return;
        }
        commit = {
          ...snapshot,
          base: this.revision,
          commit: crypto.randomUUID(),
        };
        await this.store.replicaOutbox(commit);
      }
      this.status("pending");
      let response;
      try {
        let body=JSON.stringify(commit);
        if(new TextEncoder().encode(body).length>1024*1024){
          const parts=[];
          // Bound UTF-8 payloads; JSON quoting also stays below the request limit.
          for(let offset=0;offset<body.length;){
            let length=Math.min(256*1024,body.length-offset),data=body.slice(offset,offset+length);
            while(new TextEncoder().encode(data).length>256*1024){length=Math.floor(length/2);data=body.slice(offset,offset+length);}
            offset+=length;
            const part=await this.send(this.url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({commit:commit.commit,data}),signal:AbortSignal.timeout(this.timeout)});
            if(!part.ok){if(part.status===408||part.status===429||part.status>=500)throw new Retryable("Connection interrupted");throw new UploadRejected(`Cloud upload part rejected (HTTP ${part.status}). Local progress is retained.`);}
            const receipt=await part.json();
            if(typeof receipt.ref!=="string"||!/^objects\/[a-f0-9]{64}\.json$/.test(receipt.ref))throw new UploadRejected("Invalid upload part acknowledgement");
            parts.push(receipt.ref);
          }
          body=JSON.stringify({version:1,commit:commit.commit,parts});
        }
        response = await this.send(this.url, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.timeout),
        });
      } catch (error) {
        if(error instanceof UploadRejected)throw error;
        throw new Retryable(error.message);
      }
      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      )
        throw new Retryable("Connection interrupted");
      if (!response.ok)
        throw Error(
          response.status === 409
            ? "Another browser has newer cloud progress. Local progress is retained; cloud sync stopped."
            : `Cloud save rejected (HTTP ${response.status}). Local progress is retained.`,
        );
      let receipt;
      try {
        receipt = await response.json();
      } catch {
        throw new Retryable("Incomplete acknowledgement");
      }
      if (receipt.revision !== commit.commit)
        throw Error("Invalid cloud commit acknowledgement");
      await this.store.replicaCursor(receipt.revision, commit.files);
      await this.store.replicaOutbox(null);
      this.revision = receipt.revision;
      this.files = commit.files;
      this.failures = 0;
      this.retryAt = 0;
      // Local actions may have occurred since the durable outbox was written.
      this.pending = true;
      this.status("queued");
    })()
      .catch((error) => {
        if (error instanceof Retryable) {
          this.pending = true;
          this.retryAt =
            Date.now() +
            Math.min(60000, this.backoff * 2 ** Math.min(this.failures++, 6));
          this.status("retrying", "Saved here · retrying online");
        } else {
          this.failed = true;
          this.status("error", String(error.message ?? error));
        }
      })
      .finally(() => {
        this.flight = null;
        if (this.pending) this.schedule();
      });
    return this.flight;
  }
  async close() {
    clearTimeout(this.timer);
    await this.flight;
    await this.upload(true);
    this.closed = true;
    clearTimeout(this.timer);
  }
}
class Retryable extends Error {}

class UploadRejected extends Error {}
