import { LitElement, html, nothing } from "lit";
import { theme } from "./explorer-theme.js";
import { World } from "./world.js";
import {
  RemoteRecording,
  LocalRecording,
  parseRecording,
  observationAt,
} from "./recording.js";
import "./nh-map3d.js";

const DIRECTIONS = [
  ["northwest", "↖"],
  ["north", "↑"],
  ["northeast", "↗"],
  ["west", "←"],
  ["wait", "·"],
  ["east", "→"],
  ["southwest", "↙"],
  ["south", "↓"],
  ["southeast", "↘"],
];
const KEYDIR = {
  ArrowUp: "north",
  ArrowDown: "south",
  ArrowLeft: "west",
  ArrowRight: "east",
  k: "north",
  j: "south",
  h: "west",
  l: "east",
  y: "northwest",
  u: "northeast",
  b: "southwest",
  n: "southeast",
};
const ITEMS = [
  "eat",
  "drink",
  "equip",
  "wield",
  "read",
  "apply",
  "zap",
  "drop",
];
const ROLES = [
  "valkyrie",
  "samurai",
  "barbarian",
  "healer",
  "wizard",
  "rogue",
  "ranger",
  "monk",
  "knight",
  "priest",
  "tourist",
  "archeologist",
  "caveman",
];
const label = (s) =>
  String(s ?? "")
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
const STORE = "neonethack.explorer.session.v1";

