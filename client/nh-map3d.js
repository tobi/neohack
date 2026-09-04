// A reusable presentation-only component. Both live play and replay supply
// the same observation. No engine calls, pathfinding, or hidden terrain here.
import { LitElement, html, css, nothing } from "lit";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const PALETTE = [
  0x161616, 0xba534d, 0x69a467, 0xab8253, 0x6486cb, 0xb480b9, 0x6cacb1,
  0xc4c6be, 0x89918e, 0xe89459, 0x91ca75, 0xe7cc84, 0x8ca9e2, 0xdba2d2,
  0x8bd4d2, 0xeae9dc,
];
const MARKS = {
  wall: "#",
  floor: ".",
  corridor: "#",
  closedDoor: "+",
  openDoor: "·",
  stairsUp: "<",
  stairsDown: ">",
  fountain: "{",
  water: "~",
  lava: "~",
  altar: "_",
  trap: "^",
  bars: "#",
  tree: "T",
  grave: "|",
  ice: ".",
};
const jitter = (x, y) =>
  ((Math.imul(x + 31, 73856093) ^ Math.imul(y + 71, 19349663)) >>> 0) /
  4294967295;
const valid = (t) =>
  t &&
  Number.isFinite(t.x) &&
  Number.isFinite(t.y) &&
  (!["unknown", "dark"].includes(t.terrain?.type) ||
    (t.occupant?.mark && t.occupant.mark !== "\\u0000") ||
    t.objects?.length);

