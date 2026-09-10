import { RetainedScene, type SceneSprite } from "./retained-scene";
import { TerrainScene } from "./terrain-scene";
import { DeathTraces } from "./death-traces";
import { companionAsset, knownCreatureArt } from "./creature-families";
import { DungeonSound } from "./sound";
import { layoutForSeed, type LayoutType } from "./layout-art";
import type { Cell, Observation, Snapshot, Compass } from "neonethack/types";
import {
  renderTerrain,
  drawTombstone,
  STRUCTURE_RISE,
  STRUCTURE_OVERHANG,
} from "./dungeon-art";
import {
  categoryMark,
  drawCreatureArt,
  drawUnknownCreature,
  drawCreatureQuestion,
  drawObjectArt,
  drawItemArt,
} from "./symbol-art";

import { roles, heroArt } from "./characters";

const images = new Map<string, HTMLImageElement>();
export async function loadArt(base: string | Record<string, string> = "/art/") {
  await Promise.all(
    [
      ...roles.flatMap(({ art }) => [art, `${art}-motion`]),
      "dog",
      "cat",
      "bat",
    ].map(async (name) => {
      const image = new Image();
      image.src = typeof base === "string" ? `${base}${name}.png` : base[name]!;
      await image.decode();
      images.set(name, image);
    }),
  );
}
const colors = [
  "#141b22",
  "#df7773",
  "#91b67d",
  "#c5a072",
  "#819cce",
  "#ba91c7",
  "#88c9bc",
  "#d2d0ba",
  "#77858b",
  "#f89180",
  "#c4dc8d",
  "#f4ce80",
  "#a9bde0",
  "#d5a3d5",
  "#a2e0d1",
  "#fff2d0",
];
function rect(
  c: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  c.fillStyle = color;
  c.fillRect(x, y, w, h);
}
function torch(c: CanvasRenderingContext2D, x: number, y: number) {
  rect(c, "#69523a", x + 6, y + 7, 4, 9);
  rect(c, "#352d26", x + 5, y + 12, 6, 2);
  rect(c, "#d48b4b", x + 5, y + 3, 6, 6);
  rect(c, "#f0bb68", x + 6, y, 4, 8);
  rect(c, "#ffe0a0", x + 7, y + 3, 2, 4);
}
function stairs(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  up: boolean,
) {
  rect(c, "#1e2828", x + 2, y + 2, 12, 12);
  for (let i = 0; i < 4; i++) {
    const w = up ? 10 - i * 2 : 4 + i * 2;
    rect(c, "#90927b", x + 8 - w / 2, y + 3 + i * 3, w, 1);
    rect(c, "#566154", x + 8 - w / 2, y + 4 + i * 3, w, 1);
  }
}
function glyph(
  c: CanvasRenderingContext2D,
  mark: string,
  color: string,
  x: number,
  y: number,
) {
  c.font = "bold 12px monospace";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillStyle = "#10181d";
  c.fillText(mark, x + 9, y + 9);
  c.fillStyle = color;
  c.fillText(mark, x + 8, y + 8);
}
function drawContents(
  c: CanvasRenderingContext2D,
  cell: Cell,
  x: number,
  y: number,
  symbols: boolean,
  pass: "loot" | "actor",
) {
  // Only render the occupants/objects actually present in this public frame.
  // A glyph is a perceived class, not permission to infer a monster species.
  if (pass === "loot" && cell.objects?.length) {
    const object = cell.objects[0]!;
    if (symbols) glyph(c, object.mark, colors[object.color] ?? "#dbc887", x, y);
    else if (!drawItemArt(c, object, x, y))
      drawObjectArt(
        c,
        object.mark,
        colors[object.color] ?? "#dbc887",
        x,
        y,
        true,
      );
  }
  if (pass === "actor" && cell.occupant && cell.occupant.kind !== "self") {
    const ally = cell.occupant.kind === "ally";
    const mark = cell.occupant.mark;
    const color = colors[cell.occupant.color ?? 7] ?? "#e6dac0";
    rect(c, "#26312b", x + 3, y + 13, 10, 2);
    if (symbols) glyph(c, mark, color, x, y);
    else {
      const sprite = images.get(companionAsset(cell.occupant.appearance) ?? "");
      if (sprite) c.drawImage(sprite, x, y - 2);
      else if (!drawCreatureArt(c, cell.occupant.appearance, x, y))
        drawUnknownCreature(c, x, y);
    }
    if (ally) {
      rect(c, "#b5ce8e", x + 5, y + 15, 6, 1);
      rect(c, "#b5ce8e", x + 4, y + 14, 1, 1);
      rect(c, "#b5ce8e", x + 11, y + 14, 1, 1);
    }
  }
}

export function creatureLabel(
  occupant: Pick<NonNullable<Cell["occupant"]>, "kind" | "appearance">,
) {
  if (occupant.kind === "self") return "You";
  if (occupant.appearance) return occupant.appearance;
  return "Unknown creature";
}

export function cellDescription(cell: Cell) {
  const terrain =
    cell.terrain.type.replace(/([A-Z])/g, " $1").toLowerCase() +
    (cell.visible === false ? " · Remembered, out of sight" : "");
  const occupant = cell.occupant;
  const objects = cell.objects
    ?.map((o) =>
      o.known?.appearance
        ? `${o.known.appearance}${o.known.depictedCreature ? ` of ${o.known.depictedCreature}` : ""} (${o.mark})`
        : `Object ${o.mark}`,
    )
    .join(", ");
  const actor = occupant
    ? occupant.kind === "self"
      ? "You"
      : `${creatureLabel(occupant)}${occupant.kind === "ally" ? " · Ally" : ""} (${occupant.mark})`
    : undefined;
  const contents = [actor, objects].filter(Boolean).join(" · ");
  return `${cell.x}, ${cell.y}: ${contents ? `${contents} · ` : ""}${terrain}`;
}

export function actionMessages(snapshot: Snapshot): string[] {
  const messages = snapshot.events.flatMap((event) =>
    event.type === "heard" && event.text.trim() ? [event.text] : [],
  );
  if (
    !messages.length &&
    snapshot.outcome.action === "search" &&
    snapshot.outcome.status === "completed"
  )
    messages.push("You search nearby.");
  return messages;
}

