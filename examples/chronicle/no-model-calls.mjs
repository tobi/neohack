// Test guard: chronicle tests never make a paid model request. Importing this
// module removes model credentials from the process and makes any fetch to the
// AI Gateway fail loudly, so a test that reaches the real provider breaks
// instead of silently spending money. Model behaviour is covered with doubles.
import { GATEWAY_URL } from "./generate.mjs";
for (const key of ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"]) delete process.env[key];
export const FORBIDDEN_HOST = new URL(GATEWAY_URL).host;
const real = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, init) {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    /* relative or opaque input: not the gateway */
  }
  if (host === FORBIDDEN_HOST)
    throw Error("Test attempted a real model request to " + host + "; use an injected model or fetch double.");
  return real.call(this, input, init);
};
/** Environment for child processes started by tests: no model credential. */
export const childEnvironment = (extra = {}) => {
  const env = { ...process.env, ...extra };
  for (const key of ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"]) delete env[key];
  return env;
};
