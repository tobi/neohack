// Installation is optional and never gates entering or moving in the dungeon.
if ("serviceWorker" in navigator && window.isSecureContext) {
  void navigator.serviceWorker
    .register("/service-worker.js", { scope: "/", updateViaCache: "none" })
    .catch(() => {});
}
