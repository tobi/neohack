// Public package entry points, served together by Bun under /runtime/.
import type {
  Neonethack,
  Game,
  Response,
  Snapshot,
  Compass,
  Request,
} from "/runtime/typescript/client.js";
import type {
  ActionOffer,
  CellActions,
  Decision,
  ItemRef,
} from "neonethack/types";
import {
  DungeonMap,
  actionMessages,
  cellDescription,
  creatureLabel,
  loadArt,
} from "./map";
import { creatureArtUrl, inventoryArt } from "./symbol-art";
import { MovementInput } from "./movement-input";
import type { WebMcpRegistration } from "/runtime/typescript/webmcp.js";
import { loadRuntime, warmPackage } from "./runtime-loader";
import {
  cloudReady,
  playerId, rememberPlayer, requestedRun, showRunUrl, clearRunUrl,
  journalUrl,
  publishCloud,
  restoreAdventures,
} from "./cloud";
import { roles, heroArt } from "./characters";

const STORE = "neonethack-pixel-v2";
const directions: [Compass, string][] = [
  ["northwest", "↖"],
  ["north", "↑"],
  ["northeast", "↗"],
  ["west", "←"],
  ["east", "→"],
  ["southwest", "↙"],
  ["south", "↓"],
  ["southeast", "↘"],
];
type Adventure = {
  id: string;
  name: string;
  role: string;
  seed?: number;
  turn: number;
  ended: boolean;
  pending?: Request;
};
const escape = (text: unknown) =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
class PixelNethack extends HTMLElement {
  private api: Neonethack | null = null;
  private vault = "";
  private storeName = "";
  private indexKey = "";
  private runtime!: Awaited<ReturnType<typeof loadRuntime>>;
  private preparation!: Promise<void>;
  private titleReady = false;
  private preloadAbort = new AbortController();
  private warmed: Promise<void> | null = null;
  private webMcp: WebMcpRegistration | null = null;
  private game: Game | null = null;
  private busy = false;
  private cloudStatusGeneration = 0;
  private cloudEnabled = false;
  private cloudMetadataTimer: ReturnType<typeof setTimeout> | undefined;
  private saves: Adventure[] = [];
  private metadataHealthy = true;
  private current: Adventure | null = null;
  private map!: DungeonMap;
  private tilePanel: HTMLElement | null = null;
  private panel = "inventory";
  private selectedItem: ItemRef | null = null;
  private journal: { turn: number; lastTurn: number; text: string; count: number }[] = [];
  private lastFrame = "";
  private decisionIdentity = "";
  private menuReturn: HTMLElement | null = null;
  private keyHandler = (e: KeyboardEvent) => this.key(e);
  private keyUpHandler = (e: KeyboardEvent) => {
    this.movement.release(`key:${e.code || e.key}`);
    this.introMovement.release(`key:${e.code || e.key}`);
    this.querySelectorAll("[data-intro]").forEach((b) =>
      b.classList.remove("pressed"),
    );
  };
  private introAuto: ReturnType<typeof setInterval> | undefined;
  private portalEntering = false;
  private stopMovement = () => {
    this.movement.stop();
    this.introMovement.stop();
    clearInterval(this.introAuto);
    this.querySelectorAll("[data-intro]").forEach((b) =>
      b.classList.remove("pressed"),
    );
  };
  private introAvailable() {
    return (
      !this.game &&
      this.titleReady &&
      !this.busy &&
      !this.portalEntering &&
      this.metadataHealthy &&
      !document.hidden &&
      !this.querySelector("dialog[open], .hud-menu[open]")
    );
  }
  private introMovement = new MovementInput(
    () => this.introAvailable(),
    async (direction) => this.introStep(direction),
    () => {},
  );
  private introStep(direction: Compass) {
    if (!this.introAvailable()) return false;
    const result = this.map.moveIntro(direction);
    if (result === "entered") {
      this.stopMovement();
      this.portalEntering = true;
      this.classList.add("portal-entering");
      this.text("#intro-instruction", "The threshold answers…");
      this.controls();
      this.map.enterIntroPortal(() => {
        if (!this.portalEntering) return;
        this.portalEntering = false;
        this.classList.remove("portal-entering");
        this.text("#intro-instruction", "Walk into the light");
        this.controls();
        if (this.isConnected && !this.game) this.newAdventure();
      });
      return false;
    }
    return result === "moved";
  }
  private walkToEntrance() {
    if (!this.introAvailable()) return;
    this.stopMovement();
    this.$("#dungeon").focus();
    const step = () => {
      if (!this.introAvailable()) {
        this.stopMovement();
        return;
      }
      this.introStep(this.map.introDirection());
    };
    this.introAuto = setInterval(step, 100);
    step();
  }
  private showPanel() {
    this.stopMovement();
    this.show(".rightbar", true);
    this.$("#panel-heading").focus();
  }
  private closePanel() {
    this.show(".rightbar", false);
  }
  private visibilityChanged = () => {
    if (document.hidden) {
      this.stopMovement();
      if (this.portalEntering) {
        this.portalEntering = false;
        this.classList.remove("portal-entering");
        this.text("#intro-instruction", "Walk into the light");
        this.map.resetIntro();
        this.controls();
      }
    }
  };
  private focusChanged = (e: FocusEvent) => {
    if (
      (e.target as HTMLElement).closest(
        'input,textarea,select,[contenteditable="true"],dialog',
      )
    )
      this.stopMovement();
  };
  private movement = new MovementInput(
    () =>
      this.playable() &&
      this.metadataHealthy &&
      !document.hidden &&
      !this.querySelector("dialog[open]") &&
      !this.tilePanel &&
      !this.querySelector(".hud-menu[open], .rightbar:not([hidden])"),
    (direction, repeated) => this.stepMove(direction, repeated),
    () => this.controls(),
  );
  get snapshot(): Snapshot | null {
    return this.game?.state ?? null;
  }

