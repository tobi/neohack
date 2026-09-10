// The chronicle service reuses the on-demand tool in examples/chronicle and the
// library's WASM transport. Vercel uploads only this directory, so the exact
// module closure is copied under .generated/chronicle/ with its repository
// layout intact; relative imports keep working and nothing is rewritten.
import { mkdir, cp, readFile, stat } from "node:fs/promises";
import { dirname, resolve, relative, sep } from "node:path";
const repo = resolve(import.meta.dirname, "../../..");
const target = resolve(import.meta.dirname, "../.generated/chronicle");
const entries = ["digest.mjs", "prompt.mjs", "lore.mjs", "generate.mjs", "replay.mjs"].map(
  (name) => resolve(repo, "examples/chronicle", name),
);
const pending = [...entries], copied = new Set();
while (pending.length) {
  const file = pending.pop();
  if (copied.has(file)) continue;
  copied.add(file);
  const rel = relative(repo, file);
  if (rel.startsWith("..") || rel.split(sep)[0] === "node_modules")
    throw Error("Chronicle module closure leaves the repository: " + file);
  await stat(file);
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(
    /(?:^|\n)\s*(?:import|export)[^'";]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  )) {
    const spec = match[1] ?? match[2];
    pending.push(resolve(dirname(file), spec));
  }
  // Worker entrypoints are module dependencies too. Keep current host plumbing
  // together; the original compiled engine/core/data are loaded by exact pin.
  for (const match of source.matchAll(/new URL\(\s*["'](\.{1,2}\/[^"']+\.mjs)["']\s*,\s*import\.meta\.url\s*\)/g))
    pending.push(resolve(dirname(file), match[1]));
  const destination = resolve(target, rel);
  await mkdir(dirname(destination), { recursive: true });
  await cp(file, destination);
}
// Minimal typings for the TypeScript service; the modules themselves are JS.
const declarations = {
  "digest.d.mts": `export const DIGEST_VERSION: number; export const MAX_PROMPT_CHARS: number;
export function isFullReply(reply: unknown): boolean;
export type Digest = { version: number; hero: Record<string, string>; coverage: Record<string, unknown>; events: any[] };
export class ChronicleDigest { constructor(identity?: { name?: string; role?: string; race?: string }); hero: Record<string, string>; count: number; add(reply: unknown): boolean; addEvidence(reply: unknown): boolean; finish(): Digest; }`,
  "prompt.d.mts": `import type { Digest } from "./digest.mjs";
export const PROMPT_VERSION: string; export const MODEL: string; export const SYSTEM: string;
export type Story = { title: string; paragraphs: { text: string; sources: string[]; segments?: { text: string; term?: string }[] }[] };
export function prompt(digest: Digest): string;
export function transcript(digest: Digest): string;
export function transcriptLine(event: any): string;
export function parseStoryMarkdown(text: string): { title: string; paragraphs: { text: string; sources: string[] }[] };
export function validateStory(value: unknown, digest: Digest): Story;
export function renderStory(story: Story, digest: Digest, model?: string, glossary?: Glossary): string;
export type Glossary = Record<string, { name: string; lines: string[] }>;`,
  "lore.d.mts": `import type { Digest } from "./digest.mjs"; import type { Glossary, Story } from "./prompt.mjs";
export const MAX_LOOKUPS: number; export const MAX_TERMS: number;
export function candidateTerms(digest: Digest): string[];
export function buildGlossary(lookup: (name: string) => Promise<any>, digest: Digest): Promise<Glossary>;
export function segment(text: string, glossary: Glossary): { text: string; term?: string }[];
export function annotateStory(story: Story, glossary: Glossary): { story: Story; glossary: Glossary };`,
  "generate.d.mts": `import type { Digest } from "./digest.mjs"; import type { Glossary, Story } from "./prompt.mjs";
export const GATEWAY_URL: string; export const MAX_OUTPUT_TOKENS: number; export const REQUEST_TIMEOUT_MS: number;
export function evidenceHash(digest: Digest): string;
export function parseStory(raw: unknown, digest: Digest): Story;
export function gatewayStory(digest: Digest, options: { token: string; fetch?: typeof fetch; signal?: AbortSignal; onDelta?: (delta: string, text: string) => void }): Promise<{ raw: unknown; usage?: unknown }>;
export type ChronicleDocument = { version: 1; model: string; promptVersion: string; evidenceHash: string; generatedAt: number; hero: Record<string, string>; coverage: Record<string, unknown>; usage?: unknown; story: Story; glossary: Glossary };
export function chronicleDocument(input: { digest: Digest; story: Story; glossary?: Glossary; usage?: unknown; generatedAt?: number }): ChronicleDocument;`,
  "replay.d.mts": `import type { ChronicleDigest, Digest } from "./digest.mjs";
export type ReplayTiming = { mode: 'batch-evidence'; inputs: number; completedInputs: number; chunks: number; compressedBytes: number; batches: number; manifestMs: number; runtimeMs: number; downloadWaitMs: number; replayMs: number; digestMs: number; loreMs: number; closeMs: number; totalMs: number };
export function collectReplay(url: string, collector: ChronicleDigest, options?: { runtime?: string | ((buildId: string) => Promise<string | undefined> | string | undefined); runtimeOrigin?: string; signal?: AbortSignal; lookup?: (lookup: (name: string) => Promise<any>) => Promise<void>; maxInputs?: number; onProgress?: (done: number, total: number) => void; onTiming?: (timing: ReplayTiming) => void }): Promise<Digest>;`,
};
const { writeFile } = await import("node:fs/promises");
for (const [name, text] of Object.entries(declarations))
  await writeFile(resolve(target, "examples/chronicle", name), text + "\n");
export const staged = [...copied].map((f) => relative(repo, f)).sort();
if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href)
  console.log(`Staged ${staged.length} chronicle modules into .generated/chronicle`);
