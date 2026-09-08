import { compress, digest, recordingFormat } from "./protocol-recording.mjs";

/** Uploads only new committed inputs. Neither scheduling nor a network failure
 * is on the gameplay promise chain. A lost acknowledgement retries exact bytes. */
export class ProtocolUploader {
  constructor({
    store,
    headers,
    url,
    token,
    active = () => false,
    status = () => {},
  }) {
    Object.assign(this, { store, headers, url, token, active, status });
    this.dirty = new Set();
    this.first = 0;
    this.failures = 0;
    this.closed = false;
  }
  queue(id) {
    if (this.closed) return;
    this.dirty.add(id);
    this.first ||= Date.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.flush(),
      Math.max(0, Math.min(5000, this.first + 30000 - Date.now())),
    );
    this.status("queued");
  }
  async flush() {
    if (this.flight) return this.flight;
    if (this.closed) return;
    clearTimeout(this.timer);
    if (this.active()) {
      this.timer = setTimeout(() => void this.flush(), 100);
      return;
    }
    this.flight = this.pump()
      .catch(() => {
        this.status("retrying");
        this.timer = setTimeout(
          () => void this.flush(),
          Math.min(60000, 2000 * 2 ** Math.min(this.failures++, 5)),
        );
      })
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }
  async pump() {
    for (const id of this.dirty) {
      if (this.closed) return;
      let ack = (await this.store.upload(id)) ?? { count: 0 };
      const header = this.headers.get(id);
      if (!header) continue;
      while (ack.count < header.count) {
        if (this.closed) return;
        let batch = ack.pending;
        if (!batch) {
          const available = (await this.store.range(id, ack.count, 128)).filter(
              (r) => r.digest,
            ),
            records = [];
          let length = 1024;
          for (const record of available) {
            const size =
              new TextEncoder().encode(JSON.stringify(record)).length + 1;
            if (size + 1024 > 1024 * 1024)
              throw Error("A recorded input exceeds the upload limit");
            if (length + size > 1024 * 1024) break;
            records.push(record);
            length += size;
          }
          if (!records.length) break;
          const body = {
            format: recordingFormat,
            version: 1,
            id,
            buildId: header.buildId,
            from: ack.count,
            records,
            complete:
              header.complete && ack.count + records.length === header.count,
            summary: header.summary,
          };
          let bytes = await compress(
            new TextEncoder().encode(JSON.stringify(body)),
          );
          while (bytes.length > 512 * 1024 && records.length > 1) {
            records.splice(Math.ceil(records.length / 2));
            body.complete = false;
            bytes = await compress(
              new TextEncoder().encode(JSON.stringify(body)),
            );
          }
          if (bytes.length > 512 * 1024)
            throw Error("A compressed input exceeds the upload limit");
          batch = {
            bytes,
            hash: await digest(bytes),
            from: ack.count,
            count: records.length,
          };
          ack = { ...ack, pending: batch };
          await this.store.acknowledge(id, ack);
        }
        this.status("pending");
        const response = await fetch(
          new URL(encodeURIComponent(id) + "/inputs", this.url),
          {
            method: "PUT",
            headers: {
              authorization: "Bearer " + this.token,
              "content-type": "application/gzip",
              "x-content-sha256": batch.hash,
            },
            body: batch.bytes,
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok) throw Error("Run upload pending");
        const receipt = await response.json();
        if (
          receipt.hash !== batch.hash ||
          receipt.through !== batch.from + batch.count
        )
          throw Error("Upload acknowledgement differs");
        ack = {
          ...ack,
          pending: undefined,
          count: receipt.through,
          manifest: receipt.manifest,
        };
        await this.store.acknowledge(id, ack);
      }
      if (
        header.checkpoint &&
        header.checkpoint.index <= ack.count &&
        header.checkpoint.sha256 !== ack.checkpoint
      ) {
        const checkpoint = await this.store.checkpoint(id);
        if (checkpoint && checkpoint.index <= ack.count) {
          const response = await fetch(
            new URL(encodeURIComponent(id) + "/checkpoint", this.url),
            {
              method: "PUT",
              headers: {
                authorization: "Bearer " + this.token,
                "content-type": "application/gzip",
                "x-content-sha256": checkpoint.sha256,
                "x-checkpoint-index": String(checkpoint.index),
              },
              body: checkpoint.bytes,
              signal: AbortSignal.timeout(15000),
            },
          );
          if (!response.ok) throw Error("Checkpoint upload pending");
          const receipt = await response.json();
          if (
            receipt.hash !== checkpoint.sha256 ||
            receipt.index !== checkpoint.index
          )
            throw Error("Checkpoint acknowledgement differs");
          ack = { ...ack, checkpoint: checkpoint.sha256 };
          await this.store.acknowledge(id, ack);
        }
      }
      if (ack.count >= header.count) this.dirty.delete(id);
    }
    this.failures = 0;
    this.first = 0;
    this.status(this.dirty.size ? "queued" : "saved");
    if (this.dirty.size) this.timer = setTimeout(() => void this.flush(), 5000);
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