export class ExplorerView extends LitElement {
  static properties = Object.fromEntries(
    [
      "envelope",
      "busy",
      "error",
      "uncertain",
      "messages",
      "selected",
      "targeting",
      "selectedTile",
      "choices",
      "filter",
      "seed",
      "hero",
      "role",
      "saved",
      "status",
      "mode",
      "runs",
      "loadingRuns",
      "recording",
      "playhead",
      "playing",
      "speed",
      "seeking",
      "reconstruction",
    ].map((k) => [k, { state: true }]),
  );
  static styles = theme;
  constructor() {
    super();
    this.api = new World();
    this.envelope = null;
    this.liveEnvelope = null;
    this.liveMessages = [];
    this.busy = false;
    this.error = "";
    this.uncertain = false;
    this.messages = [];
    this.selected = null;
    this.selectedTile = null;
    this.targeting = null;
    this.choices = [];
    this.filter = "";
    this.seed = "42";
    this.hero = "Explorer";
    this.role = "valkyrie";
    this.status = "Not connected";
    this.mode = "live";
    this.runs = [];
    this.loadingRuns = false;
    this.recording = null;
    this.playhead = 0;
    this.playing = false;
    this.speed = 1;
    this.seeking = false;
    this._seekToken = 0;
    this._openToken = 0;
    this._playToken = 0;
    this._jobToken = 0;
    this.reconstruction = null;
    try {
      this.saved =
        localStorage.getItem(STORE) ||
        localStorage.getItem("neonethack.session") ||
        "";
    } catch {
      this.saved = "";
    }
    this.onKey = this.onKey.bind(this);
  }
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKey);
    this.refreshRuns();
    const linkedRun = new URL(location.href).searchParams.get("run");
    if (linkedRun && /^[A-Za-z0-9_-]{1,64}$/.test(linkedRun))
      this.watch(
        linkedRun,
        Number(new URL(location.href).searchParams.get("frame") ?? 0),
      );
    try {
      const job = localStorage.getItem("neonethack.reconstruction");
      if (job) this.followReconstruction(job);
    } catch {}
  }
  disconnectedCallback() {
    window.removeEventListener("keydown", this.onKey);
    this.pause();
    this._jobToken++;
    clearTimeout(this._jobTimer);
    super.disconnectedCallback();
  }
  get obs() {
    return this.envelope?.observation ?? {};
  }
  get decision() {
    return this.envelope?.decision;
  }
  get ready() {
    return (
      this.mode === "live" &&
      !!this.envelope?.sessionId &&
      !this.envelope.ended &&
      !this.busy &&
      !this.decision &&
      !this.uncertain &&
      this.status !== "Saved"
    );
  }
  async invoke(name, args) {
    if (this.busy || this.mode !== "live") return;
    this.busy = true;
    this.error = "";
    try {
      const d = await this.api.tool(name, args);
      this.apply(d, name);
      return d;
    } catch (e) {
      this.error = e.message;
      this.uncertain = true;
      this.status = "Connection issue";
      this.log(this.error, "error");
    } finally {
      this.busy = false;
    }
  }
  apply(d, name) {
    if (d.observation) {
      const old = this.decision?.id;
      this.envelope = d;
      this.liveEnvelope = d;
      if (old !== d.decision?.id) {
        this.choices = [];
        this.filter = "";
      }
      if (
        this.selected &&
        !d.observation.inventory?.some((i) => i.id === this.selected)
      )
        this.selected = null;
    }
    if (d.sessionId) {
      this.saved = d.sessionId;
      try {
        localStorage.setItem(STORE, d.sessionId);
      } catch {}
    }
    if (d.error) {
      this.error = `${d.error.code}: ${d.error.message}`;
      this.log(this.error, "error");
    }
    if (name === "new_game" || name === "resume") {
      this.messages = [];
      this.selected = null;
      this.selectedTile = null;
      this.targeting = null;
      for (const text of d.observation?.heard ?? [])
        if (text.trim()) this.log(text);
    } else {
      for (const e of d.events ?? []) {
        if (e.type === "heard") this.log(e.text);
        if (e.type === "shown")
          for (const text of e.items ?? []) this.log(text, "system");
      }
    }
    if (d.outcome && name === "act")
      this.log(
        `${label(d.outcome.action)} · ${label(d.outcome.status)} · +${d.outcome.turnsElapsed} turn${d.outcome.turnsElapsed === 1 ? "" : "s"}${d.outcome.reason ? " · " + label(d.outcome.reason) : ""}`,
        "system",
      );
    if (d.recording?.status === "degraded") {
      this.error = `Recording needs attention: ${d.recording.message}`;
      this.log(this.error, "error");
    }
    this.uncertain =
      d.recording?.status === "degraded" ||
      d.error?.code === "recordingUnavailable" ||
      d.outcome?.status === "unknown" ||
      (d.outcome?.status === "needsChoice" && !d.decision) ||
      (!d.observation && !!d.error);
    if (d.outcome?.status === "needsChoice" && !d.decision)
      this.error =
        "The core needs a choice but returned no decision. No action was guessed.";
    this.status =
      d.recording?.status === "degraded"
        ? "Recording issue"
        : !d.observation && d.error
          ? "Resume required"
          : name === "end_session"
            ? "Saved"
            : d.ended
              ? "Ended"
              : d.decision
                ? "Decision needed"
                : "Connected";
    this.liveMessages = this.messages;
    if (d.decision)
      this.updateComplete.then(() =>
        this.renderRoot
          .querySelector(".decision button, .decision input")
          ?.focus(),
      );
    else if (
      (name === "new_game" || name === "resume") &&
      !d.ended &&
      this.mode === "live"
    )
      this.updateComplete.then(() =>
        this.renderRoot
          .querySelector(".controls")
          ?.focus({ preventScroll: true }),
      );
    if (d.ended || name === "end_session" || name === "new_game")
      this.refreshRuns();
  }
  log(text, kind = "heard") {
    if (text?.trim())
      this.messages = [
        { text, kind, turn: this.obs.turn ?? 0 },
        ...this.messages,
      ].slice(0, 150);
  }
  async start() {
    if (this.mode !== "live") this.showLive();
    if (this.envelope && !this.envelope.ended && this.status !== "Saved") {
      if (!confirm("Save this world and start a new expedition?")) return;
      await this.invoke("end_session", { sessionId: this.envelope.sessionId });
    }
    const seed = Number(this.seed);
    if (this.seed.trim() && !Number.isSafeInteger(seed)) {
      this.error = "Seed must be an integer.";
      return;
    }
    await this.invoke("new_game", {
      name: this.hero || "Explorer",
      role: this.role,
      ...(this.seed.trim() ? { seed } : {}),
      ...(this.role === "valkyrie"
        ? { race: "dwarf", gender: "female", align: "lawful" }
        : { race: "human" }),
    });
  }
  async act(intent) {
    if (
      this.mode !== "live" ||
      !this.envelope ||
      this.busy ||
      this.envelope.ended ||
      this.uncertain
    )
      return;
    if (this.decision && !intent.replyTo) return;
    this.targeting = null;
    return this.invoke("act", {
      sessionId: this.envelope.sessionId,
      expectedRevision: this.envelope.revision,
      requestId: crypto.randomUUID(),
      ...intent,
    });
  }
  answer(answer) {
    if (this.mode === "live" && this.decision)
      return this.act({ replyTo: this.decision.id, ...answer });
  }
  look() {
    if (this.saved && this.mode === "live")
      return this.invoke("get_state", { sessionId: this.saved });
  }
  resume() {
    if (this.saved && this.mode === "live")
      return this.invoke("resume", { sessionId: this.saved });
  }
  leave() {
    if (this.envelope && this.mode === "live")
      return this.invoke("end_session", { sessionId: this.envelope.sessionId });
  }
  move(direction) {
    if (this.ready)
      return this.act(
        direction === "wait"
          ? { action: "wait" }
          : { action: "move", direction },
      );
  }
  chooseAction(action) {
    if (!this.ready) return;
    if (["kick", "open", "close", "zap"].includes(action)) {
      this.targeting = {
        action,
        ...(this.selected && action === "zap"
          ? { item: { id: this.selected } }
          : {}),
      };
      return;
    }
    return this.act({
      action,
      ...(this.selected && ITEMS.includes(action)
        ? { item: { id: this.selected } }
        : {}),
    });
  }
  sendTarget(target) {
    if (this.mode !== "live") return;
    if (this.decision?.kind === "target") return this.answer({ target });
    if (this.targeting) return this.act({ ...this.targeting, target });
  }
  onKey(e) {
    // A focused dialog button/input must still honor its advertised Escape.
    // Map inspection handles its own keys and never cancels a game decision.
    if (
      !e.defaultPrevented &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.key === "Escape" &&
      this.mode === "live" &&
      e.composedPath().some((t) => t?.classList?.contains("decision"))
    ) {
      e.preventDefault();
      if (this.targeting) this.targeting = null;
      else if (this.decision?.cancellable) this.answer({ cancel: true });
      return;
    }
    if (
      e.defaultPrevented ||
      e
        .composedPath()
        .some(
          (t) =>
            t?.tagName &&
            (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "NH-MAP3D"].includes(
              t.tagName,
            ) ||
              t.isContentEditable),
        ) ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      e.repeat
    )
      return;
    if (this.mode === "replay") {
      if (e.key === " ") {
        e.preventDefault();
        this.playing ? this.pause() : this.play();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        this.pause();
        this.seek(this.playhead + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        this.pause();
        this.seek(this.playhead - 1);
      }
      return;
    }
    if (e.key === "Escape") {
      if (this.targeting) {
        this.targeting = null;
        return;
      }
      if (this.decision?.cancellable) {
        e.preventDefault();
        this.answer({ cancel: true });
        return;
      }
    }
    if (!this.ready) return;
    const direction = KEYDIR[e.key];
    if (direction) {
      e.preventDefault();
      this.move(direction);
    } else if (e.key === ".") {
      e.preventDefault();
      this.move("wait");
    } else if (e.key === "<" || e.key === ">") {
      e.preventDefault();
      this.act({ action: "climb", direction: e.key === ">" ? "down" : "up" });
    }
  }
  async refreshRuns() {
    if (this.loadingRuns) return;
    this.loadingRuns = true;
    try {
      const r = await fetch("/runs");
      if (!r.ok) throw Error(`Run library HTTP ${r.status}`);
      this.runs = (await r.json()).runs ?? [];
    } catch (e) {
      this.libraryError = e.message;
    } finally {
      this.loadingRuns = false;
    }
  }
  showLive() {
    if (this.busy) return;
    this.pause();
    this._seekToken++;
    this._openToken++;
    this.mode = "live";
    const url = new URL(location.href);
    url.searchParams.delete("run");
    url.searchParams.delete("frame");
    history.replaceState(null, "", url);
    this.envelope = this.liveEnvelope;
    this.messages = this.liveMessages;
    this.selected = null;
    this.selectedTile = null;
    this.error = "";
    this.status = !this.envelope
      ? "Not connected"
      : this.envelope.ended
        ? "Saved"
        : this.envelope.decision
          ? "Decision needed"
          : "Connected";
  }
  async watch(id, frame = 0) {
    if (this.busy) return;
    this.pause();
    const token = ++this._openToken;
    this._seekToken++;
    this.mode = "replay";
    this.status = "Opening recording…";
    this.targeting = null;
    this.selected = null;
    this.error = "";
    try {
      const rec = await new RemoteRecording(id).open();
      if (token !== this._openToken || this.mode !== "replay") return;
      if (!rec.index.length) throw Error("This run has no recorded frames.");
      this.recording = rec;
      this.targeting = null;
      this.selected = null;
      await this.seek(Number.isSafeInteger(frame) && frame >= 0 ? frame : 0);
    } catch (e) {
      this.error = e.message;
    }
  }
  async importRecording(file) {
    if (!file) return;
    this.pause();
    this.error = "";
    try {
      if (file.size > 128 * 1024 * 1024)
        throw Error(
          "Import is limited to 128 MB. Use the paged run library for larger recordings.",
        );
      this.recording = new LocalRecording(parseRecording(await file.text()));
      const url = new URL(location.href);
      url.searchParams.delete("run");
      url.searchParams.delete("frame");
      history.replaceState(null, "", url);
      this.mode = "replay";
      this.targeting = null;
      this.selected = null;
      await this.seek(0);
    } catch (e) {
      this.error = e.message;
    }
  }
  async seek(index) {
    if (!this.recording || this.mode !== "replay") return;
    index = Math.max(0, Math.min(this.recording.index.length - 1, index));
    const token = ++this._seekToken;
    this.seeking = true;
    try {
      const frame = await this.recording.frame(index);
      if (token !== this._seekToken || this.mode !== "replay") return;
      this.envelope = observationAt(frame);
      this.playhead = index;
      this.selectedTile = null;
      this.status = "Replay · read-only";
      if (this.recording.id) {
        const url = new URL(location.href);
        url.searchParams.set("run", this.recording.id);
        url.searchParams.set("frame", String(index));
        history.replaceState(null, "", url);
      }
      this.messages = (this.obs.heard ?? [])
        .filter(Boolean)
        .map((text) => ({ text, kind: "heard", turn: this.obs.turn }))
        .reverse();
      for (const event of this.envelope.events ?? [])
        if (event.type === "shown") {
          if (event.about) this.log(event.about, "system");
          for (const text of event.items ?? []) this.log(text, "system");
        }
      this.log(
        `${label(this.envelope.outcome?.action)} · ${label(this.envelope.outcome?.status)} · frame ${index + 1}`,
        "system",
      );
    } catch (e) {
      if (token === this._seekToken) {
        this.error = e.message;
        this.pause();
      }
    } finally {
      if (token === this._seekToken) this.seeking = false;
    }
  }
  pause() {
    this.playing = false;
    this._playToken++;
    clearTimeout(this._playTimer);
  }
  play() {
    if (!this.recording || this.mode !== "replay") return;
    this.pause();
    this.playing = true;
    const token = this._playToken;
    const tick = async () => {
      if (!this.playing || this.mode !== "replay" || token !== this._playToken)
        return;
      if (this.playhead >= this.recording.index.length - 1) {
        this.pause();
        return;
      }
      await this.seek(this.playhead + 1);
      if (this.playing && token === this._playToken)
        this._playTimer = setTimeout(tick, 500 / this.speed);
    };
    this._playTimer = setTimeout(tick, 500 / this.speed);
  }
  renderMap() {
    return html`<nh-map3d
      .observation=${this.envelope ? this.obs : null}
      .worldKey=${this.envelope?.sessionId ?? ""}
      .animateMoves=${this.mode === "live" || this.playing}
      .selected=${this.selectedTile}
      @tile-select=${(e) => (this.selectedTile = e.detail)}
    ></nh-map3d>`;
  }
  renderTargets(allowSelf = false) {
    return html`<div class="target-grid">
      ${DIRECTIONS.map(([direction, arrow]) =>
        direction === "wait"
          ? html`<button
              ?disabled=${!allowSelf || this.busy}
              @click=${() => this.sendTarget("self")}
              title="Act on yourself"
            >
              Self
            </button>`
          : html`<button
              ?disabled=${this.busy}
              @click=${() => this.sendTarget({ direction })}
              title=${direction}
            >
              ${arrow}
              ${direction
                .replace("north", "N")
                .replace("south", "S")
                .replace("east", "E")
                .replace("west", "W")}
            </button>`,
      )}
    </div>`;
  }
  renderDecision() {
    const d = this.decision;
    if (!d && !this.targeting) return nothing;
    if (this.mode === "replay")
      return html`<section class="panel decision">
        <div class="panel-head">
          <span class="eyebrow">Recorded decision · read-only</span>
        </div>
        <div class="card-body">
          <h2>${d?.about ?? label(d?.kind)}</h2>
          <p class="control-help">
            This is what the explorer was asked at this point. Playback never
            submits an answer.
          </p>
        </div>
      </section>`;
    if (this.targeting)
      return html`<section class="panel decision">
        <div class="panel-head">
          <span class="eyebrow">Choose a target</span
          ><span class="muted">${label(this.targeting.action)}</span>
        </div>
        <div class="card-body">
          <p class="decision-about">
            Where do you want to ${this.targeting.action}?
          </p>
          ${this.renderTargets(this.targeting.action === "zap")}<button
            class="quiet small"
            @click=${() => (this.targeting = null)}
          >
            Cancel · Esc
          </button>
        </div>
      </section>`;
    const multi = (d.selection?.max ?? 1) > 1,
      options = (d.options ?? []).filter((o) =>
        o.label.toLowerCase().includes(this.filter.toLowerCase()),
      );
    return html`<section
      class="panel decision"
      aria-labelledby="decision-heading"
    >
      <div class="panel-head">
        <span class="eyebrow">Your decision</span
        ><span class="muted">${label(d.action)}</span>
      </div>
      <div class="card-body">
        <h2 id="decision-heading" class="decision-about">
          ${d.about || label(d.kind)}
        </h2>
        ${d.kind === "confirmation"
          ? html`<div class="decision-actions">
              <button
                class="primary"
                ?disabled=${this.busy}
                @click=${() => this.answer({ confirm: true })}
              >
                Confirm</button
              ><button
                ?disabled=${this.busy}
                @click=${() => this.answer({ confirm: false })}
              >
                Decline
              </button>
            </div>`
          : d.kind === "target"
            ? this.renderTargets(d.allowedTargets?.includes("self"))
            : d.kind === "text"
              ? html`<form
                  @submit=${(e) => {
                    e.preventDefault();
                    this.answer({ text: e.currentTarget.elements.words.value });
                  }}
                >
                  <input
                    name="words"
                    aria-label=${d.about || "Your answer"}
                    autocomplete="off"
                  /><button
                    class="primary"
                    style="margin-top:10px"
                    ?disabled=${this.busy}
                  >
                    Submit
                  </button>
                </form>`
              : html`${d.options?.length > 5
                    ? html`<input
                        placeholder="Filter offered items…"
                        aria-label="Filter options"
                        .value=${this.filter}
                        @input=${(e) => (this.filter = e.target.value)}
                      />`
                    : nothing}
                  <div class="options">
                    ${options.map(
                      (o) =>
                        html`<button
                          class="option ${this.choices.includes(o.id)
                            ? "selected"
                            : ""}"
                          ?disabled=${this.busy || o.selectable === false}
                          @click=${() => {
                            if (multi)
                              this.choices = this.choices.includes(o.id)
                                ? this.choices.filter((c) => c !== o.id)
                                : [...this.choices, o.id];
                            else
                              this.answer(
                                d.kind === "item"
                                  ? { item: { id: o.id } }
                                  : { choose: o.id },
                              );
                          }}
                        >
                          ${o.label}<span>${o.location ?? ""}</span>
                        </button>`,
                    )}
                  </div>
                  ${multi
                    ? html`<button
                        class="primary"
                        ?disabled=${this.busy ||
                        this.choices.length < (d.selection?.min ?? 0)}
                        @click=${() => this.answer({ choose: this.choices })}
                      >
                        Confirm selection (${this.choices.length})
                      </button>`
                    : nothing}${!options.length
                    ? html`<p class="muted">No candidates returned.</p>`
                    : nothing}`}
        ${d.cancellable
          ? html`<button
              class="quiet small"
              style="margin-top:12px"
              ?disabled=${this.busy}
              @click=${() => this.answer({ cancel: true })}
            >
              Cancel · Esc
            </button>`
          : nothing}
        <p class="control-help">
          Only your selected answer is submitted. No warnings are
          auto-confirmed.
        </p>
      </div>
    </section>`;
  }
  renderRecordingNotice() {
    const info = this.mode === "replay" ? this.recording?.integrity : null;
    if (!info || (info.state === "complete" && !info.gaps?.length))
      return nothing;
    return html`<section class="provenance-banner recording-notice" role="note">
      <strong
        >${info.state === "complete"
          ? "Recording has history gaps"
          : "Incomplete recording · validated prefix only"}</strong
      >
      <p>
        ${info.notice ??
        "Some checkpoints are unavailable. No missing observations were invented."}
      </p>
      ${info.state !== "complete"
        ? html`<span
            >${info.completeFrames} complete checkpoints ·
            ${info.totalBytes - info.validBytes} unavailable bytes</span
          >`
        : nothing}
      ${this.recording?.id && info.state !== "complete"
        ? html`<p>
            <a href=${`/runs/${this.recording.id}/export?raw=1`}
              >Preserve raw original</a
            >
          </p>`
        : nothing}
    </section>`;
  }
  renderTimeline() {
    if (this.mode !== "replay" || !this.recording) return nothing;
    const end = this.recording.index.length - 1;
    return html`<section class="timeline" aria-label="Replay controls">
      <div class="timeline-head">
        <button
          @click=${() => {
            this.pause();
            this.seek(0);
          }}
          title="First frame"
        >
          |←</button
        ><button
          @click=${() => {
            this.pause();
            this.seek(this.playhead - 1);
          }}
          title="Previous frame"
        >
          ←</button
        ><button
          class="primary"
          @click=${() => (this.playing ? this.pause() : this.play())}
        >
          ${this.playing ? "Pause" : "Play"}</button
        ><button
          @click=${() => {
            this.pause();
            this.seek(this.playhead + 1);
          }}
          title="Next frame"
        >
          →</button
        ><button
          @click=${() => {
            this.pause();
            this.seek(end);
          }}
          title="Last frame"
        >
          →|</button
        ><select
          aria-label="Playback speed"
          .value=${String(this.speed)}
          @change=${(e) => (this.speed = Number(e.target.value))}
        >
          ${[0.5, 1, 2, 4].map(
            (n) =>
              html`<option value=${n} ?selected=${n === this.speed}>
                ${n}×
              </option>`,
          )}</select
        ><span class="pill replay-badge">Read-only replay</span>${this.recording
          .id
          ? html`<a href=${`/runs/${this.recording.id}/export`}
              >Export recording</a
            >`
          : nothing}
      </div>
      <input
        aria-label="Replay frame"
        type="range"
        min="0"
        max=${end}
        .value=${String(this.playhead)}
        @input=${(e) => {
          this.pause();
          this.seek(Number(e.target.value));
        }}
      />
      <div class="timeline-labels">
        <span
          >Frame ${this.playhead + 1} /
          ${end + 1}${this.seeking ? " · loading" : ""}</span
        ><span
          >Turn ${this.obs.turn ?? "—"} ·
          ${label(this.envelope?.outcome?.action)}</span
        >
      </div>
    </section>`;
  }
  async reconstruct(id) {
    if (this.busy || this.reconstruction?.state === "running") return;
    if (
      !confirm(
        "Reconstruct this legacy input log in a separate sandbox? The original is preserved. The result is unverified because original observations, calendar and options were not captured.",
      )
    )
      return;
    this.pause();
    this.reconstruction = { state: "running", sourceSessionId: id };
    try {
      const response = await fetch(`/runs/${id}/reconstruct`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok || !result.job)
        throw Error(result.error || "Reconstruction could not start");
      this.reconstruction = result.job;
      try {
        localStorage.setItem("neonethack.reconstruction", result.job.id);
      } catch {}
      this.followReconstruction(result.job.id);
    } catch (e) {
      this.reconstruction = { state: "failed", error: { message: e.message } };
    }
  }
  followReconstruction(id) {
    const token = ++this._jobToken,
      started = performance.now();
    clearTimeout(this._jobTimer);
    const check = async () => {
      if (token !== this._jobToken || !this.isConnected) return;
      try {
        const response = await fetch(`/reconstructions/${id}`, {
          signal: AbortSignal.timeout(15000),
        });
        const data = await response.json();
        if (!response.ok || !data.job)
          throw Error(data.error || "Cannot read reconstruction status");
        if (token !== this._jobToken) return;
        this.reconstruction = data.job;
        if (data.job.state === "running") {
          if (performance.now() - started > 240000)
            throw Error(
              "Monitoring timed out; refresh the run library to check for a completed archive.",
            );
          this._jobTimer = setTimeout(check, 1000);
        } else {
          try {
            localStorage.removeItem("neonethack.reconstruction");
          } catch {}
          this.refreshRuns();
        }
      } catch (e) {
        if (token === this._jobToken)
          this.reconstruction = {
            id,
            state: "failed",
            error: { message: e.message },
          };
      }
    };
    check();
  }
  renderRuns() {
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Recorded expeditions</h2>
        <button
          class="quiet small"
          ?disabled=${this.loadingRuns}
          @click=${() => this.refreshRuns()}
        >
          ${this.loadingRuns ? "Loading…" : "Refresh"}
        </button>
      </div>
      <div class="card-body">
        <div class="run-actions">
          <button
            class="small"
            @click=${() =>
              this.renderRoot.querySelector("#recording-file").click()}
          >
            Import recording</button
          ><input
            class="file-input"
            id="recording-file"
            type="file"
            accept=".jsonl,.ndjson"
            @change=${(e) => this.importRecording(e.target.files?.[0])}
          />
        </div>
        ${this.reconstruction
          ? html`<div class="reconstruction-status" role="status">
              <strong
                >${this.reconstruction.state === "running"
                  ? "Reconstructing in an isolated worker…"
                  : this.reconstruction.state === "completed"
                    ? "Reconstruction ready · unverified"
                    : "Reconstruction unavailable"}</strong
              >
              <p>
                ${this.reconstruction.error?.message ||
                "The original run is unchanged. Playback of the result is read-only."}
              </p>
              ${this.reconstruction.state === "completed"
                ? html`<button
                    class="small"
                    @click=${() => this.watch(this.reconstruction.archiveId)}
                  >
                    Review reconstruction
                  </button>`
                : nothing}
            </div>`
          : nothing}
        <div class="run-list">
          ${this.runs
            .slice(0, 35)
            .map(
              (r) =>
                html`<button
                  class="run-row"
                  ?disabled=${this.busy ||
                  (!r.replayReady && this.reconstruction?.state === "running")}
                  title=${r.replayReady
                    ? "Review without starting an engine"
                    : "Explicitly reconstruct this legacy log in a sandbox"}
                  @click=${() =>
                    r.replayReady
                      ? this.watch(r.sessionId)
                      : this.reconstruct(r.sessionId)}
                >
                  ${r.title?.trim() || r.sessionId}<span>${r.sessionId}</span
                  ><span
                    >${r.replayReady
                      ? `${r.provenance?.kind === "reconstruction" ? "Reconstructed · unverified · " : ""}T ${r.turn ?? "?"} · ${r.depth ?? ""} · ${r.frames} frames`
                      : "Legacy input log · click to reconstruct"}</span
                  >
                </button>`,
            )}
        </div>
        ${!this.runs.length
          ? html`<p class="muted">
              ${this.libraryError ||
              "New expeditions are recorded automatically. Their public perceptions can be reviewed here."}
            </p>`
          : nothing}
      </div>
    </section>`;
  }
  renderControls() {
    if (this.mode === "replay")
      return html`<div class="panel replay-summary">
        <span class="pill replay-badge">Past perception</span
        ><span
          >Camera and inspection work normally. Game actions are disabled.</span
        ><button class="small" @click=${() => this.showLive()}>
          Return to live world
        </button>
      </div>`;
    return html`<section
      class="controls"
      tabindex="0"
      aria-label="Game keyboard controls: arrows or h j k l move, period waits"
    >
      <div class="dpad" aria-label="Movement">
        ${DIRECTIONS.map(
          ([dir, arrow]) =>
            html`<button
              ?disabled=${!this.ready}
              @click=${() => this.move(dir)}
              title=${dir}
              aria-label=${dir === "wait" ? "Wait" : `Move ${dir}`}
            >
              ${arrow}
            </button>`,
        )}
      </div>
      <div class="action-space">
        <div class="eyebrow">Explore</div>
        <div class="action-row">
          ${["search", "pickup", "kick", "open", "close"].map(
            (action) =>
              html`<button
                ?disabled=${!this.ready}
                @click=${() => this.chooseAction(action)}
              >
                ${action === "pickup" ? "Pick up" : label(action)}
              </button>`,
          )}<button
            ?disabled=${!this.ready}
            @click=${() => this.act({ action: "climb", direction: "down" })}
          >
            Descend ↓</button
          ><button
            ?disabled=${!this.ready}
            @click=${() => this.act({ action: "climb", direction: "up" })}
          >
            Ascend ↑
          </button>
        </div>
        <div class="eyebrow" style="margin-top:11px">Belongings & self</div>
        <div class="action-row">
          ${ITEMS.map(
            (action) =>
              html`<button
                ?disabled=${!this.ready}
                @click=${() => this.chooseAction(action)}
              >
                ${label(action)}
              </button>`,
          )}<button
            ?disabled=${!this.ready}
            @click=${() => this.act({ action: "pray" })}
          >
            Pray</button
          ><button
            ?disabled=${!this.ready}
            @click=${() => this.act({ action: "inspect", target: "self" })}
          >
            Inspect self</button
          ><button
            ?disabled=${!this.ready}
            @click=${() => this.act({ action: "inspect", target: "here" })}
          >
            Inspect here
          </button>
        </div>
        <p class="control-help">
          <span class="kbd">↑ ↓ ← →</span> or <span class="kbd">hjkl</span> move
          · <span class="kbd">.</span> wait here. In map focus, arrows inspect
          instead; <span class="kbd">Esc</span> leaves map focus. Never
          auto-walk.
        </p>
      </div>
    </section>`;
  }
  render() {
    const o = this.obs,
      v = o.vitals ?? {},
      hp = Number(v.health ?? 0),
      max = Number(v.maxHealth ?? 1),
      inv = o.inventory ?? [],
      picked = inv.find((i) => i.id === this.selected),
      noSession = !this.envelope;
    const conditions = Array.isArray(v.condition) ? v.condition : [];
    return html`<header>
        <div class="brand">
          <div class="brand-icon">@</div>
          <div>
            <h1>NetHack <span class="muted">/ Explorer</span></h1>
            <div class="eyebrow">Enter a world. Revisit every moment.</div>
          </div>
        </div>
        <div class="mode-tabs">
          <button
            class="quiet small"
            aria-pressed=${this.mode === "live"}
            ?disabled=${this.busy}
            @click=${() => this.showLive()}
          >
            Live</button
          ><button
            class="quiet small"
            aria-pressed=${this.mode === "replay"}
            @click=${() => {
              this.refreshRuns();
              this.renderRoot
                .querySelector(".sidebar")
                ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }}
          >
            Run library
          </button>
        </div>
        <div class="top-actions">
          <span
            class="pill ${this.status === "Connected" ? "live" : ""}"
            role="status"
            >${this.busy ? "Acting…" : this.status}</span
          ><button
            class="quiet small"
            ?disabled=${this.mode !== "live" || this.busy || !this.saved}
            @click=${() => this.look()}
          >
            Check state</button
          ><button
            class="quiet small"
            ?disabled=${this.mode !== "live" || this.busy || !this.saved}
            @click=${() => this.resume()}
          >
            Resume</button
          ><button
            class="small"
            ?disabled=${this.mode !== "live" ||
            this.busy ||
            !this.envelope ||
            this.envelope.ended}
            @click=${() => this.leave()}
          >
            Save & leave
          </button>
        </div>
      </header>
      <main>
        ${this.renderRecordingNotice()}
        ${this.envelope?.provenance?.kind === "reconstruction"
          ? html`<section class="provenance-banner" role="note">
              <strong>Reconstructed history · unverified</strong>
              <p>${this.envelope.provenance.note}</p>
              <span
                >Source ${this.envelope.provenance.sourceSessionId} ·
                ${this.envelope.provenance.answersConsumed}/${this.envelope
                  .provenance.answersTotal}
                stored answers</span
              >
            </section>`
          : nothing}
        ${this.error
          ? html`<div class="error-banner" role="alert">
              <span>${this.error}</span>${this.mode === "live"
                ? html`<button
                    class="small"
                    ?disabled=${this.busy}
                    @click=${() => this.look()}
                  >
                    Check state
                  </button>`
                : nothing}
            </div>`
          : nothing}
        <section class="stats">
          <div class="hero">
            <div class="eyebrow">
              ${o.location?.depthLabel
                ? `${this.mode === "replay" ? "Recorded" : "Dungeon"} · ${o.location.depthLabel}`
                : "Your next expedition"}
            </div>
            <h2>${v.title?.trim() || "The dungeon awaits"}</h2>
            <div class="conditions">
              ${[v.hunger, v.burden, ...conditions]
                .filter((c) => c && String(c).trim())
                .map((c) => html`<span class="tag">${label(c)}</span>`)}
            </div>
          </div>
          <div class="stat hp">
            <span class="eyebrow">Health</span
            ><strong
              >${noSession ? "—" : hp}<span
                class="muted"
                style="font-size:13px"
              >
                / ${noSession ? "—" : max}</span
              ></strong
            >
            <div class="meter">
              <span
                style=${`width:${Math.max(0, Math.min(100, (hp / max) * 100))}%`}
              ></span>
            </div>
          </div>
          ${[
            [
              "Energy",
              noSession ? "—" : `${v.energy ?? "?"} / ${v.maxEnergy ?? "?"}`,
            ],
            ["Armor", v.armor ?? "—"],
            ["Level", v.level ?? "—"],
            ["Gold", v.gold ?? "—"],
            ["Turn", o.turn ?? "—"],
          ].map(
            ([title, value]) =>
              html`<div class="stat">
                <span class="eyebrow">${title}</span><strong>${value}</strong>
              </div>`,
          )}
        </section>
        <div class="layout">
          <div class="left">
            <section class="panel">
              <div class="panel-head">
                <h2>
                  Perceived world
                  <span class="muted">/ ${o.location?.id || "unexplored"}</span>
                </h2>
                <span class="toolbar-info"
                  >3D · only what the explorer knows</span
                >
              </div>
              <div
                class="map-area"
                tabindex="0"
                aria-label="Dungeon; arrow keys move"
              >
                ${this.renderMap()}
              </div>
              <div class="map-footer">
                <div class="legend">
                  <span class="lself">You</span><span class="lally">Ally</span
                  ><span class="lmonster">Creature</span>
                </div>
                <span
                  >${o.you
                    ? `Position ${o.you.x}, ${o.you.y}`
                    : "No unseen terrain is drawn."}</span
                >
              </div>
              ${this.renderTimeline()}
            </section>
            ${this.renderControls()}
            <section class="panel journal">
              <div class="panel-head">
                <h2>Expedition journal</h2>
                <span class="eyebrow"
                  >${this.mode === "replay" ? "At this moment" : "Newest first"}
                  · ${this.messages.length} entries</span
                >
              </div>
              <div
                class="journal-list"
                aria-live=${this.mode === "replay" ? "off" : "polite"}
              >
                ${this.messages.length
                  ? this.messages
                      .slice(0, 60)
                      .map(
                        (m) =>
                          html`<div class="log ${m.kind}">
                            <span class="turn">T ${m.turn}</span
                            ><span>${m.text}</span>
                          </div>`,
                      )
                  : html`<p class="muted" style="padding:16px 0">
                      What you hear and what your actions do will appear here.
                    </p>`}
              </div>
            </section>
          </div>
          <aside class="sidebar">
            ${this.envelope?.ended
              ? html`<section class="panel end">
                  <div class="card-body">
                    <div class="eyebrow">
                      ${this.envelope.end?.kind === "disconnected"
                        ? "World saved"
                        : "Expedition ended"}
                    </div>
                    <h2>
                      ${label(this.envelope.end?.kind || "Unknown outcome")}
                    </h2>
                    <p>
                      ${this.envelope.end?.cause ||
                      "The recorded world is available for review."}
                    </p>
                  </div>
                </section>`
              : nothing}${this.renderDecision()}
            <section class="panel">
              <div class="panel-head">
                <h2>Belongings</h2>
                <button
                  class="quiet small"
                  ?disabled=${!this.ready}
                  @click=${() => this.act({ action: "inventory" })}
                >
                  Refresh
                </button>
              </div>
              ${picked
                ? html`<div class="selection-text">
                    Selected: ${picked.label}<button
                      class="quiet small"
                      @click=${() => (this.selected = null)}
                      aria-label="Clear selected item"
                    >
                      ×
                    </button>
                  </div>`
                : nothing}
              <div class="inventory">
                ${inv.map(
                  (i) =>
                    html`<button
                      class=${this.selected === i.id ? "selected" : ""}
                      ?disabled=${this.mode === "replay" ||
                      this.busy ||
                      !!this.decision}
                      @click=${() =>
                        (this.selected = this.selected === i.id ? null : i.id)}
                    >
                      <span class="item-icon">◇</span
                      ><span class="item-detail"
                        >${i.label}
                        <div class="item-id">
                          ${i.category || i.location} · ×${i.quantity}
                        </div></span
                      >
                    </button>`,
                )}
              </div>
              <div class="statusline">
                ${noSession
                  ? "Start a world to see your belongings."
                  : o.inventoryKnown !== true
                    ? "Inventory was not captured at this point. This does not mean the pack was empty."
                    : this.mode === "replay"
                      ? "Belongings as known at this recorded moment."
                      : "Choose an item, then an action. Leave unselected to ask the world for candidates."}
              </div>
            </section>
            ${this.selectedTile
              ? html`<section class="panel">
                  <div class="panel-head">
                    <h2>
                      Square ${this.selectedTile.x}, ${this.selectedTile.y}
                    </h2>
                    <button
                      class="quiet small"
                      @click=${() => (this.selectedTile = null)}
                    >
                      ×
                    </button>
                  </div>
                  <div class="card-body details">
                    ${[
                      ["Terrain", this.selectedTile.terrain?.type || "unknown"],
                      [
                        "Knowledge",
                        this.selectedTile.terrain?.knowledge || "unknown",
                      ],
                      [
                        "Occupant",
                        this.selectedTile.occupant?.kind || "none reported",
                      ],
                    ].map(
                      ([k, value]) =>
                        html`<div class="line">
                          <span class="muted">${k}</span
                          ><span>${label(value)}</span>
                        </div>`,
                    )}
                    <p class="muted">
                      Perceived information only. No unseen contents inferred.
                    </p>
                  </div>
                </section>`
              : nothing}
            ${this.renderRuns()}
            <section class="panel setup-panel ${noSession ? "first" : ""}">
              <div class="panel-head">
                <h2>
                  ${noSession ? "Begin an expedition" : "Another expedition"}
                </h2>
                <span class="eyebrow">Seeded world</span>
              </div>
              <div class="card-body setup">
                <label
                  >Name<input
                    aria-label="Explorer name"
                    .value=${this.hero}
                    @input=${(e) => (this.hero = e.target.value)}
                /></label>
                <div class="pair">
                  <label
                    >Calling<select
                      aria-label="Role"
                      .value=${this.role}
                      @change=${(e) => (this.role = e.target.value)}
                    >
                      ${ROLES.map(
                        (r) => html`<option value=${r}>${label(r)}</option>`,
                      )}
                    </select></label
                  ><label
                    >Seed<input
                      aria-label="Seed"
                      inputmode="numeric"
                      .value=${this.seed}
                      @input=${(e) => (this.seed = e.target.value)}
                  /></label>
                </div>
                <button
                  class="primary"
                  ?disabled=${this.busy}
                  @click=${() => this.start()}
                >
                  ${noSession ? "Enter the dungeon" : "New expedition"}
                </button>
                <p class="control-help">
                  ${this.role === "valkyrie"
                    ? "Lawful dwarven Valkyrie."
                    : "Human; remaining identity is chosen by the world."}
                  Every interaction is recorded for later review.
                </p>
              </div>
            </section>
            <section class="panel">
              <details>
                <summary>Protocol inspector</summary>
                <pre class="debug">
${JSON.stringify(
                    {
                      revision: this.envelope?.revision,
                      outcome: this.envelope?.outcome,
                      decision: this.decision,
                      error: this.envelope?.error,
                    },
                    null,
                    2,
                  )}</pre
                >
              </details>
            </section>
          </aside>
        </div>
      </main>
      <footer>
        <span
          >Lit + Three.js · semantic actions · public perception
          recordings</span
        ><span
          >${this.mode === "replay"
            ? `Replay frame ${this.playhead + 1}`
            : this.saved
              ? `Session ${this.saved}`
              : "Not connected"}
          ·
          ${this.envelope
            ? `revision ${this.envelope.revision}`
            : "full observations"}</span
        >
      </footer>`;
  }
}
customElements.define("explorer-view", ExplorerView);
