/** Retained, native-pixel scene. Canvas rasterizes changed art; the browser
 * compositor owns camera, sprite-strip playback, movement and opacity. */
export interface SceneSprite {
  key: string;
  signature: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  frames?: number;
  atlasFrames?: number;
  frameOffset?: number;
  period?: number;
  phase?: number;
  from?: { x: number; y: number; duration: number; hop?: boolean };
  opacity?: number;
  target?: { x: number; y: number };
  paint: (context: CanvasRenderingContext2D, frame: number) => void;
}
interface SpriteNode {
  element: HTMLDivElement;
  canvas: HTMLCanvasElement;
  signature: string;
  animation?: Animation;
  movement?: Animation;
  x: number;
  y: number;
  frames: number;
  period: number;
  frameOffset: number;
  target?: { x: number; y: number };
}
export class RetainedScene {
  readonly element: HTMLDivElement;
  readonly camera: HTMLDivElement;
  private sprites = new Map<string, SpriteNode>();
  private shades = new Map<
    string,
    { element: HTMLDivElement; opacity: number; animation?: Animation }
  >();
  private fogMask: HTMLDivElement;
  private fogSpecs = new Map<
    string,
    {
      key: string;
      x: number;
      y: number;
      width: number;
      height: number;
      opacity: number;
    }
  >();
  private fogTimer?: ReturnType<typeof setTimeout>;
  private cameraAnimation?: Animation;
  private cameraTransform = "";
  private motion = true;
  // Small counters make renderer cost observable without recording game data.
  readonly stats = { rasterizations: 0, cameraUpdates: 0 };
  constructor(private surface: HTMLCanvasElement) {
    const document = surface.ownerDocument;
    this.element = document.createElement("div");
    this.element.dataset.scene = "retained";
    this.element.setAttribute("aria-hidden", "true");
    this.element.style.cssText =
      "position:absolute;inset:0;overflow:hidden;pointer-events:none;isolation:isolate;contain:layout paint style;background:#171f23";
    this.camera = document.createElement("div");
    this.camera.dataset.layer = "camera";
    this.camera.style.cssText =
      "position:absolute;left:0;top:0;width:1px;height:1px;transform-origin:0 0;will-change:transform;image-rendering:pixelated";
    this.fogMask = document.createElement("div");
    this.fogMask.dataset.layer = "remembered";
    this.fogMask.style.cssText =
      "position:absolute;left:-32px;top:-32px;width:1344px;height:400px;pointer-events:none;background:rgba(23,31,35,.32);backdrop-filter:grayscale(1);z-index:200000";
    this.fogMask.style.clipPath = "path('M0 0Z')";
    this.camera.append(this.fogMask);
    this.element.append(this.camera);
    surface.after(this.element);
  }
  setMotion(enabled: boolean) {
    if (enabled === this.motion) return;
    this.motion = enabled;
    if (!enabled) {
      this.cameraAnimation?.cancel();
      for (const node of this.sprites.values()) {
        node.movement?.cancel();
        node.animation?.pause();
      }
      for (const node of this.shades.values()) node.animation?.cancel();
    } else for (const node of this.sprites.values()) node.animation?.play();
  }
  moveCamera(x: number, y: number, scale: number, duration = 0) {
    const transform = `translate3d(${x}px,${y}px,0) scale(${scale})`;
    if (transform === this.cameraTransform) return;
    const from = getComputedStyle(this.camera).transform;
    this.cameraAnimation?.cancel();
    this.camera.style.transform = transform;
    if (duration && this.motion && this.cameraTransform)
      this.cameraAnimation = this.camera.animate(
        [{ transform: from }, { transform }],
        { duration, easing: "linear" },
      );
    this.cameraTransform = transform;
    this.stats.cameraUpdates++;
  }
  worldPoint(clientX: number, clientY: number) {
    const box = this.element.getBoundingClientRect();
    const transform = new DOMMatrix(getComputedStyle(this.camera).transform);
    return new DOMPoint(clientX - box.left, clientY - box.top).matrixTransform(
      transform.inverse(),
    );
  }
  pick(clientX: number, clientY: number) {
    const point = this.worldPoint(clientX, clientY);
    const nodes = [...this.sprites.values()]
      .filter((node) => node.target)
      .sort(
        (a, b) =>
          Number(getComputedStyle(b.element).zIndex) -
          Number(getComputedStyle(a.element).zIndex),
      );
    for (const node of nodes) {
      const transform = new DOMMatrix(getComputedStyle(node.element).transform);
      const x = Math.floor(point.x - transform.e),
        y = Math.floor(point.y - transform.f);
      const width = parseFloat(node.element.style.width);
      if (x < 0 || y < 0 || x >= width || y >= node.canvas.height) continue;
      const strip = new DOMMatrix(getComputedStyle(node.canvas).transform);
      if (
        node.canvas
          .getContext("2d")!
          .getImageData(Math.floor(x - strip.e), y, 1, 1).data[3]
      )
        return node.target;
    }
  }
  reconcile(specs: SceneSprite[]) {
    const retained = new Set<string>();
    for (const spec of specs) {
      retained.add(spec.key);
      let node = this.sprites.get(spec.key);
      if (!node) {
        const element = this.surface.ownerDocument.createElement("div");
        const canvas = this.surface.ownerDocument.createElement("canvas");
        element.dataset.sprite = spec.key;
        element.style.cssText =
          "position:absolute;left:0;top:0;overflow:hidden;pointer-events:none;transform-origin:0 0";
        canvas.style.cssText =
          "position:absolute;left:0;top:0;display:block;max-width:none;image-rendering:pixelated;pointer-events:none;transform-origin:0 0";
        element.append(canvas);
        this.camera.append(element);
        node = {
          element,
          canvas,
          signature: "",
          x: spec.x,
          y: spec.y,
          frames: 0,
          period: 0,
          frameOffset: -1,
        };
        this.sprites.set(spec.key, node);
      }
      const frames = spec.frames ?? 1,
        period = spec.period ?? 0;
      const atlasFrames = spec.atlasFrames ?? frames,
        frameOffset = spec.frameOffset ?? 0;
      if (
        node.signature !== spec.signature ||
        node.canvas.width !== spec.width * atlasFrames ||
        node.canvas.height !== spec.height
      ) {
        node.canvas.width = spec.width * atlasFrames;
        node.canvas.height = spec.height;
        node.canvas.style.width = `${spec.width * atlasFrames}px`;
        node.canvas.style.height = `${spec.height}px`;
        node.element.style.width = `${spec.width}px`;
        node.element.style.height = `${spec.height}px`;
        const c = node.canvas.getContext("2d")!;
        c.imageSmoothingEnabled = false;
        for (let frame = 0; frame < atlasFrames; frame++) {
          c.save();
          c.translate(frame * spec.width, 0);
          c.beginPath();
          c.rect(0, 0, spec.width, spec.height);
          c.clip();
          spec.paint(c, frame);
          c.restore();
        }
        node.signature = spec.signature;
        this.stats.rasterizations++;
      }
      if (
        node.frames !== frames ||
        node.period !== period ||
        node.frameOffset !== frameOffset
      ) {
        node.animation?.cancel();
        node.animation = undefined;
        node.canvas.style.transform = `translateX(${-spec.width * frameOffset}px)`;
        if (frames > 1 && period > 0) {
          node.animation = node.canvas.animate(
            [
              { transform: `translateX(${-spec.width * frameOffset}px)` },
              {
                transform: `translateX(${-spec.width * (frameOffset + frames)}px)`,
              },
            ],
            {
              duration: frames * period,
              iterations: Infinity,
              easing: `steps(${frames}, end)`,
            },
          );
          node.animation.currentTime = spec.phase ?? 0;
          if (!this.motion) node.animation.pause();
        }
        node.frames = frames;
        node.period = period;
        node.frameOffset = frameOffset;
      }
      const transform = `translate3d(${spec.x}px,${spec.y}px,0)`;
      if (
        node.x !== spec.x ||
        node.y !== spec.y ||
        !node.element.style.transform
      ) {
        let from = spec.from;
        if (from && node.movement?.playState === "running") {
          const current = new DOMMatrix(
            getComputedStyle(node.element).transform,
          );
          from = { ...from, x: current.e, y: current.f };
        }
        node.movement?.cancel();
        node.element.style.transform = transform;
        if (from && this.motion) {
          const start = from;
          const frames = Array.from({ length: 17 }, (_, i) => {
            const t = i / 16,
              eased = start.hop ? 1 - (1 - t) ** 2 : t;
            const x = start.x + (spec.x - start.x) * eased;
            const y = start.y + (spec.y - start.y) * eased;
            return {
              offset: t,
              transform: `translate3d(${x}px,${y - (start.hop ? Math.round(Math.sin(Math.PI * t)) : 0)}px,0)`,
              // Foot ordering can change during travel. Only stacking order is
              // updated; no geometry or sprite pixels are rasterized again.
              zIndex:
                spec.z < 100000
                  ? String(
                      Math.round(
                        spec.z + (y - spec.y) * 256 + (x - spec.x) / 8,
                      ),
                    )
                  : String(spec.z),
            };
          });
          node.movement = node.element.animate(frames, {
            duration: from.duration,
            easing: "linear",
          });
        }
        node.x = spec.x;
        node.y = spec.y;
      }
      node.element.style.zIndex = String(spec.z);
      node.element.style.opacity = String(spec.opacity ?? 1);
      node.target = spec.target;
    }
    for (const [key, node] of this.sprites)
      if (!retained.has(key)) {
        node.animation?.cancel();
        node.movement?.cancel();
        node.element.remove();
        this.sprites.delete(key);
      }
  }
  visibility(
    specs: {
      key: string;
      x: number;
      y: number;
      width: number;
      height: number;
      opacity: number;
    }[],
  ) {
    const retained = new Set<string>();
    for (const spec of specs) {
      retained.add(spec.key);
      const previous = this.fogSpecs.get(spec.key);
      if (previous && previous.opacity !== spec.opacity && this.motion) {
        let node = this.shades.get(spec.key);
        let from = String(previous.opacity);
        if (node) {
          from = getComputedStyle(node.element).opacity;
          node.animation?.cancel();
        } else {
          const element = this.surface.ownerDocument.createElement("div");
          element.dataset.fog = spec.key;
          element.style.cssText =
            "position:absolute;background:rgba(23,31,35,.32);backdrop-filter:grayscale(1);pointer-events:none;z-index:200000";
          this.camera.append(element);
          node = { element, opacity: spec.opacity };
          this.shades.set(spec.key, node);
        }
        Object.assign(node.element.style, {
          left: spec.x + "px",
          top: spec.y + "px",
          width: spec.width + "px",
          height: spec.height + "px",
          opacity: String(spec.opacity),
        });
        node.animation = node.element.animate(
          [{ opacity: from }, { opacity: String(spec.opacity) }],
          { duration: 240 },
        );
        node.opacity = spec.opacity;
      }
      this.fogSpecs.set(spec.key, spec);
    }
    for (const key of this.fogSpecs.keys())
      if (!retained.has(key)) this.fogSpecs.delete(key);
    for (const [key, node] of this.shades)
      if (!retained.has(key) || !this.motion) {
        node.animation?.cancel();
        node.element.remove();
        this.shades.delete(key);
      }
    this.paintFogMask();
    clearTimeout(this.fogTimer);
    if (this.shades.size)
      this.fogTimer = setTimeout(() => {
        for (const node of this.shades.values()) {
          node.animation?.cancel();
          node.element.remove();
        }
        this.shades.clear();
        this.paintFogMask();
      }, 250);
  }
  private paintFogMask() {
    // One clipped backdrop for settled memory, with small temporary compositor
    // layers only for cells currently fading. No layer per historical square.
    let path = "";
    for (const spec of this.fogSpecs.values())
      if (spec.opacity && !this.shades.has(spec.key))
        path += `M${spec.x + 32} ${spec.y + 32}h${spec.width}v${spec.height}h-${spec.width}Z`;
    this.fogMask.style.clipPath = `path('${path || "M0 0Z"}')`;
  }
  reset() {
    this.cameraAnimation?.cancel();
    this.cameraTransform = "";
    clearTimeout(this.fogTimer);
    this.fogSpecs.clear();
    for (const node of this.sprites.values()) {
      node.animation?.cancel();
      node.movement?.cancel();
    }
    for (const node of this.shades.values()) node.animation?.cancel();
    this.camera.replaceChildren(this.fogMask);
    this.sprites.clear();
    this.shades.clear();
    this.paintFogMask();
  }
  destroy() {
    this.reset();
    this.element.remove();
  }
}
