// Replaced at staging with the exact public asset inventory. No saves, account
// responses, upload requests or authenticated API data enter these caches.
const CONFIG = null; // NE0HACK_OFFLINE_CONFIG
const RUNTIMES = "neohack-runtimes-v1";
const shell = () => "neohack-shell-" + CONFIG.version;
self.addEventListener("install", (event) =>
  event.waitUntil(
    (async () => {
      if (!CONFIG) throw Error("The offline package has not been staged");
      const assets = CONFIG.assets.slice();
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          while (assets.length) {
            const path = assets.shift(),
              cache = await caches.open(
                /^\/runtime\/wasm\/[a-f0-9]{64}\//.test(path)
                  ? RUNTIMES
                  : shell(),
              );
            if (await cache.match(path)) continue;
            const response = await fetch(path, {
              cache: "reload",
              credentials: "omit",
            });
            if (!response.ok) throw Error("Offline asset unavailable: " + path);
            await cache.put(path, response);
          }
        }),
      );
      await self.skipWaiting();
    })(),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      // Runtime packages remain available for supported saved-run pins. This never
      // opens or deletes a run database; browser storage eviction is still possible.
      for (const name of await caches.keys())
        if (name.startsWith("neohack-shell-") && name !== shell())
          await caches.delete(name);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    !CONFIG ||
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_vercel/")
  )
    return;
  const path =
    url.pathname === "/"
      ? "/index.html"
      : ["/bots", "/bots/"].includes(url.pathname)
        ? "/bots/index.html"
        : url.pathname;
  if (
    !CONFIG.assets.includes(path) &&
    !/^\/runtime\/wasm\/[a-f0-9]{64}\//.test(path)
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(
        /^\/runtime\/wasm\/[a-f0-9]{64}\//.test(path) ? RUNTIMES : shell(),
      );
      const saved = await cache.match(path);
      if (saved) return saved;
      const response = await fetch(request);
      if (response.ok) await cache.put(path, response.clone());
      return response;
    })(),
  );
});
