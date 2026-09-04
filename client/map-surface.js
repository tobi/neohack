// Lifecycle, fallback and input handling for the presentation-only map.
import { LitElement, html, css, nothing } from "lit";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  prepareMap,
  mapWindow,
  describeCell,
  glyph,
  MAP_LIMITS,
} from "./map-presentation.js";
const MARKS = {
  wall: "#",
  floor: ".",
  corridor: "#",
  closedDoor: "+",
  openDoor: "·",
  stairsUp: "<",
  stairsDown: ">",
  fountain: "{",
  sink: "#",
  water: "~",
  lava: "~",
  altar: "_",
  trap: "^",
  bars: "#",
  tree: "T",
  grave: "|",
  ice: ".",
};

export class MapSurface extends LitElement {
  static properties = {
    observation: { attribute: false },
    worldKey: { type: String, attribute: "world-key" },
    selected: { attribute: false },
    follow: { type: Boolean, reflect: true },
    cutaway: { type: Boolean, reflect: true },
    labels: { type: Boolean },
    animateMoves: { type: Boolean },
    fallback: { state: true },
    failure: { state: true },
    _cursor: { state: true },
    _mapWarning: { state: true },
    _rendererState: { state: true },
  };
  static styles = css`
    :host {
      display: block;
      position: relative;
      min-height: 330px;
      height: 100%;
      background: radial-gradient(ellipse at 45% 45%, #1d2b2e, #0c1318 75%);
      overflow: hidden;
      border-radius: inherit;
    }
    .viewport {
      position: absolute;
      inset: 0;
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
      touch-action: none;
    }
    canvas:focus-visible,
    .grid:focus-visible {
      outline: 2px solid #96e8be;
      outline-offset: -3px;
    }
    .tools {
      position: absolute;
      right: 13px;
      top: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      max-width: calc(100% - 26px);
      z-index: 2;
    }
    button {
      font:
        12px system-ui,
        sans-serif;
      color: #d9e5e0;
      background: #122026f5;
      border: 1px solid #3b514f;
      border-radius: 6px;
      padding: 6px 9px;
      cursor: pointer;
      box-shadow: 0 3px 8px #0003;
    }
    button[aria-pressed="true"] {
      color: #92e0bf;
      border-color: #638e78;
    }
    button:hover {
      background: #324740;
    }
    button:disabled {
      opacity: 0.45;
      cursor: default;
    }
    button:focus-visible {
      outline: 2px solid #96e8be;
      outline-offset: 2px;
    }
    .hint {
      position: absolute;
      left: 14px;
      right: 14px;
      bottom: 10px;
      color: #a7bcbe;
      font:
        10px ui-monospace,
        monospace;
      pointer-events: none;
      text-shadow: 0 1px 3px #000;
    }
    .empty {
      position: absolute;
      inset: 0;
      display: grid;
      place-content: center;
      text-align: center;
      gap: 12px;
      color: #97aaa9;
      font:
        14px system-ui,
        sans-serif;
      pointer-events: none;
    }
    .empty strong {
      color: #dce9df;
      font-size: 21px;
    }
    .empty b {
      font:
        42px ui-monospace,
        monospace;
      color: #8dd7b3;
    }
    .fallback {
      position: absolute;
      inset: 86px 12px 75px;
      overflow: auto;
      overscroll-behavior: contain;
    }
    .grid {
      width: max-content;
      min-width: 100%;
      font:
        16px/1.25 ui-monospace,
        monospace;
      color: #dedbc6;
      outline: none;
    }
    .row {
      display: flex;
      width: max-content;
    }
    .cell {
      display: inline-grid;
      place-items: center;
      width: 1.2em;
      height: 1.35em;
      box-sizing: border-box;
      cursor: crosshair;
    }
    .cell[data-known="true"]:hover {
      background: #36524a;
    }
    .cell[aria-selected="true"] {
      outline: 2px solid #f1ca7c;
      background: #34554d;
      color: #fff;
    }
    .cell[data-kind="self"] {
      color: #9befc5;
    }
    .cell[data-kind="ally"] {
      color: #a7c9ff;
    }
    .cell[data-kind="creature"] {
      color: #f0b5a0;
    }
    .failure {
      position: absolute;
      left: 14px;
      right: 14px;
      top: 50px;
      color: #eed0b1;
      font:
        11px/1.35 system-ui,
        sans-serif;
      pointer-events: none;
    }
    .selection {
      position: absolute;
      left: 14px;
      right: 14px;
      bottom: 36px;
      font:
        11px/1.35 ui-monospace,
        monospace;
      color: #e8c78c;
      background: #132026ed;
      border: 1px solid #705b38;
      padding: 6px 10px;
      border-radius: 6px;
      pointer-events: none;
      max-height: 3em;
      overflow: hidden;
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `;
  constructor() {
    super();
    this.observation = null;
    this.selected = null;
    this.follow = true;
    this.cutaway = true;
    this.labels = true;
    this.animateMoves = true;
    this.fallback = false;
    this.failure = "";
    this._cursor = null;
    this._mapWarning = "";
    this._rendererState = "empty";
    this._frame = 0;
    this._last = 0;
    this._renderedFrames = 0;
    this._key = "";
    this._actors = new Map();
    this._materials = new Map();
    this._textures = new Map();
    this._cells = new Map();
    this._sources = new Map();
    this._target = new THREE.Vector3();
    this._preferred2D = false;
    this._contextLost = false;
    this._inView = true;
    this._failureKind = null;
    this._onVisibility = () =>
      document.hidden ? this._stopAnimation() : this._animate();
    this._onMotion = () => {
      this._reducedMotion = this._motion?.matches ?? false;
      if (this.controls) this.controls.enableDamping = !this._reducedMotion;
      this._sync();
    };
  }
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this._onVisibility);
    this._motion = matchMedia("(prefers-reduced-motion: reduce)");
    this._reducedMotion = this._motion.matches;
    this._motion.addEventListener("change", this._onMotion);
    if (typeof IntersectionObserver !== "undefined") {
      this._intersection = new IntersectionObserver((entries) => {
        this._inView = entries[0]?.isIntersecting ?? true;
        if (this._inView) {
          this._sync();
          this._animate();
        } else this._stopAnimation();
      });
      this._intersection.observe(this);
    }
    if (this.hasUpdated)
      this.updateComplete.then(() => {
        if (this.isConnected) this._init();
      });
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._motion?.removeEventListener("change", this._onMotion);
    this._intersection?.disconnect();
    this._intersection = null;
    this._dispose();
    this._cells.clear();
    this._sources.clear();
    this._setState("detached");
  }
  firstUpdated() {
    this._init();
  }
  willUpdate(changed) {
    if (changed.has("observation") || changed.has("worldKey")) this._prepare();
  }
  updated(changed) {
    if (
      ["observation", "cutaway", "worldKey", "animateMoves"].some((k) =>
        changed.has(k),
      )
    )
      this._sync();
    if (changed.has("selected") || changed.has("_cursor")) {
      this._selection();
      this._animate();
      this._scrollCursor();
    }
    if (changed.has("labels")) {
      for (const a of this._actors.values())
        if (a.label) a.label.visible = this.labels;
      this._animate();
    }
    if (changed.has("fallback")) this._scrollCursor();
    if (changed.has("follow")) {
      this.emit("view-follow", { follow: this.follow });
      this._animate();
    }
  }
  emit(name, detail) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true }),
    );
  }
  _setState(state) {
    if (this._rendererState !== state) {
      this._rendererState = state;
      this.emit("renderer-state", { state, message: this.failure });
    }
  }
  _prepare() {
    const data = prepareMap(this.observation);
    this._cells = new Map(data.cells.map((c) => [`${c.x},${c.y}`, c]));
    this._sources = data.sources;
    this._bounds = data.bounds;
    this._complex = data.complex;
    this._mapWarning = data.warning;
    const scope = JSON.stringify([
      this.worldKey ?? "",
      this.observation?.location?.id,
    ]);
    if (scope !== this._dataScope) {
      this._cursor = null;
      this._dataScope = scope;
    }
    if (
      this._cursor &&
      this._bounds &&
      (this._cursor.x < this._bounds.minX ||
        this._cursor.x > this._bounds.maxX ||
        this._cursor.y < this._bounds.minY ||
        this._cursor.y > this._bounds.maxY)
    )
      this._cursor = null;
    if (!this._complex && this._failureKind === "complexity") {
      this.failure = "";
      this._failureKind = null;
      this.fallback = this._preferred2D;
    }
    return data.cells;
  }
  _ensureSurface() {
    if (!this.observation) {
      this._dispose();
      this._setState("empty");
      return false;
    }
    if (this._complex) {
      this._dispose();
      this._failureKind = "complexity";
      this.failure = `Detailed 3D scene exceeds ${MAP_LIMITS.detailed} features. All accepted cells remain inspectable in the bounded 2D grid.`;
      this.fallback = true;
      this._setState("limited");
      return false;
    }
    if (!this.renderer) {
      if (!this._preferred2D && !this.failure && !this._contextLost)
        this._init();
      return false;
    }
    return !this.fallback && !this._contextLost;
  }
  _init() {
    if (this.renderer || !this.isConnected) return !!this.renderer;
    this._prepare();
    if (!this.observation) {
      this._setState("empty");
      return false;
    }
    if (this._complex) {
      this._ensureSurface();
      return false;
    }
    if (this._preferred2D) {
      this.fallback = true;
      this._setState("2d");
      return false;
    }
    this._setState("initializing");
    try {
      const canvas = document.createElement("canvas");
      this._canvas = canvas;
      this._gl = canvas.getContext("webgl2", {
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
      if (!this._gl)
        throw Error(
          "WebGL 2 is unavailable. The keyboard-accessible 2D map is available.",
        );
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        context: this._gl,
        antialias: true,
        alpha: true,
      });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.35;
      canvas.tabIndex = 0;
      canvas.setAttribute("role", "img");
      canvas.setAttribute(
        "aria-label",
        "3D perceived map. Arrow keys explore tiles; Enter inspects. Home returns to you. Use 2D for a screen-reader grid.",
      );
      canvas.setAttribute("aria-describedby", "map-help");
      this.renderRoot.querySelector(".viewport").append(canvas);
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1000);
      this.camera.position.set(12, 16, 17);
      this.controls = new OrbitControls(this.camera, canvas);
      this.controls.enableDamping = !this._reducedMotion;
      this.controls.dampingFactor = 0.1;
      this.controls.minPolarAngle = 0.15;
      this.controls.maxPolarAngle = 1.2;
      this.controls.minDistance = 5;
      this.controls.maxDistance = 1000;
      this.controls.maxTargetRadius = 30000;
      this.controls.addEventListener("change", () => this._animate());
      this.scene.add(new THREE.HemisphereLight(0xcfe2dd, 0x37302b, 2.1));
      this.sun = new THREE.DirectionalLight(0xffdbad, 3.2);
      this.sun.position.set(10, 25, 12);
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      Object.assign(this.sun.shadow.camera, {
        left: -24,
        right: 24,
        top: 24,
        bottom: -24,
      });
      this.sun.shadow.normalBias = 0.08;
      this.sun.shadow.bias = -0.0003;
      this.scene.add(this.sun, this.sun.target);
      const fill = new THREE.DirectionalLight(0x8ab2d1, 1.1);
      fill.position.set(-8, 7, -10);
      this.scene.add(fill);
      this.torch = new THREE.PointLight(0xffbf75, 14, 11, 1.7);
      this.scene.add(this.torch);
      this.staticGroup = new THREE.Group();
      this.actorGroup = new THREE.Group();
      this.scene.add(this.staticGroup, this.actorGroup);
      this.geometries = {
        box: new THREE.BoxGeometry(1, 1, 1),
        cylinder: new THREE.CylinderGeometry(1, 1, 1, 10),
        sphere: new THREE.SphereGeometry(1, 12, 8),
        cone: new THREE.ConeGeometry(1, 1, 8),
      };
      this.outline = new THREE.Mesh(
        new THREE.RingGeometry(0.46, 0.495, 32),
        new THREE.MeshBasicMaterial({
          color: 0xf3c877,
          side: THREE.DoubleSide,
          depthTest: false,
        }),
      );
      this.outline.rotation.x = -Math.PI / 2;
      this.outline.visible = false;
      this.outline.renderOrder = 10;
      this.scene.add(this.outline);
      this._ray = new THREE.Raycaster();
      this._ndc = new THREE.Vector2();
      this._canvasEvents = new AbortController();
      const options = { signal: this._canvasEvents.signal };
      let down = null;
      canvas.addEventListener(
        "pointerdown",
        (e) => {
          down = { x: e.clientX, y: e.clientY };
          canvas.focus({ preventScroll: true });
        },
        options,
      );
      canvas.addEventListener(
        "pointermove",
        (e) => {
          if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) {
            this.follow = false;
          }
        },
        options,
      );
      canvas.addEventListener(
        "pointerup",
        (e) => {
          if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
            const tile = this.tileAt(e.clientX, e.clientY);
            if (tile) this.inspectAt(tile.x, tile.y);
          }
          down = null;
        },
        options,
      );
      canvas.addEventListener("pointercancel", () => (down = null), options);
      canvas.addEventListener("keydown", (e) => this._inspectKey(e), options);
      canvas.addEventListener(
        "webglcontextlost",
        (e) => {
          e.preventDefault();
          this._contextLost = true;
          this._failureKind = "context";
          this.failure =
            "WebGL context lost. Continue with the 2D map or retry 3D.";
          this.fallback = true;
          this._stopAnimation();
          this._setState("lost");
          this.emit("renderer-error", { message: this.failure });
          const focused = this.renderRoot.activeElement === canvas;
          this.updateComplete.then(() => {
            if (focused)
              this.renderRoot
                .querySelector(".grid")
                ?.focus({ preventScroll: true });
          });
        },
        options,
      );
      canvas.addEventListener(
        "webglcontextrestored",
        () => {
          if (!this.isConnected) return;
          const focused =
            this.renderRoot.activeElement?.classList.contains("grid");
          this._dispose();
          this.failure = "";
          this._failureKind = null;
          this.fallback = this._preferred2D;
          if (!this._preferred2D) this._init();
          this.updateComplete.then(() => {
            if (focused && !this.fallback)
              this._canvas?.focus({ preventScroll: true });
          });
        },
        options,
      );
      this.failure = "";
      this._failureKind = null;
      this._contextLost = false;
      this.fallback = false;
      this._resizeObserver = new ResizeObserver(() => this._resize());
      this._resizeObserver.observe(this);
      this._resize();
      this._sync();
      if (!this.renderer || this.fallback) return false;
      this._animate();
      this._setState("ready");
      return true;
    } catch (error) {
      this._fail(error, "initialization");
      return false;
    }
  }
  _fail(error, kind = "render") {
    this._dispose();
    this._failureKind = kind;
    this.failure = `3D unavailable: ${error?.message ?? String(error)}`;
    this.fallback = true;
    this._setState("failed");
    this.emit("renderer-error", { message: this.failure });
  }
  show2D() {
    this._preferred2D = true;
    this._dispose();
    this._failureKind = null;
    this.failure = "";
    this.fallback = true;
    this._prepare();
    this._setState("2d");
  }
  retry3D() {
    this._preferred2D = false;
    this._dispose();
    this.failure = "";
    this._failureKind = null;
    this.fallback = false;
    return this._init();
  }
  _hero() {
    const p = this.observation?.you;
    return p &&
      Number.isSafeInteger(p.x) &&
      Number.isSafeInteger(p.y) &&
      this._cells.has(`${p.x},${p.y}`)
      ? p
      : null;
  }
  _point() {
    return (
      this._cursor ??
      this._hero() ??
      (this._bounds ? { x: this._bounds.minX, y: this._bounds.minY } : null)
    );
  }
  _inspectKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const moves = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      PageUp: [0, -10],
      PageDown: [0, 10],
    };
    if (
      !(e.key in moves) &&
      !["Enter", " ", "Home", "End", "Escape"].includes(e.key)
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    const p = this._point(),
      b = this._bounds;
    if (!p || !b) return;
    if (e.key === "Escape") {
      e.currentTarget.blur();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      this.inspectAt(p.x, p.y);
      return;
    }
    if (e.key === "Home") {
      this._cursor = { ...(this._hero() ?? { x: b.minX, y: b.minY }) };
      return;
    }
    if (e.key === "End") {
      const last = [...this._cells.values()].at(-1);
      this._cursor = { x: last.x, y: last.y };
      return;
    }
    const [dx, dy] = moves[e.key];
    this._cursor = {
      x: Math.max(b.minX, Math.min(b.maxX, p.x + dx)),
      y: Math.max(b.minY, Math.min(b.maxY, p.y + dy)),
    };
  }
  inspectAt(x, y) {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return false;
    const cell = this._sources.get(`${x},${y}`);
    if (!cell) return false;
    this._cursor = { x, y };
    this.selected = cell;
    this.emit("tile-select", cell);
    return true;
  }
  _selection() {
    if (!this.outline) return;
    const p = this._cursor ?? this.selected;
    this.outline.visible =
      !!p &&
      Number.isSafeInteger(p.x) &&
      Number.isSafeInteger(p.y) &&
      this._cells.has(`${p.x},${p.y}`);
    if (this.outline.visible) this.outline.position.set(p.x, 0.11, p.y);
  }
  _scrollCursor() {
    if (!this.fallback) return;
    const view = this.renderRoot.querySelector(".fallback"),
      cell = this.renderRoot.querySelector("#cursor-cell");
    if (!view || !cell) return;
    const a = cell.getBoundingClientRect(),
      b = view.getBoundingClientRect();
    if (a.left < b.left) view.scrollLeft -= b.left - a.left;
    else if (a.right > b.right) view.scrollLeft += a.right - b.right;
    if (a.top < b.top) view.scrollTop -= b.top - a.top;
    else if (a.bottom > b.bottom) view.scrollTop += a.bottom - b.bottom;
  }
  _resize() {
    if (!this.renderer || !this.camera) return;
    const w = this.clientWidth,
      h = this.clientHeight;
    if (!w || !h) {
      this._needsFitOnShow = true;
      this._stopAnimation();
      return;
    }
    if (this._needsFitOnShow) {
      this._hasFit = false;
      this._needsFitOnShow = false;
    }
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this._hasFit) this._sync();
    this._animate();
  }
  _stopAnimation() {
    cancelAnimationFrame(this._frame);
    this._frame = 0;
    this._last = 0;
  }
  _drawable() {
    return (
      this.renderer &&
      this.isConnected &&
      !document.hidden &&
      this._inView &&
      !this.fallback &&
      !this._contextLost &&
      this.clientWidth > 0 &&
      this.clientHeight > 0
    );
  }
  _animate() {
    if (this._frame || !this._drawable()) return;
    this._frame = requestAnimationFrame((time) => {
      if (!this._drawable()) {
        this._frame = 0;
        return;
      }
      try {
        const dt = Math.min((time - (this._last || time - 16)) / 1000, 0.1);
        this._last = time;
        const smooth = this.animateMoves && !this._reducedMotion;
        let moving = false;
        for (const a of this._actors.values()) {
          if (smooth && a.group.position.distanceToSquared(a.to) > 0.000001) {
            a.group.position.lerp(a.to, 1 - Math.exp(-dt * 15));
            moving = true;
          } else a.group.position.copy(a.to);
        }
        if (this.follow && this._hero()) {
          const delta = this._target.clone().sub(this.controls.target);
          if (delta.lengthSq() > 0.000001) {
            if (smooth) {
              delta.multiplyScalar(1 - Math.exp(-dt * 7));
              moving = true;
            }
            this.controls.target.add(delta);
            this.camera.position.add(delta);
          }
        }
        const changed = this.controls.update();
        const near = Math.max(
          0.1,
          Math.min(
            10,
            this.camera.position.distanceTo(this.controls.target) / 200,
          ),
        );
        if (Math.abs(near - this.camera.near) > 0.0001) {
          this.camera.near = near;
          this.camera.updateProjectionMatrix();
        }
        this.renderer.render(this.scene, this.camera);
        this._renderedFrames++;
        this._frame = 0;
        if (moving || changed) this._animate();
      } catch (error) {
        this._frame = 0;
        this._fail(error);
      }
    });
  }
  fit() {
    if (this.fallback) {
      this._cursor = null;
      return;
    }
    if (!this.controls || !this._bounds) return;
    const b = this._bounds,
      cx = (b.minX + b.maxX) / 2,
      cz = (b.minY + b.maxY) / 2;
    const target = new THREE.Vector3(cx, 0, cz),
      direction = new THREE.Vector3(0.72, 1.05, 0.86).normalize();
    this.camera.position.copy(target).add(direction);
    this.camera.lookAt(target);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(
        this.camera.quaternion,
      ),
      up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)),
      tanH = tanV * this.camera.aspect;
    let distance = 7;
    for (const x of [b.minX - 0.5, b.maxX + 0.5])
      for (const z of [b.minY - 0.5, b.maxY + 0.5])
        for (const y of [-0.5, 2]) {
          const point = new THREE.Vector3(x, y, z).sub(target);
          distance = Math.max(
            distance,
            point.dot(direction) +
              1.2 *
                Math.max(
                  Math.abs(point.dot(right)) / tanH,
                  Math.abs(point.dot(up)) / tanV,
                ),
          );
        }
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(direction, distance);
    this.controls.maxDistance = Math.max(100, distance * 4);
    this.camera.far = Math.max(1000, distance * 8);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.follow = false;
    this._animate();
  }
  focusSelf() {
    const p = this._hero();
    if (!p) return;
    this.follow = true;
    if (this.fallback) {
      this._cursor = { x: p.x, y: p.y };
      return;
    }
    if (!this.controls) return;
    const delta = new THREE.Vector3(p.x, 0, p.y).sub(this.controls.target);
    this.camera.position.add(delta);
    this.controls.target.add(delta);
    const offset = this.camera.position.clone().sub(this.controls.target);
    if (offset.length() > 24)
      this.camera.position.copy(this.controls.target).add(offset.setLength(24));
    this.controls.update();
    this._animate();
  }
  rotate() {
    if (!this.controls || this.fallback) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
    this._animate();
  }
  tileAt(x, y) {
    if (!this.pickMesh || !this.renderer || this.fallback || this._contextLost)
      return null;
    const r = this._canvas.getBoundingClientRect();
    this._ndc.set(
      ((x - r.left) / r.width) * 2 - 1,
      -((y - r.top) / r.height) * 2 + 1,
    );
    this._ray.setFromCamera(this._ndc, this.camera);
    const hit = this._ray.intersectObject(this.pickMesh)[0],
      cell =
        hit?.instanceId !== undefined ? this.pickCells[hit.instanceId] : null;
    return cell ? (this._sources.get(`${cell.x},${cell.y}`) ?? null) : null;
  }
  debug() {
    return {
      tiles: this._cells.size,
      actors: this._actors.size,
      renderer: !!this.renderer,
      fallback: this.fallback,
      state: this._rendererState,
      contextLost: this._contextLost,
      animationScheduled: !!this._frame,
      renderedFrames: this._renderedFrames,
      textures: this._textures.size,
      materials: this._materials.size,
      reducedMotion: !!this._reducedMotion,
      drawCalls: this.renderer?.info.render.calls,
      triangles: this.renderer?.info.render.triangles,
      geometries: this.renderer?.info.memory.geometries,
    };
  }
  _pruneTextures() {
    const used = new Set();
    this.scene?.traverse((o) => {
      if (o.isSprite && o.material.map) used.add(o.material.map);
    });
    for (const [key, texture] of this._textures)
      if (!used.has(texture)) {
        texture.dispose();
        this._textures.delete(key);
      }
  }
  _destroyActor(a) {
    a.ring?.geometry.dispose();
    a.ring?.material.dispose();
    a.label?.material.dispose();
  }
  _dispose() {
    this._stopAnimation();
    this._canvasEvents?.abort();
    this._canvasEvents = null;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this.controls?.dispose();
    for (const a of this._actors.values()) this._destroyActor(a);
    this.staticGroup?.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
      if (o.isSprite) o.material.dispose();
    });
    this._actors.clear();
    for (const t of this._textures.values()) t.dispose();
    this._textures.clear();
    for (const m of this._materials.values()) m.dispose();
    this._materials.clear();
    for (const g of Object.values(this.geometries ?? {})) g.dispose();
    this.outline?.geometry.dispose();
    this.outline?.material.dispose();
    this.sun?.shadow.dispose();
    try {
      this.renderer?.dispose();
      if (this._gl && !this._gl.isContextLost())
        this._gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {}
    this._canvas?.remove();
    for (const key of [
      "renderer",
      "scene",
      "camera",
      "controls",
      "geometries",
      "outline",
      "sun",
      "torch",
      "staticGroup",
      "actorGroup",
      "pickMesh",
      "pickCells",
      "_canvas",
      "_gl",
      "_ray",
      "_ndc",
    ])
      this[key] = null;
    this._contextLost = false;
    this._key = "";
    this._location = null;
    this._hasFit = false;
  }
  _grid() {
    const b = this._bounds,
      p = this._point(),
      view = mapWindow(b, p);
    if (!view) return nothing;
    return html`<div class="fallback">
      <div
        class="grid"
        role="grid"
        tabindex="0"
        aria-label="Perceived dungeon. Arrows explore; Enter inspects; Home returns to you; Escape leaves the map."
        aria-describedby="map-help"
        aria-rowcount=${b.maxY - b.minY + 1}
        aria-colcount=${b.maxX - b.minX + 1}
        aria-activedescendant=${p ? "cursor-cell" : nothing}
        @keydown=${(e) => this._inspectKey(e)}
      >
        ${Array.from({ length: view.height }, (_, dy) => {
          const y = view.y + dy;
          return html`<div
            class="row"
            role="row"
            aria-rowindex=${y - b.minY + 1}
          >
            ${Array.from({ length: view.width }, (_, dx) => {
              const x = view.x + dx,
                c = this._cells.get(`${x},${y}`),
                active = p?.x === x && p?.y === y;
              return html`<span
                class="cell"
                role="gridcell"
                id=${active ? "cursor-cell" : nothing}
                aria-colindex=${x - b.minX + 1}
                aria-selected=${active}
                aria-label=${describeCell(this._sources.get(`${x},${y}`), x, y)}
                data-known=${!!c}
                data-kind=${c?.occupant?.kind ?? ""}
                @click=${() => {
                  this._cursor = { x, y };
                  this.inspectAt(x, y);
                  this.renderRoot
                    .querySelector(".grid")
                    ?.focus({ preventScroll: true });
                }}
                >${c
                  ? (c.occupant?.mark ??
                    c.objects[0]?.mark ??
                    MARKS[c.terrain.type] ??
                    "·")
                  : " "}</span
              >`;
            })}
          </div>`;
        })}
      </div>
    </div>`;
  }
  render() {
    const p = this._cursor ?? this.selected,
      description = p
        ? describeCell(this._sources.get(`${p.x},${p.y}`), p.x, p.y)
        : "";
    return html`<div class="viewport" ?hidden=${this.fallback}></div>
      ${this.fallback ? this._grid() : nothing}
      <div
        class="tools"
        role="group"
        aria-label="Map view controls"
        @keydown=${(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this.renderRoot.activeElement?.blur();
          }
        }}
      >
        <button
          @click=${() => this.fit()}
          ?disabled=${!this._bounds}
          title="Fit known map"
        >
          ${this.fallback ? "Reset" : "Fit"}
        </button>
        <button
          @click=${() =>
            this.follow && !this.fallback
              ? (this.follow = false)
              : this.focusSelf()}
          ?disabled=${!this._hero()}
          aria-pressed=${this.fallback ? nothing : this.follow}
        >
          ${this.fallback ? "You" : "Follow"}
        </button>
        <button
          @click=${() => this.rotate()}
          ?disabled=${this.fallback || !this.renderer}
          aria-label="Rotate map quarter turn"
        >
          ↻
        </button>
        <button
          @click=${() => (this.cutaway = !this.cutaway)}
          ?disabled=${this.fallback}
          aria-pressed=${this.cutaway}
        >
          Cutaway
        </button>
        <button
          @click=${() => (this.fallback ? this.retry3D() : this.show2D())}
          ?disabled=${this._complex}
        >
          ${this.fallback ? (this.failure ? "Retry 3D" : "3D") : "2D"}
        </button>
      </div>
      ${description
        ? html`<div class="selection">${description}</div>`
        : nothing}
      <div class="sr" aria-live="polite">${description}</div>
      ${this.failure || this._mapWarning
        ? html`<div class="failure" role="status">
            ${this.failure} ${this._mapWarning}
          </div>`
        : nothing}
      ${!this.observation
        ? html`<div class="empty">
            <b>◇</b><strong>A dungeon worth exploring.</strong
            ><span>Start a world, or open a recorded expedition.</span>
          </div>`
        : nothing}
      <div class="hint" id="map-help">
        ${this.fallback
          ? "2D window · arrows / Page Up / Page Down to explore · Enter to inspect"
          : "Drag to orbit · scroll to zoom · focused arrows explore tiles · Enter inspects"}
        · Escape leaves map focus
      </div>`;
  }
}
