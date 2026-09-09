// One model step through Vercel AI Gateway. Shared by the CLI and the website
// service so both produce the same cached artifact. No credential is ever
// placed in the evidence, prompt, story or a URL; the caller supplies a bearer
// token from its environment (Vercel OIDC or AI_GATEWAY_API_KEY).
import { createHash } from "node:crypto";
import { MODEL, PROMPT_VERSION, SYSTEM, prompt, validateStory } from "./prompt.mjs";
import { annotateStory } from "./lore.mjs";

export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
export const MAX_OUTPUT_TOKENS = 2200;
export const REQUEST_TIMEOUT_MS = 90000;

export const evidenceHash = (digest) =>
  createHash("sha256")
    .update(`${MODEL}\n${PROMPT_VERSION}\n${prompt(digest)}`)
    .digest("hex");

/** Fenced or bare JSON from the model; the raw text is kept by the caller. */
export function parseStory(raw, digest) {
  if (typeof raw !== "string") throw Error("Model returned no story text");
  const json = raw
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw Error("Model returned invalid JSON; raw result is retained for review.");
  }
  return validateStory(value, digest);
}

/** A single paid request; failures are reported, never retried automatically. */
export async function gatewayStory(digest, { token, fetch: request = fetch, signal } = {}) {
  if (!token) throw Error("The story model has no credential in this environment.");
  const response = await request(GATEWAY_URL, {
    method: "POST",
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify(digest) },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      reasoning: { effort: "minimal" },
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok)
    throw Object.assign(
      Error(`Story model request failed (${response.status}); not retried automatically.`),
      { status: response.status },
    );
  const result = await response.json();
  if (result.choices?.[0]?.finish_reason === "length")
    throw Error("The model reached its output limit; evidence and prompt are saved for review.");
  return { raw: result.choices?.[0]?.message?.content, usage: result.usage };
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
