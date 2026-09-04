// CDP verification for the wasm edition: boot, new game, move, reload+resume.
const BASE = "http://127.0.0.1:8901/client/index.html";

async function cdpSession(tabWs) {
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
  if (r.result?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
async function shot(s, path) {
  const r = await s.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(path, Buffer.from(r.result.data, "base64"));
}
async function click(s, sel) {
  await evaluate(s, `document.querySelector(${JSON.stringify(sel)}).click()`);
}
async function key(s, text, keyName = text) {
  await s.send("Input.dispatchKeyEvent", { type: "keyDown", text, key: keyName, windowsVirtualKeyCode: text.charCodeAt(0) });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, windowsVirtualKeyCode: text.charCodeAt(0) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const tab = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!tab) throw new Error("no page target");
const s = await cdpSession(tab.webSocketDebuggerUrl);
await s.send("Page.enable");
await s.send("Runtime.enable");
await s.send("Network.enable");
await s.send("Network.setCacheDisabled", { cacheDisabled: true });
await s.send("Page.navigate", { url: BASE });
await sleep(6000); // wasm download + engine boot
await evaluate(s, `window.__errs=[];addEventListener("error",e=>window.__errs.push(String(e.message)));addEventListener("unhandledrejection",e=>window.__errs.push("reject:"+String(e.reason)))`);
await shot(s, "/tmp/w_boot.png");
const conn = await evaluate(s, `document.getElementById("conn-state").innerText`);
console.log("CONN:", JSON.stringify(conn));
await click(s, "#btn-new");
await sleep(8000);
await shot(s, "/tmp/w_new.png");
await evaluate(s, `[...document.querySelectorAll("#dlg button")].find(b=>/No, just start/.test(b.textContent))?.click()`);
await sleep(3000);
const hud1 = await evaluate(s, `document.querySelector("#hud .hud-msg").innerText.slice(-500)`);
console.log("HUD_AFTER_NEW:", JSON.stringify((hud1 ?? "").slice(0, 300)));
await click(s, "#map canvas");
for (const k of ["j", "j"]) { await key(s, k); await sleep(1500); }
await sleep(1500);
await shot(s, "/tmp/w_moves.png");
const prompt = await evaluate(s, `document.getElementById("prompt-line").innerText`);
const status = await evaluate(s, `document.querySelector("#hud .statgrid").innerText.slice(0,200)`);
console.log("PROMPT:", JSON.stringify(prompt));
console.log("STATUS:", JSON.stringify(status));
const logBefore = await evaluate(s, `localStorage.getItem("neonethack.inputlog")?.length ?? 0`);
console.log("STORED_LOG_BYTES:", logBefore);
// reload -> resume from localStorage
await s.send("Page.navigate", { url: BASE });
await sleep(6000);
await evaluate(s, `window.__errs=[];addEventListener("error",e=>window.__errs.push(String(e.message)));addEventListener("unhandledrejection",e=>window.__errs.push("reject:"+String(e.reason)))`);
await click(s, "#btn-resume");
await sleep(8000);
await shot(s, "/tmp/w_resume.png");
const hud2 = await evaluate(s, `document.querySelector("#hud .hud-msg")?.innerText.slice(-300) ?? "(no hud)"`);
console.log("RESUME_TAIL:", JSON.stringify((hud2 ?? "").slice(0, 200)));
const prompt2 = await evaluate(s, `document.getElementById("prompt-line")?.innerText ?? "(none)"`);
console.log("RESUME_PROMPT:", JSON.stringify(prompt2));
const errs = await evaluate(s, `window.__errs?.slice(0,5) ?? "(no listener)"`);
console.log("PAGE_ERRORS:", JSON.stringify(errs));
console.log("CDP_DONE");
process.exit(0);
