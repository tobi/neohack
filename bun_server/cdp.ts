// Minimal CDP driver (no deps): navigate, click, keys, screenshots.
// Usage: bun cdp.ts <port> ; speaks to chromium on 127.0.0.1:9333.
const PORT = process.argv[2] ?? "3001";

async function cdp(method, params = {}, id = 1) {
  const r = await fetch(`http://127.0.0.1:9333/json/new?about:blank`);
  return r;
}

async function session(tabWs) {
  const ws = new WebSocket(tabWs);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const waiters = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    waiters.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, send };
}

async function evaluate(s, expression, awaitPromise = true) {
  const r = await s.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}

async function shot(s, path) {
  const r = await s.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(path, Buffer.from(r.result.data, "base64"));
}

async function click(s, sel) {
  await evaluate(s, `document.querySelector(${JSON.stringify(sel)}).click()`);
}
async function key(s, text, key = text) {
  await s.send("Input.dispatchKeyEvent", { type: "keyDown", text, key, windowsVirtualKeyCode: text.charCodeAt(0) });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: text.charCodeAt(0) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// reuse the initial about:blank page target
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const tab = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!tab) throw new Error("no page target: " + JSON.stringify(targets).slice(0, 200));
const s = await session(tab.webSocketDebuggerUrl);
await s.send("Page.enable");
await s.send("Runtime.enable");
await s.send("Network.enable");
await s.send("Network.setCacheDisabled", { cacheDisabled: true });
await s.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/play` });
await sleep(2500);
await shot(s, "/tmp/shot_connect.png");
await click(s, "#btn-new");
await sleep(6000); // role menus + intro + first move prompt
await shot(s, "/tmp/shot_new.png");
// Dismiss the tutorial prompt with "No, just start play" if present.
await evaluate(s, `[...document.querySelectorAll("#dlg button")].find(b=>/No, just start/.test(b.textContent))?.click()`);
await sleep(2500);
const log1 = await evaluate(s, `document.querySelector("#hud .hud-msg").innerText.slice(-600)`);
console.log("LOG_AFTER_NEW:", JSON.stringify(log1.slice(0, 300)));
// focus canvas, move south twice
await click(s, "#map canvas");
for (const k of ["j", "j"]) { await key(s, k); await sleep(1200); }
await sleep(1500);
await shot(s, "/tmp/shot_moves.png");
const log2 = await evaluate(s, `document.querySelector("#hud .hud-msg").innerText.slice(-300)`);
const prompt = await evaluate(s, `document.getElementById("prompt-line").innerText`);
const status = await evaluate(s, `document.querySelector("#hud .hud-status").innerText.slice(0,200)`);
console.log("PROMPT:", JSON.stringify(prompt));
console.log("STATUS:", JSON.stringify(status));
console.log("LOG_TAIL:", JSON.stringify(log2.slice(0, 200)));
// reload -> resume
await s.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/play` });
await sleep(2000);
await click(s, "#btn-resume");
await sleep(6000);
await shot(s, "/tmp/shot_resume.png");
const log3 = await evaluate(s, `document.querySelector("#hud .hud-msg").innerText.slice(-300)`);
console.log("RESUME_TAIL:", JSON.stringify(log3.slice(0, 200)));
console.log("CDP_DONE");
process.exit(0);