export class DungeonMap {
  /** Display pacing only; never changes game turns or schedules input. */
  presentationDuration = 110;
  readonly deathTraces = new DeathTraces();
  private perceptionSession?: string;
  route: { x: number; y: number }[] = [];
  selectedTile: { x: number; y: number } | null = null;
  context: { x: number; y: number } | null = null;
  positionCursor: { x: number; y: number } | null = null;
  private intro = {
    x: 160,
    y: 208,
    fromX: 160,
    fromY: 208,
    moved: -Infinity,
    facing: 1,
  };
  private portalStarted = -Infinity;
  private portalDuration = 960;
  private portalComplete: (() => void) | null = null;
  resetIntro() {
    this.cancelIntroPortal();
    this.intro = {
      x: 160,
      y: 208,
      fromX: 160,
      fromY: 208,
      moved: -Infinity,
      facing: 1,
    };
    this.draw();
  }
  enterIntroPortal(complete: () => void) {
    if (this.observation || this.portalComplete) return false;
    this.portalStarted = performance.now();
    this.portalDuration = this.reducedMotion.matches ? 120 : 960;
    this.portalComplete = complete;
    this.draw(this.portalStarted);
    if (this.reducedMotion.matches && !document.hidden)
      this.animation = requestAnimationFrame(this.animate);
    return true;
  }
  cancelIntroPortal() {
    this.portalComplete = null;
    this.portalStarted = -Infinity;
    this.canvas.dataset.portal = "idle";
    delete this.canvas.dataset.portalProgress;
  }
  introDirection(): Compass {
    return this.intro.x < 160 ? "east" : this.intro.x > 160 ? "west" : "north";
  }
  moveIntro(direction: Compass): "moved" | "blocked" | "entered" {
    if (this.observation) return "blocked";
    const delta: Partial<Record<Compass, [number, number, number]>> = {
      north: [0, -8, 1],
      south: [0, 8, 3],
      west: [-8, 0, 2],
      east: [8, 0, 0],
    };
    const d = delta[direction];
    if (!d) return "blocked";
    const x = this.intro.x + d[0],
      y = this.intro.y + d[1];
    this.intro.facing = d[2];
    // Authored welcome courtyard only; never used for engine movement.
    if (
      x < 88 ||
      x > 232 ||
      y > 224 ||
      y < 88 ||
      (y < 120 && Math.abs(x - 160) > 16)
    ) {
      this.draw();
      return "blocked";
    }
    this.intro = {
      x,
      y,
      fromX: this.intro.x,
      fromY: this.intro.y,
      moved: performance.now(),
      facing: d[2],
    };
    this.draw();
    return y <= 96 && Math.abs(x - 160) <= 16 ? "entered" : "moved";
  }
  zoom = 3;
  private drag: { id: number; x: number; y: number } | null = null;
  private wheel = (event: WheelEvent) => {
    if (!this.observation || event.ctrlKey || event.metaKey || !event.deltaY)
      return;
    event.preventDefault();
    const unit =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? this.canvas.clientHeight
          : 1;
    this.zoomTo(
      this.zoom *
        Math.exp(-Math.max(-300, Math.min(300, event.deltaY * unit)) * 0.002),
    );
  };
  private dragStart = (event: PointerEvent) => {
    if (!this.observation || event.button !== 1) return;
    event.preventDefault();
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.classList.add("panning");
  };
  private dragMove = (event: PointerEvent) => {
    if (this.drag?.id !== event.pointerId) return;
    if (!(event.buttons & 4)) {
      this.endDrag();
      return;
    }
    event.preventDefault();
    this.pan(
      (this.drag.x - event.clientX) / (16 * this.zoom),
      (this.drag.y - event.clientY) / (16 * this.zoom),
    );
    this.drag.x = event.clientX;
    this.drag.y = event.clientY;
  };
  private endDrag = () => {
    const drag = this.drag;
    this.drag = null;
    if (drag && this.canvas.hasPointerCapture(drag.id))
      this.canvas.releasePointerCapture(drag.id);
    this.canvas.classList.remove("panning");
  };
  private auxiliary = (event: MouseEvent) => {
    if (event.button === 1 && this.observation) event.preventDefault();
  };
  zoomTo(value: number) {
    this.zoom = Math.max(1, Math.min(4, value));
    this.cameraDuration = this.reducedMotion.matches ? 0 : 160;
    this.draw();
  }
  symbols = false;
  private offset = { x: 0, y: 0 };
  private origin = { x: 0, y: 0 };
  private observer: ResizeObserver;
  private observation: Observation | null = null;
  private heroDead = false;
  private hero = heroArt("valkyrie");
  private seed = "0";
  private layoutType: LayoutType = "dungeon";
  private facing: "left" | "up" | "right" | "down" = "down";
  private walkStarted = -Infinity;
  private walkUntil = -Infinity;
  private animation = 0;
  private lastDraw = 0;
  private travelStarted = -Infinity;
  private travelFrom = { x: 0, y: 0 };
  private actorMotions = new Map<
    string,
    { fromX: number; fromY: number; started: number }
  >();
  private bubbles: {
    element: HTMLDivElement;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
    camera?: Animation;
    movement?: Animation;
  }[] = [];
  readonly sound = new DungeonSound();
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private motionChanged = () => {
    cancelAnimationFrame(this.animation);
    if (document.hidden) {
      this.clearMessages();
      this.actorMotions.clear();
    }
    if (this.reducedMotion.matches) {
      this.actorMotions.clear();
    }
    this.draw();
    if (
      !this.observation &&
      !document.hidden &&
      (!this.reducedMotion.matches || this.portalComplete)
    )
      this.animation = requestAnimationFrame(this.animate);
  };
  private animate = (now: number) => {
    if (now - this.lastDraw >= (this.portalComplete ? 16 : 80)) {
      this.draw(now);
      this.lastDraw = now;
    }
    if (
      this.portalComplete &&
      now >= this.portalStarted + this.portalDuration
    ) {
      const complete = this.portalComplete;
      this.portalComplete = null;
      this.portalStarted = -Infinity;
      this.canvas.dataset.portal = "idle";
      delete this.canvas.dataset.portalProgress;
      complete();
    }
    if (
      !this.observation &&
      !document.hidden &&
      (!this.reducedMotion.matches || this.portalComplete)
    )
      this.animation = requestAnimationFrame(this.animate);
  };
  constructor(
    private canvas: HTMLCanvasElement,
    private inspect: (
      text: string,
      x: number,
      y: number,
      walk: boolean,
    ) => void,
  ) {
    this.scene = new RetainedScene(canvas);
    this.terrainScene = new TerrainScene(canvas.ownerDocument);
    this.observer = new ResizeObserver(() => this.draw());
    this.observer.observe(canvas.parentElement!);
    window.visualViewport?.addEventListener("resize", this.viewportChanged);
    window.visualViewport?.addEventListener("scroll", this.viewportChanged);
    this.reducedMotion.addEventListener("change", this.motionChanged);
    document.addEventListener("visibilitychange", this.motionChanged);
    this.motionChanged();
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    canvas.addEventListener("pointerdown", this.dragStart);
    canvas.addEventListener("pointermove", this.dragMove);
    canvas.addEventListener("pointerup", this.endDrag);
    canvas.addEventListener("pointercancel", this.endDrag);
    canvas.addEventListener("lostpointercapture", this.endDrag);
    canvas.addEventListener("auxclick", this.auxiliary);
    window.addEventListener("blur", this.endDrag);
    let clickedObservation: Observation | null = null;
    const pickCell = (e: MouseEvent) => {
      const point = this.scene.worldPoint(e.clientX, e.clientY);
      let x = Math.floor(point.x / 16),
        y = Math.floor(point.y / 16);
      const picked = !this.symbols && this.scene.pick(e.clientX, e.clientY);
      if (picked) {
        x = picked.x;
        y = picked.y;
      }
      return { x, y };
    };
    canvas.addEventListener("click", (e) => {
      if (!this.observation || e.button !== 0) return;
      if (e.detail > 1 && clickedObservation !== this.observation) return;
      clickedObservation = this.observation;
      const { x, y } = pickCell(e);
      const cell = this.observation.world.find(
        (cell) => cell.x === x && cell.y === y,
      );
      this.inspect(
        this.heroDead &&
          this.observation.you?.x === x &&
          this.observation.you.y === y
          ? `${x}, ${y}: Your final position. Tombstone marks your death; it is not a dungeon object.`
          : cell
            ? cellDescription(cell)
            : `${x}, ${y}: Unexplored`,
        x,
        y,
        e.detail === 2,
      );
    });
    canvas.addEventListener("contextmenu", (e) => {
      if (!this.observation) return;
      e.preventDefault();
      const { x, y } = pickCell(e);
      const cell = this.observation.world.find(
        (cell) => cell.x === x && cell.y === y,
      );
      this.inspect(
        cell ? cellDescription(cell) : `${x}, ${y}: Unexplored`,
        x,
        y,
        true,
      );
    });
  }
  update(
    observation: Observation | null,
    hero = heroArt("valkyrie"),
    seed = "0",
    terminal?:
      | (Pick<Snapshot, "ended" | "end"> & Partial<Pick<Snapshot, "sessionId">>)
      | null,
  ) {
    const changedSession = Boolean(
      terminal?.sessionId && terminal.sessionId !== this.perceptionSession,
    );
    if (changedSession) {
      this.deathTraces.clear();
      this.perceptionSession = terminal?.sessionId;
    }
    this.heroDead = terminal?.ended === true && terminal.end?.kind === "death";
    this.canvas.dataset.hero =
      this.heroDead && observation?.you
        ? "tombstone"
        : observation?.you
          ? "hero"
          : "none";
    this.canvas.setAttribute(
      "aria-description",
      this.heroDead && observation?.you
        ? "A tombstone marks your final position."
        : "",
    );
    const now = performance.now();
    const resetScene =
      !observation ||
      changedSession ||
      this.seed !== seed ||
      this.observation?.location.id !== observation.location.id;
    if (resetScene) {
      this.clearMessages();
      this.deathTraces.clear();
      this.travelStarted = -Infinity;
      this.actorMotions.clear();
      this.scene.reset();
      this.terrainScene.clear();
      this.terrainSprites = [];
      this.sceneObservation = null;
    } else if (
      !this.reducedMotion.matches &&
      this.observation &&
      observation &&
      observation !== this.observation
    ) {
      this.captureActorMotions(this.observation, observation, now);
    }
    const before = this.observation?.you,
      after = observation?.you;
    if (!before || !after || resetScene) {
      this.facing = "down";
      this.walkStarted = -Infinity;
      this.walkUntil = -Infinity;
      this.travelStarted = -Infinity;
    } else {
      const dx = after.x - before.x,
        dy = after.y - before.y;
      if ((dx || dy) && Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
        // Face the displacement actually reported by the engine. Failed input,
        // inspections and standing decisions do not fabricate a walking step.
        this.facing =
          dx < 0 ? "left" : dx > 0 ? "right" : dy < 0 ? "up" : "down";
        const shift = this.travel(now);
        this.travelFrom = { x: shift.x + dx * 16, y: shift.y + dy * 16 };
        this.travelStarted = now;
        this.cameraDuration = this.reducedMotion.matches ? 0 : this.presentationDuration;
        // Consecutive steps share a gait phase instead of restarting frame zero.
        if (now >= this.walkUntil) this.walkStarted = now;
        this.walkUntil = now + 600;
      } else if (dx || dy) {
        this.walkUntil = -Infinity;
        this.travelStarted = -Infinity;
      }
    }
    if (!observation) {
      this.endDrag();
    }
    if (this.heroDead) {
      this.walkUntil = -Infinity;
      this.travelStarted = -Infinity;
    }
    cancelAnimationFrame(this.animation);
    this.animation = 0;
    clearTimeout(this.walkTimer);
    this.observation = observation;
    if (observation && now < this.walkUntil && !this.reducedMotion.matches)
      this.walkTimer = setTimeout(
        () => this.draw(),
        Math.max(0, this.walkUntil - now),
      );
    this.hero = hero;
    this.seed = seed;
    this.layoutType = observation ? layoutForSeed(seed) : "dungeon";
    this.canvas.dataset.environment = this.layoutType;
    this.draw();
    if (!observation && !document.hidden && !this.reducedMotion.matches)
      this.animation = requestAnimationFrame(this.animate);
  }
  private captureActorMotions(
    before: Observation,
    after: Observation,
    now: number,
  ) {
    this.actorMotions.clear();
    type ActorCell = Cell & { occupant: NonNullable<Cell["occupant"]> };
    const actors = (observation: Observation) => {
      const found = new Map<string, ActorCell[]>();
      for (const cell of observation.world) {
        const occupant = cell.occupant;
        if (!occupant || occupant.kind === "self") continue;
        // This is a rendering correspondence between two public frames, not a
        // claim about hidden monster identity. Repeated descriptions are left
        // stationary because there is no safe way to pair them.
        const signature = JSON.stringify([
          occupant.kind,
          occupant.mark,
          occupant.color ?? null,
          occupant.appearance ?? null,
        ]);
        const cells = found.get(signature) ?? [];
        cells.push(cell as ActorCell);
        found.set(signature, cells);
      }
      return found;
    };
    const previous = actors(before);
    for (const [signature, destinations] of actors(after)) {
      const sources = previous.get(signature);
      if (sources?.length !== 1 || destinations.length !== 1) continue;
      const source = sources[0]!,
        destination = destinations[0]!,
        dx = destination.x - source.x,
        dy = destination.y - source.y;
      if (!(dx || dy) || Math.abs(dx) > 1 || Math.abs(dy) > 1) continue;
      this.actorMotions.set(`${destination.x},${destination.y}`, {
        fromX: source.x,
        fromY: source.y,
        started: now,
      });
    }
  }
  private travel(now: number) {
    const remaining = this.reducedMotion.matches
      ? 0
      : Math.max(0, 1 - (now - this.travelStarted) / Math.max(1, this.presentationDuration));
    if (remaining === 0) return { x: 0, y: 0 };
    return {
      x: Math.round(this.travelFrom.x * remaining),
      y: Math.round(this.travelFrom.y * remaining),
    };
  }
  center() {
    this.offset = { x: 0, y: 0 };
    this.draw();
  }
  pan(x: number, y: number) {
    this.offset.x = Math.max(-79, Math.min(79, this.offset.x + x));
    this.offset.y = Math.max(-20, Math.min(20, this.offset.y + y));
    this.draw();
  }
  destroy() {
    this.endDrag();
    clearTimeout(this.walkTimer);
    this.scene.destroy();
    this.terrainScene.clear();
    this.canvas.removeEventListener("wheel", this.wheel);
    this.canvas.removeEventListener("pointerdown", this.dragStart);
    this.canvas.removeEventListener("pointermove", this.dragMove);
    this.canvas.removeEventListener("pointerup", this.endDrag);
    this.canvas.removeEventListener("pointercancel", this.endDrag);
    this.canvas.removeEventListener("lostpointercapture", this.endDrag);
    this.canvas.removeEventListener("auxclick", this.auxiliary);
    window.removeEventListener("blur", this.endDrag);
    this.cancelIntroPortal();
    this.clearMessages();
    this.sound.dispose();
    this.observer.disconnect();
    window.visualViewport?.removeEventListener("resize", this.viewportChanged);
    window.visualViewport?.removeEventListener("scroll", this.viewportChanged);
    cancelAnimationFrame(this.animation);
    this.reducedMotion.removeEventListener("change", this.motionChanged);
    document.removeEventListener("visibilitychange", this.motionChanged);
  }
  clearMessages() {
    for (const bubble of this.bubbles) {
      clearTimeout(bubble.timer);
      bubble.movement?.cancel();
      bubble.element.remove();
    }
    this.bubbles = [];
  }
  showMessages(before: Snapshot, after: Snapshot) {
    this.deathTraces.observe(before, after);
    this.draw();
    this.sound.observe(before, after, actionMessages(after));
    if (
      before.sessionId !== after.sessionId ||
      before.revision === after.revision ||
      before.observation.location.id !== after.observation.location.id ||
      after.decision ||
      after.ended ||
      after.error ||
      document.hidden
    ) {
      if (after.decision || after.ended) this.clearMessages();
      return;
    }
    const you = after.observation.you;
    if (!you) return;
    // Heard events have no source coordinates. Only an unambiguous, publicly
    // observed door transition localizes these exact messages; other prose is
    // narration near the traveler, never attributed to an invented speaker.
    const messages = actionMessages(after);
    this.showImpact(before, after, messages);
    for (const text of messages
      .filter((text) => text.trim() && text.length <= 160)
      .filter(
        (text) =>
          !(
            /^You swap places with /.test(text) &&
            after.outcome.positionChanged &&
            before.observation.world.some(
              (c) =>
                c.x === you.x && c.y === you.y && c.occupant?.kind === "ally",
            )
          ),
      )
      .filter(
        (text) =>
          !(
            after.observation.perception.here === "current" &&
            after.observation.here.items.length &&
            /^(?:You (?:see|feel) here |Things that (?:are|you feel) here:)/.test(
              text,
            )
          ),
      )
      .slice(-3)) {
      let anchor = you;
      const doorType =
        text === "The door opens."
          ? "openDoor"
          : text === "The door closes."
            ? "closedDoor"
            : null;
      if (doorType) {
        const doors = after.observation.world.filter(
          (cell) =>
            cell.terrain.type === doorType &&
            before.observation.world.some(
              (old) =>
                old.x === cell.x &&
                old.y === cell.y &&
                old.terrain.type ===
                  (doorType === "openDoor" ? "closedDoor" : "openDoor"),
            ),
        );
        if (doors.length === 1) anchor = doors[0]!;
      }
      if (this.bubbles.length >= 3) {
        const oldest = this.bubbles.shift()!;
        clearTimeout(oldest.timer);
        oldest.movement?.cancel();
        oldest.element.remove();
      }
      const element = document.createElement("div");
      element.className = "action-bubble";
      element.textContent =
        doorType === "openDoor" && anchor !== you ? "kreeek…" : text;
      // The existing status and journal provide the accessible text, once.
      element.setAttribute("aria-hidden", "true");
      element.dataset.x = String(anchor.x);
      element.dataset.y = String(anchor.y);
      element.dataset.anchor = anchor === you ? "traveler" : "terrain";
      this.canvas.parentElement!.append(element);
      const bubble = {
        element,
        x: anchor.x,
        y: anchor.y,
        timer: setTimeout(() => {
          element.remove();
          this.bubbles = this.bubbles.filter((entry) => entry !== bubble);
          this.positionMessages();
        }, 3200),
      };
      this.bubbles.push(bubble);
    }
    this.positionMessages();
  }
  private showImpact(before: Snapshot, after: Snapshot, messages: string[]) {
    if (this.reducedMotion.matches) return;
    const previous = Number(before.observation.vitals.health);
    const current = Number(after.observation.vitals.health);
    const hurt =
      Number.isFinite(previous) &&
      Number.isFinite(current) &&
      current < previous;
    const struck = messages.some((text) =>
      /^You (?:hit|smite|bite|claw|strike|punch) /.test(text),
    );
    const kicked =
      after.outcome.action === "kick" && after.outcome.turnsElapsed > 0;
    if (!hurt && !struck && !kicked) return;
    const effect = document.createElement("div");
    effect.className = "combat-impact" + (hurt ? " hurt" : "");
    effect.setAttribute("aria-hidden", "true");
    // Incoming damage is located at the player; prose never identifies a target.
    const you = after.observation.you!;
    effect.style.left =
      this.canvas.offsetLeft +
      (you.x - this.origin.x + 0.5) * 16 * this.zoom +
      "px";
    effect.style.top =
      this.canvas.offsetTop + (you.y - this.origin.y) * 16 * this.zoom + "px";
    this.canvas.parentElement!.append(effect);
    effect.addEventListener("animationend", () => effect.remove(), {
      once: true,
    });
    setTimeout(() => effect.remove(), 500);
    if (hurt || kicked)
      (this.observation ? this.scene.element : this.canvas).animate(
        [
          { transform: "translate(0,0)" },
          { transform: "translate(-2px,1px)" },
          { transform: "translate(2px,-1px)" },
          { transform: "translate(0,0)" },
        ],
        { duration: 160 },
      );
  }
  private viewportChanged = () => this.positionCommandInput();
  positionCommandInput() {
    const parent = this.canvas.parentElement!;
    const box = parent.querySelector<HTMLElement>("#keyboard-prefix");
    const you = this.observation?.you;
    if (!box || box.hidden || !you) return;
    const rect = parent.getBoundingClientRect(),
      viewport = window.visualViewport;
    const minTop = Math.max(8, (viewport?.offsetTop ?? 0) - rect.top + 8);
    const bottom =
      Math.min(
        parent.clientHeight,
        (viewport?.offsetTop ?? 0) +
          (viewport?.height ?? innerHeight) -
          rect.top,
      ) - 8;
    box.style.maxHeight = Math.max(100, bottom - minTop) + "px";
    const x =
      this.canvas.offsetLeft + (you.x - this.origin.x + 0.5) * 16 * this.zoom;
    const head =
      this.canvas.offsetTop + (you.y - this.origin.y) * 16 * this.zoom;
    const below = head + 16 * this.zoom + 10;
    const top =
      below + box.offsetHeight <= bottom ? below : head - box.offsetHeight - 10;
    box.style.left =
      Math.max(
        8,
        Math.min(
          parent.clientWidth - box.offsetWidth - 8,
          x - box.offsetWidth / 2,
        ),
      ) + "px";
    box.style.top =
      Math.max(minTop, Math.min(bottom - box.offsetHeight, top)) + "px";
  }
  private positionMessages(now = performance.now()) {
    const canvas = this.canvas;
    const camera = this.scene.camera.getAnimations().find(animation => animation.playState === "running");
    const matrix = this.bubbles.length && camera ? new DOMMatrix(getComputedStyle(this.scene.camera).transform) : null;
    let previousTop = Infinity;
    for (const bubble of [...this.bubbles].reverse()) {
      const x = (bubble.x - this.origin.x + 0.5) * 16 * this.zoom;
      const y = (bubble.y - this.origin.y) * 16 * this.zoom;
      const visible =
        x >= 0 && x < canvas.clientWidth && y >= 0 && y < canvas.clientHeight;
      bubble.element.hidden = !visible;
      if (!visible) continue;
      const width = bubble.element.offsetWidth,
        height = bubble.element.offsetHeight;
      const terrain = bubble.element.dataset.anchor === "terrain";
      bubble.element.dataset.side = "above";
      const targetLeft = canvas.offsetLeft + x - width / 2;
      const left = Math.max(
        8,
        Math.min(canvas.parentElement!.clientWidth - width - 8, targetLeft),
      );
      const proposedTop = Math.min(
        canvas.offsetTop +
          y +
          (terrain
            ? -(STRUCTURE_RISE + 2) * this.zoom - height
            : -22 * this.zoom - height),
        previousTop - height - 10,
      );
      if (previousTop !== Infinity && proposedTop < 8) {
        bubble.element.hidden = true;
        continue;
      }
      const top = Math.max(8, proposedTop);
      bubble.element.style.left = `${Math.round(left)}px`;
      bubble.element.style.top = `${Math.round(top)}px`;
      bubble.element.style.setProperty(
        "--tail-x",
        `${Math.max(8, Math.min(width - 16, canvas.offsetLeft + x - left))}px`,
      );
      if (bubble.camera !== camera) {
        bubble.movement?.cancel();
        bubble.camera = camera;
        if (camera && matrix) {
          const dx = Math.max(8 - left, Math.min(canvas.clientWidth - width - 8 - left, matrix.a * (bubble.x + .5) * 16 + matrix.e - x));
          const dy = Math.max(8 - top, matrix.d * bubble.y * 16 + matrix.f - y);
          const duration = Math.max(0, Number(camera.effect?.getTiming().duration) - Number(camera.currentTime));
          // Individual translate composes with the bubble's existing CSS entry
          // animation, and follows camera motion without a JS positioning loop.
          bubble.movement = bubble.element.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0px 0px" }], { duration });
        }
      }
      previousTop = top;
    }
  }
  private scene!: RetainedScene;
  private terrainScene!: TerrainScene;
  private sceneObservation: Observation | null = null;
  private sceneState = "";
  private terrainSprites: SceneSprite[] = [];
  private walkTimer?: ReturnType<typeof setTimeout>;
  private cameraDuration = 0;

