import type { Compass } from "neonethack/types";

type Press = { direction: Compass; source: string };

/** Serial input scheduling only. Every step still goes through the public API.
 * Keep one deliberate tap; never queue a trail of held-key repeats. */
export class MovementInput {
  private held: Press | null = null;
  private pending: Press | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  inFlight = false;

  constructor(
    private available: () => boolean,
    private step: (direction: Compass, repeated: boolean) => Promise<boolean>,
    private changed: () => void,
  ) {}

  press(direction: Compass, source: string) {
    if (!this.available() && !this.inFlight) return;
    this.held = { direction, source };
    this.pending = this.held;
    clearTimeout(this.timer);
    void this.pump();
  }

  release(source: string) {
    if (this.held?.source !== source) return;
    this.held = null;
    clearTimeout(this.timer);
    // A deliberate tap made during an in-flight step remains buffered once.
    // Timer-generated repeats are never buffered.
  }

  stop() {
    this.held = this.pending = null;
    clearTimeout(this.timer);
  }

  cancel(source: string) {
    if (this.held?.source === source) this.stop();
  }

  private async pump(repeat = false) {
    if (this.inFlight) return;
    const press = this.pending ?? (repeat ? this.held : null);
    if (!press) return;
    const repeated = !this.pending;
    this.pending = null;
    if (!this.available()) {
      this.stop();
      return;
    }
    this.inFlight = true;
    const started = performance.now();
    let keepWalking = false;
    try {
      keepWalking = await this.step(press.direction, repeated);
    } finally {
      this.inFlight = false;
      this.changed();
    }
    if (!keepWalking) {
      this.stop();
      return;
    }
    if (this.pending) {
      void this.pump();
      return;
    }
    if (this.held) {
      const cadence = repeated ? 100 : 240;
      this.timer = setTimeout(
        () => void this.pump(true),
        Math.max(0, cadence - (performance.now() - started)),
      );
    }
  }
}
