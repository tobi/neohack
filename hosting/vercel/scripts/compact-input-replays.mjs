// Explicit maintenance only; public reads and chronicle GETs never compact.
import { storage, read } from "../src/storage.ts";
import { compactProtocolReplay } from "../src/protocol-replays.ts";
const args = process.argv.slice(2).filter((a) => a !== "--compact-inputs");
let apply = false,
  run,
  limit = 100;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--apply") apply = true;
  else if (args[i] === "--run") {
    run = args[++i];
    if (!run) throw Error("--run requires one public replay ID");
  }
  else if (args[i] === "--limit") limit = Number(args[++i]);
  else
    throw Error(
      "Usage: compact-input-replays.mjs [--apply] [--run ID] [--limit N]",
    );
}
if (run !== undefined && !/^[A-Za-z0-9_-]{16}$/.test(run))
  throw Error("Invalid replay ID");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
  throw Error("Limit must be 1..1000");
const ids = run
  ? [run]
  : (await storage().list("input-runs/")).flatMap((path) => {
      const m = path.match(/^input-runs\/([A-Za-z0-9_-]{16})\.json$/);
      return m ? [m[1]] : [];
    });
let selected = 0,
  updated = 0,
  before = 0,
  after = 0;
for (const id of ids) {
  const path = "input-runs/" + id + ".json",
    doc = await read(path);
  if (!doc) {
    if (run) throw Error("Run not found");
    continue;
  }
  if (!run && !doc.complete) continue;
  if (doc.chunks.length < 3 || doc.packedThrough === doc.count) continue;
  if (selected >= limit) break;
  selected++;
  before += doc.chunks.length;
  if (!apply) {
    after += doc.chunks.length;
    continue;
  }
  await compactProtocolReplay(id);
  const current = await read(path);
  after += current.chunks.length;
  if (current.chunks.length < doc.chunks.length) updated++;
  console.log(
    JSON.stringify({
      id,
      inputs: current.count,
      chunksBefore: doc.chunks.length,
      chunksAfter: current.chunks.length,
    }),
  );
}
console.log(
  JSON.stringify({
    apply,
    selected,
    updated,
    chunksBefore: before,
    chunksAfter: after,
    limit,
    scope: run ? "one run" : "concluded input archives",
  }),
);
