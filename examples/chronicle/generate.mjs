// One model step through Vercel AI Gateway. Shared by the CLI and the website
// service so both produce the same cached artifact. No credential is ever
// placed in the evidence, prompt, story or a URL; the caller supplies a bearer
// token from its environment (Vercel OIDC or AI_GATEWAY_API_KEY).
import { createHash } from "node:crypto";
import { MODEL, PROMPT_VERSION, SYSTEM, prompt, transcript, validateStory, parseStoryMarkdown } from "./prompt.mjs";
import { annotateStory } from "./lore.mjs";

export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
export const MAX_OUTPUT_TOKENS = 2400;
export const REQUEST_TIMEOUT_MS = 180000;

export const evidenceHash = (digest) =>
  createHash("sha256")
    .update(`${MODEL}\n${PROMPT_VERSION}\n${prompt(digest)}`)
    .digest("hex");

/** The model's markdown story (or, for older captures, fenced JSON); the raw
 * text is kept by the caller for review. */
export function parseStory(raw, digest) {
  if (typeof raw !== "string" || !raw.trim()) throw Error("Model returned no story text");
  const text = raw.trim();
  const bare = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  let value;
  if (bare.startsWith("{")) {
    try {
      value = JSON.parse(bare);
    } catch {
      throw Error("Model returned invalid JSON; raw result is retained for review.");
    }
  } else value = parseStoryMarkdown(text);
  return validateStory(value, digest);
}

/** Read an OpenAI-style SSE stream, calling onDelta for each content piece. */
async function readStream(body, onDelta) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "", text = "", usage, finish;
  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.usage) usage = event.usage;
    const choice = event.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta) {
      text += delta;
      onDelta?.(delta, text);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, index).replace(/\r$/, ""));
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer.trim()) handle(buffer.trim());
  return { text, usage, finish };
}

/** A single paid request; failures are reported, never retried automatically.
 * With `onDelta`, the response is streamed and each text piece is delivered as
 * it arrives; the full text is still returned and validated by the caller. */
export async function gatewayStory(digest, { token, fetch: request = fetch, signal, onDelta } = {}) {
  if (!token) throw Error("The story model has no credential in this environment.");
  const stream = typeof onDelta === "function";
  const response = await request(GATEWAY_URL, {
    method: "POST",
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: transcript(digest) },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      reasoning: { effort: "minimal" },
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    }),
  });
  if (!response.ok)
    throw Object.assign(
      Error(`Story model request failed (${response.status}); not retried automatically.`),
      { status: response.status },
    );
  let raw, usage, finish;
  if (stream && response.body) ({ text: raw, usage, finish } = await readStream(response.body, onDelta));
  else {
    const result = await response.json();
    raw = result.choices?.[0]?.message?.content;
    usage = result.usage;
    finish = result.choices?.[0]?.finish_reason;
  }
  if (finish === "length")
    throw Error("The model reached its output limit; evidence and prompt are saved for review.");
  return { raw, usage };
}

/** The cached, public artifact: validated story, dotted-term segments, glossary. */
export function chronicleDocument({ digest, story, glossary = {}, usage, generatedAt = Date.now() }) {
  const annotated = annotateStory(story, glossary);
  return {
    version: 1,
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    evidenceHash: evidenceHash(digest),
    generatedAt,
    hero: digest.hero,
    coverage: digest.coverage,
    usage,
    story: annotated.story,
    glossary: annotated.glossary,
  };
}
