/** Cooperative tab handoff. The worker's exclusive storage lock remains the
 * final authority; this admission lock lets its owner drain and close first. */
export async function claimTabStore(
  name: string,
  signal: AbortSignal,
  yieldStore: () => Promise<void>,
) {
  const channel = new BroadcastChannel(`neohack-play:${name}`);
  const abort = new AbortController();
  const cancelled = () => abort.abort(signal.reason);
  signal.addEventListener("abort", cancelled, { once: true });
  if (signal.aborted) cancelled();
  let release!: () => void;
  const lifetime = new Promise<void>((resolve) => {
    release = resolve;
  });
  let owned = false,
    yielding = false;
  channel.onmessage = (event) => {
    if (owned && !yielding && event.data === "handoff") {
      yielding = true;
      void yieldStore().catch(() => {
        yielding = false;
      });
    }
  };
  const ask = () => channel.postMessage("handoff");
  const timer = setInterval(ask, 250);
  const timeout = setTimeout(
    () =>
      abort.abort(
        Error(
          "The other tab has not finished saving yet. Try Play here again in a moment.",
        ),
      ),
    15000,
  );
  const cleanup = () => {
    clearInterval(timer);
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancelled);
  };
  try {
    return await new Promise<{ release: () => void }>((resolve, reject) => {
      void navigator.locks
        .request(`neohack-play:${name}`, { signal: abort.signal }, async () => {
          cleanup();
          owned = true;
          resolve({
            release: () => {
              owned = false;
              channel.close();
              release();
            },
          });
          await lifetime;
        })
        .catch(reject);
      ask();
    });
  } catch (error) {
    cleanup();
    channel.close();
    throw error;
  }
}