  connectedCallback() {
    this.innerHTML = `

      <main id="main" tabindex="-1">
        <div class="map-viewport"><canvas id="dungeon" tabindex="0" aria-label="Dungeon entrance. Use arrow keys to walk into the hall."></canvas></div>
        <section id="welcome-copy" class="intro-title"><p class="eyebrow">A LITTLE COURAGE. A DEEP DUNGEON.</p><h1>neo<span>nethack</span></h1><p>The old world has an open door.</p><a class="paths-jump" href="#welcome-paths">Play, bring an agent, or build something new ↓</a></section>
        <section id="welcome-actions" class="intro-controls" aria-label="Learn to walk">
          <p id="intro-instruction">Walk into the light</p>
          <div class="intro-arrows" aria-label="Arrow keys move your traveler">
            <button data-intro="north" aria-label="Walk north toward the entrance"><kbd>↑</kbd></button>
            <button data-intro="west" aria-label="Walk west"><kbd>←</kbd></button>
            <button data-intro="south" aria-label="Walk south"><kbd>↓</kbd></button>
            <button data-intro="east" aria-label="Walk east"><kbd>→</kbd></button>
          </div>
          <p class="intro-hint">Hold the arrow keys · or touch them here</p>
          <div class="intro-links"><button id="new-adventure" class="text-button">Begin your adventure</button><button id="continue-adventure" class="primary" hidden>Continue previous run</button></div>
        </section>
        <aside id="welcome-paths" class="welcome-paths" aria-label="Three ways into NetHack">
          <header><span class="eyebrow">ONE DUNGEON. MANY POSSIBILITIES.</span><a href="https://github.com/tobi/neohack" target="_blank" rel="noopener noreferrer">GitHub ↗</a></header><p id="package-status" role="status">Preparing the game in the background…</p>
          <article><span class="path-number">01 · ADVENTURE</span><h2>Play the classic</h2><p>A deep dungeon. A loyal companion. A thousand ways to learn the hard way. Walk through the doorway and discover NetHack, one turn at a time.</p><a href="#welcome-actions">Enter the dungeon ↓</a></article>
          <article><span class="path-number">02 · BRING YOUR AGENT</span><h2>Play with WebMCP</h2><p>Let your agent explore the same world through the browser’s WebMCP tools. You watch the adventure unfold; your agent makes the moves.</p><a href="https://github.com/tobi/neohack/blob/main/lib/neonethack/docs/AGENT_BROWSER.md" target="_blank" rel="noopener noreferrer">Agent-browser walkthrough ↗</a></article>
          <article><span class="path-number">03 · MAKE SOMETHING NEW</span><h2>It’s time for NetHack itself to ascend.</h2><p>The brain of NetHack, separated from its interface and exposed as a JSON protocol. Build a completely new UX, a reinforcement learning environment for small models, an evaluation for frontier models—or whatever comes next.</p><a href="https://github.com/tobi/neohack/tree/main/lib/neonethack" target="_blank" rel="noopener noreferrer">Explore the library ↗</a></article>
          <section class="welcome-code" aria-labelledby="code-heading"><span class="path-number">THE LIBRARY · TYPESCRIPT</span><h2 id="code-heading">Your interface. NetHack’s brain.</h2><pre tabindex="0" aria-label="Native NetHack example"><code><span class="code-keyword">import</span> Nethack <span class="code-keyword">from</span> <span class="code-string">'neonethack'</span>;

<span class="code-keyword">const</span> nethack = <span class="code-keyword">new</span> Nethack();
<span class="code-keyword">try</span> {
  <span class="code-keyword">const</span> game = <span class="code-keyword">await</span> nethack.create({
    name: <span class="code-string">'Ada'</span>, role: <span class="code-string">'valkyrie'</span>, seed: <span class="code-number">42</span>,
  });
  <span class="code-keyword">const</span> step = <span class="code-keyword">await</span> game.move(<span class="code-string">'south'</span>);
  console.log(step.outcome, step.observation);

  <span class="code-keyword">const</span> food = <span class="code-keyword">await</span> game.eat();
  <span class="code-keyword">if</span> (food.decision?.kind === <span class="code-string">'item'</span>) {
    <span class="code-keyword">await</span> game.cancel(food.decision.id);
  }
  <span class="code-keyword">await</span> game.close();
} <span class="code-keyword">finally</span> {
  <span class="code-keyword">await</span> nethack.close();
}</code></pre><p>Build the native library, then create your first world. <a href="https://github.com/tobi/neohack/blob/main/lib/neonethack/docs/QUICKSTART.md" target="_blank" rel="noopener noreferrer">Get started ↗</a></p></section>
          <footer><p>A living dungeon since 1987. Decades of the NetHack DevTeam’s imagination, surprising interactions, and player discoveries live underneath this new doorway. <a href="https://www.nethack.org/common/info.html" target="_blank" rel="noopener noreferrer">Meet NetHack ↗</a></p><p>Character sprites: <a href="https://limezu.itch.io/" target="_blank" rel="noopener noreferrer">LimeZu</a>.</p></footer>
        </aside>
        <a id="creator-link" class="creator-link" href="https://x.com/tobi" target="_blank" rel="noopener noreferrer" aria-label="@tobi on X (opens in a new tab)">@tobi</a>
        <section class="hero-hud" aria-label="Adventurer" hidden>
          <img id="portrait" src="/art/${heroArt("ranger")}.png" alt="">
          <div class="hero-identity"><strong id="hero-name"></strong><span id="hero-role"></span></div>
          <div id="character-stats" class="character-stats" hidden></div>
        </section>
        <div class="world-hud">
          <div class="location-hud"><span id="location-heading"></span><span id="turn-pill"></span><span id="cloud-status" role="status"></span></div>
          <details class="hud-menu"><summary aria-label="Game menu">☰</summary><div class="hud-menu-body">
            <button id="adventures-button">Your adventures</button><button data-guide>Field guide <kbd>?</kbd></button>
            <div class="map-tools"><button id="map-symbols" aria-label="Show NetHack symbols" aria-pressed="false" title="Switch to NetHack symbols">Art</button><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-in" aria-label="Zoom in">+</button><button id="center-map" aria-label="Center on you">⌖</button></div>
            <button id="fullscreen-button">Fullscreen</button><button id="text-map-button">Read the map as text</button><button id="credits-button">About & credits</button><a class="menu-github" href="https://github.com/tobi/neohack" target="_blank" rel="noopener noreferrer">GitHub ↗</a><p id="bookmark-hint" hidden>Bookmark this run’s URL to resume. Keep it private: it opens your saved vault.</p><p id="save-status" role="status">Saves stay in this browser.</p><p id="webmcp-status"></p>
          </div></details>
        </div>
        <div class="notices"><div class="notice error" id="error" role="alert" hidden></div>
          <div class="notice" id="recovery" hidden><strong>Your last action needs checking.</strong><p>It may already have happened. Check its saved result before doing anything else. If the connection has stopped, reload and resume this adventure first.</p><button class="secondary" id="retry">Check last action</button></div>
          <div class="notice" id="ended" hidden></div>
        </div>
        <section class="play-controls" id="play-controls" aria-label="Adventure controls" hidden>
          <div class="direction-pad">${directions
            .slice(0, 4)
            .map(
              ([d, g]) =>
                `<button data-move="${d}" data-game aria-label="Move ${d}">${g}</button>`,
            )
            .join(
              "",
            )}<button id="wait-pad" data-action="wait" data-game aria-label="Wait one turn">·</button>${directions
            .slice(4)
            .map(
              ([d, g]) =>
                `<button data-move="${d}" data-game aria-label="Move ${d}">${g}</button>`,
            )
            .join("")}</div>
          <div class="action-dock"><div class="action-grid"><button data-action="search" data-game>Search<kbd>f</kbd></button><button data-action="pickup" data-game>Pick up<kbd>g</kbd></button><button data-action="eat" data-game>Eat<kbd>e</kbd></button><button data-action="open" data-game>Open door<kbd>o</kbd></button><button data-action="down" data-game>Go downstairs<kbd>&gt;</kbd></button><button id="more-actions" data-game>More actions</button></div>
          <nav class="side-nav" aria-label="Adventure views"><button data-view="inventory">Backpack <span id="inventory-count"></span><kbd>i</kbd></button><button data-view="surroundings">Surroundings</button><button data-view="journal">Journal</button></nav></div>
        </section>
        <aside class="ground-loot" id="ground-loot" aria-label="On the ground" hidden><h2>On the ground</h2><p>At your feet · choose what to take</p><div id="ground-items"></div></aside>
        <aside id="journal-preview" aria-label="Recent journal messages"><div id="recent-messages"></div><div class="journal-preview-tools"><button id="toggle-journal-preview" aria-label="Collapse recent messages" aria-expanded="true" aria-controls="recent-messages" title="Collapse recent messages"><span aria-hidden="true">⌃</span></button><button data-view="journal" aria-label="Expand journal" title="Open full journal"><span aria-hidden="true">↗</span></button></div></aside>
        <div id="contextual-stairs" hidden></div>
        <aside class="rightbar" aria-label="Field notes" hidden><button id="close-panel" aria-label="Close field notes">×</button><div class="section-title"><h2 id="panel-heading" tabindex="-1">Your backpack</h2><span id="panel-count"></span></div><div id="panel-body"></div><details id="accessible-map" hidden><summary>Read the perceived map as text</summary><pre id="map-text"></pre><p>Remembered terrain and currently perceived occupants.</p></details></aside>
        <div class="sr-only"><span id="inspect-text" role="status"></span><span id="latest-message" role="status"></span></div>
      </main>
      <dialog id="dungeon-loading" aria-labelledby="loading-title" aria-describedby="loading-detail"><div class="descent-scene" aria-hidden="true"><div class="descent-arch arch-far"></div><div class="descent-arch arch-mid"></div><div class="descent-arch arch-near"></div><div class="descent-path"></div><i class="descent-torch torch-left"></i><i class="descent-torch torch-right"></i><img id="loading-traveler" src="/art/${heroArt("ranger")}.png" alt=""></div><h2 id="loading-title">Entering the dungeon</h2><p id="loading-detail" role="status"></p><div class="descent-dots" aria-hidden="true"><i></i><i></i><i></i></div></dialog>
      <dialog id="menu" aria-labelledby="menu-title"><div class="dialog-top"><span class="eyebrow">NEONETHACK</span><button aria-label="Close dialog" class="close-dialog">×</button></div><div id="menu-content"></div></dialog>
      <dialog id="decision" aria-labelledby="decision-title"><div class="eyebrow">ONE MOMENT, ADVENTURER</div><h2 id="decision-title"></h2><p id="decision-about"></p><p id="decision-error" class="notice error" role="alert" hidden></p><div id="decision-body"></div></dialog>`;
    this.map = new DungeonMap(this.querySelector("#dungeon")!, (text, x, y) => {
      this.text("#inspect-text", text);
      this.inspectTile(x, y);
    });
    this.bind();
    document.addEventListener("keydown", this.keyHandler);
    document.addEventListener("keyup", this.keyUpHandler);
    window.addEventListener("blur", this.stopMovement);
    document.addEventListener("visibilitychange", this.visibilityChanged);
    document.addEventListener("focusin", this.focusChanged);
    try {
      this.vault = window.isSecureContext ? playerId() : "unavailable";
      this.storeName = `${STORE}-${this.vault}`;
      this.indexKey = `${this.storeName}:adventures`;
      this.readSaves();
    } catch (e) {
      this.metadataHealthy = false;
      this.error(e);
    }
    // Art and libraries load independently; network/engine work never reserves intro input.
    void loadArt()
      .then(() => {
        if (!this.isConnected) return;
        this.titleReady =
          window.isSecureContext && !!navigator.locks && !!globalThis.indexedDB;
        this.render();
        this.controls();
      })
      .catch((error) => this.error(error));
    this.preparation = this.prepareRuntime();
    void this.preparation.then(() => this.openLinkedRun()).catch((error) => this.error(error));
    this.controls();
  }
  private async openLinkedRun() {
    const linked = requestedRun();
    if (!linked) return;
    await this.run(async () => {
      await this.connectRuntime();
      this.game = await this.api!.resume(linked.id);
      const save = this.saves.find(s => s.id === linked.id) ?? { id: linked.id, name: "Saved adventurer", role: "ranger", turn: this.game.observation.turn, ended: this.game.state.ended };
      if (!this.saves.some(s => s.id === save.id)) this.saves.unshift(save);
      this.current = save;
      this.journal = [];
      this.lastFrame = "";
      this.map.center();
    }, { name: "Your adventurer", role: "ranger", resume: true });
  }
  private readSaves() {
    const raw = localStorage.getItem(this.indexKey);
    if (raw) {
      const data: unknown = JSON.parse(raw);
      if (
        !Array.isArray(data) ||
        data.some(
          (s) =>
            !s ||
            typeof s.id !== "string" ||
            typeof s.name !== "string" ||
            typeof s.role !== "string" ||
            typeof s.turn !== "number" ||
            typeof s.ended !== "boolean" ||
            (s.seed !== undefined &&
              (!Number.isInteger(s.seed) ||
                s.seed < 0 ||
                s.seed > 4294967295)) ||
            (s.pending &&
              (s.pending.version !== 1 ||
                !s.pending.params ||
                s.pending.params.sessionId !== s.id ||
                typeof s.pending.params.requestId !== "string")),
        )
      )
        throw Error("The adventure list is damaged. It has not been replaced.");
      this.saves = data;
    } else this.saves = [];
  }
  private warm() {
    // Speculative warmup is optional; the verified runtime load retries on entry.
    return this.warmed ??= warmPackage(this.preloadAbort.signal).then(() => {
      this.text("#package-status", "Game downloaded · ready when you are");
    }).catch(() => {
      this.text("#package-status", "The game will finish downloading when you enter.");
    });
  }
  private async prepareRuntime() {
    if (!window.isSecureContext) {
      throw Error(
        "Open the game over HTTPS to enable browser saves. Plain HTTP on a remote address cannot start an adventure. If the server runs on this computer, open http://127.0.0.1:3333 (or your configured port). For remote access, use an HTTPS preview or forward the server port to localhost. If the game is embedded, open its secure URL in a new tab.",
      );
    }
    if (!navigator.locks || !globalThis.indexedDB) {
      throw Error(
        "This browser cannot provide durable saves: IndexedDB and Web Locks are required. Open the game in a current browser with site storage allowed. If it is embedded, try opening its URL in a new tab. No adventure was started.",
      );
    }
    this.runtime = await loadRuntime();
    if (!this.isConnected) return;
    void this.warm();
    try {
      this.webMcp = await this.runtime.webmcp.registerWebMcp({
        send: (request) => this.webRequest(request),
      });
      if (!this.isConnected) this.webMcp.dispose();
      this.dataset.webmcp = this.webMcp.supported ? "ready" : "unsupported";
      this.text(
        "#webmcp-status",
        this.webMcp.supported
          ? `WebMCP · ${this.webMcp.toolCount} tools`
          : "WebMCP unavailable in this browser",
      );
    } catch (error) {
      this.dataset.webmcp = "error";
      this.text(
        "#webmcp-status",
        `WebMCP registration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    void cloudReady().then((ok) => {
      if (this.isConnected)
        this.text(
          "#save-status",
          ok
            ? "Ready · online saves available"
            : "Ready · saves stay in this browser",
        );
    });
  }
  /** Same protocol as MCP. Human and agent input share one UI reservation. */
  private async webRequest(request: Request): Promise<Response> {
    if (this.busy || this.movement.inFlight)
      throw Error(
        "Client busy; this tool was not submitted. Try the exact request again after the current action settles.",
      );
    if (!this.metadataHealthy)
      throw Error("Browser storage is unavailable; tool was not submitted.");
    if (this.querySelector("#menu[open]"))
      throw Error(
        "Finish or close the human menu first; tool was not submitted.",
      );
    this.stopMovement();
    this.closePanel();
    const before = this.uncertain() ? null : this.game?.state;
    let response: Response | undefined;
    let failure: unknown;
    await this.run(async () => {
      try {
        const params = request.params as Record<string, unknown>;
        let save = this.saves.find((s) => s.id === params.sessionId);
        await this.connectRuntime();
        save = this.saves.find((s) => s.id === params.sessionId);
        if ("requestId" in params && save?.pending) {
          // Object property order is immaterial; retain every argument and value.
          const canonical = (value: unknown): string => {
            if (Array.isArray(value))
              return "[" + value.map(canonical).join(",") + "]";
            if (value && typeof value === "object")
              return (
                "{" +
                Object.keys(value)
                  .sort()
                  .map(
                    (k) =>
                      JSON.stringify(k) +
                      ":" +
                      canonical((value as Record<string, unknown>)[k]),
                  )
                  .join(",") +
                "}"
              );
            return JSON.stringify(value);
          };
          if (canonical(save.pending) !== canonical(request))
            throw Error(
              "This session has an uncertain request. Check only its exact original requestId and payload first.",
            );
        }
        response = await this.api!.transport.send(request);
        if (this.runtime.client.isSnapshot(response)) {
          if (!save && !response.error) {
            save = {
              id: response.sessionId,
              name:
                typeof params.name === "string" ? params.name : "Adventurer",
              role: typeof params.role === "string" ? params.role : "valkyrie",
              ...(typeof params.seed === "number" ? { seed: params.seed } : {}),
              turn: response.observation.turn,
              ended: response.ended,
            };
            this.saves.unshift(save);
          }
          if (save) {
            const previous =
              this.game?.id === response.sessionId ? this.game.state : null;
            let latest =
              previous && previous.revision > response.revision
                ? previous
                : response;
            if (
              "requestId" in params &&
              !response.error &&
              response.outcome.status !== "unknown"
            ) {
              // A receipt from a different active session may also be old.
              // Free observation updates the view; return the original receipt.
              const observed = await this.api!.request("session.observe", {
                sessionId: response.sessionId,
              });
              if (
                this.runtime.client.isSnapshot(observed) &&
                observed.revision > latest.revision
              )
                latest = observed;
            }
            // session.close retires the engine; its terminal transport frame
            // does not mean the saved hero died or quit. Keep adventure status.
            if (request.method !== "session.close") {
              save.turn = latest.observation.turn;
              save.ended = latest.ended;
            }
            if (request.method === "session.close" && !response.error) {
              if (this.game?.id === response.sessionId) {
                this.game = null;
                this.current = null;
                this.map.resetIntro();
              }
            } else if (
              !response.error ||
              this.game?.id === response.sessionId
            ) {
              if (this.game?.id !== response.sessionId) {
                this.journal = [];
                this.lastFrame = "";
                this.map.center();
              }
              // Game is the public immutable snapshot holder. The transport's
              // saved pending request remains authoritative for raw MCP input.
              this.game = new this.runtime.client.Game(this.api!, latest, () =>
                crypto.randomUUID(),
              );
              this.current = save;
            }
            this.persist();
          }
        }
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    if (failure) throw failure;
    if (!response) throw Error("Tool was not submitted.");
    if (
      before &&
      this.game &&
      before.sessionId === this.game.id &&
      !this.uncertain()
    )
      this.map.showMessages(before, this.game.state);
    return response;
  }
  private assertConnected() {
    if (!this.isConnected || this.preloadAbort.signal.aborted)
      throw Error("Game interface closed before opening storage.");
  }
  private async connectRuntime() {
    this.assertConnected();
    if (this.api) return;
    this.vault = playerId();
    this.storeName = `${STORE}-${this.vault}`;
    this.indexKey = `${this.storeName}:adventures`;
    rememberPlayer(this.vault);
    await this.warm();
    this.assertConnected();
    ++this.cloudStatusGeneration;
    this.cloudEnabled = await cloudReady();
    this.text("#cloud-status", this.cloudEnabled ? "Connecting online save…" : "Saved in this browser");
    const replica = this.cloudEnabled ? journalUrl(this.vault) : undefined;
    if (requestedRun() && !replica && !this.saves.some(save => save.id === requestedRun()!.id)) throw Error("The cloud save could not be reached. Retry this bookmark when connected; no new game was started.");
    const wasm = await this.runtime.wasm.createWasm({
      storage: replica
        ? { kind: "indexeddb", name: this.storeName, replicaUrl: replica }
        : { kind: "indexeddb", name: this.storeName },
      workerUrl: new URL("/runtime/wasm/core-worker.mjs", location.href),
      onReplicaStatus: async ({ state, message }) => {
        if (!this.isConnected) return;
        const generation = ++this.cloudStatusGeneration;
        if (state === "saved") {
          try { await publishCloud(this.saves, this.vault); }
          catch { this.text("#cloud-status", "Saved here · online save pending"); return; }
        }
        if (generation !== this.cloudStatusGeneration) return;
        this.text("#cloud-status", state === "saved" ? "Saved online" : state === "pending" ? "Saving online…" : "Saved here · cloud sync paused");
        if (state === "error") this.error(Error(message));
      },
    });
    // Opening may finish after this element has been removed. Never adopt that
    // late worker/store owner, even if the same element was reattached meanwhile.
    try { this.assertConnected(); }
    catch (error) { await wasm.close(); throw error; }
    // A title tab may have waited while another tab updated adventure metadata.
    // Refresh only after acquiring ownership, before any request can persist it.
    try {
      this.readSaves();
      if (!this.saves.length) {
        const remote = await restoreAdventures(this.vault);
        if (remote?.length) this.saves = remote;
      }
    } catch (error) {
      this.metadataHealthy = false;
      await wasm.close();
      throw error;
    }
    const api = new this.runtime.client.Neonethack({
      send: async (request) => {
        // Keep the exact outgoing request in display metadata before forwarding.
        // The engine's IndexedDB journal remains the authoritative receipt store.
        // This permits a deliberate same-ID check after abrupt page loss.
        const params = request.params;
        const record =
          "requestId" in params
            ? this.saves.find((s) => s.id === params.sessionId)
            : undefined;
        if (record) {
          record.pending = structuredClone(request);
          this.persist();
        }
        const response = await wasm.transport.send(request);
        const unresolved =
          (this.runtime.client.isSnapshot(response) &&
            response.outcome.status === "unknown") ||
          ("error" in response && response.error?.code === "incompleteRequest");
        if (record && !unresolved) {
          record.pending = undefined;
          try {
            this.persist();
          } catch (error) {
            record.pending = structuredClone(request);
            throw error;
          }
        }
        return response;
      },
      close: () => wasm.close(),
    });
    try {
      const description = await api.describe();
      this.assertConnected();
      if (
        description.capabilities.persistence !== "indexeddb" ||
        description.capabilities.durability !== "indexeddb-transaction"
      ) throw Error("Durable browser saves are unavailable. No adventure was started.");
      this.api = api;
    } catch (error) {
      await api.close();
      throw error;
    }
  }
  disconnectedCallback() {
    this.preloadAbort.abort();
    this.webMcp?.dispose();
    this.movement.stop();
    document.removeEventListener("keydown", this.keyHandler);
    document.removeEventListener("keyup", this.keyUpHandler);
    window.removeEventListener("blur", this.stopMovement);
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    document.removeEventListener("focusin", this.focusChanged);
    this.stopMovement();
    this.map.destroy();
    const api = this.api;
    this.api = null;
    void api?.close();
  }
  private $(selector: string) {
    return this.querySelector<HTMLElement>(selector)!;
  }
  private text(selector: string, value: unknown) {
    this.$(selector).textContent = String(value);
  }
  private show(selector: string, visible: boolean) {
    this.$(selector).hidden = !visible;
  }
  private error(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.text("#error", message.includes("Another worker or tab owns this WASM store")
      ? "This game is open in another tab. Close that tab, or choose Save & return to doorway there, then try again here. Your save has not been changed."
      : message);
    this.show("#error", true);
  }
  private button(
    label: string,
    action: () => unknown,
    className = "secondary",
  ) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.textContent = label;
    b.onclick = () => {
      if (!b.disabled) action();
    };
    return b;
  }
  private bind() {
    this.$("#close-panel").onclick = () => {
      this.closePanel();
      this.$("#dungeon").focus();
    };
    this.$(".hud-menu").addEventListener("toggle", () => {
      if (this.querySelector(".hud-menu[open]")) this.stopMovement();
    });
    (this.$("#fullscreen-button") as HTMLButtonElement).disabled =
      !document.fullscreenEnabled;
    this.$("#fullscreen-button").onclick = () => {
      const task = document.fullscreenElement
        ? document.exitFullscreen()
        : this.requestFullscreen();
      void task.catch((e) => this.error(e));
    };
    this.$("#text-map-button").onclick = () => {
      this.querySelector<HTMLDetailsElement>(".hud-menu")!.open = false;
      this.showPanel();
      this.querySelector<HTMLDetailsElement>("#accessible-map")!.open = true;
      this.$("#accessible-map summary").focus();
    };
    this.querySelectorAll<HTMLButtonElement>("[data-intro]").forEach((b) => {
      const direction = b.dataset.intro as Compass;
      b.onpointerdown = (e) => {
        if (!e.isPrimary || e.button !== 0) return;
        e.preventDefault();
        this.stopMovement();
        b.setPointerCapture(e.pointerId);
        b.classList.add("pressed");
        this.introMovement.press(direction, `pointer:${e.pointerId}`);
      };
      b.onpointerup = (e) => {
        this.introMovement.release(`pointer:${e.pointerId}`);
        b.classList.remove("pressed");
      };
      b.onpointercancel = b.onlostpointercapture = (e) => {
        this.introMovement.cancel(`pointer:${e.pointerId}`);
        b.classList.remove("pressed");
      };
      b.onclick = (e) => {
        if (e.detail === 0) this.introStep(direction);
      };
    });
    this.querySelectorAll<HTMLElement>("[data-guide]").forEach(
      (b) => (b.onclick = () => this.guide()),
    );
    this.$("#toggle-journal-preview").onclick = () => {
      const button = this.$("#toggle-journal-preview");
      const expanded = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(expanded));
      button.setAttribute("aria-label", expanded ? "Collapse recent messages" : "Expand recent messages");
      button.title = expanded ? "Collapse recent messages" : "Expand recent messages";
      button.innerHTML = '<span aria-hidden="true">' + (expanded ? "⌃" : "⌄") + "</span>";
      this.show("#recent-messages", expanded);
    };
    this.querySelectorAll<HTMLElement>("[data-view]").forEach(
      (b) =>
        (b.onclick = () => {
          this.panel = b.dataset.view!;
          this.movement.stop();
          if (
            document.startViewTransition &&
            !matchMedia("(prefers-reduced-motion: reduce)").matches
          )
            document.startViewTransition(() => this.renderPanel());
          else this.renderPanel();
          this.showPanel();
        }),
    );
    this.querySelectorAll<HTMLElement>("[data-move]").forEach((b) => {
      b.onpointerdown = (e) => {
        if (!e.isPrimary || e.button !== 0) return;
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        this.movement.press(
          b.dataset.move as Compass,
          `pointer:${e.pointerId}`,
        );
      };
      b.onpointerup = (e) => this.movement.release(`pointer:${e.pointerId}`);
      b.onpointercancel = b.onlostpointercapture = (e) =>
        this.movement.cancel(`pointer:${e.pointerId}`);
      // Assistive/keyboard activation has no pointerdown. Pointer clicks were
      // already handled above and must not take a second step on release.
      b.onclick = (e) => {
        if (e.detail === 0) this.move(b.dataset.move as Compass);
      };
    });
    const labels: Record<string, string> = {
      wait: "Wait one turn",
      search: "Search",
      pickup: "Pick up",
      eat: "Eat",
      open: "Open door",
      down: "Go downstairs",
    };
    this.querySelectorAll<HTMLElement>("[data-action]").forEach((b) => {
      b.onclick = () => this.action(b.dataset.action!);
      b.setAttribute(
        "aria-label",
        labels[b.dataset.action!] ?? b.dataset.action!,
      );
    });
    this.$("#new-adventure").onclick = () => this.walkToEntrance();
    this.$("#continue-adventure").onclick = () =>
      this.resume(this.saves.find((s) => !s.ended)!);
    this.$("#adventures-button").onclick = () => this.adventures();
    this.$("#more-actions").onclick = () => this.more();
    this.$("#more-actions").setAttribute("aria-label", "More actions");
    this.$("#credits-button").onclick = () => this.credits();
    this.$("#zoom-in").onclick = () => {
      this.map.zoom = Math.min(4, this.map.zoom + 1);
      this.map.draw();
    };
    this.$("#zoom-out").onclick = () => {
      this.map.zoom = Math.max(1, this.map.zoom - 1);
      this.map.draw();
    };
    this.$("#center-map").onclick = () => this.map.center();
    this.$("#map-symbols").onclick = () => {
      this.map.symbols = !this.map.symbols;
      this.$("#map-symbols").setAttribute(
        "aria-pressed",
        String(this.map.symbols),
      );
      this.text("#map-symbols", this.map.symbols ? "Symbols" : "Art");
      const label = this.map.symbols ? "Show illustrated map" : "Show NetHack symbols";
      this.$("#map-symbols").setAttribute("aria-label", label);
      this.$("#map-symbols").setAttribute("title", label);
      this.map.draw();
    };
    this.$("#retry").onclick = () =>
      void this.run(async () => {
        if (!this.game || !this.current) return;
        if (this.game.pendingRequest) {
          try {
            await this.game.retry();
          } finally {
            if (!this.game.pendingRequest) this.current.pending = undefined;
          }
        } else if (this.current.pending) {
          const response = await this.api!.transport.send(this.current.pending);
          if (
            (!this.runtime.client.isSnapshot(response) &&
              "error" in response &&
              response.error.code === "incompleteRequest") ||
            (this.runtime.client.isSnapshot(response) &&
              response.outcome.status === "unknown")
          )
            throw Error(
              "The action is still uncertain. Its original request is preserved.",
            );
          this.current.pending = undefined;
          await this.game.observe();
          if ("error" in response && response.error)
            throw Error(response.error.message);
        }
        if (!this.game.pendingRequest) this.current.pending = undefined;
      });
    this.$(".close-dialog").onclick = () => this.closeMenu();
    this.querySelector<HTMLDialogElement>("#menu")!.addEventListener(
      "close",
      () => {
        if (!this.game) this.map.resetIntro();
        this.controls();
        this.menuReturn?.focus();
      },
    );
    this.querySelector<HTMLDialogElement>("#decision")!.addEventListener(
      "cancel",
      (e) => {
        e.preventDefault();
        if (!this.busy && this.game?.decision?.cancellable && !this.uncertain())
          void this.run(() => this.game!.cancel(this.game!.decision!.id));
      },
    );
  }
  private uncertain() {
    return !!(this.game?.pendingRequest || this.current?.pending);
  }
  private playable() {
    return (
      !!this.game &&
      !this.busy &&
      !this.game.decision &&
      !this.game.state.ended &&
      !this.uncertain() &&
      ["completed", "blocked", "cancelled", "interrupted"].includes(
        this.game.state.outcome.status,
      ) &&
      [this.game.state.storage, this.game.state.recording].every(
        (d) => !d || d.status === "ok",
      )
    );
  }
  private async run(action: () => Promise<unknown>, entry?: { name: string; role: string; resume?: boolean }) {
    if (this.busy) return;
    this.closeTile();
    const game = this.game;
    const before = this.uncertain() ? null : game?.state;
    let completed = false;
    this.busy = true;
    if (this.metadataHealthy) this.show("#error", false);
    this.controls();
    const loading = this.querySelector<HTMLDialogElement>("#dungeon-loading")!;
    try {
      if (entry) {
        this.stopMovement();
        this.text("#loading-title", entry.resume ? "Returning to the dungeon" : "Entering the dungeon");
        this.text("#loading-detail", entry.resume ? "Finding " + entry.name + "’s place in the story…" : entry.name + " takes the first steps into the dark…");
        (this.$("#loading-traveler") as HTMLImageElement).src = `/art/${heroArt(entry.role)}.png`;
        loading.oncancel = event => event.preventDefault();
        loading.showModal();
        // Paint before engine work, without stalling entry in a hidden tab.
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(); }, 100);
          const frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
        });
      }
      await action();
      completed = true;
    } catch (e) {
      this.error(e);
    } finally {
      // A discovery call, rejected start or agent session.close can finish on
      // the title screen. Retire its transport too, so no invisible worker
      // keeps the whole origin's save store locked while this client is idle.
      if (!this.game && this.api) {
        const api = this.api;
        this.api = null;
        try { await api.close(); }
        catch (error) { this.error(error); }
      }
      if (this.game && this.current) {
        this.current.turn = this.game.observation.turn;
        this.current.ended = this.game.state.ended;
        if (this.game.pendingRequest)
          this.current.pending = this.game.pendingRequest;
        try {
          this.persist();
        } catch (e) {
          this.error(e);
        }
      }
      if (entry && loading.open) loading.close();
      this.busy = false;
      if (!this.game?.decision) this.map.context = null;
      this.render();
      if (completed && before && game === this.game && !this.uncertain())
        this.map.showMessages(before, this.game!.state);
      if (completed && before && game === this.game && this.playable()) {
        const witness = this.game!.state.events.find(
          (e) =>
            e.type === "doorWitness" && ["locked", "resisted"].includes(e.fact),
        );
        if (witness?.type === "doorWitness")
          this.inspectTile(witness.x, witness.y, true);
      }
    }
  }
  private persist() {
    if (!this.metadataHealthy)
      throw Error(
        "Adventure metadata is unavailable; the stored list has not been overwritten.",
      );
    localStorage.setItem(this.indexKey, JSON.stringify(this.saves));
    if (this.cloudEnabled) {
      clearTimeout(this.cloudMetadataTimer);
      this.cloudMetadataTimer = setTimeout(() => {
        void publishCloud(this.saves, this.vault).catch(() => {});
      }, 250);
    }

  }
  private controls() {
    (this.$("#text-map-button") as HTMLButtonElement).disabled = !this.game;
    this.querySelectorAll<HTMLButtonElement>("[data-intro]").forEach(
      (b) => (b.disabled = !this.introAvailable()),
    );
    this.querySelectorAll<HTMLButtonElement>("[data-game]").forEach(
      (b) =>
        (b.disabled = !(
          this.playable() ||
          (this.movement.inFlight && b.hasAttribute("data-move"))
        )),
    );
    this.querySelectorAll<HTMLButtonElement>("[data-choice]").forEach(
      (b) => (b.disabled = this.busy || this.uncertain()),
    );
    for (const id of [
      "new-adventure",
      "continue-adventure",
      "adventures-button",
    ])
      (this.$(`#${id}`) as HTMLButtonElement).disabled =
        this.busy ||
        this.portalEntering ||
        !this.titleReady ||
        !this.metadataHealthy;
    (this.$("#retry") as HTMLButtonElement).disabled = this.busy;
    this.querySelectorAll<HTMLButtonElement>("#menu [data-operation]").forEach(
      (b) => (b.disabled = this.busy),
    );
    this.setAttribute("aria-busy", String(this.busy));
    this.renderStairs();
  }
  private render() {
    const state = this.game?.state;
    this.renderGround();
    this.show("#welcome-copy", !state);
    this.show("#welcome-actions", !state);
    this.show("#welcome-paths", !state);
    this.show("#bookmark-hint", !!state);
    this.show("#creator-link", !state);
    this.show("#play-controls", !!state);
    this.show(".hero-hud", !!state);
    this.show("#character-stats", !!state);
    this.show("#accessible-map", !!state);
    this.show("#recovery", this.uncertain());
    this.show(
      "#continue-adventure",
      this.saves.some((s) => !s.ended),
    );
    const previousRun = this.saves.find(save => !save.ended);
    this.$("#continue-adventure").innerHTML = "Continue previous run" + (previousRun ? `<small>${escape(previousRun.name)} · Turn ${previousRun.turn}</small>` : "");
    this.classList.toggle("in-game", !!state);
    if (state) {
      this.introMovement.stop();
      clearInterval(this.introAuto);
      const o = state.observation,
        v = o.vitals;
      this.dataset.turn = String(o.turn);
      this.dataset.sessionId = state.sessionId;
      showRunUrl(state.sessionId, this.vault);
      this.dataset.revision = String(state.revision);
      this.dataset.decision = state.decision?.kind ?? "none";
      this.text("#hero-name", this.current?.name ?? "Adventurer");
      this.text(
        "#hero-role",
        roles
          .find((r) => r.id === this.current?.role)
          ?.title.replace("The ", "") ?? "Adventurer",
      );
      (this.$("#portrait") as HTMLImageElement).src =
        `/art/${heroArt(this.current?.role)}.png`;
      this.text(
        "#location-heading",
        o.location.depthLabel.replace(/^Dlvl:/, "Dungeon, level ") ||
          "The dungeon",
      );
      this.text("#turn-pill", `TURN ${o.turn}`);
      this.$("#dungeon").setAttribute(
        "aria-label",
        `Perceived dungeon, ${o.location.depthLabel}. Arrow keys move one step. Shift and arrow keys pan the view.`,
      );
      const fraction = Number(v.health) / Number(v.maxHealth);
      this.$("#character-stats").innerHTML =
        `<div class="health-label"><span>Health</span><strong>${escape(v.health ?? "?")} <span>/ ${escape(v.maxHealth ?? "?")}</span></strong></div><progress aria-label="Health" max="100" value="${Number.isFinite(fraction) ? Math.max(0, Math.min(100, fraction * 100)) : 0}"></progress><div class="stats-row"><div><small>ARMOR</small><strong>${escape(v.armor ?? "?")}</strong></div><div><small>GOLD</small><strong>${escape(v.gold ?? "?")}</strong></div><div><small>LEVEL</small><strong>${escape(v.level ?? "?")}</strong></div></div><p class="condition">${escape([v.hunger, v.burden, ...(Array.isArray(v.condition) ? v.condition : [v.condition])].filter(Boolean).join(" · ") || "Ready for the next step")}</p>`;
      this.text(
        "#inventory-count",
        o.inventoryKnown ? o.inventory.length : "?",
      );
      this.text(
        "#save-status",
        this.uncertain()
          ? "Last action needs checking"
          : [state.storage, state.recording].some((d) => d && d.status !== "ok")
            ? "Save needs recovery · input paused"
            : `Saved in this browser · turn ${o.turn}`,
      );
      const frameKey = JSON.stringify([
        state.sessionId,
        state.revision,
        o.turn,
        o.heard,
      ]);
      if (frameKey !== this.lastFrame) {
        for (const text of this.lastFrame ? actionMessages(state) : o.heard)
          if (text.trim()) {
            const previous = this.journal.at(-1);
            if (previous?.text === text) {
              previous.count++;
              previous.lastTurn = o.turn;
            } else this.journal.push({ turn: o.turn, lastTurn: o.turn, text, count: 1 });
          }
        this.lastFrame = frameKey;
      }
      this.text(
        "#latest-message",
        actionMessages(state).at(-1) ??
          o.heard.at(-1) ??
          "Take a moment. Your next step is yours to choose.",
      );
      this.$("#recent-messages").innerHTML = this.journal.slice(-3).map(entry => `<p>${this.journalText(entry)}</p>`).join("");
      const status = state.outcome.status;
      this.text(
        "#inspect-text",
        status === "interrupted"
          ? "Interrupted. Continue only if you choose the activity again."
          : status === "blocked"
            ? `No progress${state.outcome.reason ? ` · ${state.outcome.reason}` : ""}. You can choose a different action.`
            : state.decision
              ? "A choice is waiting. The dungeon will wait for your answer."
              : "Explore at your own pace. Click a tile to inspect what you know.",
      );
      const lines = Array.from({ length: 21 }, () =>
        Array<string>(80).fill(" "),
      );
      const terrain: Record<string, string> = {
        wall: "#",
        floor: ".",
        corridor: "·",
        stairsUp: "<",
        stairsDown: ">",
        closedDoor: "+",
        openDoor: "/",
        fountain: "{",
        trap: "^",
        water: "~",
        lava: "~",
        altar: "_",
      };
      for (const cell of o.world)
        if (lines[cell.y] && cell.x >= 0 && cell.x < 80)
          lines[cell.y]![cell.x] =
            cell.occupant?.mark ??
            cell.objects?.[0]?.mark ??
            terrain[cell.terrain.type] ??
            " ";
      this.text("#map-text", lines.map((row) => row.join("")).join("\n"));
      this.show("#ended", state.ended);
      if (state.ended)
        this.$("#ended").innerHTML =
          `<strong>This chapter has ended.</strong><p>${escape(state.end?.cause ?? state.end?.kind ?? "Your adventure is over.")} · Turn ${o.turn}. Your journal is still here. Start another chapter from Your adventures.</p>`;
    } else {
      delete this.dataset.turn;
      delete this.dataset.sessionId;
      delete this.dataset.revision;
      this.closePanel();
      delete this.dataset.decision;
      this.text("#hero-name", "Your story awaits.");
      this.text("#hero-role", "Every legend starts somewhere.");
      this.text("#location-heading", "The dungeon is calling.");
      this.text("#turn-pill", "EST. 1987 · REIMAGINED");
      this.text("#inventory-count", "—");
      this.text(
        "#inspect-text",
        "The world can wait. Take the first step when you’re ready.",
      );
      this.text(
        "#latest-message",
        "Explore, experiment, and make a story that’s entirely yours.",
      );
      this.text(
        "#save-status",
        this.titleReady
          ? "Ready · saves stay in this browser"
          : "Browser saves unavailable",
      );
      (this.$("#portrait") as HTMLImageElement).src = `/art/${heroArt("ranger")}.png`;
      this.$("#dungeon").setAttribute(
        "aria-label",
        "Dungeon entrance. Use arrow keys to walk into the hall.",
      );
      this.show("#ended", false);
    }
    this.map.update(
      state?.observation ?? null,
      heroArt(this.current?.role),
      `${this.current?.seed ?? this.current?.id ?? 0}:${state?.observation.location.id ?? "threshold"}`,
    );
    this.renderPanel();
    this.renderDecision();
    this.controls();
  }
  private renderPanel() {
    this.querySelectorAll<HTMLElement>("[data-view]").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === this.panel);
      b.setAttribute("aria-pressed", String(b.dataset.view === this.panel));
    });
    const body = this.$("#panel-body");
    const o = this.game?.observation;
    this.text(
      "#panel-heading",
      {
        inventory: "Your backpack",
        surroundings: "Around you",
        journal: "Your journal",
      }[this.panel] ?? "Your backpack",
    );
    if (!o) {
      this.text("#panel-count", "READY WHEN YOU ARE");
      const copy =
        this.panel === "surroundings"
          ? [
              "The world is waiting.",
              "Start or resume an adventure to see what is around you.",
            ]
          : this.panel === "journal"
            ? [
                "A story yet to be told.",
                "Your journal collects what you hear during this visit to an adventure.",
              ]
            : [
                "Pack a little possibility.",
                "Your equipment, useful finds, and mysterious things will live here.",
              ];
      body.innerHTML = `<div class="empty-bag"><span aria-hidden="true">▦</span><h3>${copy[0]}</h3><p>${copy[1]}</p></div>`;
      return;
    }
    body.replaceChildren();
    if (this.panel === "inventory") {
      this.text(
        "#panel-count",
        o.inventoryKnown ? `${o.inventory.length} ITEMS` : "UNKNOWN",
      );
      if (o.perception.inventory !== "current")
        body.append(
          Object.assign(document.createElement("p"), {
            className: "subtle",
            textContent:
              o.perception.inventory === "lastKnown"
                ? "Last known items. The current inventory is not available."
                : "You do not currently know what you are carrying.",
          }),
        );
      for (const item of o.inventory) {
        const b = this.button("", () => this.itemDetails(item), "item-row");
        b.innerHTML = `<span class="item-icon" aria-hidden="true"><img src="${inventoryArt(item.category)}" alt=""></span><span class="item-copy"><span>${escape(item.label)}</span><small>${escape(item.usage?.join(" · ") || item.category || "item")}</small></span><span class="item-quantity">${item.quantity > 1 ? item.quantity : "›"}</span>`;
        body.append(b);
      }
      if (o.inventoryKnown && !o.inventory.length)
        body.append(
          Object.assign(document.createElement("p"), {
            textContent: "Your backpack is empty.",
          }),
        );
    } else if (this.panel === "surroundings") {
      this.text("#panel-count", "PERCEIVED");
      const p = document.createElement("p");
      p.className = "subtle";
      p.textContent = o.here.known
        ? o.here.items.length
          ? "At your feet"
          : "No objects known at your feet."
        : "The objects at your feet are unknown.";
      body.append(p);
      for (const item of o.here.items) {
        const b = this.button(
          item.label,
          () => this.itemDetails(item),
          "item-row",
        );
        body.append(b);
      }
      const you = o.you;
      const nearby = you
        ? o.world.filter(
            (cell) =>
              Math.abs(cell.x - you.x) <= 1 && Math.abs(cell.y - you.y) <= 1,
          )
        : [];
      const list = document.createElement("ul");
      list.className = "nearby-list";
      for (const cell of nearby) {
        const li = document.createElement("li");
        li.append(
          this.button(
            cellDescription(cell),
            () => this.inspectTile(cell.x, cell.y),
            "text-button",
          ),
        );
        list.append(li);
      }
      body.append(list);
    } else {
      this.text("#panel-count", `${this.journal.reduce((sum, entry) => sum + entry.count, 0)} NOTES`);
      for (const entry of [...this.journal].reverse()) {
        const p = document.createElement("p");
        p.className = "journal-entry";
        p.innerHTML = `<small>TURN ${entry.turn}${entry.lastTurn !== entry.turn ? `–${entry.lastTurn}` : ""}</small>${this.journalText(entry)}`;
        body.append(p);
      }
      if (!this.journal.length)
        body.textContent = "Your story begins with your next step.";
      const note = document.createElement("p");
      note.className = "subtle";
      note.textContent =
        "Notes shown since opening this adventure. The saved game retains its own history.";
      body.append(note);
    }
  }
  private journalText(entry: { text: string; count: number }) {
    return escape(entry.text) + (entry.count > 1
      ? ` <span class="journal-repeat" aria-label="Repeated ${entry.count} times">×${entry.count}</span>` : "");
  }
  private renderStairs() {
    const host = this.$("#contextual-stairs");
    host.replaceChildren();
    this.show("#contextual-stairs", false);
    const game = this.game, n = game?.observation.neighborhood;
    if (!game || !this.playable() || n?.status !== "available" || n.inputGate.state !== "ready") return;
    const here = n.cells.find(cell => cell.movement.relation === "here");
    for (const offer of here?.actions ?? []) {
      if (offer.method !== "game.climb" || offer.availability !== "attemptable") continue;
      const revision = n.basis.revision;
      const button = this.button(offer.arguments.direction === "down" ? "Go downstairs" : "Go upstairs", () => {
        if (this.game !== game || !this.playable() || game.state.revision !== revision) return;
        this.stopMovement();
        void this.run(() => this.executeOffer(game, offer, revision));
      });
      button.dataset.direction = offer.arguments.direction;
      host.append(button);
    }
    this.show("#contextual-stairs", !!host.childElementCount);
  }
  private renderGround() {
    const game = this.game,
      o = game?.observation;
    const items =
      o?.perception.here === "current" && o.here.known ? o.here.items : [];
    this.show(
      "#ground-loot",
      !!game && !!items.length && !game.decision && !game.state.ended,
    );
    const list = this.$("#ground-items");
    list.replaceChildren();
    if (!game) return;
    const revision = game.state.revision;
    for (const item of items) {
      const button = this.button(
        "",
        () => {
          if (this.game !== game || !this.playable()) return;
          this.stopMovement();
          void this.run(() =>
            game.pickup({ id: item.id }, { expectedRevision: revision }),
          );
        },
        "ground-item",
      );
      button.innerHTML =
        '<img alt="" src="' +
        inventoryArt(item.category) +
        '"><span>' +
        escape(item.label) +
        "</span><small>Take</small>";
      button.setAttribute("aria-label", "Pick up " + item.label);
      button.disabled = !this.playable();
      list.append(button);
    }
  }
  private closeTile() {
    if (!this.tilePanel) return;
    const focused = this.tilePanel.contains(document.activeElement);
    this.tilePanel.remove();
    this.tilePanel = null;
    if (focused) (this.querySelector("#dungeon") as HTMLElement)?.focus();
  }
  private inspectTile(x: number, y: number, obstruction = false) {
    this.closeTile();
    this.movement.stop();
    const game = this.game,
      n = game?.observation.neighborhood;
    if (!game || this.busy || n?.status !== "available") return;
    const cell = n.cells.find((c) => c.x === x && c.y === y);
    if (!cell) return;
    this.map.clearMessages();
    const revision = n.basis.revision;
    const panel = document.createElement("section");
    panel.className = "tile-actions";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Tile actions");
    panel.dataset.x = String(x);
    panel.dataset.y = String(y);
    const perceived = game.observation.world.find(
      (c) => c.x === x && c.y === y,
    );
    const occupant = perceived?.occupant;
    const title = occupant
      ? creatureLabel(occupant)
      : cell.door?.lock === "locked"
        ? cell.door.freshness === "remembered"
          ? "Last known: locked"
          : "A locked door"
        : (cell.terrain?.type.replace(/([A-Z])/g, " $1") ?? "Beyond the map");
    panel.innerHTML =
      '<header class="tile-heading"><strong></strong></header><p class="subtle"></p><div class="tile-buttons"></div>';
    panel.querySelector("strong")!.textContent = title;
    if (occupant && occupant.kind !== "self") {
      const image = document.createElement("img");
      image.src = creatureArtUrl(occupant.appearance, occupant.mark);
      image.alt = "";
      panel.querySelector("header")!.prepend(image);
      const tag = document.createElement("span");
      tag.className = "tile-relation";
      tag.textContent = occupant.kind === "ally" ? "Ally" : "Creature";
      panel.querySelector("header")!.append(tag);
    }
    panel.setAttribute(
      "aria-description",
      `${x}, ${y}. ${cell.terrain?.freshness ?? "unknown"}. Arrow keys inspect neighboring tiles.`,
    );
    panel.querySelector("p")!.textContent =
      occupant && occupant.kind !== "self"
        ? (occupant.kind === "ally"
            ? "A companion. Moving toward them may swap places."
            : "Moving toward this creature may attack it.") +
          (occupant.appearance
            ? ""
            : " ? means this game version supplies only a creature category; there is no identify action to clear it.")
        : cell.terrain?.freshness === "remembered"
          ? "Remembered · out of sight"
          : cell.movement.relation === "distant"
            ? "Too far to interact from here"
            : "Attempts can fail or need a choice.";
    const labels: Record<string, string> = {
      move: "Move",
      open: "Try opening",
      close: "Close door",
      kick: "Kick",
      apply: "Use a tool…",
      search: "Search here",
      wait: "Wait",
      pickup: "Pick up…",
      climb: "Take the stairs",
    };
    const offers = obstruction
      ? cell.actions
          .filter((a) => a.key !== "move")
          .sort((a, b) => (a.key === "apply" ? -1 : b.key === "apply" ? 1 : 0))
      : cell.actions;
    for (const offer of offers) {
      const button = this.button(
        offer.key === "move" && occupant && occupant.kind !== "self"
          ? occupant.kind === "ally"
            ? "Move toward ally"
            : "Move / attack"
          : (labels[offer.key] ?? offer.key),
        () => {
          if (game !== this.game || this.busy || !this.playable()) return;
          this.closeTile();
          void this.run(() => this.executeOffer(game, offer, revision));
        },
      );
      button.disabled =
        n.inputGate.state !== "ready" || !this.playable() || !offer.arguments;
      if (offer.availability === "knownBlocked")
        button.title =
          offer.reason === "noKnownTools"
            ? "No known tools in your pack"
            : offer.reason;
      if (offer.availability === "outOfReach") button.title = "Out of reach";
      if (offer.key === "kick") {
        button.classList.add("risky-action");
      }
      if (offer.key === "kick")
        button.title = "May injure you, make noise or damage property";
      panel.querySelector(".tile-buttons")!.append(button);
    }
    const back = this.button("×", () => this.closeTile(), "tile-dismiss");
    back.setAttribute("aria-label", "Close tile actions");
    panel.append(back);
    this.tilePanel = panel;
    this.querySelector("#dungeon")!.parentElement!.append(panel);
    this.map.draw();
    // Focus Back, so the input that exposed an obstruction cannot activate an attempt.
    back.focus();
  }
  private executeOffer(
    game: Game,
    offer: ActionOffer,
    revision: number,
  ): Promise<unknown> {
    if (!offer.arguments) return Promise.resolve();
    this.map.context = offer.context ?? null;
    const options = { expectedRevision: revision };
    switch (offer.method) {
      case "game.move":
        return game.move(offer.arguments.direction, options);
      case "game.open":
        return game.open(offer.arguments.target?.direction, options);
      case "game.close":
        return game.closeDoor(offer.arguments.target?.direction, options);
      case "game.kick":
        return game.kick(offer.arguments.target?.direction, options);
      case "game.apply":
        return game.apply(offer.arguments.item, options);
      case "game.pickup":
        return game.pickup(offer.arguments.item, options);
      case "game.search":
        return game.search(options);
      case "game.wait":
        return game.wait(options);
      case "game.climb":
        return game.climb(offer.arguments.direction, options);
    }
  }
  private openMenu(html: string) {
    this.closeTile();
    this.stopMovement();
    this.closePanel();
    this.querySelector<HTMLDetailsElement>(".hud-menu")!.open = false;
    const dialog = this.querySelector<HTMLDialogElement>("#menu")!;
    if (!dialog.open) this.menuReturn = document.activeElement as HTMLElement;
    this.$("#menu-content").innerHTML = html;
    if (!dialog.open) dialog.showModal();
  }
  private closeMenu() {
    this.querySelector<HTMLDialogElement>("#menu")!.close();
  }
  private newAdventure() {
    this.openMenu(
      `<h2 id="menu-title">Every story needs an adventurer.</h2><p class="subtle">Choose a starting path. The rest is up to you.</p><form id="create-form"><div class="create-fields"><label class="field-label" for="adventurer-name">YOUR NAME</label><input id="adventurer-name" name="name" required maxlength="24" autocomplete="off" placeholder="What should we call you?" value="Ada"><fieldset class="class-picker"><legend>YOUR STARTING PATH · ${roles.length} CLASSES</legend>${roles.map((r, i) => `<label class="role-card"><input type="radio" name="role" value="${r.id}" ${i === 0 ? "checked" : ""}><img src="/art/${r.art}.png" alt=""><span><strong>${r.title}${i === 0 ? "<small>FIRST ADVENTURE PICK</small>" : ""}</strong><span>${r.description}</span></span></label>`).join("")}</fieldset><details class="seed-details"><summary>Choose a world seed (optional)</summary><label for="world-seed">A number for a repeatable starting world</label><input id="world-seed" name="seed" type="number" min="0" max="4294967295" step="1" placeholder="Surprise me"></details><p class="save-explanation">Progress is saved on this browser and address. Clearing site data deletes it. Each life is an adventure of its own.</p></div><footer class="create-footer"><button data-operation class="primary" type="submit">Enter the dungeon →</button></footer></form>`,
    );
    const form = this.querySelector<HTMLFormElement>("#create-form")!;
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!form.reportValidity() || this.busy || !this.metadataHealthy) return;
      const data = new FormData(form),
        name = String(data.get("name")).trim();
      if (!name) {
        this.querySelector<HTMLInputElement>(
          "#adventurer-name",
        )!.setCustomValidity("Choose a name for your adventurer.");
        this.querySelector<HTMLInputElement>(
          "#adventurer-name",
        )!.reportValidity();
        return;
      }
      const role = roles.find((r) => r.id === data.get("role"))!;
      const inputSeed = String(data.get("seed")).trim();
      const seed = inputSeed
        ? Number(inputSeed)
        : crypto.getRandomValues(new Uint32Array(1))[0]!;
      this.closeMenu();
      void this.run(async () => {
        if (this.game) await this.game.close();
        this.game = null;
        this.current = null;
        await this.preparation;
        await this.connectRuntime();
        this.game = await this.api!.create({ ...role.identity, name, seed });
        this.current = {
          id: this.game.id,
          name,
          role: role.id,
          seed,
          turn: this.game.observation.turn,
          ended: false,
        };
        this.saves.unshift(this.current);
        this.journal = [];
        this.lastFrame = "";
        this.map.center();
        this.$("#dungeon").focus();
      }, { name, role: role.id });
    };
    this.querySelector<HTMLInputElement>("#adventurer-name")!.oninput = (e) =>
      (e.target as HTMLInputElement).setCustomValidity("");
  }
  private resume(save: Adventure) {
    if (!save) return;
    showRunUrl(save.id, this.vault);
    this.closeMenu();
    void this.run(async () => {
      if (this.game) await this.game.close();
      this.game = null;
      this.current = null;
      await this.preparation;
      await this.connectRuntime();
      this.game = await this.api!.resume(save.id);
      this.current = this.saves.find((record) => record.id === save.id) ?? save;
      this.saves = [this.current, ...this.saves.filter(record => record.id !== save.id)];
      this.journal = [];
      this.lastFrame = "";
      this.map.center();
      this.$("#dungeon").focus();
    }, { name: save.name, role: save.role, resume: true });
  }
  private async returnToDoorway() {
    await this.game?.close();
    this.game = null;
    this.current = null;
    await this.api?.close();
    this.api = null;
    clearRunUrl();
  }
  private adventures() {
    this.openMenu(
      '<h2 id="menu-title">Your adventures</h2><p class="subtle">Saved on this browser and address. Returning to the doorway keeps your progress.</p><div id="save-list"></div><div class="dialog-actions" id="save-actions"></div>',
    );
    const list = this.$("#save-list");
    if (!this.saves.length)
      list.textContent = "A blank page. A good place to begin.";
    for (const save of this.saves) {
      const b = this.button(
        `${save.name} · ${save.role} · turn ${save.turn}${save.ended ? " · ended" : ""}`,
        () => this.resume(save),
        "save-row",
      );
      b.dataset.operation = "";
      b.disabled = save.id === this.game?.id || this.busy;
      list.append(b);
    }
    if (this.game) {
      const b = this.button("Save & return to doorway", () => {
        this.closeMenu();
        void this.run(() => this.returnToDoorway());
      });
      b.dataset.operation = "";
      this.$("#save-actions").append(b);
    }
    const fresh = this.button(
      "Start a new adventure",
      () => this.newAdventure(),
      "primary",
    );
    fresh.dataset.operation = "";
    this.$("#save-actions").append(fresh);
  }
  private move(direction: Compass) {
    this.movement.press(direction, "tap");
    this.movement.release("tap");
  }
  private async stepMove(direction: Compass, repeated: boolean) {
    const before = this.game!.observation;
    // Stop held walking around currently perceived creatures. A fresh deliberate
    // press may still interact; this is input consent, not combat/pathfinding logic.
    if (
      repeated &&
      before.you &&
      before.world.some(
        (cell) =>
          cell.occupant?.kind === "creature" &&
          Math.abs(cell.x - before.you!.x) <= 1 &&
          Math.abs(cell.y - before.you!.y) <= 1,
      )
    )
      return false;
    let succeeded = false;
    await this.run(async () => {
      const result = await this.game!.move(direction);
      const after = result.observation;
      succeeded =
        result.outcome.status === "completed" &&
        result.outcome.positionChanged &&
        result.outcome.turnsElapsed <= 1 &&
        !result.error &&
        before.location.id === after.location.id &&
        !(
          typeof before.vitals.health === "number" &&
          typeof after.vitals.health === "number" &&
          after.vitals.health < before.vitals.health
        );
    });
    return succeeded && this.playable() && this.metadataHealthy;
  }
  private action(name: string, item?: ItemRef) {
    this.movement.stop();
    if (!this.playable()) return;
    const g = this.game!,
      ref = item ? { id: item.id } : undefined;
    const actions: Record<string, () => Promise<Snapshot>> = {
      wait: () => g.wait(),
      search: () => g.search(),
      pickup: () => g.pickup(ref),
      eat: () => g.eat(ref),
      drink: () => g.drink(ref),
      open: () => g.open(),
      close: () => g.closeDoor(),
      kick: () => g.kick(),
      up: () => g.climb("up"),
      down: () => g.climb("down"),
      pray: () => g.pray(),
      read: () => g.read(ref),
      apply: () => g.apply(ref),
      wield: () => g.wield(ref),
      equip: () => g.equip(ref),
      remove: () => g.remove(ref),
      drop: () => g.drop(ref),
      zap: () => g.zap(ref),
    };
    if (actions[name]) {
      this.closeMenu();
      void this.run(actions[name]!);
    }
  }
  private more() {
    this.openMenu(
      '<h2 id="menu-title">A few more possibilities.</h2><p class="subtle">Choose an action. If it needs an item, direction, or permission, you’ll be asked.</p><div class="more-grid" id="more-grid"></div>',
    );
    for (const [action, label] of Object.entries({
      drink: "Drink",
      read: "Read",
      apply: "Use a tool",
      wield: "Wield",
      equip: "Wear equipment",
      remove: "Remove equipment",
      drop: "Drop",
      zap: "Zap a wand",
      close: "Close a door",
      kick: "Kick",
      up: "Go upstairs",
      pray: "Pray",
    })) {
      const b = this.button(label, () => this.action(action));
      b.dataset.operation = "";
      this.$("#more-grid").append(b);
    }
  }
  private itemDetails(item: ItemRef) {
    this.selectedItem = item;
    this.openMenu(
      `<div class="large-item-icon" aria-hidden="true"><img src="${inventoryArt(item.category)}" alt=""></div><h2 id="menu-title">${escape(item.label)}</h2><p class="subtle">${escape(item.location === "here" ? "At your feet" : "In your backpack")}${item.usage?.length ? ` · ${escape(item.usage.join(", "))}` : ""}</p><p>Choose what you’d like to try. The dungeon decides what is possible.</p><div class="more-grid" id="item-actions"></div>`,
    );
    const labels =
      item.location === "here"
        ? { pickup: "Pick up", eat: "Eat" }
        : {
            wield: "Wield",
            equip: "Wear",
            remove: "Remove",
            eat: "Eat",
            drink: "Drink",
            read: "Read",
            apply: "Use",
            zap: "Zap",
            drop: "Drop",
          };
    for (const [action, label] of Object.entries(labels)) {
      const b = this.button(label!, () =>
        this.action(action, this.selectedItem!),
      );
      b.disabled = !this.playable();
      this.$("#item-actions").append(b);
    }
  }
  private renderDecision() {
    const d = this.game?.decision,
      dialog = this.querySelector<HTMLDialogElement>("#decision")!;
    if (!d || this.uncertain()) {
      this.querySelector("#direction-target")?.remove();
      if (dialog.open) dialog.close();
      this.decisionIdentity = "";
      return;
    }
    if (d.kind === "target" && d.allowedTargets.includes("direction")) {
      if (dialog.open) dialog.close();
      if (this.decisionIdentity === d.id && this.querySelector("#direction-target")) return;
      this.closeMenu();
      this.closeTile();
      this.closePanel();
      this.querySelector("#direction-target")?.remove();
      this.decisionIdentity = d.id;
      const target = document.createElement("section");
      target.id = "direction-target";
      target.setAttribute("aria-label", d.about ?? "Choose a direction");
      target.innerHTML = '<p class="target-caption"></p><div class="target-arrows"></div><div class="target-extra"></div>';
      target.querySelector("p")!.textContent = `${d.action.charAt(0).toUpperCase() + d.action.slice(1)} · ${d.about ?? "Choose a direction"}`;
      const answer = (direction: string) => void this.run(() => this.game!.answer(d.id, { kind: "target", target: { direction: direction as Compass } }));
      directions.forEach(([direction, glyph], index) => {
        const button = this.button(glyph, () => answer(direction));
        button.setAttribute("aria-label", direction);
        button.dataset.targetDirection = direction;
        button.style.gridArea = String(Math.floor((index < 4 ? index : index + 1) / 3) + 1) + " / " + String((index < 4 ? index : index + 1) % 3 + 1);
        target.querySelector(".target-arrows")!.append(button);
      });
      const extra = target.querySelector(".target-extra")!;
      for (const direction of ["up", "down"]) extra.append(this.button(direction === "up" ? "Above" : "Below", () => answer(direction)));
      if (d.allowedTargets.includes("self")) extra.append(this.button("Myself", () => void this.run(() => this.game!.answer(d.id, { kind: "target", target: "self" }))));
      if (d.cancellable) extra.append(this.button("Cancel", () => void this.run(() => this.game!.cancel(d.id))));
      target.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.dataset.choice = ""; });
      this.$("#dungeon").parentElement!.append(target);
      this.map.draw();
      target.querySelector<HTMLElement>("button")?.focus();
      return;
    }
    this.querySelector("#direction-target")?.remove();
    this.show("#decision-error", !this.$("#error").hidden);
    this.text("#decision-error", this.$("#error").textContent ?? "");
    if (this.decisionIdentity === d.id && dialog.open) return;
    this.closeMenu();
    this.decisionIdentity = d.id;
    this.text(
      "#decision-title",
      (
        {
          item: "What would you like to use?",
          target: "Which direction?",
          confirmation: "Are you sure?",
          choice: "Make your choice.",
          text: "What do you have in mind?",
        } as Record<string, string>
      )[d.kind] ?? "A new kind of choice",
    );
    this.text(
      "#decision-about",
      d.about ?? "The dungeon is waiting for your answer.",
    );
    const body = this.$("#decision-body");
    body.replaceChildren();
    const add = (
      label: string,
      action: () => Promise<unknown>,
      className = "secondary",
    ) => {
      const b = this.button(label, () => void this.run(action), className);
      b.dataset.choice = "";
      body.append(b);
      return b;
    };
    if (d.kind === "confirmation") {
      add(
        "No, not now",
        () => this.game!.answer(d.id, { kind: "confirmation", confirm: false }),
        "primary",
      );
      add("Yes, continue", () =>
        this.game!.answer(d.id, { kind: "confirmation", confirm: true }),
      );
    } else if (d.kind === "item") {
      for (const item of d.options)
        add(
          item.label,
          () =>
            this.game!.answer(d.id, { kind: "item", item: { id: item.id } }),
          "choice-row",
        );
    } else if (d.kind === "target") {
      if (d.allowedTargets.includes("direction"))
        for (const [direction, label] of [
          ...directions,
          ["up", "↑ Above"],
          ["down", "↓ Below"],
        ] as const)
          add(`${label} ${direction}`, () =>
            this.game!.answer(d.id, { kind: "target", target: { direction } }),
          );
      if (d.allowedTargets.includes("self"))
        add("Myself", () =>
          this.game!.answer(d.id, { kind: "target", target: "self" }),
        );
    } else if (d.kind === "choice") {
      const min = d.selection?.min ?? 1,
        max = d.selection?.max ?? 1;
      const form = document.createElement("form");
      body.append(form);
      const inputs = d.options.map((option) => {
        const label = document.createElement("label");
        label.className = "menu-choice";
        const input = document.createElement("input");
        input.type = max > 1 ? "checkbox" : "radio";
        input.name = "selection";
        input.value = String(option.id);
        label.append(input, document.createTextNode(option.label));
        form.append(label);
        return { input, id: option.id };
      });
      const hint = document.createElement("p");
      hint.className = "subtle";
      hint.textContent = `Choose ${min === max ? min : `${min}–${max}`} option${max === 1 ? "" : "s"}.`;
      form.append(hint);
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "primary";
      submit.textContent = "Confirm selection";
      submit.dataset.choice = "";
      form.append(submit);
      form.onsubmit = (e) => {
        e.preventDefault();
        const choose = inputs.filter((v) => v.input.checked).map((v) => v.id);
        if (choose.length < min || choose.length > max) {
          hint.textContent = `Please choose between ${min} and ${max} options.`;
          return;
        }
        void this.run(() =>
          this.game!.answer(d.id, { kind: "choice", choose }),
        );
      };
    } else if (d.kind === "text") {
      const form = document.createElement("form"),
        label = document.createElement("label"),
        input = document.createElement("input");
      label.textContent = "Your answer";
      input.name = "answer";
      input.maxLength = 256;
      label.append(input);
      form.append(label);
      body.append(form);
      const submit = document.createElement("button");
      submit.textContent = "Send answer";
      submit.className = "primary";
      submit.dataset.choice = "";
      form.append(submit);
      form.onsubmit = (e) => {
        e.preventDefault();
        void this.run(() =>
          this.game!.answer(d.id, { kind: "text", text: input.value }),
        );
      };
    } else {
      const p = document.createElement("p");
      p.textContent =
        "This interface cannot answer this choice yet. It has not sent any input.";
      body.append(p);
    }
    if (d.cancellable)
      add(
        "Cancel action",
        () => this.game!.cancel(d.id),
        "text-button cancel-choice",
      );
    add(
      "Save & return to doorway",
      () => this.returnToDoorway(),
      "text-button",
    );
    if (!dialog.open) dialog.showModal();
    body.querySelector<HTMLElement>("button,input")?.focus();
  }
  private key(e: KeyboardEvent) {
    const target = this.querySelector<HTMLElement>("#direction-target");
    if (target && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.defaultPrevented || this.querySelector("dialog[open], .rightbar:not([hidden])") ||
          (e.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return;
      const menu = this.querySelector<HTMLDetailsElement>(".hud-menu[open]");
      if (menu) {
        if (e.key === "Escape") { e.preventDefault(); menu.open = false; }
        return;
      }
      const keys: Record<string, string> = { ArrowUp: "north", ArrowDown: "south", ArrowLeft: "west", ArrowRight: "east", w: "north", a: "west", s: "south", d: "east", h: "west", j: "south", k: "north", l: "east", y: "northwest", u: "northeast", b: "southwest", n: "southeast", "<": "up", ">": "down" };
      if (keys[e.key] || e.key === "Escape") {
        e.preventDefault();
        const d = this.game?.decision;
        if (!e.repeat && d && !this.busy) {
          if (e.key === "Escape") { if (d.cancellable) void this.run(() => this.game!.cancel(d.id)); }
          else void this.run(() => this.game!.answer(d.id, { kind: "target", target: { direction: keys[e.key] as Compass } }));
        }
        return;
      }
      return; // Let focused controls handle Enter/Space/Tab; no gameplay shortcuts.
    }
    if (e.key === "Escape" && !this.querySelector("dialog[open]")) {
      this.stopMovement();
      this.closePanel();
      this.querySelector<HTMLDetailsElement>(".hud-menu")!.open = false;
    }
    if (
      !this.game &&
      !(e.target instanceof Element && e.target.closest("#welcome-paths")) &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      this.introAvailable()
    ) {
      const introKeys: Record<string, Compass> = {
        w: "north", a: "west", s: "south", d: "east",
        ArrowUp: "north",
        ArrowDown: "south",
        ArrowLeft: "west",
        ArrowRight: "east",
      };
      const direction = introKeys[e.key];
      if (direction) {
        e.preventDefault();
        if (!e.repeat) {
          this.stopMovement();
          this.querySelector(`[data-intro="${direction}"]`)?.classList.add(
            "pressed",
          );
          this.introMovement.press(direction, `key:${e.code || e.key}`);
        }
        return;
      }
    }
    if (this.tilePanel) {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeTile();
      }
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      const delta: Record<string, [number, number]> = {
        w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      };
      if (delta[e.key]) {
        e.preventDefault();
        const [dx, dy] = delta[e.key]!;
        const x = Number(this.tilePanel.dataset.x) + dx,
          y = Number(this.tilePanel.dataset.y) + dy;
        const n = this.game?.observation.neighborhood;
        if (
          n?.status === "available" &&
          n.cells.some((c) => c.x === x && c.y === y)
        )
          this.inspectTile(x, y);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) this.movement.stop();
    if (e.repeat) {
      if (
        !this.querySelector("dialog[open]") &&
        !(e.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable="true"]',
        ) &&
        (e.key.startsWith("Arrow") ||
          "wasdhjklyubn".includes(e.key) ||
          (e.target as HTMLElement).closest("[data-move]"))
      )
        e.preventDefault();
      return;
    }
    if (
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      this.querySelector("dialog[open]") ||
      (e.target as HTMLElement).closest(
        'input,textarea,select,[contenteditable="true"]',
      )
    )
      return;
    if (e.key === "Enter" && this.game?.observation.you) {
      e.preventDefault();
      const { x, y } = this.game.observation.you;
      this.inspectTile(x, y);
      return;
    }
    if (e.key === "?") {
      e.preventDefault();
      this.guide();
      return;
    }
    if (e.key === "i") {
      this.movement.stop();
      e.preventDefault();
      this.panel = "inventory";
      this.renderPanel();
      this.showPanel();
      return;
    }
    const move: Record<string, Compass> = {
      w: "north", a: "west", s: "south", d: "east",
        ArrowUp: "north",
      ArrowDown: "south",
      ArrowLeft: "west",
      ArrowRight: "east",
      h: "west",
      j: "south",
      k: "north",
      l: "east",
      y: "northwest",
      u: "northeast",
      b: "southwest",
      n: "southeast",
    };
    if (e.shiftKey && e.key.startsWith("Arrow")) {
      this.movement.stop();
      e.preventDefault();
      this.map.pan(
        e.key === "ArrowLeft" ? -3 : e.key === "ArrowRight" ? 3 : 0,
        e.key === "ArrowUp" ? -3 : e.key === "ArrowDown" ? 3 : 0,
      );
      return;
    }
    if (move[e.key]) {
      e.preventDefault();
      this.movement.press(move[e.key]!, `key:${e.code || e.key}`);
      return;
    }
    const action: Record<string, string> = {
      ".": "wait",
      f: "search",
      g: "pickup",
      e: "eat",
      o: "open",
      ">": "down",
      "<": "up",
    };
    if (action[e.key]) {
      e.preventDefault();
      this.action(action[e.key]!);
    }
  }
  private guide() {
    this.openMenu(
      `<h2 id="menu-title">A small guide to a very big world.</h2><p>Find the Amulet of Yendor in the depths, and bring it back. Getting there is a story of curiosity, decisions, and learning from a short life or two.</p><div class="guide-section"><h3>01 / Take your time</h3><p>This is turn-based. Reading, inspecting the map, and opening your backpack cost nothing. An action can take time; the journal tells you what happened.</p></div><div class="guide-section"><h3>02 / Try one thing</h3><p>Tap W A S D, an arrow, or a direction button for one step; hold to walk. Release to stop repeating. Rapid taps keep at most one extra step buffered. Walking pauses at walls, nearby creatures, damage, and decisions. Press again deliberately to interact. Search around you, open a door, or pick up something interesting.</p></div><div class="guide-section"><h3>03 / Listen to the dungeon</h3><p>Hunger, danger, and strange objects are part of the adventure. Read warnings before answering. If eating or reading is interrupted, choose the action again only when you want to continue.</p></div><div class="guide-section"><h3>04 / Know what you know</h3><p>The map shows remembered terrain and currently perceived occupants. Creature and object art represents the visible NetHack category, not an exact identity. A green underline marks an ally. Use @ in the corner menu to show the original symbols. Raised stone edges frame corridors; recessed gaps lead toward unexplored space, where the layout is still unknown. Click a tile or open Surroundings for a text description.</p></div><dl class="key-list"><dt>W A S D / Arrows / H J K L</dt><dd>Tap to step · hold to walk</dd><dt>Y U B N</dt><dd>Move diagonally</dd><dt>. / F / G / E / O</dt><dd>Wait / search / pick up / eat / open</dd><dt>&lt; / &gt;</dt><dd>Go upstairs / downstairs</dd><dt>Enter / arrow keys / Escape</dt><dd>Inspect here / nearby tiles / return</dd><dt>I / ?</dt><dd>Backpack / this guide</dd><dt>Shift + arrows</dt><dd>Pan the map without moving</dd></dl><p class="save-explanation">Your game saves after each completed action, on this browser and address. Clearing site data removes saves. Keep the same game version to return to an older adventure.</p>`,
    );
  }
  private credits() {
    this.openMenu(
      `<h2 id="menu-title">An old world. An open door.</h2><p>neonethack is a new, approachable window into NetHack, built on the neonethack library and its shared C engine.</p><p>NetHack by the NetHack DevTeam and its contributors, under the NetHack General Public License. Original notices remain with the engine.</p><p>Character art from Modern Interiors by <a href="https://limezu.itch.io/moderninteriors" target="_blank" rel="noreferrer">LimeZu</a>. Companion and bat illustrations use original templates from the pixel-art-interfaces skill. Dungeon tiles and interface design are original to this example.</p><p>Gameplay runs in your browser.</p>`,
    );
  }
}
customElements.define("pixel-nethack", PixelNethack);
