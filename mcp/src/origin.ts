// Local-by-default transport policy. Origin checks alone are insufficient for
// DNS rebinding: also reject unexpected Host names before serving local data.
// Explicit reverse-proxy origins may be configured. This is not authentication.
function allowedOrigins() {
  return (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
export function hostAllowed(req: Request): boolean {
  const hostname = new URL(req.url).hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname))
    return true;
  return allowedOrigins().some((origin) => {
    try {
      return new URL(origin).hostname.toLowerCase() === hostname;
    } catch {
      return false;
    }
  });
}
export function originAllowed(req: Request): boolean {
  if (!hostAllowed(req)) return false;
  const origin = req.headers.get("origin");
  return (
    !origin ||
    origin === new URL(req.url).origin ||
    allowedOrigins().includes(origin)
  );
}
