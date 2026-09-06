const base = new URL(process.argv[2] ?? "https://neohack.dev");
for (const [path, type, marker] of [
  ["/", "text/html", "neohack"],
  ["/dashboard", "text/html", "dashboard"],
  ["/component", "text/html", "neohack-world"],
  ["/bots", "text/html", ""],
  ["/login", "text/html", ""],
  ["/api/health", "application/json", ""],
  ["/api/stats", "application/json", ""],
]) {
  const response = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes(type))
    throw Error(
      `${path}: ${response.status} ${response.headers.get("content-type")}`,
    );
  const body = await response.text();
  if (marker && !body.toLowerCase().includes(marker))
    throw Error(`${path}: wrong page`);
  if (path === "/api/health" && !JSON.parse(body).ok)
    throw Error("API unavailable");
  if (path === "/api/stats" && !JSON.parse(body).totals)
    throw Error("Dashboard contract unavailable");
  console.log("OK", path);
}