export class NhMap3D extends LitElement {
  static properties = {
    observation: { attribute: false },
    selected: { attribute: false },
    follow: { type: Boolean, reflect: true },
    cutaway: { type: Boolean, reflect: true },
    labels: { type: Boolean },
    animateMoves: { type: Boolean },
    fallback: { state: true },
    failure: { state: true },
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
      outline: none;
      touch-action: none;
    }
    .viewport {
      position: absolute;
      inset: 0;
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
      outline: none;
    }
    .tools {
      position: absolute;
      right: 13px;
      top: 12px;
      display: flex;
      gap: 5px;
      z-index: 2;
    }
    .tools button {
      font:
        12px system-ui,
        sans-serif;
      color: #d9e5e0;
      background: #122026e8;
      border: 1px solid #3b514f;
      border-radius: 6px;
      padding: 6px 9px;
      cursor: pointer;
      box-shadow: 0 3px 8px #0003;
    }
    .tools button[aria-pressed="true"] {
      color: #92e0bf;
      border-color: #638e78;
    }
    .tools button:hover {
      background: #324740;
    }
    .tools button:focus-visible {
      outline: 2px solid #96e8be;
      outline-offset: 2px;
    }
    .hint {
      position: absolute;
      left: 14px;
      bottom: 11px;
      color: #91a8ac;
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
      inset: 46px 12px 32px;
      overflow: auto;
      display: grid;
      place-content: center;
    }
    .fallback pre {
      margin: 0;
      font:
        16px/1.2 ui-monospace,
        monospace;
      letter-spacing: 2px;
      color: #ddd7b6;
    }
    .failure {
      position: absolute;
      left: 12px;
      top: 12px;
      max-width: 60%;
      color: #e3b9a4;
      font:
        11px system-ui,
        sans-serif;
    }
    .selection {
      position: absolute;
      left: 14px;
      top: 12px;
      font:
        11px ui-monospace,
        monospace;
      color: #e8c78c;
      background: #132026db;
      border: 1px solid #705b38;
      padding: 6px 10px;
      border-radius: 6px;
      pointer-events: none;
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
    this._frame = 0;
    this._key = "";
    this._actors = new Map();
    this._materials = new Map();
    this._textures = new Map();
    this._target = new THREE.Vector3();
    this._last = 0;
    this._onVisibility = () => {
      if (!document.hidden) this._animate();
    };
  }
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this._onVisibility);
    if (this.hasUpdated) this.updateComplete.then(() => this._init());
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._dispose();
  }
  firstUpdated() {
    this._init();
  }
  updated(changed) {
    if (changed.has("observation") || changed.has("cutaway")) this._sync();
    if (changed.has("selected")) this._selection();
    if (changed.has("labels"))
      for (const a of this._actors.values())
        if (a.label) a.label.visible = this.labels;
  }
  emit(name, detail) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true }),
    );
  }
  _init() {
    if (this.renderer || !this.isConnected) return;
    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.35;
      const canvas = this.renderer.domElement;
      canvas.tabIndex = 0;
      canvas.setAttribute(
        "aria-label",
        "3D dungeon. Drag to orbit, right-drag to pan, scroll to zoom, click to inspect.",
      );
      this.renderRoot.querySelector(".viewport").append(canvas);
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 250);
      this.camera.position.set(12, 16, 17);
      this.controls = new OrbitControls(this.camera, canvas);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.1;
      this.controls.minPolarAngle = 0.15;
      this.controls.maxPolarAngle = 1.2;
      this.controls.minDistance = 5;
      this.controls.maxDistance = 100;
      this.controls.maxTargetRadius = 150;
      this.scene.add(new THREE.HemisphereLight(0xcfe2dd, 0x37302b, 2.1));
      this.sun = new THREE.DirectionalLight(0xffdbad, 3.2);
      this.sun.position.set(10, 25, 12);
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      this.sun.shadow.camera.left = -24;
      this.sun.shadow.camera.right = 24;
      this.sun.shadow.camera.top = 24;
      this.sun.shadow.camera.bottom = -24;
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
      let down = null;
      canvas.addEventListener("pointerdown", (e) => {
        down = { x: e.clientX, y: e.clientY };
        canvas.focus();
      });
      canvas.addEventListener("pointermove", (e) => {
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) {
          this.follow = false;
          this.emit("view-follow", { follow: false });
        }
      });
      canvas.addEventListener("pointerup", (e) => {
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
          const tile = this.tileAt(e.clientX, e.clientY);
          if (tile) this.emit("tile-select", tile);
        }
        down = null;
      });
      canvas.addEventListener("pointercancel", () => (down = null));
      canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        this.failure =
          "WebGL context lost. The accessible map is still available.";
        this.fallback = true;
        cancelAnimationFrame(this._frame);
        this._frame = 0;
      });
      this._resizeObserver = new ResizeObserver(() => this._resize());
      this._resizeObserver.observe(this);
      this._resize();
      this._sync();
      this._animate();
    } catch (e) {
      this.failure = `3D unavailable: ${e.message}`;
      this.fallback = true;
      this.emit("renderer-error", { message: e.message });
    }
  }
  _mat(key, color, options = {}) {
    if (!this._materials.has(key))
      this._materials.set(
        key,
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.83,
          metalness: 0,
          ...options,
        }),
      );
    return this._materials.get(key);
  }
  _mesh(parent, shape, mat, x, y, z, sx, sy, sz, rz = 0) {
    const mesh = new THREE.Mesh(this.geometries[shape], mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.rotation.z = rz;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  _instances(parent, shape, mat, records) {
    if (!records.length) return null;
    const mesh = new THREE.InstancedMesh(
      this.geometries[shape],
      mat,
      records.length,
    );
    const helper = new THREE.Object3D();
    records.forEach((r, i) => {
      helper.position.set(r.x, r.y, r.z);
      helper.scale.set(r.sx, r.sy, r.sz);
      helper.rotation.set(0, r.ry || 0, 0);
      helper.updateMatrix();
      mesh.setMatrixAt(i, helper.matrix);
      if (r.color) mesh.setColorAt(i, new THREE.Color(r.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  _sync() {
    if (!this.scene) return;
    const obs = this.observation;
    const cells = (obs?.world ?? []).filter(valid);
    this._cells = new Map(cells.map((t) => [`${t.x},${t.y}`, t]));
    const key = JSON.stringify([
      obs?.location?.id,
      this.cutaway,
      cells.map((t) => [t.x, t.y, t.terrain?.type, t.objects]),
    ]);
    if (key !== this._key) {
      const locationChanged = obs?.location?.id !== this._location;
      this._key = key;
      this._location = obs?.location?.id;
      this._buildTerrain(cells);
      if (locationChanged || !this._hasFit) {
        const following = this.follow;
        this.fit();
        if (following && obs?.you) this.focusSelf();
        this._hasFit = true;
      }
    }
    const seen = new Set();
    for (const cell of cells) {
      if (!cell.occupant) continue;
      const o = cell.occupant;
      const key =
        o.kind === "self" ? "self" : `${cell.x},${cell.y}:${o.kind}:${o.mark}`;
      seen.add(key);
      let actor = this._actors.get(key);
      if (!actor) {
        actor = this._actor(o);
        actor.group.position.set(cell.x, 0, cell.y);
        this.actorGroup.add(actor.group);
        this._actors.set(key, actor);
      }
      actor.to.set(cell.x, 0, cell.y);
      if (!this.animateMoves || actor.group.position.distanceTo(actor.to) > 1.5)
        actor.group.position.copy(actor.to);
      if (actor.label) actor.label.visible = this.labels;
    }
    for (const [key, a] of this._actors)
      if (!seen.has(key)) {
        this.actorGroup.remove(a.group);
        this._destroyActor(a);
        this._actors.delete(key);
      }
    if (obs?.you) {
      this._target.set(obs.you.x, 0, obs.you.y);
      this.torch.position.set(obs.you.x, 2.5, obs.you.y);
      this.sun.position.set(obs.you.x + 10, 25, obs.you.y + 12);
      this.sun.target.position.set(obs.you.x, 0, obs.you.y);
    }
    this._selection();
  }
  _buildTerrain(cells) {
    for (const child of [...this.staticGroup.children]) {
      child.traverse((o) => {
        if (o.isSprite) o.material.dispose();
      });
      this.staticGroup.remove(child);
      if (child.isInstancedMesh) child.dispose();
    }
    const floors = [],
      tops = [],
      walls = [],
      caps = [],
      bricks = [];
    const stone = this._mat("stone", 0xffffff),
      wallmat = this._mat("wall", 0xffffff),
      dark = this._mat("dark", 0x182025),
      wood = this._mat("wood", 0x94623c),
      iron = this._mat("iron", 0x414e50, { metalness: 0.55 }),
      water = this._mat("water", 0x378b9d, {
        metalness: 0.35,
        roughness: 0.25,
        transparent: true,
        opacity: 0.8,
      });
    for (const t of cells) {
      const x = t.x,
        z = t.y,
        type = t.terrain?.type ?? "unknown",
        j = jitter(x, z);
      let base = 0x4b5555;
      if (type === "corridor") base = 0x394344;
      if (type === "unknown" || type === "dark") base = 0x243237;
      if (type === "water") base = 0x264a57;
      if (type === "lava") base = 0x673c2b;
      const color = new THREE.Color(base).multiplyScalar(0.88 + j * 0.18);
      floors.push({
        x,
        y: -0.23,
        z,
        sx: 0.99,
        sy: 0.45,
        sz: 0.99,
        color: color.clone().multiplyScalar(0.63),
      });
      if (type !== "stairsDown")
        tops.push({ x, y: 0.02, z, sx: 0.965, sy: 0.07, sz: 0.965, color });
      if (type === "wall") {
        const h = this.cutaway ? 0.58 : 1.65;
        walls.push({
          x,
          y: h / 2 + 0.04,
          z,
          sx: 0.98,
          sy: h,
          sz: 0.98,
          color: new THREE.Color(0x6b7371).multiplyScalar(0.83 + j * 0.2),
        });
        caps.push({
          x,
          y: h + 0.07,
          z,
          sx: 1,
          sy: 0.08,
          sz: 1,
          color: 0x7c837a,
        });
        if (!this.cutaway)
          bricks.push({
            x,
            y: 0.64,
            z,
            sx: 1.01,
            sy: 0.025,
            sz: 1.01,
            color: 0x404c4d,
          });
      }
      if (type === "closedDoor" || type === "openDoor") {
        const g = new THREE.Group();
        g.position.set(x, 0, z);
        const horizontal =
          this._cells.get(`${x - 1},${z}`)?.terrain?.type === "wall" ||
          this._cells.get(`${x + 1},${z}`)?.terrain?.type === "wall";
        if (!horizontal) g.rotation.y = Math.PI / 2;
        this.staticGroup.add(g);
        const h = this.cutaway ? 0.8 : 1.55;
        for (const side of [-1, 1])
          this._mesh(g, "box", iron, side * 0.42, h / 2, 0, 0.1, h, 0.18);
        this._mesh(g, "box", iron, 0, h, 0, 0.95, 0.1, 0.18);
        if (type === "closedDoor") {
          this._mesh(g, "box", wood, 0, h / 2, 0, 0.75, h - 0.1, 0.09);
          for (const yy of [0.2, h - 0.23])
            this._mesh(g, "box", iron, 0, yy, 0.06, 0.77, 0.06, 0.04);
          this._mesh(
            g,
            "sphere",
            this._mat("brass", 0xcca65e, { metalness: 0.8, roughness: 0.3 }),
            0.24,
            h * 0.5,
            0.08,
            0.045,
            0.045,
            0.045,
          );
        } else {
          const door = this._mesh(
            g,
            "box",
            wood,
            -0.37,
            h / 2,
            -0.32,
            0.72,
            h - 0.1,
            0.08,
          );
          door.rotation.y = Math.PI / 2;
        }
      }
      if (type === "stairsUp" || type === "stairsDown") {
        const g = new THREE.Group();
        g.position.set(x, 0, z);
        this.staticGroup.add(g);
        this._mesh(g, "box", dark, 0, -0.03, 0, 0.91, 0.08, 0.91);
        for (let i = 0; i < 5; i++) {
          const yy =
            type === "stairsDown" ? -0.02 - i * 0.055 : 0.05 + (4 - i) * 0.11;
          this._mesh(
            g,
            "box",
            this._mat("stairs", 0x929481),
            0,
            yy,
            -0.34 + i * 0.17,
            0.76,
            0.075,
            0.16,
          );
        }
        const sign = this._label(type === "stairsDown" ? "↓" : "↑", "#eed69d");
        sign.position.set(0.32, 0.62, 0.2);
        sign.scale.set(0.43, 0.43, 1);
        g.add(sign);
      }
      if (type === "fountain" || type === "sink") {
        const g = new THREE.Group();
        g.position.set(x, 0, z);
        this.staticGroup.add(g);
        this._mesh(
          g,
          "cylinder",
          this._mat("basin", 0x798d8d),
          0,
          0.12,
          0,
          0.35,
          0.22,
          0.35,
        );
        this._mesh(g, "cylinder", water, 0, 0.245, 0, 0.29, 0.015, 0.29);
        this._mesh(
          g,
          "cylinder",
          this._mat("basin", 0x798d8d),
          0,
          0.45,
          0,
          0.07,
          0.48,
          0.07,
        );
        if (type === "fountain")
          this._mesh(g, "sphere", water, 0, 0.73, 0, 0.08, 0.12, 0.08);
      }
      if (type === "altar") {
        const g = new THREE.Group();
        g.position.set(x, 0, z);
        this.staticGroup.add(g);
        this._mesh(
          g,
          "box",
          this._mat("altar", 0x74706e),
          0,
          0.24,
          0,
          0.7,
          0.42,
          0.6,
        );
        this._mesh(
          g,
          "box",
          this._mat("altar-top", 0xb9b193),
          0,
          0.48,
          0,
          0.8,
          0.08,
          0.7,
        );
        this._mesh(
          g,
          "sphere",
          this._mat("altar-glow", 0xd8b95b, {
            emissive: 0xaa7f22,
            emissiveIntensity: 0.5,
          }),
          0,
          0.64,
          0,
          0.09,
          0.12,
          0.09,
        );
      }
      if (type === "water" || type === "lava") {
        const material =
          type === "water"
            ? water
            : this._mat("lava", 0xa44b24, {
                emissive: 0xde481a,
                emissiveIntensity: 0.8,
                roughness: 0.4,
              });
        this._mesh(
          this.staticGroup,
          "box",
          material,
          x,
          0.065,
          z,
          0.97,
          0.035,
          0.97,
        );
      }
      if (type === "tree") {
        this._mesh(
          this.staticGroup,
          "cylinder",
          wood,
          x,
          0.4,
          z,
          0.1,
          0.8,
          0.1,
        );
        this._mesh(
          this.staticGroup,
          "cone",
          this._mat("leaves", 0x496d53),
          x,
          1,
          z,
          0.43,
          1.15,
          0.43,
        );
      }
      if (type === "bars") {
        for (let i = -2; i <= 2; i++)
          this._mesh(
            this.staticGroup,
            "box",
            iron,
            x + i * 0.16,
            0.5,
            z,
            0.035,
            1,
            0.035,
          );
      }
      if (type === "trap") {
        const g = new THREE.Group();
        g.position.set(x, 0.09, z);
        this.staticGroup.add(g);
        for (const r of [-1, 1])
          this._mesh(
            g,
            "box",
            this._mat("trap", 0xb97c5a),
            0,
            0,
            0,
            0.6,
            0.035,
            0.05,
            r * 0.6,
          );
      }
      if (type === "grave") {
        this._mesh(
          this.staticGroup,
          "box",
          this._mat("grave", 0x888c88),
          x,
          0.3,
          z,
          0.38,
          0.55,
          0.13,
        );
      }
      for (const o of t.objects ?? []) this._object(x, z, o);
    }
    this._instances(this.staticGroup, "box", stone, floors);
    this._instances(this.staticGroup, "box", stone, tops);
    this._instances(this.staticGroup, "box", wallmat, walls);
    this._instances(this.staticGroup, "box", wallmat, caps);
    this._instances(this.staticGroup, "box", wallmat, bricks);
    this.pickCells = cells;
    const plane = this.geometries.box;
    const pickMat = this._mat("pick", 0x000000, { visible: false });
    this.pickMesh = this._instances(
      this.staticGroup,
      "box",
      pickMat,
      cells.map((t) => ({ x: t.x, y: 0.06, z: t.y, sx: 1, sy: 0.02, sz: 1 })),
    );
    if (this.pickMesh) {
      this.pickMesh.castShadow = false;
      this.pickMesh.receiveShadow = false;
    }
  }
  _object(x, z, o) {
    const mark = o.mark,
      group = new THREE.Group();
    group.position.set(x, 0, z);
    this.staticGroup.add(group);
    const gold = this._mat("gold", 0xe3b65f, {
        metalness: 0.7,
        roughness: 0.3,
      }),
      wood = this._mat("wood", 0x94623c),
      paper = this._mat("paper", 0xcec7a7),
      steel = this._mat("steel", 0xb3c4c7, { metalness: 0.6, roughness: 0.3 });
    if (mark === "$") {
      for (let i = 0; i < 3; i++)
        this._mesh(
          group,
          "cylinder",
          gold,
          (i - 1) * 0.13,
          0.11 + i * 0.035,
          0,
          0.14,
          0.07,
          0.14,
        );
    } else if (mark === "(") {
      this._mesh(group, "box", wood, 0, 0.2, 0, 0.5, 0.32, 0.35);
      for (const x of [-0.17, 0.17])
        this._mesh(group, "box", gold, x, 0.23, 0, 0.035, 0.34, 0.37);
    } else if (mark === "!") {
      this._mesh(
        group,
        "cylinder",
        this._mat("potion", PALETTE[o.color & 15] || 0x9cb8a3, {
          metalness: 0.2,
          roughness: 0.25,
        }),
        0,
        0.2,
        0,
        0.13,
        0.27,
        0.13,
      );
      this._mesh(group, "cylinder", paper, 0, 0.37, 0, 0.05, 0.1, 0.05);
    } else if (mark === "?" || mark === "+") {
      this._mesh(group, "box", paper, 0, 0.13, 0, 0.37, 0.09, 0.26);
      this._mesh(
        group,
        "box",
        this._mat("book", 0x705948),
        0,
        0.185,
        0,
        0.38,
        0.025,
        0.27,
      );
    } else if (mark === ")" || mark === "/") {
      const a = this._mesh(group, "box", steel, 0, 0.14, 0, 0.045, 0.04, 0.62);
      a.rotation.y = 0.6;
      this._mesh(group, "box", wood, -0.14, 0.14, -0.22, 0.1, 0.065, 0.16);
    } else if (mark === "[") {
      this._mesh(group, "sphere", steel, 0, 0.15, 0, 0.22, 0.17, 0.19);
    } else if (mark === "%" || mark === ":") {
      this._mesh(
        group,
        "sphere",
        this._mat("food", 0x987b62),
        0,
        0.14,
        0,
        0.25,
        0.1,
        0.17,
      );
    } else if (mark === "`" || mark === "0") {
      this._mesh(
        group,
        "sphere",
        this._mat("boulder", 0x7c817d),
        0,
        0.29,
        0,
        0.36,
        0.31,
        0.3,
      );
    } else {
      this._mesh(group, "sphere", gold, 0, 0.16, 0, 0.1, 0.13, 0.1);
    }
  }
  _label(mark, color) {
    const key = mark + color;
    let texture = this._textures.get(key);
    if (!texture) {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "rgba(13,22,26,.85)";
      ctx.beginPath();
      ctx.roundRect(14, 14, 100, 100, 24);
      ctx.fill();
      ctx.font = "bold 76px monospace";
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(mark, 64, 66);
      texture = new THREE.CanvasTexture(c);
      texture.colorSpace = THREE.SRGBColorSpace;
      this._textures.set(key, texture);
    }
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        transparent: true,
      }),
    );
    s.renderOrder = 5;
    return s;
  }
  _actor(o) {
    const group = new THREE.Group(),
      self = o.kind === "self",
      pet = o.kind === "ally";
    const skin = this._mat("skin", 0xcda580),
      metal = this._mat("hero-armor", 0x648c7a, {
        metalness: 0.45,
        roughness: 0.45,
      }),
      leather = this._mat("leather", 0x4c4034),
      creature = this._mat(
        `creature-${o.mark}-${o.color}`,
        PALETTE[(o.color ?? 7) & 15],
      );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.39, 32),
      new THREE.MeshBasicMaterial({
        color: self ? 0x8ae4b5 : pet ? 0x8aaef0 : 0xd6a48c,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.09;
    group.add(ring);
    if (self) {
      for (const x of [-0.12, 0.12]) {
        this._mesh(group, "box", leather, x, 0.22, 0, 0.14, 0.27, 0.18);
        this._mesh(group, "box", metal, x, 0.41, 0, 0.15, 0.19, 0.17);
      }
      this._mesh(group, "box", metal, 0, 0.57, 0, 0.37, 0.3, 0.25);
      this._mesh(group, "sphere", skin, 0, 0.85, 0, 0.13, 0.14, 0.12);
      this._mesh(
        group,
        "sphere",
        this._mat("helm", 0xb3b5a2, { metalness: 0.6 }),
        0,
        0.94,
        0,
        0.16,
        0.12,
        0.145,
      );
      const cape = this._mesh(
        group,
        "box",
        this._mat("cape", 0x316858),
        0,
        0.49,
        -0.18,
        0.33,
        0.53,
        0.045,
      );
      cape.rotation.x = -0.13;
      this._mesh(group, "box", leather, -0.24, 0.55, 0, 0.12, 0.27, 0.14);
      this._mesh(
        group,
        "cylinder",
        this._mat("shield", 0xaab299, { metalness: 0.35 }),
        -0.3,
        0.51,
        0.04,
        0.21,
        0.065,
        0.21,
        Math.PI / 2,
      );
      this._mesh(
        group,
        "cylinder",
        leather,
        0.31,
        0.59,
        0.08,
        0.025,
        1.05,
        0.025,
      );
      this._mesh(
        group,
        "cone",
        this._mat("spear", 0xc2d1cb, { metalness: 0.75 }),
        0.31,
        1.2,
        0.08,
        0.06,
        0.24,
        0.06,
      );
    } else if ("dfqru".includes(o.mark)) {
      const fur = pet ? this._mat("pet", 0xb58e63) : creature;
      this._mesh(group, "sphere", fur, 0, 0.35, 0, 0.23, 0.19, 0.31);
      this._mesh(group, "sphere", fur, 0, 0.51, 0.25, 0.15, 0.15, 0.18);
      for (const x of [-0.14, 0.14])
        for (const z of [-0.18, 0.16])
          this._mesh(group, "box", fur, x, 0.18, z, 0.09, 0.27, 0.09);
      for (const x of [-0.09, 0.09])
        this._mesh(group, "cone", fur, x, 0.68, 0.2, 0.07, 0.17, 0.07);
      const tail = this._mesh(
        group,
        "cylinder",
        fur,
        0,
        0.5,
        -0.33,
        0.035,
        0.34,
        0.035,
      );
      tail.rotation.x = -0.7;
      this._mesh(
        group,
        "box",
        this._mat("eyes", 0x172228),
        0,
        0.53,
        0.405,
        0.17,
        0.028,
        0.025,
      );
    } else if (o.mark === "e") {
      this._mesh(group, "sphere", creature, 0, 0.6, 0, 0.31, 0.3, 0.3);
      this._mesh(
        group,
        "sphere",
        this._mat("eye-white", 0xe2d7b9),
        0,
        0.62,
        0.22,
        0.19,
        0.19,
        0.1,
      );
      this._mesh(
        group,
        "sphere",
        this._mat("eye", 0x283d48),
        0,
        0.62,
        0.31,
        0.09,
        0.12,
        0.03,
      );
    } else if ("FjPb".includes(o.mark)) {
      this._mesh(group, "sphere", creature, 0, 0.27, 0, 0.35, 0.22, 0.32);
    } else {
      for (const x of [-0.12, 0.12])
        this._mesh(group, "box", leather, x, 0.23, 0, 0.13, 0.3, 0.15);
      this._mesh(group, "sphere", creature, 0, 0.52, 0, 0.24, 0.29, 0.16);
      this._mesh(group, "sphere", creature, 0, 0.84, 0, 0.16, 0.18, 0.15);
      for (const x of [-0.27, 0.27])
        this._mesh(group, "box", creature, x, 0.49, 0, 0.1, 0.35, 0.13);
    }
    const text = this._label(
      self ? "@" : o.mark,
      self ? "#93e5bc" : pet ? "#a8c7fc" : "#efc1a7",
    );
    text.position.set(0, self ? 1.6 : 1.27, 0);
    text.scale.set(0.4, 0.4, 1);
    group.add(text);
    return { group, to: new THREE.Vector3(), label: text, ring };
  }
  _selection() {
    if (!this.outline) return;
    this.outline.visible = !!this.selected;
    if (this.selected)
      this.outline.position.set(this.selected.x, 0.11, this.selected.y);
  }
  _resize() {
    if (!this.renderer) return;
    const w = Math.max(this.clientWidth, 1),
      h = Math.max(this.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  _animate() {
    if (
      this._frame ||
      !this.renderer ||
      !this.isConnected ||
      document.hidden ||
      this.fallback
    )
      return;
    const tick = (time) => {
      this._frame = 0;
      if (
        !this.renderer ||
        !this.isConnected ||
        document.hidden ||
        this.fallback
      )
        return;
      const dt = Math.min((time - (this._last || time)) / 1000, 0.1);
      this._last = time;
      for (const a of this._actors.values())
        a.group.position.lerp(a.to, 1 - Math.exp(-dt * 15));
      if (this.follow && this.observation?.you) {
        const delta = this._target
          .clone()
          .sub(this.controls.target)
          .multiplyScalar(1 - Math.exp(-dt * 7));
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this._frame = requestAnimationFrame(tick);
    };
    this._frame = requestAnimationFrame(tick);
  }
  fit() {
    if (!this.controls || !this._cells?.size) return;
    const cells = [...this._cells.values()],
      xs = cells.map((t) => t.x),
      ys = cells.map((t) => t.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2,
      cz = (Math.min(...ys) + Math.max(...ys)) / 2;
    const span = Math.max(
      7,
      (Math.max(...xs) - Math.min(...xs)) / Math.max(0.6, this.camera.aspect),
      Math.max(...ys) - Math.min(...ys),
    );
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx + span * 0.72, span * 1.05, cz + span * 0.86);
    this.controls.update();
    this.follow = false;
  }
  focusSelf() {
    if (!this.controls || !this.observation?.you) return;
    this.follow = true;
    const p = this.observation.you,
      delta = new THREE.Vector3(p.x, 0, p.y).sub(this.controls.target);
    this.camera.position.add(delta);
    this.controls.target.add(delta);
    const offset = this.camera.position.clone().sub(this.controls.target);
    if (offset.length() > 24)
      this.camera.position.copy(this.controls.target).add(offset.setLength(24));
    this.controls.update();
  }
  rotate() {
    if (!this.controls) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }
  tileAt(clientX, clientY) {
    if (!this.pickMesh) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    this._ndc.set(
      ((clientX - r.left) / r.width) * 2 - 1,
      1 - ((clientY - r.top) / r.height) * 2,
    );
    this._ray.setFromCamera(this._ndc, this.camera);
    const hit = this._ray.intersectObject(this.pickMesh)[0];
    const cell =
      hit?.instanceId !== undefined ? this.pickCells[hit.instanceId] : null;
    return cell ? (this._cells.get(`${cell.x},${cell.y}`) ?? null) : null;
  }
  debug() {
    return {
      tiles: this._cells?.size ?? 0,
      actors: this._actors.size,
      renderer: !!this.renderer,
      fallback: this.fallback,
      drawCalls: this.renderer?.info.render.calls,
      triangles: this.renderer?.info.render.triangles,
      geometries: this.renderer?.info.memory.geometries,
    };
  }
  _destroyActor(a) {
    a.ring?.geometry.dispose();
    a.ring?.material.dispose();
    a.label?.material.dispose();
  }
  _dispose() {
    cancelAnimationFrame(this._frame);
    this._frame = 0;
    this._resizeObserver?.disconnect();
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
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.renderer = null;
    this.scene = null;
    this._key = "";
    this._hasFit = false;
  }
  _ascii() {
    const cells = (this.observation?.world ?? []).filter(valid);
    if (!cells.length) return "";
    const xs = cells.map((t) => t.x),
      ys = cells.map((t) => t.y),
      map = new Map(cells.map((t) => [`${t.x},${t.y}`, t]));
    const rows = [];
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
      let row = "";
      for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
        const t = map.get(`${x},${y}`);
        row +=
          t?.occupant?.mark ??
          t?.objects?.[0]?.mark ??
          MARKS[t?.terrain?.type] ??
          " ";
      }
      rows.push(row);
    }
    return rows.join("\n");
  }
  render() {
    return html`<div class="viewport" ?hidden=${this.fallback}></div>
      ${this.fallback
        ? html`<div class="fallback">
            <pre aria-label="Accessible dungeon map">${this._ascii()}</pre>
          </div>`
        : nothing}
      <div class="tools">
        <button @click=${() => this.fit()} title="Fit known map">Fit</button
        ><button @click=${() => this.focusSelf()} aria-pressed=${this.follow}>
          Follow</button
        ><button @click=${() => this.rotate()} title="Rotate quarter turn">
          ↻</button
        ><button
          @click=${() => (this.cutaway = !this.cutaway)}
          aria-pressed=${this.cutaway}
        >
          Cutaway</button
        ><button
          @click=${() => {
            this.fallback = !this.fallback;
            if (!this.fallback) this._animate();
          }}
        >
          ${this.fallback ? "3D" : "2D"}
        </button>
      </div>
      ${this.selected
        ? html`<div class="selection">
            ${this.selected.x}, ${this.selected.y} ·
            ${this.selected.terrain?.type ?? "unknown"}
          </div>`
        : nothing}${this.failure
        ? html`<div class="failure" role="status">${this.failure}</div>`
        : nothing}${!this.observation
        ? html`<div class="empty">
            <b>◇</b><strong>A dungeon worth exploring.</strong
            ><span>Start a world, or open a recorded expedition.</span>
          </div>`
        : nothing}
      <div class="hint">
        Drag to orbit · right-drag to pan · scroll to zoom · click to inspect
      </div>`;
  }
}
customElements.define("nh-map3d", NhMap3D);
