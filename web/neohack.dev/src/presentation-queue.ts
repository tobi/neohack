/** Completed observations only. This queue never schedules engine input. */
export class PresentationQueue<T extends { sessionId: string; revision: number }> {
  current: T | null = null;
  private frames: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readyAt = 0;
  private waiting: (() => void)[] = [];
  private closed = false;
  private show: (frame: T, duration: number, paint: boolean) => void;
  private instant: () => boolean;
  constructor(show: (frame: T, duration: number, paint: boolean) => void, instant = () => false) {
    this.show = show;
    this.instant = instant;
  }
  get pending() { return this.frames.length; }
  get latest() { return this.frames.at(-1) ?? this.current; }
  get duration() { return Math.max(16, Math.round(180 / Math.max(1, this.pending / 30))); }
  async push(frame: T) {
    if (this.closed) return;
    if (this.latest?.sessionId !== frame.sessionId) { this.reset(frame); return; }
    if (frame.revision <= this.latest.revision) return;
    // Bounded memory even if an agent outruns accelerated playback indefinitely.
    // Only a full queue applies backpressure; ordinary calls return immediately.
    while (this.frames.length >= 120 && !this.closed)
      await new Promise<void>(resolve => this.waiting.push(resolve));
    if (this.closed || this.latest?.sessionId !== frame.sessionId) return;
    this.frames.push(frame);
    if (this.instant()) this.flush();
    else this.schedule();
  }
  private release() { for (const resolve of this.waiting.splice(0)) resolve(); }
  private schedule() {
    if (this.timer || !this.frames.length) return;
    const delay = Math.min(this.duration, Math.max(0, this.readyAt - performance.now()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.instant()) { this.flush(); return; }
      const frame = this.frames.shift()!;
      const duration = this.duration;
      this.current = frame;
      this.readyAt = performance.now() + duration;
      this.release();
      this.show(frame, duration, true);
      this.schedule();
    }, delay);
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const frames = this.frames.splice(0);
    // Keep every journal receipt; only intermediate raster/display work is skipped.
    frames.forEach((frame, i) => {
      this.current = frame;
      this.show(frame, 0, i === frames.length - 1);
    });
    this.readyAt = 0;
    this.release();
  }
  reset(frame: T | null, paint = true) {
    clearTimeout(this.timer); this.timer = undefined;
    this.frames = []; this.release();
    this.current = frame;
    this.readyAt = performance.now() + 180;
    if (frame && !this.closed && paint) this.show(frame, 0, true);
  }
  close() { this.closed = true; this.reset(null); }
}
