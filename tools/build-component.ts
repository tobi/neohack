// Standalone ESM: no application shell, transport, engine or runtime CDN.
import { resolve, join } from "node:path";
const root = resolve(import.meta.dir, "..");
export async function buildComponent() {
  const outdir = join(root, "client/dist/standalone");
  const result = await Bun.build({
    entrypoints: [join(root, "client/nh-map3d.js")],
    outdir,
    target: "browser",
    format: "esm",
    splitting: false,
    minify: true,
    sourcemap: "external",
    naming: "[name].[ext]",
  });
  if (!result.success) throw Error(result.logs.map(String).join("\n"));
  const js = result.outputs.filter((o) => o.path.endsWith(".js"));
  if (js.length !== 1)
    throw Error("Standalone map must be a single executable module");
  let notices =
    "NetHack Explorer map component — private project build.\nNo additional license grant for project files is asserted here.\nThird-party code retains the following licenses:\n";
  for (const name of [
    "lit",
    "lit-element",
    "lit-html",
    "@lit/reactive-element",
    "three",
  ])
    notices += `\n--- ${name} ---\n${await Bun.file(join(root, "node_modules", name, "LICENSE")).text()}\n`;
  await Bun.write(join(outdir, "LICENSES.txt"), notices);
  const demo = (await Bun.file(join(root, "client/component-demo.html")).text())
    .replaceAll("./dist/standalone/nh-map3d.js", "./nh-map3d.js")
    .replaceAll("/dist/standalone/nh-map3d.js", "./nh-map3d.js")
    .replaceAll("/dist/standalone/LICENSES.txt", "./LICENSES.txt")
    .replaceAll("/api-docs", "./README.md");
  await Bun.write(join(outdir, "demo.html"), demo);
  await Bun.write(
    join(outdir, "README.md"),
    `# Standalone nh-map3d\n\nServe this directory over HTTP and open demo.html, or import ./nh-map3d.js as an ESM module.\nThe single JS file includes Lit, Three.js, styles and procedural assets.\nNo application shell, engine, WebSocket, fetch or runtime CDN is required.\nThe .map file is optional. Keep LICENSES.txt with redistributions.\n\n\`\`\`js\nimport { NhMap3D } from './nh-map3d.js';\nconst map=document.createElement('nh-map3d');\nmap.style.height='500px';\nmap.observation=response.observation;\nmap.worldKey=response.sessionId;\nmap.animateMoves=false; // arbitrary replay seeks\nmap.addEventListener('tile-select',e=>console.log(e.detail));\ndocument.body.append(map);\n\`\`\`\n\nMethods: fit(), focusSelf(), rotate(), inspectAt(x,y), show2D(), retry3D(), debug().\nEvents: tile-select, view-follow, renderer-error, renderer-state.\nFocused map arrows inspect; Enter selects; Escape leaves map focus.\nA host must not interpret tile selection as an implicit game action.\nSee client/API.md and client/component-demo.html in the source repository.\n`,
  );
  for (const file of result.outputs)
    console.log(`${file.path} (${Math.round(file.size / 1024)} KB)`);
  return result;
}
if (import.meta.main) await buildComponent();
