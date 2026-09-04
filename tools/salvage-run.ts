// Explicit preserved-copy salvage. Never starts an engine or modifies a run.
// bun tools/salvage-run.ts SESSIONS_DIR RUN_ID NEW_BUNDLE_DIR --confirm
import { salvageRun } from "../mcp/src/salvage";
const args = process.argv.slice(2);
if (args.length !== 4 || args[3] !== "--confirm") {
  console.error(
    "Usage: bun tools/salvage-run.ts SESSIONS_DIR RUN_ID NEW_BUNDLE_DIR --confirm\nDestination must be new and outside the session root. Save/retire the source first. No live world is repaired.",
  );
  process.exit(2);
}
try {
  const result = await salvageRun(args[0], args[1], args[2], { confirm: true });
  console.log(
    JSON.stringify(
      {
        destination: result.destination,
        frames: result.integrity.completeFrames,
        integrity: result.integrity,
        review: result.review,
        notice: result.notice,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
