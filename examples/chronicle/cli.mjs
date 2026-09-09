#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { ChronicleDigest } from "./digest.mjs";
import { prompt, validateStory, renderStory } from "./prompt.mjs";
import { buildGlossary } from "./lore.mjs";
import {
  evidenceHash as hashEvidence,
  gatewayStory,
  parseStory,
  chronicleDocument,
} from "./generate.mjs";

const argv = process.argv.slice(2);
const { values } = parseArgs({
  options: Object.fromEntries([
    ...["input", "replay", "out", "runtime", "name", "role", "provider"].map(
      (key) => [key, { type: "string" }],
    ),
    ["prepare-only", { type: "boolean" }],
    ["help", { type: "boolean" }],
  ]),
});
const option = (name) => values[name.slice(2)];
if (argv.includes("--help") || (!option("--input") && !option("--replay"))) {
  console.log(
    "node examples/chronicle/cli.mjs (--input replies.jsonl | --replay STATIC_MANIFEST_URL) --out /tmp/chronicle [--runtime LOCAL_PACKAGE_DIR] [--name NAME --role ROLE] [--prepare-only | --provider muse|gateway]\nFull public snapshots, MCP structuredContent or {request,response}, one JSON value per line. Replay mode verifies immutable chunks, reconstructs every input with its exact WASM pin and adds encyclopedia notes for witnessed names. Outputs digest.json, prompt.txt, story.json and index.html. Default: Muse Spark 1.3 through authenticated muse CLI; gateway uses AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN.",
  );
  process.exit(argv.includes("--help") ? 0 : 1);
}
if (option("--input") && option("--replay"))
  throw Error("Choose --input or --replay");
const provider = option("--provider") ?? "muse";
if (!["muse", "gateway"].includes(provider))
  throw Error("Provider must be muse or gateway");
const out = resolve(option("--out") ?? "/tmp/neohack-chronicle"),
  collector = new ChronicleDigest({
    name: option("--name"),
    role: option("--role"),
  });
let line = 0,
  glossary = {};
if (option("--replay")) {
  const { collectReplay } = await import("./replay.mjs");
  await collectReplay(option("--replay"), collector, {
    runtime: option("--runtime"),
    lookup: async (lookup) => {
      glossary = await buildGlossary(lookup, collector.finish());
    },
  });
} else
  for await (const text of createInterface({
    input: createReadStream(option("--input")),
    crlfDelay: Infinity,
  })) {
    line++;
    if (!text.trim()) continue;
    if (Buffer.byteLength(text) > 8 * 1024 * 1024)
      throw Error(`Reply line ${line} exceeds 8 MiB`);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw Error(`Invalid JSON on line ${line}`);
    }
    collector.add(value);
  }
const digest = collector.finish();
const evidenceHash = hashEvidence(digest);
await mkdir(out, { recursive: true });
await writeFile(
  join(out, "digest.json"),
  JSON.stringify(digest, null, 2) + "\n",
);
await writeFile(join(out, "prompt.txt"), prompt(digest));
console.log(
  `${digest.coverage.observedReplies} replies → ${digest.events.length} events, ${Buffer.byteLength(JSON.stringify(digest))} evidence bytes, ${Object.keys(glossary).length} encyclopedia names`,
);
let cached;
try {
  const saved = JSON.parse(await readFile(join(out, "story.json"), "utf8"));
  if (saved.evidenceHash === evidenceHash)
    cached = validateStory(saved.story, digest);
} catch (error) {
  if (error.code && error.code !== "ENOENT") throw error;
}
if (!cached)
  for (const name of ["story.json", "index.html", "model-output.txt"])
    await rm(join(out, name), { force: true });
if (argv.includes("--prepare-only")) process.exit(0);
const save = async (story, usage) => {
  const document = chronicleDocument({ digest, story, glossary, usage });
  await writeFile(join(out, "story.json"), JSON.stringify(document, null, 2) + "\n");
  await writeFile(
    join(out, "index.html"),
    renderStory(document.story, digest, document.model, document.glossary),
  );
};
if (cached) {
  await save(cached);
  console.log(`Reused chronicle: ${join(out, "index.html")} (no model call)`);
  process.exit(0);
}
let raw, usage;
if (provider === "gateway") {
  const token = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
  if (!token)
    throw Error(
      "Set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN; never put a key in the prompt or command arguments.",
    );
  ({ raw, usage } = await gatewayStory(digest, { token }));
} else if (provider === "muse") {
  const work = await mkdtemp(join(tmpdir(), "neohack-chronicler-"));
  try {
    const file = join(work, "prompt.txt");
    await writeFile(file, prompt(digest));
    raw = await new Promise((resolve, reject) => {
      const child = spawn(
        "muse",
        [
          "exec",
          "--model",
          "muse-spark-1.3",
          "--reasoning-effort",
          "minimal",
          "--max-model-steps",
          "1",
          "--no-session-log",
          "--no-foreign-personal-context",
          "--disable-shell",
          "--disable-write",
          "--disable-web-tools",
          "--workspace",
          work,
          "--prompt-file",
          file,
        ],
        { cwd: work, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("Muse timed out; no automatic retry."));
      }, 90000);
      child.stdout.on("data", (c) => {
        stdout += c;
        if (stdout.length > 100000) {
          child.kill("SIGKILL");
          reject(Error("Model output exceeded limit"));
        }
      });
      child.stderr.on("data", (c) => {
        stderr = (stderr + c).slice(-4000);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else {
          const category = stderr.match(
            /\b(?:HTTP[ :]+[1-5]\d\d|timed out|unauthorized|rate limit|overloaded|connection refused|connection reset)\b/i,
          )?.[0];
          reject(
            Error(
              `Muse exited ${code}${category ? `: ${category}` : ""}; evidence is saved. Check the provider separately; not retried automatically.`,
            ),
          );
        }
      });
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
} else throw Error("Provider must be muse or gateway");
if (typeof raw !== "string") throw Error("Model returned no story text");
// Keep the actual model result even if structural/citation checks fail.
await writeFile(join(out, "model-output.txt"), raw);
await save(parseStory(raw, digest), usage);
console.log(`One-page chronicle: ${join(out, "index.html")}`);
