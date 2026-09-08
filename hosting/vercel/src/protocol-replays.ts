import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { read, update, Conflict, AuthStore } from "./storage.ts";
import {
  publicReplayConfigured,
  publicReplayStorage,
  writeReplayBytes,
} from "./public-replay-store.ts";
import { markRecorded } from "./ledger-store.ts";
import { validateRecord } from "../.generated/protocol-recording.mjs";

const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
function manifestUrl(path: string, request: Request) {
  const base =
    process.env.PUBLIC_REPLAY_ORIGIN ??
    new URL("/replay-files/", request.url).href;
  return new URL(path, base.endsWith("/") ? base : base + "/").href;
}
async function immutableManifest(id: string, manifest: any) {
  const bytes = JSON.stringify(manifest),
    path = "replays/" + id + "/manifest-" + sha(bytes) + ".json",
    store = publicReplayStorage();
  try {
    await store.write(path, manifest);
  } catch (e) {
    if (!(e instanceof Conflict)) throw e;
    if (JSON.stringify((await store.read(path))?.value) !== bytes)
      throw Error("Immutable manifest differs");
  }
  return path;
}
function inputManifest(id: string, doc: any) {
  return {
    format: "neonethack.inputs",
    version: 1,
    generation: doc.generation,
    id,
    buildId: doc.buildId,
    count: doc.count,
    chunks: doc.chunks,
    checkpoints: doc.checkpoints ?? [],
    role: doc.role,
    seed: doc.seed,
    complete: doc.complete,
  };
}
async function publishManifest(id: string) {
  const store = publicReplayStorage(),
    manifestPath = "replays/" + id + "/manifest.json";
  for (let attempt = 0; attempt < 12; attempt++) {
    const doc = await read("input-runs/" + id + ".json"),
      current = await store.read(manifestPath);
    if (current && current.value.format !== "neonethack.inputs")
      throw Error("Published archive uses another format");
    const manifest = inputManifest(id, doc);
    const immutablePath = await immutableManifest(id, manifest);
    if (current?.value.generation >= doc.generation) return immutablePath;
    try {
      await store.write(manifestPath, manifest, current?.etag);
      return immutablePath;
    } catch (e) {
      if (!(e instanceof Conflict) || attempt === 11) throw e;
    }
  }
  throw Error("Manifest publication did not complete");
}
export async function protocolCheckpoint(request: Request, id: string) {
  if (request.method !== "PUT")
    return json({ error: "Method not allowed" }, 405);
  if (
    request.headers.get("origin") &&
    request.headers.get("origin") !== new URL(request.url).origin
  )
    return json({ error: "Origin differs" }, 403);
  const token = request.headers.get("authorization")?.replace(/^Bearer /, ""),
    index = Number(request.headers.get("x-checkpoint-index"));
  if (!token || !/^[0-9a-f-]{36}$/i.test(token))
    return json({ error: "Upload authority required" }, 401);
  const path = "input-runs/" + id + ".json",
    doc = await read(path);
  if (!doc || doc.owner !== sha(token))
    return json({ error: "Upload authority differs" }, 403);
  if (!Number.isSafeInteger(index) || index < 1 || index > doc.count)
    return json({ error: "Checkpoint is outside the committed log" }, 409);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: "Missing checkpoint" }, 400);
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4 * 1024 * 1024) {
        await reader.cancel();
        return json({ error: "Checkpoint too large" }, 413);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(parts),
    hash = sha(bytes);
  if (length < 16 || request.headers.get("x-content-sha256") !== hash)
    return json({ error: "Checkpoint checksum differs" }, 400);
  const checkpoint = {
    index,
    path: "checkpoints/" + hash + ".gz",
    sha256: hash,
    bytes: length,
  };
  await writeReplayBytes("replays/" + id + "/" + checkpoint.path, bytes);
  const rejected = await update<any, Response | null>(
    path,
    () => {
      throw Error("Run disappeared");
    },
    (current) => {
      current.checkpoints ??= [];
      const previous = current.checkpoints.find((c: any) => c.index === index);
      if (previous && previous.sha256 !== hash)
        return json({ error: "Checkpoint at this input already exists" }, 409);
      if (!previous && current.checkpoints.length >= 10000)
        return json({ error: "Checkpoint index is full" }, 413);
      if (
        !current.checkpoints.some((c: any) => c.index === index) &&
        current.checkpoints.length < 10000
      ) {
        current.checkpoints.push(checkpoint);
        current.generation++;
      }
      current.checkpoints.sort((a: any, b: any) => a.index - b.index);
      return null;
    },
  );
  if (rejected) return rejected;
  const published = await publishManifest(id);
  return json({ index, hash, manifest: manifestUrl(published, request) });
}
export async function protocolReplay(request: Request, id: string) {
  if (request.method !== "PUT" && request.method !== "GET")
    return json({ error: "Method not allowed" }, 405);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return json({ error: "Origin differs" }, 403);
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token || !/^[0-9a-f-]{36}$/i.test(token))
    return json({ error: "Upload authority required" }, 401);
  if (request.method === "GET") {
    const doc = await read("input-runs/" + id + ".json");
    if (!doc) return json({ error: "Run is not backed up yet" }, 404);
    if (doc.owner !== sha(token))
      return json({ error: "Upload authority differs" }, 403);
    // Fresh-device restore resolves its exact immutable prefix through private
    // metadata. Watching never calls this endpoint. Repair an interrupted
    // publication using committed inputs only; no engine is run here.
    return json({
      manifest: manifestUrl(
        await immutableManifest(id, inputManifest(id, doc)),
        request,
      ),
    });
  }
  if (!publicReplayConfigured())
    return json({ error: "Replay publication unavailable" }, 503);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: "Missing input chunk" }, 400);
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 512 * 1024) {
        await reader.cancel();
        return json({ error: "Chunk too large" }, 413);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(parts),
    hash = sha(bytes);
  if (request.headers.get("x-content-sha256") !== hash)
    return json({ error: "Chunk hash differs" }, 400);
  let body: any;
  try {
    body = JSON.parse(
      gunzipSync(bytes, { maxOutputLength: 1024 * 1024 }).toString("utf8"),
    );
  } catch {
    return json({ error: "Invalid compressed input chunk" }, 400);
  }
  if (
    body?.format !== "neonethack.inputs" ||
    body.version !== 1 ||
    body.id !== id ||
    !Number.isSafeInteger(body.from) ||
    body.from < 0 ||
    !/^[a-f0-9]{64}$/.test(body.buildId ?? "") ||
    !Array.isArray(body.records) ||
    body.records.length < 1 ||
    body.records.length > 128 ||
    typeof body.complete !== "boolean"
  )
    return json({ error: "Invalid input chunk" }, 400);
  for (let i = 0; i < body.records.length; i++) {
    const r = body.records[i],
      index = body.from + i;
    try {
      validateRecord(r, index);
    } catch {
      return json({ error: "Invalid input record or integrity evidence" }, 400);
    }
    if (
      r?.index !== index ||
      r.request?.version !== 1 ||
      typeof r.request.method !== "string" ||
      !r.request.params ||
      JSON.stringify(r.request).length > 4096 ||
      !/^[a-f0-9]{64}$/.test(r.digest ?? "")
    )
      return json({ error: "Invalid input record" }, 400);
    if (index === 0) {
      if (
        r.request.method !== "session.create" ||
        r.creation?.id !== id ||
        !Number.isSafeInteger(r.creation.epoch) ||
        r.creation.epoch < 0 ||
        r.creation.epoch > 4102444799 ||
        !Number.isSafeInteger(r.request.params.seed)
      )
        return json({ error: "Missing world identity" }, 400);
    } else if (
      r.creation ||
      r.request.method === "session.create" ||
      r.request.params.sessionId !== id
    )
      return json({ error: "Input belongs to another run" }, 400);
  }
  const owner = sha(token),
    path = "input-runs/" + id + ".json";
  let initial = await read(path);
  if (!initial) {
    if (await publicReplayStorage().read("replays/" + id + "/manifest.json"))
      return json({ error: "This run already has a published archive" }, 409);
    const adventures = await read("vaults/" + token + "/adventures.json");
    const run = adventures?.values?.find((r: any) => r.id === id);
    if (!run)
      return json(
        { error: "Run does not belong to this upload authority" },
        403,
      );
    if (run.buildId !== body.buildId)
      return json({ error: "Run package differs" }, 409);
    initial = {
      owner,
      buildId: body.buildId,
      count: 0,
      generation: 0,
      chunks: [],
      name: run.name,
      role: run.role,
      seed: body.records[0]?.request.params.seed,
      control:
        run.control === "manual"
          ? "interactive"
          : (run.control ?? "interactive"),
      complete: false,
    };
  }
  if (initial.owner !== owner)
    return json({ error: "Upload authority differs" }, 403);
  let accountId = initial.accountId;
  if (!accountId) {
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("nh_session="))
      ?.slice(11);
    if (cookie) {
      const session = await new AuthStore().get("session:" + cookie);
      if (session?.expires > Date.now()) accountId = session.userId;
    }
  }
  const chunk = {
    path: "chunks/" + hash + ".gz",
    sha256: hash,
    bytes: bytes.length,
    from: body.from,
    count: body.records.length,
  };
  const through = body.from + body.records.length;
  const accepted = await update<any, Response | null>(
    path,
    () => initial,
    async (doc) => {
      if (doc.owner !== owner)
        return json({ error: "Upload authority differs" }, 403);
      if (doc.buildId !== body.buildId)
        return json({ error: "Run package differs" }, 409);
      const prior = doc.chunks.find((c: any) => c.from === body.from);
      if (prior)
        return prior.sha256 === hash
          ? null
          : json({ error: "Committed input range differs" }, 409);
      if (body.from !== doc.count || doc.complete)
        return json({ error: "Input cursor differs" }, 409);
      if (doc.chunks.length >= 100000)
        return json({ error: "Run archive is full" }, 413);
      await writeReplayBytes("replays/" + id + "/" + chunk.path, bytes);
      doc.chunks.push(chunk);
      doc.count = through;
      doc.generation++;
      doc.complete = body.complete;
      doc.accountId ??= accountId;
      doc.updated = Date.now();
      const s = body.summary;
      if (
        s &&
        Number.isSafeInteger(s.turn) &&
        s.turn >= 0 &&
        Number.isSafeInteger(s.level) &&
        Number.isSafeInteger(s.maxLevel) &&
        typeof s.depth === "string" &&
        s.depth.length <= 128 &&
        typeof s.outcome === "string" &&
        s.outcome.length <= 64
      )
        doc.summary = {
          revision: Number.isSafeInteger(s.revision) ? s.revision : 0,
          turn: s.turn,
          level: s.level,
          maxLevel: s.maxLevel,
          depth: s.depth,
          outcome: s.outcome,
        };
      return null;
    },
  );
  if (accepted) return accepted;
  // Ack only after static publication. A lost response republishes this same
  // committed prefix and returns the same range/hash without another game step.
  const manifestPath = await publishManifest(id);
  if (body.from === 0) await markRecorded(id);
  const publishedUrl = manifestUrl(manifestPath, request);
  if (accountId)
    await update<any, void>(
      "accounts/" + accountId + "/runs/" + id + ".json",
      () => ({}),
      (doc) => {
        doc.inputRun ??= id;
        doc.run ??= {
          id,
          sessionId: id,
          name: initial.name,
          role: initial.role,
          seed: initial.seed,
          control: initial.control,
          automated: initial.control === "bot",
          buildId: body.buildId,
          replayUrl: publishedUrl,
          inputRun: true,
        };
        doc.run.replayUrl = publishedUrl;
      },
    );
  return json({ through, hash, manifest: publishedUrl });
}
