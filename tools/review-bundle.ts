// Dedicated public-only server. No core, engine, MCP or reconstruction imports.
// bun tools/review-bundle.ts BUNDLE_DIR [--port PORT]
import { resolve } from "node:path";
import {
  openBundleReview,
  createBundleReviewHandler,
} from "../mcp/src/bundle-review";
const args = process.argv.slice(2);
if (
  !args[0] ||
  ![1, 3].includes(args.length) ||
  (args.length === 3 && args[1] !== "--port")
) {
  console.error("Usage: bun tools/review-bundle.ts BUNDLE_DIR [--port PORT]");
  process.exit(2);
}
const port = Number(args[2] ?? 3313);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw Error("Invalid port");
const bundle = await openBundleReview(args[0]);
try {
  const fetch = await createBundleReviewHandler(
    bundle,
    resolve(import.meta.dir, "../client"),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 1024,
    fetch,
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop(true);
    await bundle.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(
    JSON.stringify({
      url: `http://127.0.0.1:${server.port}/play?run=${bundle.id}`,
      sessionId: bundle.id,
      readOnly: true,
      frames: bundle.integrity.completeFrames,
      verification:
        "Public checkpoint SHA-256 only; private evidence/export not read or verified; not authenticity or historical verification",
    }),
  );
} catch (error) {
  await bundle.close();
  throw error;
}
