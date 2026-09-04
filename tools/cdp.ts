// Minimal CDP helper for real-browser contract/visual checks. Creates its own
// tab and never navigates or closes another user's tab.
import { writeFile } from "node:fs/promises";
export async function browserTab(url: string, width = 1500, height = 1000) {
  const base = process.env.CDP_URL ?? "http://127.0.0.1:9333";
  const target = await (
    await fetch(`${base}/json/new?about:blank`, { method: "PUT" })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = reject;
  });
  let seq = 0;
  const pending = new Map();
  const errors: any[] = [];
  const requests: { url: string; method: string }[] = [];
  const listeners = new Map<string, Set<(params: any) => unknown>>();
  let onLoad = () => {};
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id) {
      const p = pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(m.id);
        m.error ? p.reject(m.error) : p.resolve(m.result);
      }
    } else {
      if (m.method === "Runtime.exceptionThrown") errors.push(m.params);
      if (m.method === "Network.requestWillBeSent")
        requests.push({
          url: m.params.request.url,
          method: m.params.request.method,
        });
      if (m.method === "Page.loadEventFired") onLoad();
      for (const listener of listeners.get(m.method) ?? [])
        Promise.resolve(listener(m.params)).catch((error) =>
          errors.push({ listener: m.method, error: String(error) }),
        );
    }
  };
  function call(method: string, params: any = {}) {
    return new Promise<any>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`CDP timeout: ${method}`));
      }, 60000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression: string) {
    const r = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  }
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const loaded = new Promise<void>((resolve) => (onLoad = resolve));
  await call("Page.navigate", { url });
  await loaded;
  return {
    target,
    errors,
    requests,
    call,
    evaluate,
    async screenshot(path: string) {
      await evaluate(
        "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
      );
      const r = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(path, Buffer.from(r.data, "base64"));
    },
    on(method: string, listener: (params: any) => unknown) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method)!.add(listener);
      return () => listeners.get(method)?.delete(listener);
    },
    async close() {
      ws.close();
      if (process.env.KEEP_BROWSER_TAB !== "1")
        await fetch(`${base}/json/close/${target.id}`).catch(() => {});
    },
  };
}
