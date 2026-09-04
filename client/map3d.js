// map3d.js — isometric sprite renderer over the generated pixel-art atlas.
// Input: renderer cells {x, y, sprite, tint} where sprite names an atlas
// tile and tint is a CSS color (white-base entities) or null (pre-colored).
// Layers (3 draw calls): textured ground quads, extruded wall boxes with
// auto-tiled tops, and upright billboard sprites with per-vertex tint.
// A warm torch light follows the player (@ cell); camera follows too.
//
// Public API:
//   const m = createIsoMap(container);
//   await m.setAtlas("assets/");            // loads atlas.json + atlas.png
//   m.setMap({cols, rows, cells}); // cells=[{x,y,sprite,tint,wall,ground}]
//   m.applyDelta(cells);         // same shape, subset (sprite=null: flat)
//   m.onTileClick = ({x, y}) => {};
//   m.screenToTile(clientX, clientY);
//   m.setFollow(bool); m.playerPos();

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const WALL_H = 0.85;
const SLAB_H = 0.32; // voxel floor slab height; walls rise from y=0

export function createIsoMap(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0b09);
  scene.fog = new THREE.Fog(0x0d0b09, 55, 120);

  const aspect = 1;
  const frustum = 14;
  const camera = new THREE.OrthographicCamera(
    -frustum * aspect / 2, frustum * aspect / 2,
    frustum / 2, -frustum / 2, 0.1, 300,
  );
  const az = Math.PI / 4;
  const el = Math.atan(1 / Math.sqrt(2));
  const dist = 60;

  scene.add(new THREE.AmbientLight(0xbfb4a8, 0.55));
  scene.add(new THREE.HemisphereLight(0xd8c8a8, 0x141010, 0.5));
  const dir = new THREE.DirectionalLight(0xfff2df, 0.55);
  dir.position.set(5, 10, 2);
  scene.add(dir);
  const torch = new THREE.PointLight(0xffb45e, 30, 22, 1.8);
  torch.position.set(0, 3, 0);
  scene.add(torch);

  let cols = 0, rows = 0;
  let cells = []; // {sprite, tint} per index, tint = THREE.Color
  let atlas = null; // {tex, tiles, tile, width, height}
  let atlasReady = null;
  let groundMesh = null;
  let wallMesh = null;
  let spriteMesh = null;
  let pickMesh = null;
  let player = null; // {x, y}

  let viewSize = 20;
  let viewX = 0, viewZ = 0;
  let follow = true;
  let flicker = 0;

  const hoverGeo = new THREE.PlaneGeometry(1, 1);
  const hoverMat = new THREE.MeshBasicMaterial({
    color: 0xffd75f, wireframe: true, transparent: true, opacity: 0.9,
  });
  const hover = new THREE.Mesh(hoverGeo, hoverMat);
  hover.rotation.x = -Math.PI / 2;
  hover.visible = false;
  hover.position.y = SLAB_H + 0.04;
  scene.add(hover);

  const raycaster = new THREE.Raycaster();
  const pointerNDC = new THREE.Vector2();

  function setFollow(v) {
    v = !!v;
    if (v === follow) return;
    follow = v;
    if (api.onFollowChange) api.onFollowChange(follow);
  }

  const api = {
    onTileClick: null,
    onTileHover: null,
    onFollowChange: null,
    setAtlas,
    setMap,
    applyDelta,
    screenToTile,
    snapToPlayer,
    resize,
    dispose,
    setFollow,
    playerPos: () => (player ? { ...player } : null),
    canvas: () => renderer.domElement,
    debug: () => ({
      cols, rows, atlas: !!atlas, player,
      camera: [camera.top, camera.left, camera.right, camera.bottom].map(Math.round),
      info: renderer.info.render,
    }),
  };

  resize();
  window.addEventListener("resize", resize);
  renderer.domElement.addEventListener("pointermove", (ev) => {
    const t = screenToTile(ev.clientX, ev.clientY);
    if (t) {
      hover.visible = true;
      hover.position.set(tileToWorldX(t.x, t.y), SLAB_H + 0.04, tileToWorldZ(t.x, t.y));
      if (api.onTileHover) api.onTileHover(t);
    } else {
      hover.visible = false;
    }
  });
  renderer.domElement.addEventListener("click", (ev) => {
    const t = screenToTile(ev.clientX, ev.clientY);
    if (t && api.onTileClick) api.onTileClick(t);
  });
  renderer.domElement.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    viewSize = Math.min(90, Math.max(8, viewSize * (ev.deltaY > 0 ? 1.15 : 1 / 1.15)));
    applyCamera();
  }, { passive: false });
  {
    let drag = null;
    renderer.domElement.addEventListener("pointerdown", (ev) => {
      if (ev.button === 1 || ev.button === 2 || ev.shiftKey) {
        drag = { x: ev.clientX, y: ev.clientY, vx: viewX, vz: viewZ };
        setFollow(false); // looking around disconnects; button syncs back
      }
    });
    window.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const scale = viewSize / renderer.domElement.clientHeight;
      viewX = drag.vx - (ev.clientX - drag.x) * scale;
      viewZ = drag.vz - (ev.clientY - drag.y) * scale;
      applyCamera();
    });
    window.addEventListener("pointerup", () => { drag = null; });
    renderer.domElement.addEventListener("contextmenu", (ev) => ev.preventDefault());
  }

  animate();
  return api;

  // ---- atlas ----

  function setAtlas(base) {
    if (!atlasReady) {
      atlasReady = (async () => {
        const meta = await (await fetch(`${base}atlas.json`)).json();
        const tex = await new THREE.TextureLoader().loadAsync(`${base}atlas.png`);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        atlas = { tex, tiles: meta.tiles, tile: meta.tile, w: meta.width, h: meta.height };
        if (cols && rows) buildAll();
      })();
    }
    return atlasReady;
  }

  function uvFor(name) {
    const t = atlas && atlas.tiles[name];
    if (!t) return null;
    const { x, y } = t;
    const s = atlas.tile;
    return {
      u0: x / atlas.w, v0: 1 - (y + s) / atlas.h,
      u1: (x + s) / atlas.w, v1: 1 - y / atlas.h,
    };
  }

  // ---- map data ----

  function setMap({ cols: c, rows: r, cells: list }) {
    cols = c; rows = r;
    cells = new Array(cols * rows).fill(null);
    player = null;
    for (const cell of list) putCell(cell);
    buildAll();
    // New map = new game: follow by default.
    setFollow(true);
    if (player) snapToPlayer();
  }

  function applyDelta(list) {
    if (!cols || !rows) return;
    let playerMoved = false;
    for (const cell of list) {
      if (putCell(cell) && cell.sprite === "e_player") playerMoved = true;
    }
    buildAll();
    void playerMoved;
  }

  // Store a cell; returns true if the visible content changed.
  // sprite=null -> flat ground cell showing `ground`; otherwise `ground`
  // under an upright billboard.
  function putCell({ x, y, sprite, tint, wall, ground }) {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return false;
    const i = y * cols + x;
    const prev = cells[i];
    const next = {
      sprite: sprite || null,
      ground: ground || "floor_dark",
      tint: tint ? new THREE.Color(tint) : new THREE.Color("#ffffff"),
      wall: !!wall,
    };
    cells[i] = next;
    if (sprite === "e_player") player = { x, y };
    return !prev || prev.sprite !== next.sprite ||
      prev.ground !== next.ground ||
      prev.wall !== next.wall || !prev.tint.equals(next.tint);
  }

  function isWall(x, y) {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return false;
    const c = cells[y * cols + x];
    return !!(c && c.wall);
  }

  // Wall-top variant from orthogonal wall neighbors.
  function wallVariant(x, y) {
    const n = isWall(x, y - 1), s = isWall(x, y + 1);
    const w = isWall(x - 1, y), e = isWall(x + 1, y);
    const open = (o) => !o;
    const oe = open(e), ow = open(w), on = open(n), os = open(s);
    const count = oe + ow + on + os;
    if (count === 0) return "wall_cross";
    if (count === 4) return "wall_t";
    if (count === 3) return "wall_t";
    if (count === 1) return "wall_end";
    if (oe && ow) return "wall_h";
    if (on && os) return "wall_v";
    if (oe && os) return "wall_tl";
    if (ow && os) return "wall_tr";
    if (oe && on) return "wall_bl";
    return "wall_br";
  }

  // ---- builders ----

  function clearMesh(mesh) {
    if (!mesh) return;
    scene.remove(mesh);
    mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
    else mesh.material.dispose();
  }

  function buildAll() {
    if (!atlas) return; // setAtlas resolves, then rebuilds
    clearMesh(groundMesh); groundMesh = null;
    clearMesh(wallMesh); wallMesh = null;
    clearMesh(spriteMesh); spriteMesh = null;
    clearMesh(pickMesh); pickMesh = null;
    groundMesh = buildGround();
    wallMesh = buildWalls();
    spriteMesh = buildSprites();
    pickMesh = buildPickPlane();
    if (groundMesh) scene.add(groundMesh);
    if (wallMesh) scene.add(wallMesh);
    if (spriteMesh) scene.add(spriteMesh);
    if (pickMesh) scene.add(pickMesh);
  }

  function groundTileFor(x, y) {
    const c = cells[y * cols + x];
    if (!c) return "floor_dark";
    if (c.wall) return wallVariant(x, y);
    return c.ground;
  }

  // Voxel floor: one slab per cell (dirt sides, textured top), with
  // stair cells built as three ascending steps.
  function buildGround() {
    const boxes = [];
    const sideUV = uvFor("floor_dark");
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const wx = tileToWorldX(x, y);
        const wz = tileToWorldZ(x, y);
        const tile = groundTileFor(x, y);
        if (tile === "stair_up" || tile === "stair_dn") {
          const up = tile === "stair_up";
          for (let s = 0; s < 3; s++) {
            const h = up
              ? SLAB_H + (2 - s) * 0.24
              : SLAB_H + s * 0.24;
            const g = new THREE.BoxGeometry(1 / 3, h, 1);
            remapBoxUV(g, sideUV, uvFor(tile) || sideUV);
            const sx = wx - 1 / 3 + s * (1 / 3);
            g.translate(sx, h / 2, wz);
            boxes.push(g);
          }
          continue;
        }
        const g = new THREE.BoxGeometry(1, SLAB_H, 1);
        remapBoxUV(g, sideUV, uvFor(tile) || sideUV);
        g.translate(wx, SLAB_H / 2, wz);
        boxes.push(g);
      }
    }
    if (!boxes.length) return null;
    const geo = mergeGeometries(boxes);
    boxes.forEach((g) => g.dispose());
    const mat = new THREE.MeshLambertMaterial({ map: atlas.tex });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.isGround = true;
    mesh.userData.boxOrder = true;
    return mesh;
  }

  function buildWalls() {
    const boxes = [];
    const sideUV = uvFor("wall_cross");
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const c = cells[y * cols + x];
        if (!c || !c.wall) continue;
        const g = new THREE.BoxGeometry(1, WALL_H, 1);
        remapBoxUV(g, sideUV, uvFor(wallVariant(x, y)) || sideUV);
        g.translate(tileToWorldX(x, y), WALL_H / 2, tileToWorldZ(x, y));
        boxes.push(g);
      }
    }
    if (!boxes.length) return null;
    const geo = mergeGeometries(boxes);
    boxes.forEach((g) => g.dispose());
    const mat = new THREE.MeshLambertMaterial({ map: atlas.tex });
    return new THREE.Mesh(geo, mat);
  }

  // BoxGeometry vertex order per face: 4 verts each, faces
  // +x, -x, +y, -y, +z, -z. Sides share one tile; the +y top gets its own.
  function remapBoxUV(geo, side, top) {
    const uv = geo.attributes.uv;
    for (let f = 0; f < 6; f++) {
      const r = f === 2 ? top : side;
      if (!r) continue;
      // Box face verts run (0,1),(1,1),(0,0),(1,0): map to the tile rect.
      uv.setXY(f * 4, r.u0, r.v1);
      uv.setXY(f * 4 + 1, r.u1, r.v1);
      uv.setXY(f * 4 + 2, r.u0, r.v0);
      uv.setXY(f * 4 + 3, r.u1, r.v0);
    }
    uv.needsUpdate = true;
  }

  function buildSprites() {
    const list = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const c = cells[y * cols + x];
        if (!c || !c.sprite) continue;
        const r = uvFor(c.sprite);
        if (!r) continue;
        const item = c.sprite !== "e_player" && !c.sprite.startsWith("e_");
        const hw = item ? 0.3 : 0.45;
        const hh = item ? 0.3 : 0.45;
        // Stand on the voxel slab tops, not inside them.
        const lift = (item ? 0.34 : 0.55) + SLAB_H;
        list.push({ x, y, r, tint: c.tint, hw, hh, lift });
      }
    }
    if (!list.length) return null;
    const n = list.length;
    const pos = new Float32Array(n * 4 * 3);
    const uv = new Float32Array(n * 4 * 2);
    const col = new Float32Array(n * 4 * 3);
    const idx = [];
    const right = { x: -Math.cos(az + Math.PI / 2), z: -Math.sin(az + Math.PI / 2) };
    list.forEach((s, q) => {
      const wx = tileToWorldX(s.x, s.y);
      const wz = tileToWorldZ(s.x, s.y);
      const v = q * 12;
      const corners = [[-s.hw, -s.hh], [s.hw, -s.hh], [s.hw, s.hh], [-s.hw, s.hh]];
      corners.forEach(([ox, oy], ci) => {
        pos[v + ci * 3] = wx + right.x * ox;
        pos[v + ci * 3 + 1] = s.lift + oy;
        pos[v + ci * 3 + 2] = wz + right.z * ox;
        col[v + ci * 3] = s.tint.r;
        col[v + ci * 3 + 1] = s.tint.g;
        col[v + ci * 3 + 2] = s.tint.b;
      });
      const o = q * 8;
      uv[o] = s.r.u0; uv[o + 1] = s.r.v0;
      uv[o + 2] = s.r.u1; uv[o + 3] = s.r.v0;
      uv[o + 4] = s.r.u1; uv[o + 5] = s.r.v1;
      uv[o + 6] = s.r.u0; uv[o + 7] = s.r.v1;
      const b = q * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      map: atlas.tex,
      vertexColors: true,
      transparent: true,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.isSprites = true;
    return mesh;
  }

  // Invisible pick plane: one quad per cell in cell order, since the
  // voxel ground merges a variable number of boxes per cell and can't
  // map faceIndex back to cells. Raycasts fine while rendering nothing.
  function buildPickPlane() {
    const quads = cols * rows;
    const pos = new Float32Array(quads * 4 * 3);
    const idx = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const q = y * cols + x;
        const wx = tileToWorldX(x, y);
        const wz = tileToWorldZ(x, y);
        const v = q * 12;
        pos[v] = wx - 0.5; pos[v + 1] = SLAB_H; pos[v + 2] = wz - 0.5;
        pos[v + 3] = wx + 0.5; pos[v + 4] = SLAB_H; pos[v + 5] = wz - 0.5;
        pos[v + 6] = wx + 0.5; pos[v + 7] = SLAB_H; pos[v + 8] = wz + 0.5;
        pos[v + 9] = wx - 0.5; pos[v + 10] = SLAB_H; pos[v + 11] = wz + 0.5;
        const b = q * 4;
        idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }));
    mesh.userData.isPick = true;
    return mesh;
  }

  // ---- coords / camera ----

  function tileToWorldX(x, y) { return (x - (cols - 1) / 2); }
  function tileToWorldZ(x, y) { return (y - (rows - 1) / 2); }

  function screenToTile(clientX, clientY) {
    if (!pickMesh) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNDC, camera);
    const hit = raycaster.intersectObject(pickMesh)[0];
    if (!hit || hit.faceIndex == null) return null;
    // Pick quads are stored in cell order, 2 triangles each.
    const q = Math.floor(hit.faceIndex / 2);
    if (q < 0 || q >= cols * rows) return null;
    return { x: q % cols, y: Math.floor(q / cols) };
  }

  function snapToPlayer() {
    if (!player) return;
    viewX = tileToWorldX(player.x, player.y);
    viewZ = tileToWorldZ(player.x, player.y);
    applyCamera();
  }

  function applyCamera() {
    const w = renderer.domElement.clientWidth || 800;
    const h = renderer.domElement.clientHeight || 600;
    camera.top = viewSize / 2; camera.bottom = -viewSize / 2;
    camera.left = -viewSize / 2 * (w / h); camera.right = -camera.left;
    camera.updateProjectionMatrix();
    camera.position.set(
      Math.cos(el) * Math.cos(az) * dist + viewX,
      Math.sin(el) * dist,
      Math.cos(el) * Math.sin(az) * dist + viewZ,
    );
    camera.lookAt(viewX, 0, viewZ);
  }

  function resize() {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;
    renderer.setSize(w, h);
    applyCamera();
  }

  function animate() {
    if (api._dead) return;
    requestAnimationFrame(animate);
    // Smooth camera follow + torch tracking + flame flicker.
    if (follow && player) {
      const tx = tileToWorldX(player.x, player.y);
      const tz = tileToWorldZ(player.x, player.y);
      viewX += (tx - viewX) * 0.08;
      viewZ += (tz - viewZ) * 0.08;
      applyCamera();
    }
    if (player) {
      torch.position.set(
        tileToWorldX(player.x, player.y), 2.5,
        tileToWorldZ(player.x, player.y),
      );
    }
    flicker += 0.15;
    torch.intensity = 30 + Math.sin(flicker) * 3 + Math.sin(flicker * 2.7) * 2;
    renderer.render(scene, camera);
  }

  function dispose() {
    api._dead = true;
    window.removeEventListener("resize", resize);
    renderer.dispose();
    container.removeChild(renderer.domElement);
  }
}
