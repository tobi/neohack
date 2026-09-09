import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
const root = resolve(import.meta.dir, ".."),
  out = join(root, "test-results/art/floor");
await mkdir(out, { recursive: true });
const sources = await Promise.all(
  ["symbol-art", "death-traces"].map(async (name) => {
    const bundle = await Bun.build({
      entrypoints: [join(root, `src/${name}.ts`)],
      target: "browser",
      format: "esm",
    });
    if (!bundle.success) throw Error("Failed to compile " + name);
    return bundle.outputs[0]!.text();
  }),
);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  headless: true,
  chromiumSandbox: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const cards = await page.evaluate(async (sources) => {
    const [{ drawItemArt }, { DeathTraces }] = await Promise.all(
      sources.map(
        (source) =>
          import(
            URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
          ),
      ),
    );
    const cards: { label: string; image: string }[] = [];
    for (const appearance of ["large box", "chest", "ice box"]) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 32;
      drawItemArt(
        canvas.getContext("2d"),
        { category: "tool", known: { appearance } },
        8,
        8,
      );
      cards.push({ label: appearance, image: canvas.toDataURL() });
    }
    const traces = new DeathTraces();
    for (const age of [0, 4, 5, 6, 7]) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 32;
      traces.draw(
        canvas.getContext("2d"),
        { x: 0, y: 0, turn: 10, appearance: "goblin" },
        8,
        8,
        10 + age,
      );
      cards.push({
        label: `Death impression · age ${age}`,
        image: canvas.toDataURL(),
      });
    }
    document.body.style.cssText =
      "background:#34453d;color:#e6dfcc;font:16px system-ui;padding:20px;display:flex;flex-wrap:wrap;gap:16px";
    for (const { label, image } of cards) {
      const card = document.createElement("div");
      card.style.width = "180px";
      const img = document.createElement("img");
      img.src = image;
      img.width = img.height = 128;
      img.style.imageRendering = "pixelated";
      const title = document.createElement("p");
      title.textContent = label;
      card.append(title, img);
      document.body.append(card);
    }
    return cards;
  }, sources);
  await page.screenshot({ path: join(out, "preview.png"), fullPage: true });
  await writeFile(
    join(out, "report.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Floor artwork proof</title><style>body{background:#203029;color:#e7dfc7;font:16px system-ui;max-width:1000px;margin:32px}p{line-height:1.6;max-width:800px}main{display:flex;flex-wrap:wrap;gap:16px}a{color:#c4dba8}h1{font-size:30px}</style><h1>Chests, click targets and fading remains</h1><p>The old floor chest was a generic tool icon: the map exported named shapes for weapons and statues but omitted containers. Rigid containers now carry their perceived names, and the same chest master has a smaller wooden-box variant. Contents, traps and locks remain undisclosed.</p><p>Inspection prioritizes creatures and floor objects over terrain. Clicking a raised sprite selects its actual ground square. <a href="../../chest-inspection.png">Chest inspection</a> · <a href="../../creature-inspection.png">Creature inspection</a> · <a href="../../chest-death-inspection.png">Impression explanation</a></p><p>Only a directly witnessed engine death creates an impression. Invisible, hallucinated and life-saved creatures do not. Impressions stay beneath objects and actors, fade on turns five and six, and vanish at age seven. They never create loot or an action target. Actual corpse items keep the engine's ordinary rules.</p><main></main><script type="module">import{LitElement,html,css}from'https://esm.sh/lit@3';class ArtCard extends LitElement{static properties={label:{type:String},image:{type:String}};static styles=css\`:host{background:#34453d;padding:16px;width:190px;border-radius:8px}img{width:128px;height:128px;image-rendering:pixelated}h2{font-size:15px}\`;render(){return html\`<h2>\${this.label}</h2><img src="\${this.image}" alt="\${this.label}">\`}}customElements.define('art-card',ArtCard);for(const data of ${JSON.stringify(cards)}){const card=document.createElement('art-card');Object.assign(card,data);document.querySelector('main').append(card)}</script></html>`,
  );
  console.log("Exported runtime chest variants and turn-fade proof to " + out);
} finally {
  await browser.close();
}
