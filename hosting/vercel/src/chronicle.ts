// On-demand AI chronicle of a concluded public run. The service replays the
// published input archive with its exact WASM pin (the same reconstruction the
// browser viewer performs; the archive holds inputs only, so the messages the
// hero saw exist nowhere until the engine replays them), asks Muse Spark once
// through Vercel AI Gateway, and caches the validated story as a public,
// immutable object. Page views read that object statically; a story is
// generated at most once per run.
//
// A POST that accepts application/x-ndjson watches the work as it happens:
// replay progress, then the story text as the model writes it, then the stored
// document. The work itself never depends on the watcher: it is registered with
// the platform's waitUntil and finishes, validates and stores the story even if
// the reader leaves.
//
// Credentials: the gateway accepts the deployment's own OIDC token (supplied by
// Vercel on the request, never stored) or AI_GATEWAY_API_KEY from the project's
// environment. Nothing in this repository contains a key.
import { AsyncLocalStorage } from "node:async_hooks";
import { waitUntil } from "@vercel/functions";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { read, Conflict } from "./storage.ts";
import { publicReplayConfigured, publicReplayStorage } from "./public-replay-store.ts";
import { ledgerRun, markChronicled } from "./ledger-store.ts";
import { manifestUrl, publishManifest } from "./protocol-replays.ts";
import { failureKind } from "./observability.ts";
import type { Run } from "./board.ts";
import { ChronicleDigest, type Digest } from "../.generated/chronicle/examples/chronicle/digest.mjs";
import { collectReplay, type ReplayTiming } from "../.generated/chronicle/examples/chronicle/replay.mjs";
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

export type StoryModel = (digest: Digest, options: { onDelta: (delta: string, text: string) => void }) => Promise<{ raw: unknown; usage?: unknown }>;
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

type Stage = "archive" | "replay" | "model" | "store";
/** Watchers receive small status objects; the final one carries the document. */
export type ChronicleEvent =
  | { status: "replaying"; done: number; total: number }
  | { status: "writing" }
  | { delta: string }
  | { status: "storing" }
  | { available: true; [key: string]: unknown }
  | { available: false; error: string };
type Watcher = (event: ChronicleEvent) => void;
type Timings = { admissionMs: number; archiveMs?: number; replay?: ReplayTiming;
  modelMs?: number; modelFirstTextMs?: number; validationMs?: number; storeMs?: number };
type Progress = { stage: Stage; watch: Watcher; timing: Timings };

async function generate(request: Request, id: string, run: Run, progress: Progress): Promise<ChronicleDocument> {
  const archiveStarted = performance.now();
  let source: string;
  try {
    const archive = await read("input-runs/" + id + ".json");
    if (!archive || archive.complete !== true || !(archive.count > 0))
      throw new Ineligible("The recorded journey has not finished uploading; the tale can be told once the recording is complete.");
    source = manifestUrl(await publishManifest(id), request);
  } finally { progress.timing.archiveMs = performance.now() - archiveStarted; }
  progress.stage = "replay";
  const collector = new ChronicleDigest({ name: run.name, role: run.role });
  let glossary: Glossary = {};
  let last = 0;
  const digest = await collectReplay(source, collector, {
    runtime: localRuntime,
    runtimeOrigin: new URL("/", request.url).href,
    maxInputs: MAX_REPLAY_INPUTS,
    onTiming: timing => { progress.timing.replay = timing; },
    onProgress: (done, total) => {
      const now = Date.now();
      if (done === total || done === 0 || now - last > 400) {
        last = now;
        progress.watch({ status: "replaying", done, total });
      }
    },
    lookup: async (lookup) => {
      glossary = await buildGlossary(lookup, collector.finish());
    },
  });
  progress.stage = "model";
  progress.watch({ status: "writing" });
  const modelStarted = performance.now();
  const onDelta = (delta: string) => {
    progress.timing.modelFirstTextMs ??= performance.now() - modelStarted;
    progress.watch({ delta });
  };
  const model = storyModelContext.getStore();
  let generated: { raw: unknown; usage?: unknown };
  try {
    generated = model ? await model(digest, { onDelta })
      : await gatewayStory(digest, { token: gatewayToken(request), onDelta });
  } finally { progress.timing.modelMs = performance.now() - modelStarted; }
  const validating = performance.now();
  try { return chronicleDocument({ digest, story: parseStory(generated.raw, digest), glossary, usage: generated.usage }); }
  finally { progress.timing.validationMs = performance.now() - validating; }
}

class Ineligible extends Error {}

const wantsStream = (request: Request) => (request.headers.get("accept") ?? "").includes("application/x-ndjson");

export async function chronicle(request: Request, id: string) {
  const started = performance.now();
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
  const watchers = new Set<Watcher>();
  const progress: Progress = { stage: "archive", watch: (event) => watchers.forEach((w) => w(event)),
    timing: { admissionMs: performance.now() - started } };
  // The whole job, independent of any reader. It resolves with the final
  // event and never rejects; the platform keeps the function alive for it.
  const work: Promise<{ status: number; body: ChronicleEvent }> = (async () => {
    let completed = false, storeStarted: number | undefined;
    try {
      const document = await generate(request, id, run!, progress);
      progress.stage = "store";
      storeStarted = performance.now();
      progress.watch({ status: "storing" });
      try {
        await store.write(storyPath(id), document);
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
      const stored = await store.read(storyPath(id));
      await store.write(pendingPath(id), { startedAt: now, finishedAt: Date.now() }, claim).catch(() => {});
      await markChronicled(id);
      completed = true;
      return { status: 200, body: { available: true as const, ...((stored?.value ?? document) as object) } };
    } catch (error) {
      // The released claim records only the stage and an upstream HTTP status:
      // bounded operational facts, never the exception, URL or credential.
      const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
      await store.write(pendingPath(id), { startedAt: 0, failedAt: Date.now(), stage: progress.stage, ...(status ? { status } : {}) }, claim).catch(() => {});
      if (error instanceof Ineligible) return { status: 409, body: { available: false as const, error: error.message } };
      console.warn(JSON.stringify({ event: "chronicle_failed", stage: progress.stage, kind: failureKind(error), ...(status ? { status } : {}) }));
      return { status: 502, body: { available: false as const, error: "The chronicler could not finish this tale. Nothing was charged twice; try again in a little while." } };
    } finally {
      if (storeStarted !== undefined) progress.timing.storeMs = performance.now() - storeStarted;
      // Exactly one bounded operational record per generation. No run/vault
      // capability, prompt, journal, story text or credential enters the log.
      console.info(JSON.stringify({ event: 'chronicle_timing', outcome: completed ? 'completed' : 'failed',
        stage: progress.stage, ...progress.timing, totalMs: performance.now() - started },
        (_key, value) => typeof value === 'number' ? Math.round(value * 10) / 10 : value));
    }
  })();
  const finished = work.then((result) => {
    progress.watch(result.body);
    watchers.clear();
  });
  try {
    waitUntil(finished);
  } catch {
    /* outside the platform the promise simply runs to completion */
  }
  if (!wantsStream(request)) {
    const result = await work;
    return json(result.body, result.status);
  }
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined, open = true;
  const watcher: Watcher = (event) => {
    if (!open || !controller) return;
    try {
      controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      if ("available" in event) controller.close();
    } catch {
      open = false;
    }
    if ("available" in event) {
      open = false;
      watchers.delete(watcher);
    }
  };
  watchers.add(watcher);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      watcher({ status: "replaying", done: 0, total: 0 });
    },
    cancel() {
      // The reader left; the work continues and is stored regardless.
      open = false;
      watchers.delete(watcher);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
