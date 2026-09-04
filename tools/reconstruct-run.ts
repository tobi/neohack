// Explicit operator utility for trusted, server-managed legacy histories.
// bun tools/reconstruct-run.ts SESSIONS_DIR SOURCE_ID [--publish-to DEST_SESSIONS]
// Conversion always uses the same sandboxed worker as the web management route.
import { resolve, join } from "node:path";
import { copyFile, mkdir, mkdtemp, lstat, rename, rm } from "node:fs/promises";
import { createReconstructor } from "../mcp/src/reconstruct";
const args = process.argv.slice(2),
  root = args[0],
  source = args[1];
if (!root || !source) {
  console.error(
    "Usage: bun tools/reconstruct-run.ts SESSIONS_DIR SOURCE_ID [--publish-to DEST_SESSIONS]",
  );
  process.exit(2);
}
const manager = createReconstructor(resolve(root));
const start = await manager.start(source);
if (start.status !== 202) {
  console.error(JSON.stringify(start.body));
  process.exit(1);
}
const job = await manager.wait((start.body as any).job.id);
if (job.state !== "completed") {
  console.error(JSON.stringify(job, null, 2));
  process.exit(1);
}
const option = args.indexOf("--publish-to");
if (option >= 0) {
  if (!args[option + 1]) throw Error("--publish-to needs a destination");
  const dest = resolve(args[option + 1]),
    target = join(dest, job.archiveId);
  await mkdir(dest, { recursive: true });
  try {
    await lstat(target);
    throw Error("Destination archive already exists");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const staging = await mkdtemp(join(dest, ".incoming-"));
  try {
    for (const file of [
      "perceptions.jsonl",
      "perceptions.index.jsonl",
      "run.json",
      "meta.json",
      ".lease",
    ])
      await copyFile(
        join(resolve(root), job.archiveId, file),
        join(staging, file),
      );
    await rename(staging, target);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
}
console.log(JSON.stringify(job, null, 2));
