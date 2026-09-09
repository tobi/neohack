// On-demand AI chronicle of a concluded public run. The service replays the
// published input archive with its exact WASM pin (the same reconstruction the
// browser viewer performs), asks Muse Spark once through Vercel AI Gateway, and
// caches the validated story as a public, immutable object. Page views read
// that object statically; a story is generated at most once per run.
//
// Credentials: the gateway accepts the deployment's own OIDC token (supplied by
// Vercel on the request, never stored) or AI_GATEWAY_API_KEY from the project's
// environment. Nothing in this repository contains a key.
import { AsyncLocalStorage } from "node:async_hooks";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { read, Conflict } from "./storage.ts";
import { publicReplayConfigured, publicReplayStorage } from "./public-replay-store.ts";
import { ledgerRun, markChronicled } from "./ledger-store.ts";
import { manifestUrl, publishManifest } from "./protocol-replays.ts";
import { failureKind } from "./observability.ts";
import type { Run } from "./board.ts";
import { ChronicleDigest, type Digest } from "../.generated/chronicle/examples/chronicle/digest.mjs";
import { collectReplay } from "../.generated/chronicle/examples/chronicle/replay.mjs";
import { buildGlossary } from "../.generated/chronicle/examples/chronicle/lore.mjs";
import type { Glossary } from "../.generated/chronicle/examples/chronicle/prompt.mjs";
import {
  gatewayStory,
  parseStory,
  chronicleDocument,
  type ChronicleDocument,
} from "../.generated/chronicle/examples/chronicle/generate.mjs";

/** A tale needs a few chapters: the hero reached this depth and level, then died. */
export const CHRONICLE_MIN_DEPTH = 3;
export const CHRONICLE_MIN_LEVEL = 2;
const MAX_REPLAY_INPUTS = 20000;
const PENDING_MS = 5 * 60 * 1000;
const RUN_ID = /^[A-Za-z0-9_-]{16}$/;

export type StoryModel = (digest: Digest) => Promise<{ raw: unknown; usage?: unknown }>;
/** Tests inject a model; production uses the gateway with a request-scoped token. */
export const storyModelContext = new AsyncLocalStorage<StoryModel>();

const json = (body: unknown, status = 200, cache = "no-store") =>
  Response.json(body, { status, headers: { "cache-control": cache } });

export function chronicleEligibility(run: Run | null) {
  if (!run) return { eligible: false, reason: "This run is not in the ledger." };
  if (!run.ended || run.endKind !== "death")
    return { eligible: false, reason: "Chronicles are written for adventurers who died; this run has not ended in death." };
  if ((run.maxDepth ?? 0) < CHRONICLE_MIN_DEPTH || (run.maxLevel ?? 0) < CHRONICLE_MIN_LEVEL)
    return { eligible: false, reason: `Chronicles begin at dungeon level ${CHRONICLE_MIN_DEPTH} and experience level ${CHRONICLE_MIN_LEVEL}.` };
  return { eligible: true as const, reason: "" };
}

const storyPath = (id: string) => "chronicles/" + id + "/story.json";
const pendingPath = (id: string) => "chronicles/" + id + "/pending.json";

async function localRuntime(buildId: string) {
  const dir = resolve(import.meta.dirname, "../public/runtime/wasm", buildId);
  try {
    await stat(resolve(dir, "manifest.json"));
    return dir;
  } catch {
    return undefined;
  }
}

function gatewayToken(request: Request) {
  return (
    request.headers.get("x-vercel-oidc-token") ||
    process.env.VERCEL_OIDC_TOKEN ||
    process.env.AI_GATEWAY_API_KEY ||
    ""
  );
}

type Progress = { stage: "archive" | "replay" | "model" | "store" };
async function generate(request: Request, id: string, run: Run, progress: Progress): Promise<ChronicleDocument> {
  const archive = await read("input-runs/" + id + ".json");
  if (!archive || archive.complete !== true || !(archive.count > 0))
    throw new Ineligible("The recorded journey has not finished uploading; the tale can be told once the recording is complete.");
  progress.stage = "replay";
  const immutable = await publishManifest(id),
    source = manifestUrl(immutable, request),
    collector = new ChronicleDigest({ name: run.name, role: run.role });
  let glossary: Glossary = {};
  const digest = await collectReplay(source, collector, {
    runtime: localRuntime,
    runtimeOrigin: new URL("/", request.url).href,
    maxInputs: MAX_REPLAY_INPUTS,
    lookup: async (lookup) => {
      glossary = await buildGlossary(lookup, collector.finish());
    },
  });
  progress.stage = "model";
  const model = storyModelContext.getStore();
  const { raw, usage } = model
    ? await model(digest)
    : await gatewayStory(digest, { token: gatewayToken(request) });
  return chronicleDocument({ digest, story: parseStory(raw, digest), glossary, usage });
}

class Ineligible extends Error {}

export async function chronicle(request: Request, id: string) {
  if (!RUN_ID.test(id)) return json({ error: "not found" }, 404);
  if (!["GET", "POST"].includes(request.method)) return json({ error: "method not allowed" }, 405);
  if (!publicReplayConfigured()) return json({ error: "Public replay store is not configured" }, 503);
  const store = publicReplayStorage();
  const existing = await store.read(storyPath(id));
  if (existing) return json({ available: true, ...existing.value }, 200, "public, max-age=300");
  const run = await ledgerRun(id),
    eligibility = chronicleEligibility(run);
  if (request.method === "GET")
    return json({ available: false, ...eligibility }, 404);
  if (!eligibility.eligible) return json({ available: false, error: eligibility.reason, ...eligibility }, 409);
  if (!storyModelContext.getStore() && !gatewayToken(request))
    return json({ error: "The chronicler is not configured on this deployment." }, 503);
  // One paid generation per run: claim a short-lived pending marker first.
  const pending = await store.read(pendingPath(id));
  const now = Date.now();
  if (pending && now - Number(pending.value?.startedAt ?? 0) < PENDING_MS && !pending.value?.finishedAt)
    return json({ available: false, pending: true, error: "The chronicler is already writing this tale." }, 202);
  try {
    await store.write(pendingPath(id), { startedAt: now }, pending?.etag);
  } catch (error) {
    if (error instanceof Conflict)
      return json({ available: false, pending: true, error: "The chronicler is already writing this tale." }, 202);
    throw error;
  }
  const claim = (await store.read(pendingPath(id)))?.etag;
  const progress: Progress = { stage: "archive" };
  try {
    const document = await generate(request, id, run!, progress);
    progress.stage = "store";
    try {
      await store.write(storyPath(id), document);
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
    }
    const stored = await store.read(storyPath(id));
    await store.write(pendingPath(id), { startedAt: now, finishedAt: Date.now() }, claim).catch(() => {});
    await markChronicled(id);
    return json({ available: true, ...(stored?.value ?? document) });
  } catch (error) {
    await store.write(pendingPath(id), { startedAt: 0, failedAt: Date.now() }, claim).catch(() => {});
    if (error instanceof Ineligible) return json({ available: false, error: error.message }, 409);
    console.warn(JSON.stringify({ event: "chronicle_failed", stage: progress.stage, kind: failureKind(error) }));
    return json({ available: false, error: "The chronicler could not finish this tale. Nothing was charged twice; try again in a little while." }, 502);
  }
}
