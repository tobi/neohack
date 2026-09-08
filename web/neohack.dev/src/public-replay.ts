import { appendReplay, replayQueue, reconcileReplay, nextReplayBatch, acknowledgeReplay } from "./replay-outbox";
import type { Snapshot } from "neonethack/types";
export function replayLink(id: string) {
  return new URL("/dashboard?run=" + encodeURIComponent(id), location.origin)
    .href;
}
export function embedCode(id: string,manifest?:string) {
  return (
    '<script type="module" src="' +
    location.origin +
    '/component/neohack.js"></script>\n<neohack-world src="' +
    (manifest??replayLink(id)) +
    '" autoplay speed="4" controls style="height:480px"></neohack-world>'
  );
}
/** The worker records inputs. This handle only supports deliberate sharing. */
export class InputReplayRecorder {
  manifest?:string;
  constructor(private publish:()=>Promise<{count:number;manifest?:string}>,private prepare:()=>Promise<void>){}
  record(_frame:Snapshot){}
  close(){}
  async flush(){
    try{await this.prepare();const result=await this.publish();this.manifest=result.manifest;return result.count>0;}
    catch{return false;}
  }
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
        await appendReplay(this.key, copy);
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
        let queue = await replayQueue(this.key);
        if (!queue.count) return;
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
          await reconcileReplay(this.key,count,revision);
          queue = await replayQueue(this.key);
        }
        while (queue.count && !this.closed) {
          const batch = await nextReplayBatch(this.key);
          if (!batch) throw Error('Recording queue is incomplete');
          const response = await fetch("/api/runs/" + this.id + "/replay", {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer " + this.vault,
            },
            body: JSON.stringify(batch),
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
          const receipt = await response.json();
          await acknowledgeReplay(this.key,batch,receipt.acknowledged);
          queue = await replayQueue(this.key);
        }
        this.failures = 0;
        this.status(
          this.stopped
            ? "Replay partial · recording paused"
            : queue.count
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
    return (await replayQueue(this.key)).index! > 0;
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
