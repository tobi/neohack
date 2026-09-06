import { readRuns, summarize } from "./_store.js";

export async function GET() {
  return Response.json(await summarize(await readRuns()), {
    headers: { "cache-control": "no-store" },
  });
}
