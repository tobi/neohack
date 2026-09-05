import ts from "typescript";
import { resolve } from "node:path";
import { access } from "node:fs/promises";

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
  noUncheckedIndexedAccess: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  baseUrl: root,
  paths: {
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
const result = await Bun.build({
  entrypoints: [`${root}/src/app.ts`],
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
