import {claimTabStore} from './tab-lease';
import {readAdventures,writeAdventure,changedAdventure,type Adventure} from './adventure-index';
import { appendReceipt, journalScroll, renderJournalEntry, type JournalEntry } from './journal';
import { renderHeroHud } from './hero-hud';
import { encyclopedia } from './encyclopedia';
import './component';
import { PublicReplayRecorder,InputReplayRecorder, embedCode, replayLink } from './public-replay';
import { adventurerName } from './adventurer-names';
import { renderCharacterSheet, equipmentDescription } from './character-sheet';
import { actionIcon } from "./action-icons";
import { accountApi, RunRecorder } from './account-client';
import { reportError, reportTiming } from "./telemetry";
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
import { loadRuntime, warmPackage, runtimePackage } from "./runtime-loader";
import {
  cloudReady,
  playerId, rememberPlayer, requestedRun, showRunUrl, clearRunUrl,
  journalUrl,
  publishCloud,
  queueCloud,
  restoreAdventures,
  type PlayControl,
} from "./cloud";
import { roles, heroArt } from "./characters";
import { pickupEditor, pickupSummary, loadPickupPreferences, rememberPickup } from "./pickup-editor";

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
  private runtimeBuildId = "";
  private vault = "";
  private storeName = "";
  private indexKey = "";
  private tabLease?: Awaited<ReturnType<typeof claimTabStore>>;
  private yielding = false;
  private transferredRun?: string;
  private settled: Promise<unknown> = Promise.resolve();
  private storageChanged = (event: StorageEvent) => {
    if (event.storageArea !== localStorage || !event.key || !this.indexKey) return;
    try {
      if (event.key === this.indexKey) this.readSaves();
      else if (event.key.startsWith(this.indexKey + ':') && event.newValue) {
        const save = changedAdventure(event.key,event.newValue);
        if (save.id !== this.current?.id) this.saves = [save,...this.saves.filter(s => s.id !== save.id)];
      } else return;
      this.controls();
    }
    catch (error) { this.metadataHealthy=false; this.error(error); }
  };
  private runtime!: Awaited<ReturnType<typeof loadRuntime>>;
  private preparation!: Promise<void>;
  private titleReady = false;
  private preloadAbort = new AbortController();
  private warmed: Promise<void> | null = null;
  private webMcp: WebMcpRegistration | null = null;
  private game: Game | null = null;
  private busy = false;
  private inspectionVersion=0;
  private navigationNotice="";
  private navigationAbort: AbortController | null = null;
  private cloudStatusGeneration = 0;
  private cloudEnabled = false;
  private saves: Adventure[] = [];
  private metadataHealthy = true;
  private current: Adventure | null = null;
  private map!: DungeonMap;
  private tilePanel: HTMLElement | null = null;
  private panel = "inventory";
  private prayerExplained = (() => {
    try { return localStorage.getItem("neonethack-prayer-explained") === "yes"; } catch { return false; }
  })();
  private journal: JournalEntry[] = [];
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
    this.navigationAbort?.abort();
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
  private accountUser = accountApi().catch(() => null);
  private accountChanged = (event: Event) => { this.accountUser = Promise.resolve((event as CustomEvent).detail); this.accountSession = ''; this.accountRecorder = null; };
  private accountRecorder: RunRecorder | null = null;
  private accountSession = '';
  private publicRecorder?: PublicReplayRecorder|InputReplayRecorder;
  private inputTransport?:import('neonethack/wasm').WasmTransport;
  private inputRecording=false;
  private onlineRecording=()=>{if(this.game&&this.inputTransport)void this.inputTransport.flushRecording(this.game.id);};
  private publicSession='';
  private inputSource: PlayControl = "manual";
  private recordReplays() {
    const frame = this.game?.state, current = this.current;
    if(!frame || !current?.buildId) return;
    if(current.recording==='inputs'){
      if(this.publicSession!==frame.sessionId){
        this.publicSession=frame.sessionId;this.publicRecorder?.close();
        this.publicRecorder=new InputReplayRecorder(()=>this.inputTransport!.flushRecording(frame.sessionId),()=>publishCloud(this.saves.filter(save=>save.id===frame.sessionId),this.vault));
      }
      return;
    }
    if(this.cloudEnabled) {
      if(this.publicSession!==frame.sessionId){
        this.publicSession=frame.sessionId;this.text('#copy-embed','Copy run embed');
        this.publicRecorder?.close();
        this.publicRecorder=new PublicReplayRecorder(frame.sessionId,this.vault,()=>publishCloud(this.saves.filter(save=>save.id===frame.sessionId),this.vault),message=>{if(this.publicSession!==frame.sessionId)return;const node=this.querySelector('#public-recording');if(node)node.textContent=message;});
      }
      this.publicRecorder?.record(frame);
    }
    void this.accountUser.then(user => {
      if(!user) return;
      if(this.accountSession !== frame.sessionId) {
        this.accountSession = frame.sessionId;
        this.accountRecorder = new RunRecorder({name:current.name,role:current.role,seed:current.seed,buildId:current.buildId!}, message => {
          const node = document.getElementById('account-recording');
          if(node) node.textContent = message;
        });
      }
      this.accountRecorder?.record(frame);
    });
  }
  get snapshot(): Snapshot | null {
    return this.game?.state ?? null;
  }

  private hudLayout?: ResizeObserver;
  connectedCallback() {
    this.innerHTML = `

      <main id="main" tabindex="-1">
        <div class="map-viewport"><canvas id="dungeon" tabindex="0" aria-label="Dungeon entrance. Use arrow keys to walk into the hall."></canvas><button id="enter-gate" aria-label="Walk into the glowing gate and create an adventurer" title="Enter the dungeon"></button></div>
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
          <header><span class="eyebrow">ONE DUNGEON. MANY POSSIBILITIES.</span><a href="https://github.com/tobi/neohack" target="_blank" rel="noopener noreferrer">GitHub ↗</a></header>
          <div class="welcome-content"><p id="package-status" role="status">Preparing the game in the background…</p>
          <article><span class="path-number">01 · ADVENTURE</span><h2>Play the classic</h2><p>A deep dungeon. A loyal companion. A thousand ways to learn the hard way. Walk through the doorway and discover NetHack, one turn at a time.</p><a href="#welcome-actions">Enter the dungeon ↓</a></article>
          <article><span class="path-number">02 · BRING YOUR AGENT</span><h2>Have your Agent play</h2><p>Let your agent play with <a href="https://webmachinelearning.github.io/webmcp/" target="_blank" rel="noopener noreferrer">WebMCP</a>.</p><a href="https://github.com/tobi/neohack/blob/main/lib/neonethack/docs/AGENT_BROWSER.md" target="_blank" rel="noopener noreferrer">Agent-browser walkthrough ↗</a></article>
          <article><span class="path-number">03 · MAKE SOMETHING NEW</span><h2>It’s time for NetHack itself to ascend.</h2><p>The brain of NetHack, separated from its interface and exposed as a JSON protocol. Build a completely new UX, a reinforcement learning environment for small models, an evaluation for frontier models—or whatever comes next.</p><a href="https://github.com/tobi/neohack/tree/main/lib/neonethack" target="_blank" rel="noopener noreferrer">Explore the library ↗</a></article>
          <section class="welcome-code" aria-labelledby="code-heading"><span class="path-number">THE LIBRARY · TYPESCRIPT</span><h2 id="code-heading">Your interface. NetHack’s brain.</h2><pre tabindex="0" aria-label="Native NetHack example"><code><span class="code-keyword">import</span> Nethack <span class="code-keyword">from</span> <span class="code-string">'neonethack'</span>;

<span class="code-keyword">const</span> nethack = <span class="code-keyword">new</span> Nethack();
<span class="code-keyword">try</span> {
  <span class="code-keyword">const</span> game = <span class="code-keyword">await</span> nethack.create({
    role: <span class="code-string">'valkyrie'</span>, seed: <span class="code-number">42</span>,
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
          </div>
        </aside>
        <a id="creator-link" class="creator-link" href="https://x.com/tobi" target="_blank" rel="noopener noreferrer" aria-label="@tobi on X (opens in a new tab)">@tobi</a>
        <section class="hero-hud" aria-label="Adventurer" hidden>
          <img id="portrait" src="/art/${heroArt("ranger")}.png" alt="">
          <div class="hero-identity"><strong id="hero-name"></strong><span id="hero-role"></span></div><div id="hero-level" class="hero-level"></div>
          <div id="character-stats" class="character-stats" hidden></div>
        </section>
        <div class="world-hud">
          <div class="location-hud"><span id="location-heading"></span><span id="turn-pill"></span><span id="cloud-status" role="status"></span></div>
          <details class="hud-menu"><summary aria-label="Game menu">☰</summary><div class="hud-menu-body">
            <button id="adventures-button">Your adventures</button><button id="pickup-settings" data-game>Automatic pickup</button><button id="abandon-run" data-game hidden>Abandon run</button><button data-guide>Field guide <kbd>?</kbd></button><button id="encyclopedia-button" data-game>Encyclopedia</button>
            <div class="map-tools"><button id="map-symbols" aria-label="Show NetHack symbols" aria-pressed="false" title="Switch to NetHack symbols">Art</button><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-in" aria-label="Zoom in">+</button><button id="center-map" aria-label="Center on you">⌖</button></div>
            <button id="copy-embed">Copy run embed</button><p id="public-recording" role="status">Public replays record observed scenes from this visit.</p><button id="sound-button" aria-pressed="false">Sound: off</button><button id="fullscreen-button">Fullscreen</button><button id="text-map-button">Read the map as text</button><button id="credits-button">About & credits</button><a class="menu-github" href="/dashboard" target="_blank" rel="noopener noreferrer">Adventure ledger ↗</a><a class="menu-github" href="https://github.com/tobi/neohack" target="_blank" rel="noopener noreferrer">GitHub ↗</a><p id="bookmark-hint" hidden>Bookmark this run’s URL to resume. Keep it private: it opens your saved vault.</p><p id="save-status" role="status">Saves stay in this browser.</p><p id="webmcp-status"></p><p id="account-recording" role="status"></p><a class="menu-github" href="/component" target="_blank" rel="noopener">Embed the world ↗</a><a class="menu-github" href="/bots" target="_blank" rel="noopener">Ascender workshop ↗</a><a class="menu-github" href="/login" target="_blank" rel="noopener">Your account & replays ↗</a>
          </div></details>
        </div>
        <div class="notices"><div class="notice error" id="error" role="alert" hidden></div>
          <div class="notice" id="recovery" hidden><strong>Your last action needs checking.</strong><p>It may already have happened. Check its saved result before doing anything else. If the connection has stopped, reload and resume this adventure first.</p><button class="secondary" id="retry">Check last action</button></div>
          <div class="notice" id="ended" hidden></div>
        </div>
        <section class="play-controls" id="play-controls" aria-label="Adventure controls" hidden>
          <div class="navigation-cluster"><pre id="nearby-ascii" aria-hidden="true"></pre><div class="direction-pad">${directions
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
            .join("")}</div></div>
          <div class="action-dock"><div id="navigation-status" hidden><span id="navigation-status-text"></span><button id="navigation-stop">Stop walking</button></div><div class="action-grid"><button data-action="search" data-game>Search<kbd>f</kbd></button><button data-action="pickup" data-game>Pick up<kbd>g</kbd></button><button data-action="eat" data-game>Eat<kbd>e</kbd></button><button data-action="pray" data-game>Pray</button><button id="more-actions" data-game>More actions</button></div>
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
      <dialog id="journal-scroll" aria-labelledby="scroll-title"><div class="dialog-top"><span class="eyebrow">FROM YOUR JOURNAL</span><button id="close-scroll" aria-label="Close scroll">×</button></div><h2 id="scroll-title">A page from your adventure</h2><p id="scroll-turn" class="eyebrow"></p><div id="scroll-text" role="region" aria-label="Journal passage" tabindex="0"></div><button id="finish-scroll" class="primary">Return to the adventure</button></dialog>
      <dialog id="decision" aria-labelledby="decision-title"><div class="eyebrow">ONE MOMENT, ADVENTURER</div><h2 id="decision-title"></h2><p id="decision-about"></p><p id="decision-error" class="notice error" role="alert" hidden></p><div id="decision-body"></div><div id="decision-footer"></div></dialog>`;
    this.map = new DungeonMap(this.querySelector("#dungeon")!, (text, x, y, walk) => {
      this.text("#inspect-text", text);
      const decision = this.game?.decision;
      if (decision?.kind === "position") {
        if (!this.busy && x >= 1 && x <= 79 && y >= 0 && y <= 20) void this.run(() => this.game!.answer(decision.id, {kind: "position", position: {x, y}}));
      } else this.inspectTile(x, y, false, walk);
    });
    this.bind();
    this.hudLayout = new ResizeObserver(() => {
      const top = this.getBoundingClientRect().top;
      const bottom = Math.max(...[".hero-hud", ".location-hud"].map(selector => this.$(selector).getBoundingClientRect().bottom));
      this.style.setProperty("--hud-floor", `${Math.max(128, bottom - top + 8)}px`);
    });
    for (const node of [this, this.$(".hero-hud"), this.$(".location-hud")]) this.hudLayout.observe(node);
    document.addEventListener("keydown", this.keyHandler);
    document.addEventListener("keyup", this.keyUpHandler);
    window.addEventListener("blur", this.stopMovement);
    window.addEventListener("account-dialog-open", this.stopMovement);
    window.addEventListener("accountchange", this.accountChanged);
    window.addEventListener("storage", this.storageChanged);
    document.addEventListener("visibilitychange", this.visibilityChanged);
    window.addEventListener('online',this.onlineRecording);
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
    void this.preparation.then(() => this.openLinkedRun()).catch((error) => { reportError(error,this.runtimeBuildId,{kind:"boot",local:!!requestedRun()?.local}); this.error(error); this.entryRecovery(requestedRun()?.id,error); });
    this.controls();
  }
  private async openLinkedRun() {
    const linked = requestedRun();
    if (!linked) return;
    await this.run(async () => {
      await this.connectRuntime(linked.id);
      this.game = await this.api!.resume(linked.id);
      const save = this.saves.find(s => s.id === linked.id) ?? { id: linked.id, name: "Saved adventurer", role: "ranger", turn: this.game.observation.turn, ended: this.game.state.ended };
      if (!this.saves.some(s => s.id === save.id)) this.saves.unshift(save);
      this.current = save;
      this.journal = [];
      this.lastFrame = "";
      this.map.center();
    }, { name: "Your adventurer", role: "ranger", resume: true, sessionId:linked.id });
  }
  private readSaves() {
    this.saves = readAdventures(this.indexKey, STORE + '-' + this.vault).map(save =>
      save.id === this.current?.id ? this.current : save);
  }
  private warm(buildId?: string) {
    // Speculative warmup is optional; the verified runtime load retries on entry.
    return this.warmed ??= warmPackage(this.preloadAbort.signal, buildId).then(() => {
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
    if (!requestedRun()) void this.warm();
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
    if ('sessionId' in request.params && (request.params.sessionId === this.transferredRun || this.yielding) && request.method !== 'session.resume')
      return {version:1,sessionId:request.params.sessionId,error:{code:'clientNotActive',message:'This run moved to another tab. Use session.resume explicitly to play it here; this tool was not submitted.'}};
    if (this.busy || this.yielding || this.movement.inFlight)
      throw Error(
        "Client busy; this tool was not submitted. Try the exact request again after the current action settles.",
      );
    if (!this.metadataHealthy)
      throw Error("Browser storage is unavailable; tool was not submitted.");
    if (this.querySelector("#menu[open]"))
      throw Error(
        "Finish or close the human menu first; tool was not submitted.",
      );
    this.inputSource = "webmcp";
    if (this.current) {
      this.current.control = "webmcp";
      this.current.automated = true;
    }
    this.stopMovement();
    this.closePanel();
    const before = this.uncertain() ? null : this.game?.state;
    let response: Response | undefined;
    let failure: unknown;
    await this.run(async () => {
      try {
        const params = request.params as Record<string, unknown>;
        let save = this.saves.find((s) => s.id === params.sessionId);
        await this.connectRuntime(typeof params.sessionId === "string" ? params.sessionId : undefined, request.method === 'session.create');
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
              buildId: this.runtimeBuildId,
              localStore: this.storeName,
              ...(this.inputRecording?{recording:'inputs' as const}:{}),
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
              save.maxLevel = Math.max(save.maxLevel ?? 0, Number(latest.observation.vitals.level) || 0);
              save.depthLabel = latest.observation.location.depthLabel;
              save.endKind = latest.end?.kind;
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
            this.persist(save);
          }
        }
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    const entryError = response && "error" in response ? response.error : undefined;
    if ((request.method === "session.create" || request.method === "session.resume") && (failure || entryError)) reportError(failure ?? entryError?.code,this.runtimeBuildId,{kind:request.method === "session.create" ? "create" : "resume",local:!!requestedRun()?.local});
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
  private async connectRuntime(sessionId?: string, newRun = false) {
    this.assertConnected();
    if (this.api && !newRun && (!sessionId || sessionId === this.game?.id)) return;
    this.vault = playerId();
    this.indexKey = `${STORE}-${this.vault}:adventures`;
    this.readSaves();
    rememberPlayer(this.vault);
    const preferLocal = !!requestedRun()?.local;
    let buildId: string | undefined, remoteBranch: string | undefined;
    if (sessionId) {
      let saved = this.saves.find(save => save.id === sessionId);
      if (!preferLocal && !saved) {
        const remote = await restoreAdventures(this.vault);
        if (remote) { remoteBranch=remote.find(save=>save.id===sessionId)?.branch;if(!saved){this.saves = remote; saved = this.saves.find(save=>save.id===sessionId);} }
      }
      if (!saved?.buildId) throw Error("This development run has no saved runtime identity. Start a new adventure; its journal has been retained.");
      buildId = saved.buildId;
    }
    const selected = await runtimePackage(buildId, this.preloadAbort.signal);
    const inputRecording=!sessionId||this.saves.find(save=>save.id===sessionId)?.recording==='inputs';
    const saved = this.saves.find(save => save.id === sessionId);
    const storeName = sessionId
      ? saved?.localStore ?? (inputRecording ? 'neohack-run-' + sessionId : STORE + '-' + this.vault)
      : this.api && !newRun ? this.storeName : 'neohack-run-' + crypto.randomUUID();
    if (this.api && this.runtimeBuildId === selected.buildId && this.inputRecording===inputRecording && this.storeName===storeName) return;
    await this.closeRuntime();
    this.game = null; this.current = null;
    this.storeName = storeName;
    this.text('#loading-detail', 'Opening your adventure in this tab…');
    this.tabLease = await claimTabStore(storeName, this.preloadAbort.signal, () => this.yieldRun());
    try {
      this.assertConnected();
      // Speculative downloads must never gate opening the actual runtime.
      void this.warm(selected.buildId);
      this.assertConnected();
      ++this.cloudStatusGeneration;
      this.cloudEnabled = true;
      this.text("#cloud-status", "Saved here · syncing in the background");
      const sourceBranch=remoteBranch ?? this.saves.find(save=>save.id===sessionId)?.branch ?? this.saves.find(save=>save.branch)?.branch;
      const sourceUrl=new URL(journalUrl(this.vault));if(sourceBranch)sourceUrl.searchParams.set('branch',sourceBranch);
      const replica = sourceUrl.href;
      if (requestedRun() && !replica && !this.saves.some(save => save.id === requestedRun()!.id)) throw Error("The cloud save could not be reached. Retry this bookmark when connected; no new game was started.");
      this.inputRecording=inputRecording;
      const transportPackage = buildId ? await runtimePackage(undefined, this.preloadAbort.signal) : selected;
      const wasm = await this.runtime.wasm.createWasm({
        runtimeUrl: new URL(selected.base, location.href).href,
        storage: this.inputRecording?{kind:'journal',name:this.storeName,uploadUrl:new URL('/api/runs/',location.href).href,uploadToken:this.vault,archiveConfigUrl:new URL('/replay-config.json',location.href).href}:replica
          ? { kind: "indexeddb", name: this.storeName, replicaUrl: replica, replicaBranches: true, replicaRestore: !!sessionId && !preferLocal, replicaSession: sessionId }
          : { kind: "indexeddb", name: this.storeName },
        workerUrl: new URL(`${transportPackage.base}core-worker.mjs`, location.href),
        onTiming: ({stage,duration}) => reportTiming(stage,duration,'slow',this.runtimeBuildId),
        onStartup: stage => { this.entryStage=stage;this.text('#loading-detail',({ownership:'Opening your local save…',assets:'Downloading the game…',compile:'Preparing the game…',local:'Reading your local adventure…',cloud:'Downloading your saved adventure…',engine:'Starting the dungeon…',ready:'Entering your adventure…'})[stage]); },
        onReplicaStatus: async ({ state, message, branch, sessions }) => {
          if (!this.isConnected) return;
          if (state === "error" && message.includes("conflicts with remote progress")) {
            reportError(Error(message),this.runtimeBuildId);
          }
          const generation = ++this.cloudStatusGeneration;
          if (state === "saved") {
            if(branch && this.current && sessions?.includes(this.current.id)){this.current.branch=branch;this.persist();}
            this.text("#cloud-status","Saved here · online save pending");
            queueCloud(this.current ? [this.current] : [], this.vault,()=>{if(this.isConnected && generation===this.cloudStatusGeneration)this.text("#cloud-status","Saved online");});
            return;
          }
          if (generation !== this.cloudStatusGeneration) return;
          this.text("#cloud-status", state === "pending" ? "Saving online…" : state === "queued" ? "Saved here" : state === "retrying" ? "Saved here · retrying online" : "Saved here · cloud sync paused");
          this.$("#cloud-status").title = state === "error" ? message : "";
        },
      });
      this.inputTransport=this.inputRecording?wasm.transport as import('neonethack/wasm').WasmTransport:undefined;
      // Opening may finish after this element has been removed. Never adopt that
      // late worker/store owner, even if the same element was reattached meanwhile.
      try { this.assertConnected(); }
      catch (error) { await wasm.close(); throw error; }
      // A title tab may have waited while another tab updated adventure metadata.
      // Refresh only after acquiring ownership, before any request can persist it.
      try {
        const imported = this.saves.find(save => save.id === sessionId);
        this.readSaves();
        if (imported && !this.saves.some(save => save.id === sessionId)) this.saves.unshift(imported);
        const active = this.saves.find(save => save.id === sessionId);
        if (active) active.localStore = storeName;
        if (sessionId && !this.saves.length && this.cloudEnabled) {
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
            this.persist(record);
          }
          const response = await wasm.transport.send(request);
          const unresolved =
            (this.runtime.client.isSnapshot(response) &&
              response.outcome.status === "unknown") ||
            ("error" in response && response.error?.code === "incompleteRequest");
          if (record && !unresolved) {
            record.pending = undefined;
            try {
              this.persist(record);
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
        this.runtimeBuildId = selected.buildId;
        this.transferredRun = undefined;
      } catch (error) {
        await api.close();
        throw error;
      }
    } catch (error) {
      await this.closeRuntime();
      throw error;
    }
  }
  private async closeRuntime() {
    const api = this.api, lease = this.tabLease;
    this.api = null; this.tabLease = undefined;
    this.publicRecorder?.close(); this.publicRecorder = undefined; this.publicSession = '';
    this.inputTransport = undefined;
    try { await api?.close(); }
    finally { lease?.release(); }
  }
  private async yieldRun() {
    this.yielding = true;
    this.stopMovement();
    // Let the accepted input and its exact receipt finish before retiring C.
    await this.settled;
    const save = this.current;
    try {
      await this.closeRuntime();
      this.transferredRun = save?.id;
      this.game = null; this.current = null;
      if (!this.isConnected) return;
      for (const dialog of this.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close();
      this.closePanel(); this.render();
      if (save) {
        this.openMenu('<h2 id="menu-title">Playing in another tab</h2><p>This adventure moved to the tab you just opened. Your progress is saved.</p><div class="dialog-actions" id="tab-actions"></div>');
        this.$('#tab-actions').append(
          this.button('Play here', () => this.resume(save), 'primary'),
          this.button('Start a new adventure', () => this.newAdventure()));
      }
    } finally { this.yielding = false; }
  }
  disconnectedCallback() {
    this.navigationAbort?.abort();
    this.publicRecorder?.close();
    this.publicSession="";
    this.hudLayout?.disconnect();
    this.preloadAbort.abort();
    this.webMcp?.dispose();
    this.movement.stop();
    document.removeEventListener("keydown", this.keyHandler);
    document.removeEventListener("keyup", this.keyUpHandler);
    window.removeEventListener("blur", this.stopMovement);
    window.removeEventListener("account-dialog-open", this.stopMovement);
    window.removeEventListener("accountchange", this.accountChanged);
    window.removeEventListener("storage", this.storageChanged);
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    window.removeEventListener('online',this.onlineRecording);
    document.removeEventListener("focusin", this.focusChanged);
    this.stopMovement();
    this.map.destroy();
    void this.settled.finally(() => this.closeRuntime());
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
    reportError(error, this.runtimeBuildId);
    const message = error instanceof Error ? error.message : String(error);
    this.text("#error", message.includes("Another worker or tab owns this WASM store")
      ? "An older game tab is still holding this save. Reload that tab once to enable automatic handoff. New adventures can already run independently."
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
    this.$("#navigation-stop").onclick=()=>this.navigationAbort?.abort();
    this.$("#close-panel").onclick = () => {
      this.closePanel();
      this.$("#dungeon").focus();
    };
    this.$('#copy-embed').addEventListener('click',()=>void (async()=>{
      this.stopMovement();
      const id=this.game?.state.sessionId;
      if(!id){this.openMenu('<h2>Start a run first</h2><p>An embed needs a recorded adventure.</p>');return;}
      const saved=await this.publicRecorder?.flush();
      const code=embedCode(id,this.publicRecorder instanceof InputReplayRecorder?this.publicRecorder.manifest:undefined);
      try {if(!saved)throw Error();await navigator.clipboard.writeText(code);this.$('#copy-embed').textContent='Embed copied';}
      catch {this.openMenu('<h2>Run embed</h2><p>'+ (saved?'Copy this code into your page.':'This replay is still saved locally. Its embed becomes available after online backup finishes.') +'</p><textarea id="embed-code" readonly aria-label="Embed code" style="width:100%;min-height:140px"></textarea>');const field=this.querySelector<HTMLTextAreaElement>('#embed-code')!;field.value=code;field.select();}
    })());
    this.$(".hud-menu").addEventListener("toggle", () => {
      if (this.querySelector(".hud-menu[open]")) this.stopMovement();
    });
    (this.$("#fullscreen-button") as HTMLButtonElement).disabled =
      !document.fullscreenEnabled;
    this.$("#sound-button").onclick = async () => {
      const button = this.$("#sound-button") as HTMLButtonElement;
      if (this.map.sound.enabled) this.map.sound.disable();
      else {
        button.disabled = true;
        button.textContent = "Loading sound…";
        try { await this.map.sound.enable(); }
        catch { this.map.sound.disable(); this.error(Error("Sound could not start. Try enabling it again.")); }
        finally { button.disabled = false; }
      }
      button.textContent = this.map.sound.enabled ? "Sound: on" : "Sound: off";
      button.setAttribute("aria-pressed", String(this.map.sound.enabled));
    };
    this.$("#fullscreen-button").onclick = () => {
      const task = document.fullscreenElement
        ? document.exitFullscreen()
        : this.requestFullscreen();
      void task.catch((e) => this.error(e));
    };
    this.$("#abandon-run").onclick = () => {
      if (!this.playable()) return;
      this.querySelector<HTMLDetailsElement>(".hud-menu")!.open = false;
      this.stopMovement();
      void this.run(() => this.game!.quit());
    };
    this.$("#text-map-button").onclick = () => {
      this.panel = "surroundings";
      this.renderPanel();
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
    this.$("#pickup-settings").onclick = () => this.openPickupSettings();
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
    this.$("#enter-gate").onclick = () => this.walkToEntrance();
    this.$("#new-adventure").onclick = () => this.walkToEntrance();
    this.$("#continue-adventure").onclick = () =>
      this.resume(this.saves.find((s) => !s.ended)!);
    this.$("#adventures-button").onclick = () => this.adventures();
    this.$("#more-actions").onclick = () => this.more();
    this.$("#more-actions").setAttribute("aria-label", "More actions");
    this.$("#credits-button").onclick = () => this.credits();
    this.$("#encyclopedia-button").onclick = () => {
      if (!this.game) return;
      const book = encyclopedia(this.game);
      this.openMenu('');
      this.$('#menu-content').append(book);
      book.querySelector<HTMLInputElement>('input')!.focus();
    };
    this.$("#zoom-in").onclick = () => {
      this.map.zoomTo(this.map.zoom + 1);
    };
    this.$("#zoom-out").onclick = () => {
      this.map.zoomTo(this.map.zoom - 1);
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
    const scroll = this.querySelector<HTMLDialogElement>("#journal-scroll")!;
    this.$("#close-scroll").onclick = this.$("#finish-scroll").onclick = () => scroll.close();
    scroll.addEventListener("close", () => this.controls());
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
      !this.yielding &&
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
  private entryStage = "preparation";
  private run(action: () => Promise<unknown>, entry?: { name: string; role: string; resume?: boolean; sessionId?:string }) {
    if (this.busy || this.yielding) return Promise.resolve();
    const result = this.performRun(action,entry);
    this.settled = result.catch(() => {});
    return result;
  }
  private async performRun(action: () => Promise<unknown>, entry?: { name: string; role: string; resume?: boolean; sessionId?:string }) {
    if (this.busy) return;
    const started=performance.now();
    this.entryStage='preparation';
    const slow=entry?setTimeout(()=>reportTiming(this.entryStage,performance.now()-started,'slow',this.runtimeBuildId),10000):undefined;
    this.closeTile();
    const game = this.game;
    const before = this.uncertain() ? null : game?.state;
    this.navigationNotice="";
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
      if(entry) { reportError(e,this.runtimeBuildId,{kind:entry.resume?"resume":"create",local:!!requestedRun()?.local}); this.entryRecovery(entry.sessionId,e); }
      this.error(e);
    } finally {
      clearTimeout(slow);
      if(entry || performance.now()-started>250)reportTiming(entry?this.entryStage:'action',performance.now()-started,completed?'complete':'failed',this.runtimeBuildId);
      // A discovery call, rejected start or agent session.close can finish on
      // the title screen. Retire its transport too, so no invisible worker
      // keeps the whole origin's save store locked while this client is idle.
      if (!this.game) {
        try { await this.closeRuntime(); }
        catch (error) { this.error(error); }
      }
      if (this.game && this.current) {
        this.recordReplays();
        this.enrich(this.current);
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
      const openingPassage=this.journal.find(journalScroll);
      if (completed && entry && !entry.resume && this.game && !this.game.decision && openingPassage)
        this.openJournalScroll(openingPassage);
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
  private enrich(save: Adventure) {
    const game = this.game;
    if (!game) return;
    const o = game.observation;
    const end = game.state.end;
    const level = Number(o.vitals.level) || 0;
    const gold = Number(o.vitals.gold);
    const xp = o.vitals.experience ?? o.vitals.xp;
    const kills = o.knowledge?.conduct?.kills;
    const fromLabel = Number((o.location.depthLabel.match(/(\d+)/) || [])[1]) || 0;
    const fromMemory = Math.max(0, ...(o.knowledge?.levels ?? []).map((l) => l.depth));
    const gotAmulet =
      end?.kind === "ascended" ||
      (o.knowledge?.achievements ?? []).some(
        (a) => /amulet/i.test(a.id) || /amulet/i.test(a.name),
      );
    const control: PlayControl =
      save.control === "webmcp" || this.inputSource === "webmcp"
        ? "webmcp"
        : location.pathname.startsWith("/bots")
          ? "playground"
          : this.inputSource;
    void this.accountUser.then((user) => {
      if (user?.id && save.id === this.current?.id) save.accountId = user.id;
    });
    save.vaultId = this.vault;
    save.actualClass = save.role;
    save.turn = o.turn;
    save.ended = game.state.ended;
    save.heroLevel = level || save.heroLevel;
    save.maxLevel = Math.max(save.maxLevel ?? 0, level);
    save.maxDepth = Math.max(save.maxDepth ?? 0, fromLabel, fromMemory);
    save.depthLabel = o.location.depthLabel;
    if (Number.isFinite(gold)) save.gold = gold;
    if (typeof kills === "number") save.kills = kills;
    if (xp !== undefined && Number.isFinite(Number(xp))) save.experience = Number(xp);
    save.gotAmulet = save.gotAmulet || gotAmulet;
    save.endKind = end?.kind ?? save.endKind;
    if (typeof end?.score === "number") save.score = end.score;
    save.control = control;
    save.automated = control !== "manual";
  }
  private persist(save = this.current) {
    if (!this.metadataHealthy)
      throw Error(
        "Adventure metadata is unavailable; the stored list has not been overwritten.",
      );
    if (save) writeAdventure(this.indexKey, save);
    if (this.cloudEnabled && save) {
      queueCloud([save],this.vault);
    }

  }
  private controls() {
    this.show("#navigation-status",!!this.navigationAbort || !!this.navigationNotice);
    this.text("#navigation-status-text",this.navigationNotice || "Walking…");
    this.show("#navigation-stop",!!this.navigationAbort);
    this.$("#pickup-settings").hidden = !this.game;
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
    this.querySelectorAll<HTMLButtonElement>("[data-game][data-action]").forEach(button => {
      const reason = this.actionUnavailable(button.dataset.action!);
      button.disabled ||= !!reason;
      button.title = reason;
    });
    this.querySelectorAll<HTMLButtonElement>("[data-choice]").forEach(
      (b) => (b.disabled = this.busy || this.uncertain() || b.dataset.emptySelection === "true"),
    );
    for (const id of [
      "new-adventure",
      "enter-gate",
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
      (b) => (b.disabled = this.busy || !!b.dataset.unavailable),
    );
    this.setAttribute("aria-busy", String(this.busy));
    this.renderStairs();
  }
  private render() {
    const state = this.game?.state;
    this.renderGround();
    this.show("#welcome-copy", !state);
    this.show("#welcome-actions", !state);
    this.show("#enter-gate", !state);
    this.show("#welcome-paths", !state);
    this.show("#bookmark-hint", !!state);
    this.show("#abandon-run", !!state && !state.ended);
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
      renderHeroHud(this,o);
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
        // Use the complete receipt, including blank text-window lines. The
        // observation's heard list is only a rolling ten-line preview.
        appendReceipt(this.journal, state, this.lastFrame ? actionMessages(state) : o.heard);
        this.lastFrame = frameKey;
      }
      this.text(
        "#latest-message",
        actionMessages(state).at(-1) ??
          o.heard.at(-1) ??
          "Take a moment. Your next step is yours to choose.",
      );
      const recent = this.$("#recent-messages");
      recent.replaceChildren();
      for (const entry of this.journal.slice(-3)) {
        const p = document.createElement("p");
        this.appendJournalContent(p, entry);
        recent.append(p);
      }
      const status = state.outcome.status;
      this.text(
        "#inspect-text",
        status === "interrupted"
          ? "Interrupted. Continue only if you choose the activity again."
          : status === "blocked"
            ? `No progress${state.outcome.reason ? ` · ${state.outcome.reason}` : ""}. You can choose a different action.`
            : state.decision
              ? "A choice is waiting. The dungeon will wait for your answer."
              : this.navigationNotice || "Explore at your own pace. Click a tile to inspect or plan a walk.",
      );
      const lines = Array.from({ length: 21 }, () =>
        Array<string>(80).fill(" "),
      );
      const terrain: Record<string, string> = {
        wall: "|",
        floor: ".",
        corridor: "#",
        stairsUp: "<",
        stairsDown: ">",
        closedDoor: "+",
        openDoor: "/",
        fountain: "{",
        trap: "^",
        water: "~",
        lava: "~",
        altar: "_",
        sink: "#",
        grave: "|",
        throne: "\\",
        tree: "#",
      };
      const walls = new Set(o.world.filter(cell => cell.terrain.type === "wall").map(cell => `${cell.x},${cell.y}`));
      for (const cell of o.world)
        if (lines[cell.y] && cell.x >= 0 && cell.x < 80)
          lines[cell.y]![cell.x] =
            cell.occupant?.mark ??
            cell.objects?.[0]?.mark ??
            (cell.terrain.type === "wall" && (walls.has(`${cell.x - 1},${cell.y}`) || walls.has(`${cell.x + 1},${cell.y}`)) ? "-" : terrain[cell.terrain.type]) ??
            " ";
      this.text("#map-text", lines.map((row) => row.join("")).join("\n"));
      const near = o.you ? Array.from({ length: 9 }, (_, row) =>
        Array.from({ length: 15 }, (_, col) => lines[o.you!.y + row - 4]?.[o.you!.x + col - 7] ?? " ").join("")
      ).join("\n") : "";
      this.text("#nearby-ascii", near);
      this.show("#ended", state.ended);
      if (state.ended && this.$('#ended').dataset.session !== state.sessionId) {
        const ended=this.$('#ended');ended.dataset.session=state.sessionId;
        ended.innerHTML = '<strong>This chapter has ended.</strong><p>'+escape(state.end?.cause ?? state.end?.kind ?? 'Your adventure is over.')+' · Turn '+o.turn+'. Your journal is still here. Start another chapter from Your adventures.</p><div id="death-replay"></div><div class="replay-sharing"><button id="death-copy-embed">Copy embed</button><button id="death-copy-link">Copy replay link</button><a id="death-replay-link">Open replay ↗</a></div><p id="death-share-status" role="status">Loading the recorded journey…</p><textarea id="death-share-code" readonly hidden aria-label="Share replay"></textarea>';
        const id=state.sessionId;
        const viewer=document.createElement('neohack-world');viewer.setAttribute('controls','');viewer.setAttribute('autoplay','');viewer.setAttribute('speed','4');
        this.$('#death-replay').append(viewer);
        const link=this.querySelector<HTMLAnchorElement>('#death-replay-link')!;link.href=replayLink(id);link.target='_blank';link.rel='noopener';
        const copy=async(text:string)=>{try{await navigator.clipboard.writeText(text);this.text('#death-share-status','Copied. Ready to share.');}catch{const field=this.querySelector<HTMLTextAreaElement>('#death-share-code');if(field){field.hidden=false;field.value=text;field.select();}}};
        this.$('#death-copy-embed').onclick=()=>void copy(embedCode(id));
        this.$('#death-copy-link').onclick=()=>void copy(replayLink(id));
        // The final observation is queued by the operation before this microtask.
        void Promise.resolve().then(async()=>{
          await this.publicRecorder?.flush();
          if(!viewer.isConnected)return;
          viewer.setAttribute('src',replayLink(id));
          this.text('#death-share-status','Share this read-only replay. Recording may begin partway through the run.');
        });
      }
      if(!state.ended){this.$('#ended').replaceChildren();delete this.$('#ended').dataset.session;}
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
      this.$("#ended").replaceChildren();delete this.$("#ended").dataset.session;
    }
    this.map.positionCursor = state?.decision?.kind === "position" ? state.decision.cursor : null;
    this.map.update(
      state?.observation ?? null,
      heroArt(this.current?.role),
      `${this.current?.seed ?? this.current?.id ?? 0}:${state?.observation.location.id ?? "threshold"}`,
      state,
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
    this.$(".rightbar").classList.toggle("character-panel", this.panel === "inventory");
    this.$(".rightbar").setAttribute("aria-label", this.panel === "inventory" ? "Character sheet" : "Field notes");
    const body = this.$("#panel-body");
    const o = this.game?.observation;
    this.show("#accessible-map", !!o && this.panel === "surroundings");
    this.text(
      "#panel-heading",
      {
        inventory: "Your adventurer",
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
      const settings = this.button("Automatic pickup · " + (o.automaticPickup ? pickupSummary(o.automaticPickup) : "Unavailable"), () => this.openPickupSettings(), "pickup-shortcut");
      settings.disabled = !this.playable() || !o.automaticPickup;
      this.text(
        "#panel-count",
        o.inventoryKnown ? `${o.inventory.length} ITEMS` : "UNKNOWN",
      );
      const sheetGame=this.game!, sheetRevision=sheetGame.state.revision;
      body.append(renderCharacterSheet(o, {
        name: this.current?.name ?? 'Adventurer',
        role: roles.find(r=>r.id===this.current?.role)?.title.replace('The ','') ?? 'Adventurer',
        portrait: '/art/'+heroArt(this.current?.role)+'.png',
        equip: (item,action,slot)=>{if(this.game===sheetGame && sheetGame.state.revision===sheetRevision && this.playable())this.action(action,item,slot);},
        inspect: item=>this.itemDetails(item),
        actions: (host,item)=>this.appendItemActions(host,item,true),
      }));
      body.append(settings);
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
        p.innerHTML = `<small>TURN ${entry.turn}${entry.lastTurn !== entry.turn ? `–${entry.lastTurn}` : ""}</small>`;
        this.appendJournalContent(p, entry);
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
  private appendJournalContent(host: HTMLElement, entry: JournalEntry) {
    renderJournalEntry(host, entry, entry=>this.openJournalScroll(entry));
  }
  private openJournalScroll(entry: {turn: number; text: string}) {
    this.stopMovement();
    this.text("#scroll-turn", "TURN " + entry.turn);
    this.text("#scroll-text", entry.text);
    const dialog = this.querySelector<HTMLDialogElement>("#journal-scroll")!;
    if (!dialog.open) dialog.showModal();
    this.controls();
  }
  private climbLabel(direction: "up" | "down") {
    return direction === "down" ? "Go downstairs" : this.game?.observation.location.depthLabel.trim() === "Dlvl:1" ? "Leave" : "Go upstairs";
  }
  private renderStairs() {
    const host = this.$("#contextual-stairs");
    host.replaceChildren();
    this.show("#contextual-stairs", false);
    const game = this.game, n = game?.observation.neighborhood;
    if (!game || !this.playable() || n?.status !== "available" || n.inputGate.state !== "ready" || n.basis.revision !== game.state.revision) return;
    const here = n.cells.find(cell => cell.movement.relation === "here");
    for (const offer of here?.actions ?? []) {
      const water = here?.terrain?.freshness === "current" && ["fountain", "sink"].includes(here.terrain.type);
      if (offer.availability !== "attemptable" || (offer.method !== "game.climb" && offer.method !== "game.loot" && !(water && offer.method === "game.drink"))) continue;
      const revision = n.basis.revision;
      const button = this.button(offer.method === "game.climb" ? this.climbLabel(offer.arguments.direction) : offer.method === "game.loot" ? "Open container" : `Drink from ${here!.terrain!.type}`, () => {
        if (this.game !== game || !this.playable() || game.state.revision !== revision) return;
        this.stopMovement();
        void this.run(() => this.executeOffer(game, offer, revision));
      });
      if (offer.method === "game.climb") button.dataset.direction = offer.arguments.direction;
      host.append(button);
    }
    for (const cell of n.cells.filter(c => c.movement.relation === "adjacent" && c.terrain?.freshness === "current")) {
      for (const offer of cell.actions) {
        if ((offer.method !== "game.open" && offer.method !== "game.close") || offer.availability !== "attemptable") continue;
        const revision = n.basis.revision;
        const label = offer.method === "game.open" ? "Open door" : "Close door";
        const button = this.button(label + " · " + offer.arguments.target?.direction, () => {
          if (this.game !== game || !this.playable() || game.state.revision !== revision) return;
          this.stopMovement();
          void this.run(() => this.executeOffer(game, offer, revision));
        });
        host.append(button);
      }
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
        inventoryArt(item) +
        '"><span>' +
        escape(item.label) +
        "</span><small>Take</small>";
      button.setAttribute("aria-label", "Pick up " + item.label);
      button.disabled = !this.playable();
      list.append(button);
    }
  }
  private closeTile() {
    this.inspectionVersion++;
    this.map.route=[];
    this.map.draw();
    if (!this.tilePanel) return;
    const focused = this.tilePanel.contains(document.activeElement);
    this.tilePanel.remove();
    this.tilePanel = null;
    if (focused) (this.querySelector("#dungeon") as HTMLElement)?.focus();
  }
  private async inspectTile(x: number, y: number, obstruction = false, walkImmediately = false) {
    this.closeTile();
    this.movement.stop();
    const game = this.game,
      n = game?.observation.neighborhood;
    if (!game || this.busy || n?.status !== "available") return;
    const inspection=this.inspectionVersion, capturedRevision=game.state.revision;
    let cell = n.cells.find((c) => c.x === x && c.y === y);
    if(!cell && x>=1 && x<=79 && y>=0 && y<=20){
      try { cell=(await game.actions({x,y},{expectedRevision:capturedRevision})).cell; }
      catch(error){if(this.inspectionVersion===inspection)this.text("#inspect-text",String(error));return;}
    }
    if (!cell || this.inspectionVersion!==inspection || this.game!==game || this.busy || game.state.revision!==capturedRevision) return;
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
            ? "Select a known walking route, or inspect nearby actions."
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
      loot: "Open container",
      eat: "Eat…", drink: "Drink…", wield: "Wield…", equip: "Wear…", remove: "Remove…", read: "Read…", drop: "Drop…", zap: "Zap…",
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
          : offer.method === "game.climb" && offer.arguments ? this.climbLabel(offer.arguments.direction) : (labels[offer.key] ?? offer.key),
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
    if (!obstruction && cell.inBounds && cell.movement.relation !== "here" && !game.decision) {
      const walk=this.button("Checking route…",()=>{},"primary");
      walk.disabled=true;
      const routeText=document.createElement("p");routeText.className="subtle";
      routeText.setAttribute("role","status");
      panel.querySelector(".tile-buttons")!.prepend(walk);
      panel.append(routeText);
      void game.route({x,y},{expectedRevision:revision}).then(route=>{
        if(this.tilePanel!==panel || this.game!==game || game.state.revision!==revision)return;
        walk.textContent="Walk here";
        if(route.distance!==null && !occupant)panel.querySelector("p")!.hidden=true;
        walk.disabled=route.distance===null || !this.playable();
        routeText.textContent=route.distance===null?"No known walking route. Adjacent attempts remain available.":
          route.distance+" known steps · avoids known hazards. Pauses on changes or choices.";
        this.map.route=route.steps;this.map.draw();
        walk.onclick=()=>{
          if(!this.playable() || this.game!==game || game.state.revision!==revision)return;
          this.stopMovement();
          const controller=new AbortController();this.navigationAbort=controller;
          void this.run(async()=>{
            try {
              this.map.route=route.steps;
              const result=await game.go({to:{x,y},signal:controller.signal,onStep:frame=>{
                this.recordReplays();this.render();
                const at=route.steps.findIndex(p=>p.x===frame.observation.you?.x&&p.y===frame.observation.you?.y);
                this.map.route=at<0?[]:route.steps.slice(at+1);this.map.draw();
              }});
              this.navigationNotice=result.reason==="arrived"?"":"Walking stopped: "+result.reason+".";
            } finally {
              if(this.navigationAbort===controller)this.navigationAbort=null;
              this.map.route=[];this.map.draw();
            }
          });
        };
        if(walkImmediately && !walk.disabled)walk.click();
      }).catch(error=>{
        if(this.tilePanel===panel){walk.textContent="Route unavailable";routeText.textContent=String(error);}
      });
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
      case "game.loot":
        return game.loot(options);
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
      case "game.eat":
        return game.eat(offer.arguments.item, options);
      case "game.drink":
        return game.drink(offer.arguments.item, options);
      case "game.wield":
        return game.wield(offer.arguments.item, options);
      case "game.equip":
        return game.equip(offer.arguments.item, options);
      case "game.remove":
        return game.remove(offer.arguments.item, options);
      case "game.read":
        return game.read(offer.arguments.item, options);
      case "game.drop":
        return game.drop(offer.arguments.item, options);
      case "game.zap":
        return game.zap(offer.arguments.item, undefined, options);
      case "game.search":
        return game.search(options);
      case "game.wait":
        return game.wait(options);
      case "game.climb":
        return game.climb(offer.arguments.direction, options);
    }
  }
  private pickupMemoryNotice() {
    this.text("#error", "Automatic pickup is configured for this adventure, but preferences could not be remembered for future runs.");
    this.show("#error", true);
  }
  private openPickupSettings() {
    const game = this.game;
    if (!game?.observation.automaticPickup || !this.playable()) return;
    const revision = game.state.revision;
    const editor = pickupEditor(game.observation.automaticPickup, loadPickupPreferences().rememberable);
    this.openMenu('<h2 id="menu-title">Automatic pickup</h2><form id="pickup-settings-form"></form>');
    const form = this.querySelector<HTMLFormElement>("#pickup-settings-form")!;
    const footer = document.createElement("footer"); footer.className = "dialog-actions";
    const save = document.createElement("button"); save.type = "submit"; save.className = "primary";
    save.textContent = "Save settings"; save.dataset.game = "";
    const cancel = this.button("Cancel", () => this.closeMenu(), "secondary"); cancel.type = "button";
    footer.append(save, cancel); form.append(editor.element, footer);
    form.onsubmit = e => {
      e.preventDefault();
      if (this.game !== game || this.busy) return;
      const settings = editor.value();
      void this.run(async () => {
        await game.configurePickup(settings, {expectedRevision:revision});
        this.closeMenu();
        if (!rememberPickup(settings)) this.pickupMemoryNotice();
      });
    };
  }
  private openMenu(html: string, preservePanel = false) {
    this.closeTile();
    this.stopMovement();
    if (!preservePanel) this.closePanel();
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
      `<h2 id="menu-title">Every story needs an adventurer.</h2><p class="subtle">Choose a starting path. The rest is up to you.</p><form id="create-form"><div class="create-fields"><label class="field-label" for="adventurer-name">YOUR NAME</label><div class="adventurer-name-field"><input id="adventurer-name" name="name" required maxlength="24" autocomplete="off" placeholder="What should we call you?" value="${adventurerName()}"><button type="button" id="generate-adventurer-name" title="Suggest another name" aria-label="Generate another adventurer name">↻</button></div><fieldset class="class-picker"><legend>YOUR STARTING PATH · ${roles.length} CLASSES</legend>${roles.map((r, i) => `<label class="role-card"><input type="radio" name="role" value="${r.id}" ${i === 0 ? "checked" : ""}><img src="/art/${r.art}.png" alt=""><span><strong>${r.title}${i === 0 ? "<small>FIRST ADVENTURE PICK</small>" : ""}</strong><span>${r.description}</span></span></label>`).join("")}</fieldset><details class="seed-details"><summary>Choose a world seed (optional)</summary><label for="world-seed">A number for a repeatable starting world</label><input id="world-seed" name="seed" type="number" min="0" max="4294967295" step="1" placeholder="Surprise me"></details><p class="save-explanation">Progress is saved on this browser and address. Clearing site data deletes it. Each life is an adventure of its own.</p></div><footer class="create-footer"><button data-operation class="primary" type="submit">Enter the dungeon →</button></footer></form>`,
    );
    const form = this.querySelector<HTMLFormElement>("#create-form")!;
    this.$("#generate-adventurer-name").onclick = () => {
      const input=this.querySelector<HTMLInputElement>("#adventurer-name")!;
      input.value=adventurerName(input.value);input.setCustomValidity("");input.focus();input.select();
    };
    const preferences = loadPickupPreferences();
    const pickup = pickupEditor(preferences.settings, preferences.rememberable);
    const details = document.createElement("details"); details.className = "pickup-creation";
    const summary = document.createElement("summary");
    const updateSummary = () => { summary.textContent = "Automatic pickup · " + pickupSummary(pickup.value()); };
    details.append(summary, pickup.element); updateSummary();
    details.addEventListener("change", updateSummary); details.addEventListener("click", () => queueMicrotask(updateSummary));
    form.querySelector(".seed-details")!.before(details);
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
        await this.connectRuntime(undefined, true);
        const automaticPickup = pickup.value();
        this.game = await this.api!.create({ ...role.identity, name, seed, automaticPickup });
        if (!rememberPickup(automaticPickup)) this.pickupMemoryNotice();
        this.inputSource = "manual";
        this.current = {
          id: this.game.id,
          buildId: this.runtimeBuildId,
          localStore: this.storeName,
          ...(this.inputRecording?{recording:'inputs' as const}:{}),
          vaultId: this.vault,
          name,
          role: role.id,
          actualClass: role.id,
          randomClass: false,
          seed,
          seedSpecified: Boolean(inputSeed),
          turn: this.game.observation.turn,
          ended: false,
          control: "manual",
          automated: false,
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
  private openLocalCopy(id:string) {
    const url=new URL(location.href);url.hash=new URLSearchParams({run:id,vault:this.vault,local:"1"}).toString();
    location.replace(url.href);location.reload();
  }
  private entryRecovery(id?:string,error?:unknown) {
    if (id && /other tab|worker or tab owns/.test(String(error))) {
      this.openMenu('<h2 id="menu-title">Waiting for the other tab</h2><p>That tab has not released this adventure yet. You can try again or play a different adventure here.</p><div class="dialog-actions" id="tab-actions"></div>');
      const save = this.saves.find(save => save.id === id);
      if (save) this.$('#tab-actions').append(this.button('Play here',()=>this.resume(save),'primary'));
      this.$('#tab-actions').append(this.button('Start a new adventure',()=>this.newAdventure()));
      return;
    }
    if(!id || requestedRun()?.local)return;
    this.openMenu('<h2 id="menu-title">Return to your local adventure</h2><p>Online recovery could not open this run. Try the copy stored in this browser, with automatic background backup. Its original engine and save checks still apply.</p><p>Your cloud copy and pending upload will be kept.</p><div id="entry-recovery"></div>');
    this.$("#entry-recovery").append(this.button("Open local copy",()=>this.openLocalCopy(id),"primary"));
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
      await this.connectRuntime(save.id);
      this.game = await this.api!.resume(save.id);
      this.current = this.saves.find((record) => record.id === save.id) ?? save;
      this.saves = [this.current, ...this.saves.filter(record => record.id !== save.id)];
      this.journal = [];
      this.lastFrame = "";
      this.map.center();
      this.$("#dungeon").focus();
    }, { name: save.name, role: save.role, resume: true, sessionId:save.id });
  }
  private async returnToDoorway() {
    await this.game?.close();
    this.game = null;
    this.current = null;
    await this.closeRuntime();
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
  private actionUnavailable(name: string) {
    const n = this.game?.observation.neighborhood;
    if (n?.status !== "available" || n.basis.revision !== this.game?.state.revision) return "";
    const offer = n.cells.find(cell => cell.dx === 0 && cell.dy === 0)?.actions.find(offer => offer.key === name);
    if (offer?.availability !== "knownBlocked") return "";
    return offer.reason === "noPerceivedContainers" ? "No container underfoot" : offer.reason === "noPerceivedItems" ? "No eligible items available" : offer.reason === "noKnownTools" ? "No tools in your pack" : "Unavailable here";
  }
  private explainPrayer() {
    this.openMenu('<h2 id="menu-title">Prayer is a plea for help.</h2><p>Your deity may help with serious trouble, including hunger or low health. Prayer takes time, and help is not guaranteed.</p><p>Praying too often or displeasing your deity can bring punishment. This interface cannot tell whether prayer is safe. A glow means you are in trouble, not that your deity is ready.</p><p class="subtle">Continue to the dungeon’s own confirmation, or return without taking a turn.</p><div class="more-grid" id="prayer-actions"></div>');
    this.$("#prayer-actions").append(this.button("Continue to prayer", () => {
      this.prayerExplained = true;
      try { localStorage.setItem("neonethack-prayer-explained", "yes"); } catch { /* Optional help preference; never blocks play. */ }
      this.action("pray");
    }), this.button("Not now", () => this.closeMenu()));
  }
  private action(name: string, item?: ItemRef, slot?: import("neonethack/types").EquipmentSlot) {
    this.movement.stop();
    if (!this.playable() || this.actionUnavailable(name)) return;
    if (name === "pray" && !this.prayerExplained) { this.explainPrayer(); return; }
    const g = this.game!,
      ref = item ? { id: item.id } : undefined,
      options = { expectedRevision: g.state.revision };
    const actions: Record<string, () => Promise<Snapshot>> = {
      wait: () => g.wait(),
      search: () => g.search(),
      pickup: () => g.pickup(ref, options),
      eat: () => g.eat(ref, options),
      drink: () => g.drink(ref, options),
      open: () => g.open(),
      close: () => g.closeDoor(),
      kick: () => g.kick(),
      up: () => g.climb("up"),
      down: () => g.climb("down"),
      pray: () => g.pray(),
      loot: () => g.loot(options),
      read: () => g.read(ref, options),
      apply: () => g.apply(ref, options),
      wield: () => g.wield(ref, options),
      equip: () => g.equip(ref, { ...options, slot }),
      remove: () => g.remove(ref, options),
      drop: () => g.drop(ref, options),
      zap: () => g.zap(ref, undefined, options),
      throw: () => g.throw(ref, undefined, options),
      offer: () => g.offer(ref, options),
      dip: () => g.dip(ref, options),
      rub: () => g.rub(ref, options),
      invoke: () => g.invoke(ref, options),
      quiver: () => g.quiver(ref, options),
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
      open: "Open a door",
      loot: "Open container",
      pray: "Pray",
    })) {
      const b = this.button(label, () => this.action(action));
      const reason = this.actionUnavailable(action);
      b.disabled = !!reason;
      b.title = reason;
      if (reason) { const hint = document.createElement("small"); hint.textContent = reason; b.append(hint); }
      b.dataset.unavailable = reason;
      b.dataset.operation = "";
      this.$("#more-grid").append(b);
    }
  }
  private itemDetails(item: ItemRef) {
    this.openMenu(
      `<div class="large-item-icon" aria-hidden="true"><img src="${inventoryArt(item)}" alt=""></div><h2 id="menu-title">${escape(item.label)}</h2><p class="subtle">${escape(item.location === "here" ? "At your feet" : equipmentDescription(item))}${item.usage?.length ? ` · ${escape(item.usage.join(", "))}` : ""}</p><p>Choose what you’d like to try. The dungeon decides what is possible.</p><div class="more-grid" id="item-actions"></div>`,
      !this.$(".rightbar").hidden,
    );
    this.appendItemActions(this.$("#item-actions"), item);
  }
  private appendItemActions(host: HTMLElement, item: ItemRef, compact = false) {
    const game = this.game!, revision = game.state.revision;
    const labels: Record<string, string> = {pickup: "Pick up", eat: "Eat", equip: "Wear", remove: "Remove", apply: "Use", drink: "Drink", read: "Read", zap: "Zap", wield: "Wield", drop: "Drop", throw: "Throw", offer: "Offer", dip: "Dip", rub: "Rub", invoke: "Invoke", quiver: "Ready in quiver"};
    // Presentation priority only: eligibility remains the engine's candidate list.
    const preferred: Record<string,string> = {food:'eat',potion:'drink',scroll:'read',spellbook:'read',wand:'zap',armor:'equip',ring:'equip',amulet:'equip',weapon:'wield',tool:'apply'};
    const primary = item.equipmentSlots?.some(slot=>!['weapon','offhand','alternateWeapon','quiver'].includes(slot)) ? 'remove' : preferred[item.category];
    const candidates = (item.actions ?? []).filter(action=>!compact || action===primary || action==='drop');
    for (const action of candidates) {
      const button = this.button(labels[action]!, () => {
        if (this.game !== game || game.state.revision !== revision || !this.playable()) return;
        this.action(action, item);
      });
      button.disabled = !this.playable();
      button.dataset.operation = "";
      button.dataset.itemAction = action;
      if (compact) { button.innerHTML = actionIcon(action); button.title = labels[action]!; }
      button.setAttribute("aria-label", labels[action] + " " + item.label);
      host.append(button);
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
    if (d.kind === "position" || (d.kind === "target" && d.allowedTargets.includes("direction"))) {
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
      const answer = (direction: string) => void this.run(() => this.game!.answer(d.id, d.kind === "position" ? { kind: "position", position: direction as Compass } : { kind: "target", target: { direction: direction as Compass } }));
      directions.forEach(([direction, glyph], index) => {
        const button = this.button(glyph, () => answer(direction));
        button.setAttribute("aria-label", direction);
        button.dataset.targetDirection = direction;
        button.style.gridArea = String(Math.floor((index < 4 ? index : index + 1) / 3) + 1) + " / " + String((index < 4 ? index : index + 1) % 3 + 1);
        target.querySelector(".target-arrows")!.append(button);
      });
      const extra = target.querySelector(".target-extra")!;
      if (d.kind === "position") {
        target.querySelector("p")!.textContent += ` · cursor ${d.cursor.x}, ${d.cursor.y}`;
        const messages = document.createElement("details");
        const summary = document.createElement("summary"); summary.textContent = "Map instructions and messages";
        messages.append(summary);
        for (const event of this.game!.state.events) if (event.type === "heard") { const p = document.createElement("p"); p.textContent = event.text; messages.append(p); }
        messages.style.maxHeight = "30vh"; messages.style.overflow = "auto";
        target.append(messages);
        extra.append(this.button("Help (?)", () => void this.run(() => this.game!.answer(d.id, { kind: "position", position: "help" }))));
        extra.append(this.button(d.mode === "browse" ? "Done" : "Select", () => void this.run(() => this.game!.answer(d.id, { kind: "position", position: "finish" }))));
      } else for (const direction of ["up", "down"]) extra.append(this.button(direction === "up" ? "Above" : "Below", () => answer(direction)));
      if (d.kind === "target" && d.allowedTargets.includes("self")) extra.append(this.button("Myself", () => void this.run(() => this.game!.answer(d.id, { kind: "target", target: "self" }))));
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
    const potionNickname = d.kind === "text" && d.purpose === "consumedPotionNickname";
    this.text(
      "#decision-title",
      potionNickname ? "Give this potion a nickname" : (
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
      potionNickname ? "You aren’t sure what the potion did. Give it a nickname, or generate one." : d.about ?? "The dungeon is waiting for your answer.",
    );
    const body = this.$("#decision-body");
    body.replaceChildren();
    const footer = this.$("#decision-footer"); footer.replaceChildren();
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
    if (d.action === "loot") {
      this.text("#decision-title", "At the container");
      const state = this.game!.state;
      const narration = state.outcome.action === "loot"
        ? state.events.filter(event => event.type === "heard" && event.text.trim()) : [];
      if (narration.length) {
        const notes = document.createElement("details");
        notes.className = "container-notes";
        notes.setAttribute("aria-label", "Container details");
        const summary = document.createElement("summary");
        summary.textContent = "Inspection messages"; notes.append(summary);
        for (const event of narration) {
          if (event.type !== "heard") continue;
          const line = document.createElement("p");
          line.textContent = event.text;
          notes.append(line);
        }
        body.append(notes);
      }
    }
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
    } else if (d.kind === "choice" && d.containerPhase === "transfer") {
      this.text("#decision-title", "Container & backpack");
      const form = document.createElement("form");
      form.className = "container-transfer";
      form.id = "container-transfer-form";
      const help = document.createElement("p");
      help.className = "subtle";
      help.textContent = "Select items to transfer. Taking happens first; warnings still ask for your answer.";
      form.append(help);
      const columns = document.createElement("div");
      columns.className = "container-columns";
      const inputs: { input: HTMLInputElement; id: number; transfer: "take" | "put" }[] = [];
      const summary = document.createElement("p");
      summary.setAttribute("aria-live", "polite");
      const submit = document.createElement("button");
      submit.type = "submit"; submit.className = "primary";
      submit.textContent = "Apply transfers"; submit.dataset.choice = "";
      const update = () => {
        const take = inputs.filter(v => v.input.checked && v.transfer === "take").length;
        const put = inputs.filter(v => v.input.checked && v.transfer === "put").length;
        summary.textContent = `${take} stack${take === 1 ? "" : "s"} to take · ${put} to put in`;
        submit.dataset.emptySelection = String(take + put === 0);
        submit.disabled = take + put === 0;
      };
      for (const transfer of ["take", "put"] as const) {
        const section = document.createElement("fieldset");
        const legend = document.createElement("legend");
        legend.textContent = transfer === "take" ? "Inside container" : "Your backpack";
        section.append(legend);
        const list = document.createElement("div"); list.className = "container-items";
        const options = d.options.filter(o => o.transfer === transfer);
        if (transfer === "take" && options.length) {
          const all = this.button("Take everything", () => {
            inputs.filter(v => v.transfer === "take").forEach(v => { v.input.checked = true; });
            update();
          }, "secondary");
          all.type = "button"; section.append(all);
        }
        if (!options.length) {
          const empty = document.createElement("p"); empty.className = "subtle";
          empty.textContent = transfer === "take" ? "The container is empty." : "Nothing available to put in.";
          list.append(empty);
        }
        for (const option of options) {
          const label = document.createElement("label"); label.className = "menu-choice";
          const input = document.createElement("input"); input.type = "checkbox";
          input.onchange = update;
          label.append(input, document.createTextNode(option.label)); list.append(label);
          inputs.push({input, id:option.id, transfer});
        }
        section.append(list); columns.append(section);
      }
      const clear = this.button("Clear selection", () => {
        inputs.forEach(v => { v.input.checked = false; }); update();
      }, "secondary");
      clear.type = "button";
      form.append(columns); body.append(form);
      submit.setAttribute("form", form.id);
      const actions = document.createElement("div"); actions.className = "transfer-actions";
      actions.append(summary, clear, submit); footer.append(actions); update();
      form.onsubmit = e => {
        e.preventDefault();
        const choose = inputs.filter(v => v.input.checked).map(v => v.id);
        if (!choose.length) return;
        void this.run(() => this.game!.answer(d.id, {kind:"choice", choose}));
      };
    } else if (d.kind === "choice" && (d.containerPhase === "inspect" || (d.action === "loot" && !d.selection))) {
      for (const option of d.options) add(option.label, () =>
        this.game!.answer(d.id, { kind: "choice", choose: [option.id] }), "choice-row");
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
      if (potionNickname) {
        const narration = document.createElement("section"); narration.className = "potion-narration";
        const heading = document.createElement("p"); heading.textContent = "You drank the potion.";
        const effects = document.createElement("blockquote");
        const heard = this.game!.state.events.flatMap(event => event.type === "heard" ? [event.text] : []);
        effects.textContent = (heard.length ? heard : this.game!.observation.heard).join("\n");
        input.value = effects.textContent.replace(/\s+/g, " ").trim().slice(0, 256);
        narration.append(heading, effects); body.append(narration);
        const appearance = document.createElement("p"); appearance.className = "subtle";
        appearance.textContent = d.about ?? ""; body.append(appearance);
      }
      label.textContent = potionNickname ? "Nickname" : "Your answer";
      input.name = "answer";
      input.maxLength = 256;
      label.append(input);
      form.append(label);
      body.append(form);
      const submit = document.createElement("button");
      submit.textContent = potionNickname ? "Use nickname" : "Send answer";
      if (potionNickname) {
        input.required = true;
        const generate = this.button("Generate nickname", () => {
          const words = crypto.getRandomValues(new Uint32Array(2));
          const first = ["Velvet", "Moonlit", "Wandering", "Quiet", "Copper", "Twilight", "Little", "Distant"];
          const last = ["Mystery", "Whisper", "Riddle", "Echo", "Secret", "Fable", "Wonder", "Tale"];
          input.value = first[words[0]! % first.length] + " " + last[words[1]! % last.length];
          input.focus();
        }, "secondary");
        form.append(generate);
        const help = document.createElement("p"); help.className = "subtle";
        help.textContent = "This is your label for this potion type, not an identification. A generated nickname is just a suggestion; edit it before choosing Use nickname.";
        form.append(help);
      }
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
        potionNickname ? "Skip nickname" : "Cancel action",
        () => this.game!.cancel(d.id),
        "text-button cancel-choice",
      );
    add(
      "Save & return to doorway",
      () => this.returnToDoorway(),
      "text-button",
    );
    for (const form of body.querySelectorAll<HTMLFormElement>(":scope > form:not(.container-transfer)")) {
      form.id = "decision-answer-form";
      for (const button of form.querySelectorAll<HTMLButtonElement>(":scope > .primary")) {
        button.setAttribute("form", form.id); footer.append(button);
      }
    }
    for (const button of body.querySelectorAll(":scope > .text-button")) footer.append(button);
    if (!dialog.open) dialog.showModal();
    body.querySelector<HTMLElement>("button,input")?.focus();
  }
  private key(e: KeyboardEvent) {
    if(this.navigationAbort && e.key==="Escape") { e.preventDefault();this.navigationAbort.abort();return; }
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
      if (keys[e.key] || e.key === "Escape" || (this.game?.decision?.kind === "position" && ["?", "Enter", "."].includes(e.key))) {
        e.preventDefault();
        const d = this.game?.decision;
        if (!e.repeat && d && !this.busy) {
          if (e.key === "Escape") { if (d.cancellable) void this.run(() => this.game!.cancel(d.id)); }
          else if (d.kind === "position") {
            const position = e.key === "?" ? "help" : ["Enter", "."].includes(e.key) ? "finish" : keys[e.key] as Compass;
            if (keys[e.key] !== "up" && keys[e.key] !== "down") void this.run(() => this.game!.answer(d.id, { kind: "position", position }));
          } else void this.run(() => this.game!.answer(d.id, { kind: "target", target: { direction: keys[e.key] as Compass } }));
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
      `<h2 id="menu-title">A small guide to a very big world.</h2><p>Find the Amulet of Yendor in the depths, and bring it back. Getting there is a story of curiosity, decisions, and learning from a short life or two.</p><div class="guide-section"><h3>01 / Take your time</h3><p>This is turn-based. Reading, inspecting the map, and opening your backpack cost nothing. An action can take time; the journal tells you what happened.</p></div><div class="guide-section"><h3>02 / Try one thing</h3><p>Tap W A S D, an arrow, or a direction button for one step; hold to walk. Release to stop repeating. Rapid taps keep at most one extra step buffered. Walking pauses at walls, nearby creatures, damage, and decisions. Press again deliberately to interact. Search around you, open a door, or pick up something interesting.</p></div><div class="guide-section"><h3>03 / Listen to the dungeon</h3><p>Hunger, danger, and strange objects are part of the adventure. Read warnings before answering. If eating or reading is interrupted, choose the action again only when you want to continue.</p></div><div class="guide-section"><h3>04 / Know what you know</h3><p>The map shows remembered terrain and currently perceived occupants. Creature and object art represents the visible NetHack category, not an exact identity. A green underline marks an ally. Use @ in the corner menu to show the original symbols. Raised stone edges frame corridors; recessed gaps lead toward unexplored space, where the layout is still unknown. Click a tile or open Surroundings for a text description.</p></div><dl class="key-list"><dt>W A S D / Arrows / H J K L</dt><dd>Tap to step · hold to walk</dd><dt>Y U B N</dt><dd>Move diagonally</dd><dt>. / F / G / E / O</dt><dd>Wait / search / pick up / eat / open</dd><dt>&lt; / &gt;</dt><dd>Go upstairs / downstairs</dd><dt>Enter / arrow keys / Escape</dt><dd>Inspect here / nearby tiles / return</dd><dt>I / ?</dt><dd>Backpack / this guide</dd><dt>Mouse wheel / middle drag</dt><dd>Zoom / look around without taking a turn</dd><dt>Shift + arrows</dt><dd>Pan the map without moving</dd></dl><p class="save-explanation">Your game saves after each completed action, on this browser and address. Clearing site data removes saves. Keep the same game version to return to an older adventure.</p>`,
    );
  }
  private credits() {
    this.openMenu(
      `<h2 id="menu-title">An old world. An open door.</h2><p>neonethack is a new, approachable window into NetHack, built on the neonethack library and its shared C engine.</p><p>NetHack by the NetHack DevTeam and its contributors, under the NetHack General Public License. Original notices remain with the engine.</p><p>Character art from Modern Interiors by <a href="https://limezu.itch.io/moderninteriors" target="_blank" rel="noreferrer">LimeZu</a>. Companion and bat illustrations use original templates from the pixel-art-interfaces skill. Dungeon tiles and interface design are original to this example.</p><p>JetBrains Mono by the JetBrains Mono Project Authors, under the <a href="/fonts/OFL.txt" target="_blank" rel="noreferrer">SIL Open Font License</a>.</p><p>Sound effects: <a href="https://kenney.nl/assets/rpg-audio" target="_blank" rel="noreferrer">Kenney RPG Audio</a>, <a href="/audio/Kenney-LICENSE.txt">CC0</a>.</p><p>Gameplay runs in your browser.</p>`,
    );
  }
}
customElements.define("pixel-nethack", PixelNethack);
