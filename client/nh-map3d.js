// Stylized models for the presentation-only map; lifecycle lives in map-surface.
import * as THREE from "three";
import { MapSurface } from "./map-surface.js";
const PALETTE = [
  0x161616, 0xba534d, 0x69a467, 0xab8253, 0x6486cb, 0xb480b9, 0x6cacb1,
  0xc4c6be, 0x89918e, 0xe89459, 0x91ca75, 0xe7cc84, 0x8ca9e2, 0xdba2d2,
  0x8bd4d2, 0xeae9dc,
];
const jitter = (x, y) =>
  ((Math.imul(x + 31, 73856093) ^ Math.imul(y + 71, 19349663)) >>> 0) /
  4294967295;

class NhMap3DImplementation extends MapSurface {
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
    try {
      this._syncScene();
    } catch (error) {
      this._fail(error);
    }
  }
  _syncScene() {
    const cells = this._prepare();
    if (!this._ensureSurface()) return;
    const obs = this.observation;
    const location = JSON.stringify([this.worldKey ?? "", obs?.location?.id]);
    const key = JSON.stringify([
      location,
      this.cutaway,
      cells.map((t) => [t.x, t.y, t.terrain?.type, t.objects]),
    ]);
    const locationChanged = location !== this._location;
    if (locationChanged) this._hasFit = false;
    if (key !== this._key) {
      this._key = key;
      this._location = location;
      this._buildTerrain(cells);
    }
    if (
      (locationChanged || !this._hasFit) &&
      this._bounds &&
      this.clientWidth &&
      this.clientHeight &&
      this._inView
    ) {
      const following = this.follow;
      this.fit();
      if (following && this._hero()) this.focusSelf();
      this._hasFit = true;
    }
    const seen = new Set();
    for (const cell of cells) {
      if (!cell.occupant) continue;
      const o = cell.occupant;
      const key =
        o.kind === "self"
          ? "self"
          : `${cell.x},${cell.y}:${o.kind}:${o.mark}:${o.color}`;
      seen.add(key);
      let actor = this._actors.get(key);
      if (!actor) {
        actor = this._actor(o);
        actor.group.position.set(cell.x, 0, cell.y);
        this.actorGroup.add(actor.group);
        this._actors.set(key, actor);
      }
      actor.to.set(cell.x, 0, cell.y);
      if (
        !this.animateMoves ||
        this._reducedMotion ||
        locationChanged ||
        actor.group.position.distanceTo(actor.to) > 1.5
      )
        actor.group.position.copy(actor.to);
      if (actor.label) actor.label.visible = this.labels;
    }
    for (const [key, a] of this._actors)
      if (!seen.has(key)) {
        this.actorGroup.remove(a.group);
        this._destroyActor(a);
        this._actors.delete(key);
      }
    if (this._hero()) {
      this._target.set(obs.you.x, 0, obs.you.y);
      this.torch.position.set(obs.you.x, 2.5, obs.you.y);
      this.sun.position.set(obs.you.x + 10, 25, obs.you.y + 12);
      this.sun.target.position.set(obs.you.x, 0, obs.you.y);
    }
    this._pruneTextures();
    this._selection();
    this._animate();
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
      bricks = [],
      liquidWater = [],
      liquidLava = [];
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
      if (type === "water" || type === "lava")
        (type === "water" ? liquidWater : liquidLava).push({
          x,
          y: 0.065,
          z,
          sx: 0.97,
          sy: 0.035,
          sz: 0.97,
        });
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
    this._instances(this.staticGroup, "box", water, liquidWater);
    this._instances(
      this.staticGroup,
      "box",
      this._mat("lava", 0xa44b24, {
        emissive: 0xde481a,
        emissiveIntensity: 0.8,
        roughness: 0.4,
      }),
      liquidLava,
    );
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
        this._mat(`potion-${o.color & 15}`, PALETTE[o.color & 15] ?? 0x9cb8a3, {
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
      if (!ctx)
        throw new Error(
          "Cannot create the glyph canvas; 2D inspection remains available",
        );
      ctx.fillStyle = "rgba(13,22,26,.85)";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(14, 14, 100, 100, 24);
      else ctx.rect(14, 14, 100, 100);
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
      creature = this._mat(`creature-${o.color}`, PALETTE[(o.color ?? 7) & 15]);
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
}
export const NhMap3D = customElements.get("nh-map3d") ?? NhMap3DImplementation;
if (!customElements.get("nh-map3d")) customElements.define("nh-map3d", NhMap3D);
