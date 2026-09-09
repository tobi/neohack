/** Read the retained raster layers for native-pixel art assertions. This is a
 * test-only readback, not a second live renderer. Compositor animation/visibility
 * are exercised separately against Chrome screenshots and tracing. */
export async function installScenePixels(page) {
  await page.exposeFunction("__sceneScreenshot", async (clip) =>
    (await page.screenshot({ clip, animations: "allow" })).toString("base64"),
  );
  await page.addInitScript(() => {
    window.sceneScreenPixels = async (map) => {
      const box = map.scene.element.getBoundingClientRect();
      const image = new Image();
      image.src =
        "data:image/png;base64," +
        (await window.__sceneScreenshot({
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
        }));
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(box.width / map.zoom);
      canvas.height = Math.ceil(box.height / map.zoom);
      const c = canvas.getContext("2d");
      c.imageSmoothingEnabled = false;
      c.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    };
    window.scenePixels = (map) => {
      const scene = map.scene;
      const canvas = document.createElement("canvas");
      const viewport = scene.element.getBoundingClientRect();
      canvas.width = Math.ceil(viewport.width / map.zoom);
      canvas.height = Math.ceil(viewport.height / map.zoom);
      const c = canvas.getContext("2d");
      c.imageSmoothingEnabled = false;
      c.fillStyle = "#171f23";
      c.fillRect(0, 0, canvas.width, canvas.height);
      const camera = new DOMMatrix(getComputedStyle(scene.camera).transform);
      c.setTransform(
        camera.a / map.zoom,
        0,
        0,
        camera.d / map.zoom,
        camera.e / map.zoom,
        camera.f / map.zoom,
      );
      const nodes = [
        ...scene.camera.querySelectorAll(":scope > [data-sprite]"),
      ].sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex));
      for (const node of nodes) {
        const image = node.querySelector("canvas"),
          style = getComputedStyle(node);
        const transform = new DOMMatrix(style.transform);
        const strip = new DOMMatrix(getComputedStyle(image).transform);
        const width = parseFloat(node.style.width),
          height = parseFloat(node.style.height);
        c.save();
        c.globalAlpha = Number(style.opacity);
        c.drawImage(
          image,
          Math.round(-strip.e),
          0,
          width,
          height,
          transform.e,
          transform.f,
          width,
          height,
        );
        c.restore();
      }
      return canvas;
    };
  });
}
