import { mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, ".."),
  out = resolve(root, "mcp/bin/nhxcli");
await mkdir(resolve(root, "mcp/bin"), { recursive: true });
const tmp = `${out}.new-${process.pid}`;
const p = Bun.spawn(
  [
    process.env.CC ?? "cc",
    "-O2",
    "-Wall",
    "-Wextra",
    `-I${root}/lib`,
    "-o",
    tmp,
    ...["cli/nhxcli.c", "lib/session.c", "lib/minjson.c", "lib/explorer.c"].map(
      (s) => resolve(root, s),
    ),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (await p.exited) process.exit(1);
await rename(tmp, out);
console.log(
  `Built ${out} (existing bridge processes keep their current executable)`,
);
