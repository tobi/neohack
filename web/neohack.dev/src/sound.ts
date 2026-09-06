import type { Snapshot } from "neonethack/types";

const clips = ["footstep00", "footstep01", "creak1", "chop"] as const;
type Clip = typeof clips[number];
/** Optional feedback for fresh public observations. Never queues engine input. */
export class DungeonSound {
  enabled = false;
  private context?: AudioContext;
  private buffers = new Map<Clip, AudioBuffer>();
  private active = new Set<AudioBufferSourceNode>();
  private seen = new Map<string, number>();
  private generation = 0;
  private disposed = false;
  private hidden = () => { if (document.hidden) this.stop(); };
  constructor(private base = "/audio/") { document.addEventListener("visibilitychange", this.hidden); }
  async enable() {
    const generation = ++this.generation;
    this.context ??= new AudioContext();
    const context = this.context;
    // Called directly from the sound button's user gesture.
    await context.resume();
    await Promise.all(clips.map(async clip => {
      if (this.buffers.has(clip)) return;
      const response = await fetch(`${this.base}${clip}.ogg`);
      if (!response.ok) throw Error("Sound could not load. Try enabling it again.");
      this.buffers.set(clip, await context.decodeAudioData(await response.arrayBuffer()));
    }));
    if (!this.disposed && generation === this.generation) this.enabled = true;
  }
  reset() { this.seen.clear(); this.stop(); }
  disable() { this.generation++; this.enabled = false; this.stop(); }
  private stop() {
    for (const source of this.active) source.stop();
    this.active.clear();
  }
  dispose() {
    this.disposed = true;
    this.disable();
    document.removeEventListener("visibilitychange", this.hidden);
    void this.context?.close();
  }
  observe(before: Snapshot, after: Snapshot, messages: string[]) {
    const revision = Number(after.revision);
    const last = this.seen.get(after.sessionId) ?? -1;
    if (revision <= last) return;
    this.seen.set(after.sessionId, revision);
    if (this.seen.size > 32) this.seen.delete(this.seen.keys().next().value!);
    if (!this.enabled || document.hidden || this.context?.state !== "running" ||
        before.sessionId !== after.sessionId || before.revision === after.revision ||
        before.observation.location.id !== after.observation.location.id ||
        after.error || after.ended || after.decision || after.outcome.turnsElapsed <= 0) return;
    const you = after.observation.you, was = before.observation.you;
    if (!you || !was) return;
    let clip: Clip | undefined;
    let volume = 0.12;
    if (messages.some(text => /^You (?:hit|smite|bite|claw|strike|punch) /.test(text))) {
      clip = "chop"; volume = 0.16;
    } else if (after.observation.world.some(cell =>
      cell.terrain.type === "openDoor" && before.observation.world.some(old =>
        old.x === cell.x && old.y === cell.y && old.terrain.type === "closedDoor"))) {
      clip = "creak1"; volume = 0.13;
    } else if (after.outcome.action === "move" && after.outcome.positionChanged && Math.max(Math.abs(you.x-was.x), Math.abs(you.y-was.y)) === 1) {
      clip = revision % 2 ? "footstep00" : "footstep01"; volume = 0.065;
    }
    if (!clip || !this.buffers.has(clip)) return;
    // Bound overlap; late loading never replays an old action.
    if (this.active.size >= 3) return;
    const source = this.context.createBufferSource(), gain = this.context.createGain();
    source.buffer = this.buffers.get(clip)!;
    gain.gain.value = volume;
    source.connect(gain).connect(this.context.destination);
    this.active.add(source);
    source.onended = () => { this.active.delete(source); source.disconnect(); gain.disconnect(); };
    source.start();
  }
}
