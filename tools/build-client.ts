import { resolve } from "node:path";
import { buildComponent } from "./build-component";
const root = resolve(import.meta.dir, "..");
const result = await Bun.build({
  entrypoints: [resolve(root, "client/explorer-app.js")],
  outdir: resolve(root, "client/dist"),
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
  sourcemap: "external",
  naming: {
    entry: "[name].js",
    chunk: "[name]-[hash].js",
    asset: "[name]-[hash].[ext]",
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const output of result.outputs)
  console.log(`${output.path} (${Math.round(output.size / 1024)} KB)`);
await buildComponent();
