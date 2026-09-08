import "./build-errors.mjs";
import ts from "typescript";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { catalog, exampleProject } from "../../../examples/workshop/projects.js";

const root = resolve(import.meta.dir, "..");
const library = resolve(root, "../../lib/neonethack");
await access(`${library}/dist/wasm/manifest.json`).catch(() => {
  throw Error(
    "Build the library first: npm run --prefix lib/neonethack build && make -C lib/neonethack wasm (with Emscripten activated).",
  );
});
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  resolveJsonModule: true,
  noUncheckedIndexedAccess: true,
  noEmit: true,
  allowJs: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  baseUrl: root,
  paths: {
    "neonethack/low": [`${library}/dist/typescript/low.d.ts`],
    "neonethack/high": [`${library}/dist/typescript/high.d.ts`],
    neonethack: [`${library}/dist/typescript/client.d.ts`],
    "neonethack/types": [`${library}/dist/typescript/types.d.ts`],
    "neonethack/wasm": [`${library}/dist/typescript/wasm.d.ts`],
    "/runtime/typescript/wasm.js": [`${library}/dist/typescript/wasm.d.ts`],
    "/runtime/typescript/webmcp.js": [`${library}/dist/typescript/webmcp.d.ts`],
    "/runtime/typescript/client.js": [`${library}/dist/typescript/client.d.ts`],
  },
  types: ["bun"],
  typeRoots: [resolve(root, "node_modules/@types")],
};
const program = ts.createProgram(
  [
    `${root}/src/app.ts`,
    `${root}/src/component.ts`,
    `${root}/src/login.ts`,
    `${root}/src/bots.ts`,
    `${root}/src/rail.ts`,
    `${root}/src/bot-worker.ts`,
    `${root}/bots/imp/main.js`,
    `${root}/src/bot-language.ts`,
    `${root}/server.ts`,
    `${root}/scripts/render-dungeon.ts`,
  ],
  options,
);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (f) => f,
      getNewLine: () => "\n",
    }),
  );
  process.exit(1);
}
const embeddedArt: Record<string,string> = {};
for (const file of new Bun.Glob('*.png').scanSync(root+'/public/art')) embeddedArt[file.replace(/\.png$/, '')] = 'data:image/png;base64,' + Buffer.from(await Bun.file(root+'/public/art/'+file).arrayBuffer()).toString('base64');
const botTypes: Record<string, string> = {};
for (const name of new Bun.Glob('*.d.ts').scanSync(library + '/dist/typescript')) botTypes['/types/' + name] = await Bun.file(library + '/dist/typescript/' + name).text();
for (const name of new Bun.Glob('lib.*.d.ts').scanSync(root + '/node_modules/typescript/lib')) botTypes['/lib/' + name] = await Bun.file(root + '/node_modules/typescript/lib/' + name).text();
const defines = { __NEOHACK_ART__: JSON.stringify(embeddedArt), __BOT_TYPES__: JSON.stringify(botTypes), __BOT_EXAMPLES__: JSON.stringify(Object.fromEntries(await Promise.all(catalog.map(async (example) => [example.id, await exampleProject(example)])))) };
const result = await Bun.build({
  define: defines,
  entrypoints: [`${root}/src/app.ts`, `${root}/src/login.ts`, `${root}/src/bots.ts`, `${root}/src/rail.ts`],
  outdir: `${root}/public/build`,
  target: "browser",
  minify: true,
  external: ["/runtime/*"],
});
if (!result.success)
  throw new AggregateError(result.logs, "Browser build failed");
console.log(
  "Pixel client typechecked and built. Gameplay uses the public neonethack API.",
);

for (const [entry, target, format] of [
  ['component', 'component/neohack.js', 'esm'],
  ['bot-language', 'build/bot-language.js', 'esm'],
  ['bot-worker', 'build/bot-worker.js', 'iife'],
  ['bot-sandbox', 'build/bot-sandbox.js', 'iife'],
] as const) {
  const built = await Bun.build({entrypoints:[root+'/src/'+entry+'.ts'],target:'browser',format,minify:true,define:defines});
  if(!built.success) throw new AggregateError(built.logs, entry+' build failed');
  const notice = entry === 'component' ? '/*! NeoHack viewer. NetHack attribution and project terms: https://github.com/tobi/neohack/blob/main/lib/neonethack/NOTICE.md . Character art by LimeZu (https://limezu.itch.io/moderninteriors), licensed for project use; raw asset redistribution is restricted. See web/neohack.dev/art/ATTRIBUTION.md in the matching source. */\n' : '';
  await Bun.write(root+'/public/'+target,notice + await built.outputs[0]!.text());
}
