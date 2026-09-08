import { mkdir, cp } from "node:fs/promises";
import { resolve } from "node:path";
const directory = resolve(import.meta.dirname, "../.generated");
await mkdir(directory, { recursive: true });
for (const suffix of ["mjs", "d.mts"])
  await cp(
    resolve(
      import.meta.dirname,
      "../../../lib/neonethack/wasm/protocol-recording." + suffix,
    ),
    resolve(directory, "protocol-recording." + suffix),
  );