  draw(now = performance.now()) {
    const canvas = this.canvas;
    const width = canvas.parentElement?.clientWidth ?? 640;
    const height = canvas.parentElement?.clientHeight ?? 640;
    const motion = !this.reducedMotion.matches && !document.hidden;
    this.scene.setMotion(motion);
    this.scene.element.hidden = !this.observation;
    if (!this.observation) {
      const scale = width >= 850 && height >= 750 ? 3 : 2;
      const cols = Math.max(7, Math.ceil(width / (16 * scale))),
        rows = Math.max(7, Math.ceil(height / (16 * scale)));
      if (canvas.width !== cols * 16) canvas.width = cols * 16;
      if (canvas.height !== rows * 16) canvas.height = rows * 16;
      canvas.style.width = `${cols * 16 * scale}px`;
      canvas.style.height = `${rows * 16 * scale}px`;
      const c = canvas.getContext("2d")!;
      c.imageSmoothingEnabled = false;
      rect(c, "#171f23", 0, 0, canvas.width, canvas.height);
      const gate =
        canvas.parentElement?.querySelector<HTMLElement>("#enter-gate");
      if (gate) {
        gate.style.left = (Math.floor(cols * 8 - 160) + 137) * scale + "px";
        gate.style.top = (Math.floor(rows * 8 - 128) + 44) * scale + "px";
        gate.style.width = 46 * scale + "px";
        gate.style.height = 58 * scale + "px";
      }
      this.drawWelcomeArt(c, cols, rows, now);
      return;
    }
    // The original canvas remains the keyboard/pointer surface. It does not
    // carry a duplicate bitmap of the retained scene.
    if (canvas.width !== 1 || canvas.height !== 1) {
      canvas.width = canvas.height = 1;
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const you = this.observation.you;
    this.origin = {
      x:
        Math.round(
          ((you?.x ?? 40) + 0.5 - width / (32 * this.zoom) + this.offset.x) *
            16,
        ) / 16,
      y:
        Math.round(
          ((you?.y ?? 10) + 0.5 - height / (32 * this.zoom) + this.offset.y) *
            16,
        ) / 16,
    };
    this.scene.moveCamera(
      -this.origin.x * 16 * this.zoom,
      -this.origin.y * 16 * this.zoom,
      this.zoom,
      this.cameraDuration,
    );
    this.cameraDuration = 0;
    this.positionMessages(now);
    this.positionCommandInput();
    const target =
      canvas.parentElement!.querySelector<HTMLElement>("#direction-target");
    if (target && you) {
      target.style.left =
        Math.max(
          100,
          Math.min(width - 100, (you.x - this.origin.x + 0.5) * 16 * this.zoom),
        ) + "px";
      target.style.top =
        Math.max(
          120,
          Math.min(
            height - 160,
            (you.y - this.origin.y + 0.5) * 16 * this.zoom,
          ),
        ) + "px";
    }
    const walking = motion && now < this.walkUntil;
    const state = JSON.stringify([
      this.seed,
      this.layoutType,
      this.hero,
      this.heroDead,
      this.facing,
      walking,
      motion,
      this.symbols,
      this.route,
      this.selectedTile,
      this.context,
      this.positionCursor,
      this.deathTraces.entries,
      this.observation,
    ]);
    if (this.sceneObservation === this.observation && this.sceneState === state)
      return;
    this.sceneState = state;
    this.sceneObservation = this.observation;
    {
      this.terrainSprites = this.terrainScene.prepare(
        this.observation.world,
        {
          seed: this.seed,
          layoutType: this.layoutType,
          readableCells: [
            ...(you ? [{ x: you.x, y: you.y, rise: 16 }] : []),
            ...this.observation.world
              .filter(
                (cell) =>
                  cell.visible !== false &&
                  (cell.occupant ||
                    cell.objects?.length ||
                    (cell.visible === true &&
                      ["closedDoor", "openDoor", "doorway"].includes(
                        cell.terrain.type,
                      ))),
              )
              .map((cell) => ({
                x: cell.x,
                y: cell.y,
                rise: cell.occupant
                  ? 16
                  : cell.objects?.length
                    ? 4
                    : STRUCTURE_RISE,
              })),
          ],
        },
        motion,
      );
    }
    const sprites: SceneSprite[] = [...this.terrainSprites];
    // Fixed, world-space dust. No camera-driven rasterization.
    sprites.push({
      key: "dust",
      signature: "dust-1",
      x: -32,
      y: -32,
      width: 1344,
      height: 400,
      z: -1,
      paint: (c) => {
        for (let y = 0; y < 25; y++)
          for (let x = 0; x < 84; x++)
            if ((((x - 2) * 31 + (y - 2) * 17) & 7) === 0)
              rect(c, "#1b2429", x * 16 + 3, y * 16 + 9, 3, 1);
      },
    });
    const depth = (x: number, y: number, actor = false) =>
      1000 + Math.round(y * 16) * 256 + Math.round(x * 2) + Number(actor);
    const sprite = (
      key: string,
      signature: unknown,
      x: number,
      y: number,
      z: number,
      paint: SceneSprite["paint"],
      extra: Partial<SceneSprite> = {},
    ) => {
      sprites.push({
        key,
        signature: JSON.stringify(signature),
        x: x * 16 - 8,
        y: y * 16 - 32,
        width: 32,
        height: 48,
        z,
        paint,
        ...extra,
      });
    };
    if (this.selectedTile)
      sprite(
        "selection",
        "selection",
        this.selectedTile.x,
        this.selectedTile.y,
        1,
        (c) => {
          c.strokeStyle = "#b8c995";
          c.lineWidth = 1;
          c.strokeRect(8.5, 32.5, 15, 15);
        },
      );
    this.deathTraces.age(this.observation.turn);
    if (!this.symbols)
      for (const trace of this.deathTraces.entries) {
        const cell = this.observation.world.find(
          (cell) => cell.x === trace.x && cell.y === trace.y,
        );
        if (cell?.visible === true) {
          const age = this.observation.turn - trace.turn;
          sprite(
            `death:${trace.x},${trace.y}:${trace.turn}`,
            trace,
            trace.x,
            trace.y,
            1,
            (c) => this.deathTraces.draw(c, trace, 8, 32, trace.turn),
            { opacity: age < 5 ? 1 : age === 5 ? 0.4 / 0.65 : 0.2 / 0.65 },
          );
        }
      }
    const actorCounts = new Map<string, number>();
    const actorKey = (cell: Cell) =>
      JSON.stringify([
        cell.occupant?.kind,
        cell.occupant?.mark,
        cell.occupant?.color,
        cell.occupant?.appearance,
      ]);
    for (const cell of this.observation.world)
      if (cell.occupant)
        actorCounts.set(
          actorKey(cell),
          (actorCounts.get(actorKey(cell)) ?? 0) + 1,
        );
    for (const cell of this.observation.world) {
      const contents =
        !cell.objects &&
        you?.x === cell.x &&
        you.y === cell.y &&
        this.observation.perception?.here === "current" &&
        this.observation.here.known
          ? {
              ...cell,
              objects: this.observation.here.items.map((item) => ({
                mark: categoryMark(item.category),
                color: 7,
                category: item.category,
                known: item.known?.appearance
                  ? {
                      appearance: item.known.appearance,
                      depictedCreature: item.known.depictedCreature,
                    }
                  : undefined,
              })),
            }
          : cell;
      if (contents.objects?.length)
        sprite(
          `loot:${cell.x},${cell.y}`,
          [this.symbols, contents.objects],
          cell.x,
          cell.y,
          depth(cell.x, cell.y),
          (c) => drawContents(c, contents, 8, 32, this.symbols, "loot"),
          { target: { x: cell.x, y: cell.y } },
        );
      if (cell.occupant && cell.occupant.kind !== "self") {
        const identity =
          actorCounts.get(actorKey(cell)) === 1
            ? actorKey(cell)
            : `${cell.x},${cell.y}`;
        const movement = this.actorMotions.get(`${cell.x},${cell.y}`);
        const from =
          movement && now < movement.started + 140
            ? {
                x: movement.fromX * 16 - 8,
                y: movement.fromY * 16 - 32,
                duration: Math.max(0, 140 - (now - movement.started)),
                hop: true,
              }
            : undefined;
        sprite(
          `actor:${identity}`,
          [this.symbols, cell.occupant],
          cell.x,
          cell.y,
          depth(cell.x, cell.y, true),
          (c) => drawContents(c, cell, 8, 32, this.symbols, "actor"),
          { from, target: { x: cell.x, y: cell.y } },
        );
        if (!this.symbols && !knownCreatureArt(cell.occupant.appearance))
          sprite(
            `question:${identity}`,
            "question",
            cell.x,
            cell.y,
            110000,
            (c) => drawCreatureQuestion(c, 8, 32),
            { from, target: { x: cell.x, y: cell.y } },
          );
      }
    }
    if (you) {
      this.canvas.dataset.facing = this.facing;
      this.canvas.dataset.motion = this.heroDead
        ? "still"
        : walking
          ? "walk"
          : "idle";
      this.canvas.dataset.frame = "0";
      const shift = this.travel(now);
      const image = images.get(`${this.hero}-motion`);
      const facing = this.facing,
        dead = this.heroDead;
      sprite(
        "hero",
        [this.hero, dead, Boolean(image)],
        you.x,
        you.y,
        depth(you.x, you.y, true),
        (c, frame) => {
          if (dead) {
            drawTombstone(c, 8, 32);
            return;
          }
          rect(c, "#26312b", 10, 45, 12, 2);
          rect(c, "#a6be87", 12, 47, 8, 1);
          if (image)
            c.drawImage(
              image,
              (frame % 24) * 16,
              frame >= 24 ? 32 : 0,
              16,
              32,
              8,
              16,
              16,
              32,
            );
          else glyph(c, "@", "#e7d498", 8, 32);
        },
        {
          atlasFrames: !dead && image ? 48 : 1,
          frameOffset:
            !dead && image
              ? (walking ? 24 : 0) +
                { right: 0, up: 1, left: 2, down: 3 }[facing] * 6
              : 0,
          frames: motion && !dead && image ? 6 : 1,
          period: walking ? Math.min(100, Math.max(16, this.presentationDuration)) : 167,
          phase: walking ? now - this.walkStarted : now % 1002,
          from:
            shift.x || shift.y
              ? {
                  x: you.x * 16 - 8 - shift.x,
                  y: you.y * 16 - 32 - shift.y,
                  duration: Math.max(0, this.presentationDuration - (now - this.travelStarted)),
                }
              : undefined,
        },
      );
    }
    for (const point of this.route)
      sprite(
        `route:${point.x},${point.y}`,
        "route",
        point.x,
        point.y,
        100000,
        (c) => rect(c, "#b8c995", 15, 39, 3, 3),
      );
    const cursor = this.positionCursor ?? this.context;
    if (cursor)
      sprite("cursor", "cursor", cursor.x, cursor.y, 100001, (c) => {
        c.strokeStyle = "#efd092";
        c.lineWidth = 1;
        c.strokeRect(8.5, 32.5, 15, 15);
      });
    if (this.observation.neighborhood?.status === "available")
      for (const cell of this.observation.neighborhood.cells) {
        if (cell.door?.lock !== "locked") continue;
        sprite(
          `lock:${cell.x},${cell.y}`,
          cell.door.freshness,
          cell.x,
          cell.y,
          120000,
          (c) => {
            rect(c, "#182128", 18, 26, 9, 12);
            rect(c, "#d4be83", 20, 27, 5, 5);
            rect(c, "#182128", 21, 29, 3, 3);
            rect(
              c,
              cell.door?.freshness === "remembered" ? "#92978a" : "#efd092",
              19,
              32,
              7,
              5,
            );
            rect(c, "#524a37", 22, 33, 1, 2);
          },
        );
      }
    this.scene.reconcile(sprites);
    this.scene.visibility(
      this.observation.world
        .filter((cell) => !["dark", "unknown"].includes(cell.terrain.type))
        .map((cell) => {
          const structure = [
            "wall",
            "closedDoor",
            "openDoor",
            "doorway",
          ].includes(cell.terrain.type);
          const rise = structure
            ? STRUCTURE_RISE
            : cell.occupant && cell.occupant.kind !== "self"
              ? 8
              : cell.objects?.length
                ? 4
                : 0;
          return {
            key: `${cell.x},${cell.y}`,
            x: cell.x * 16 - (structure ? STRUCTURE_OVERHANG : 0),
            y: cell.y * 16 - rise,
            width: structure ? 16 + STRUCTURE_OVERHANG : rise ? 19 : 16,
            height: 16 + rise,
            opacity: cell.visible === false ? 1 : 0,
          };
        }),
    );
  }
  // An authored welcome courtyard, never inserted into a game observation.
  drawWelcomeArt(
    c: CanvasRenderingContext2D,
    cols: number,
    rows: number,
    now: number,
  ) {
    const ox = Math.floor(cols * 8 - 160),
      oy = Math.floor(rows * 8 - 128);
    const portalProgress = this.portalComplete
      ? Math.max(
          0,
          Math.min(1, (now - this.portalStarted) / this.portalDuration),
        )
      : null;
    const portal =
      portalProgress === null
        ? null
        : this.reducedMotion.matches
          ? portalProgress < 0.5
            ? 0
            : 1
          : portalProgress;
    this.canvas.dataset.portal = portal === null ? "idle" : "entering";
    if (portal === null) delete this.canvas.dataset.portalProgress;
    else this.canvas.dataset.portalProgress = portalProgress!.toFixed(3);
    // Quiet, coordinate-stable stone dust around the courtyard.
    for (let y = 0; y < rows * 16; y += 8)
      for (let x = 0; x < cols * 16; x += 8) {
        const n = (((x * 13) ^ (y * 29)) >>> 0) % 31;
        if (n < 3) rect(c, n ? "#202b2d" : "#25302f", x, y, 2, 1);
      }
    c.save();
    c.translate(ox, oy);
    const scene: Cell[] = [];
    for (let y = 2; y <= 14; y++)
      for (let x = 3; x <= 16; x++) {
        // Narrow upper hall opens into a courtyard with side alcoves.
        if (y < 6 && (x < 7 || x > 12)) continue;
        const wall =
          y === 2 ||
          (y < 6 && (x === 7 || x === 12)) ||
          (y === 6 && (x < 8 || x > 11)) ||
          x === 3 ||
          x === 16;
        scene.push({
          x,
          y,
          terrain: { type: wall ? "wall" : "floor", knowledge: "remembered" },
        });
      }
    renderTerrain(c, scene, {
      seed: "threshold:courtyard:3",
      originX: 0,
      originY: 0,
      columns: 20,
      rows: 16,
    });
    // Inlaid approach, dark edging and a worn central runner.
    for (let y = 122; y < 238; y += 8) {
      rect(c, "#665f45", 141, y, 2, 5);
      rect(c, "#665f45", 178, y, 2, 5);
      rect(c, y % 16 ? "#394541" : "#414b43", 148, y, 25, 7);
      rect(c, "#707058", 159, y + 3, 2, 1);
    }
    // Recessed entry and three stepped voussoirs give the hall real depth.
    rect(c, "#0f191f", 136, 43, 48, 60);
    if (portal === null) {
      rect(c, "#675e40", 137, 44, 46, 58);
      rect(c, "#a18b56", 143, 44, 34, 58);
      rect(c, "#d5b873", 150, 44, 20, 58);
      rect(c, "#f3dda0", 156, 44, 8, 58);
      for (let i = 0; i < 7; i++)
        rect(
          c,
          i % 2 ? "#d5b873" : "#edcf87",
          139 + i * 6,
          96 - (i % 3) * 7,
          2,
          2,
        );
    }
    if (portal !== null) {
      const charge = Math.min(1, portal / 0.28),
        pull = Math.max(0, Math.min(1, (portal - 0.12) / 0.64)),
        pulse = Math.floor(portal * 18),
        portalColors = ["#526b63", "#80906e", "#c0ae73", "#f0ce82"];
      // The doorway wakes in stepped, hard-edged bands. This remains an
      // authored title-screen effect and cannot reveal engine terrain.
      rect(c, "#182b31", 137, 44, 46, 58);
      for (let ring = 0; ring < 5; ring++) {
        const inset = 2 + ring * 3,
          color = portalColors[(ring + pulse) % portalColors.length]!;
        if (ring / 5 > charge) continue;
        rect(c, color, 136 + inset, 43 + inset, 48 - inset * 2, 2);
        rect(c, color, 136 + inset, 101 - inset, 48 - inset * 2, 2);
        rect(c, color, 136 + inset, 45 + inset, 2, 56 - inset * 2);
        rect(c, color, 182 - inset, 45 + inset, 2, 56 - inset * 2);
      }
      rect(c, "#243d3d", 152, 50, 16, 47);
      rect(c, "#61725b", 156, 47, 8, 50);
      rect(c, "#e6c77c", 159, 45, 2, 52);
      // Threshold runes light from the center outward as the pull begins.
      for (let i = 0; i < 9; i++) {
        const side = i % 2 ? -1 : 1,
          x = 160 + side * (8 + ((i * 11) % 35)),
          y = 105 + ((i * 7) % 35);
        if (i / 9 > pull) continue;
        rect(c, i % 3 ? "#9d925f" : "#e7c879", x, y, 2, 2);
        rect(c, "#35463e", x + side * 2, y + 2, 2, 1);
      }
    }
    for (let i = 0; i < 4; i++) {
      rect(
        c,
        ["#47524a", "#626b57", "#7e8266", "#999575"][i]!,
        128 + i * 3,
        52 - i * 3,
        3,
        55 + i * 3,
      );
      rect(
        c,
        ["#47524a", "#626b57", "#7e8266", "#999575"][i]!,
        188 - i * 3,
        52 - i * 3,
        3,
        55 + i * 3,
      );
      rect(
        c,
        ["#47524a", "#626b57", "#7e8266", "#999575"][i]!,
        131 + i * 3,
        49 - i * 3,
        57 - i * 6,
        3,
      );
    }
    rect(c, "#b5a577", 156, 35, 8, 9);
    for (let i = 0; i < 4; i++) {
      rect(c, "#686d54", 138 - i * 2, 94 + i * 5, 44 + i * 4, 2);
      rect(c, "#303c36", 138 - i * 2, 96 + i * 5, 44 + i * 4, 3);
    }
    // Lantern pools use hard pixel bands, never blurred light.
    for (const x of [116, 196]) {
      rect(c, "#514d35", x - 9, 107, 18, 3);
      rect(c, "#403f30", x - 13, 110, 26, 4);
      torch(c, x - 8, 76);
    }
    // Paired plinths, broken side paving and clustered moss frame the approach.
    for (const x of [65, 239]) {
      for (const y of [133, 185]) {
        rect(c, "#202d2c", x - 5, y + 17, 25, 5);
        rect(c, "#535e50", x, y, 16, 19);
        rect(c, "#7e8569", x - 2, y - 3, 20, 5);
        rect(c, "#a0a080", x - 2, y - 3, 20, 1);
        rect(c, "#37483d", x + 12, y + 2, 4, 17);
        rect(c, "#6c7d4e", x + 2, y + 2, 3, 7);
      }
    }
    for (let i = 0; i < 65; i++) {
      const side = i % 2 ? 49 : 248;
      const x = side + ((i * 17) % 22),
        y = 118 + ((i * 23) % 125);
      rect(c, ["#33493f", "#4e6348", "#697a50"][i % 3]!, x, y, 2 + (i % 3), 2);
    }
    const dog = images.get("dog");
    if (dog) c.drawImage(dog, 181, 205);
    const introArt = heroArt("ranger");
    const hero = images.get(`${introArt}-motion`);
    const width = 16;
    const moving = now < this.intro.moved + 140;
    const t = this.reducedMotion.matches
      ? 1
      : Math.min(1, (now - this.intro.moved) / 100);
    const x = Math.round(
      this.intro.fromX + (this.intro.x - this.intro.fromX) * t,
    );
    let y = Math.round(
      this.intro.fromY + (this.intro.y - this.intro.fromY) * t,
    );
    const pull =
      portal === null ? 0 : Math.max(0, Math.min(1, (portal - 0.12) / 0.64));
    const easedPull = pull * pull * (3 - 2 * pull);
    y -= Math.round(easedPull * 34);
    const shadowWidth = Math.max(2, 12 - Math.round(easedPull * 10));
    rect(c, "#202b29", x - Math.floor(shadowWidth / 2), y - 2, shadowWidth, 3);
    if (hero) {
      const frame = this.reducedMotion.matches
        ? 0
        : Math.floor(now / (moving ? 100 : 167)) % 6;
      const dissolve =
        portal === null ? 0 : Math.max(0, Math.min(1, (portal - 0.5) / 0.32));
      c.save();
      c.globalAlpha = Math.max(0.25, Math.ceil((1 - dissolve) * 4) / 4);
      c.drawImage(
        hero,
        this.intro.facing * 6 * width + frame * width,
        moving && !this.reducedMotion.matches ? 32 : 0,
        width,
        32,
        x - width / 2,
        y - 32,
        width,
        32,
      );
      c.restore();
      if (dissolve) {
        // Deterministic two-pixel fragments replace the traveler from the feet
        // upward, retaining the sprite's fixed pivot throughout the effect.
        for (let py = 0; py < 16; py += 2)
          for (let px = 0; px < 16; px += 2) {
            const order = ((px * 13 + py * 7) % 31) / 31;
            if (order > dissolve) continue;
            const lift = Math.floor(dissolve * (8 + ((px + py) % 9)));
            rect(
              c,
              (px + py) % 4 ? "#d8bb75" : "#8fa078",
              x - 8 + px,
              y - 16 + py - lift,
              2,
              2,
            );
          }
      }
    }
    if (portal !== null) {
      const flare = Math.max(0, Math.min(1, (portal - 0.68) / 0.32)),
        reach = Math.floor(flare * 86);
      // A final pixel flare closes over the threshold in discrete rays and a
      // checker veil instead of a smooth gradient or blur.
      for (let i = 0; i < 7; i++) {
        const width = Math.max(2, reach - i * 10);
        rect(
          c,
          i % 2 ? "#c6ae6d" : "#6f8269",
          160 - Math.floor(width / 2),
          55 + i * 7,
          width,
          2,
        );
      }
      if (flare > 0.55)
        for (let py = 0; py < 256; py += 4)
          for (let px = 0; px < 320; px += 4)
            if (((px / 4 + py / 4) | 0) % 5 < Math.floor(flare * 4) - 1)
              rect(c, "#d9c585", px, py, 2, 2);
    }
    c.restore();
  }
}
