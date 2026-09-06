import { mergeRuns, readRuns, writeRuns, type Run } from "./_store.js";

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET() {
  return Response.json(await readRuns(), { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { runs?: Array<Record<string, unknown>> };
  const incoming: Run[] = [];
  const now = Date.now();
  for (const run of (body.runs ?? []).slice(0, 50)) {
    if (typeof run.id !== "string" || !RUN_ID.test(run.id)) continue;
    incoming.push({
      id: run.id,
      name: typeof run.name === "string" ? run.name.slice(0, 64) : "Adventurer",
      role: typeof run.role === "string" ? run.role.slice(0, 32) : "valkyrie",
      turn: typeof run.turn === "number" ? run.turn : 0,
      ended: Boolean(run.ended),
      updatedAt: now,
    });
  }
  try {
    const runs = mergeRuns(await readRuns(), incoming);
    await writeRuns(runs);
    return Response.json({ stored: incoming.length });
  } catch (error) {
    return Response.json(
      { stored: 0, error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
