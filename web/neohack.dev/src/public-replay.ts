import { replayOutbox } from "./replay-outbox";
import type { Snapshot } from "neonethack/types";
export function replayLink(id: string) {
  return new URL("/dashboard?run=" + encodeURIComponent(id), location.origin)
    .href;
}
export function embedCode(id: string) {
  return (
    '<script type="module" src="' +
    location.origin +
    '/component/neohack.js"></script>\n<neohack-world src="' +
    replayLink(id) +
    '" autoplay speed="4" controls style="height:480px"></neohack-world>'
  );
}
/** Durable public recording queue, independent of the authoritative game save. */
export class PublicReplayRecorder {
  private tail = Promise.resolve();
  private revision = -1;
  private flight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private stopped = false;
  private closed = false;
  private key: string;
  constructor(
    private id: string,
    private vault: string,
    private prepare: () => Promise<void>,
    private status: (message: string) => void,
  ) {
    this.key = vault + ":" + id;
  }
  record(frame: Snapshot) {
    if (this.stopped || this.closed || frame.revision <= this.revision) return;
    this.revision = frame.revision;
    const copy = structuredClone(frame);
    delete copy.observation.neighborhood;
    this.tail = this.tail
      .then(async () => {
        await replayOutbox(this.key, (queue) => {
          if (queue.frames.some((f) => f.revision === copy.revision)) return;
          const bytes = new TextEncoder().encode(JSON.stringify(copy)).length;
          if (
            queue.frames.length >= 500 ||
            queue.bytes + bytes > 32 * 1024 * 1024
          )
            throw Error(
              "Recording paused: local queue is full. Saved frames remain available.",
            );
          queue.frames.push(copy);
          queue.bytes += bytes;
        });
        this.status("Replay local · publishes when this run settles");
      })
      .catch((error) => {
        this.stopped = true;
        this.status(error.message ?? "Recording storage unavailable.");
      });
  }
  private pump(): Promise<void> {
    if (this.flight) return this.flight;
    if (this.closed) return Promise.resolve();
    this.flight = navigator.locks
      .request("neohack-recording:" + this.key, async () => {
        await this.tail;
        let queue = await replayOutbox(this.key);
        if (!queue.frames.length) return;
        await this.prepare();
        if (queue.index === null) {
          const response = await fetch("/api/runs/" + this.id + "/replay?publication=1", {
            headers: {authorization:"Bearer "+this.vault},
            signal: AbortSignal.timeout(10000),
          });
          let count = 0,
            revision = -1;
          if (response.ok) {
            const data = await response.json();
            count = data.count;
            revision = data.revision;
            if (
              !Number.isSafeInteger(count) ||
              count < 0 ||
              !Number.isSafeInteger(revision)
            )
              throw Error("Invalid recording metadata");
          } else if (response.status !== 404)
            throw Error("Recording service unavailable");
          queue = await replayOutbox(this.key, (q) => {
            q.index = count;
            q.frames = q.frames.filter((f) => f.revision > revision);
            q.bytes = new TextEncoder().encode(JSON.stringify(q.frames)).length;
          });
        }
        while (queue.frames.length && !this.closed) {
          const frame = queue.frames[0]!;
          const response = await fetch("/api/runs/" + this.id + "/replay", {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer " + this.vault,
            },
            body: JSON.stringify({ index: queue.index, frame }),
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) {
            if (
              response.status >= 400 &&
              response.status < 500 &&
              ![408, 429].includes(response.status)
            ) {
              this.stopped = true;
              throw Error(
                "Recording stopped: server refused this sequence. Saved frames remain available.",
              );
            }
            throw Error("Recording upload pending");
          }
          queue = await replayOutbox(this.key, (q) => {
            if (q.frames[0]?.revision !== frame.revision)
              throw Error("Recording queue changed");
            q.frames.shift();
            q.index = (q.index ?? 0) + 1;
            q.bytes = new TextEncoder().encode(JSON.stringify(q.frames)).length;
          });
        }
        this.failures = 0;
        this.status(
          this.stopped
            ? "Replay partial · recording paused"
            : queue.frames.length
              ? "Replay pending · recorded here"
              : "Replay uploaded · recording from this visit",
        );
      })
      .then(() => {})
      .catch((error) => {
        this.status(
          this.stopped ? error.message : "Replay pending · retrying online",
        );
        if (!this.stopped && !this.closed)
          this.timer = setTimeout(
            () => void this.pump(),
            Math.min(60000, 1000 * 2 ** Math.min(this.failures++, 6)),
          );
      })
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight!;
  }
  async flush() {
    await this.tail;
    await this.pump();
    return (await replayOutbox(this.key)).index! > 0;
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
