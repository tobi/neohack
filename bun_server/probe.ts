// Probe page errors + state.
const PORT = process.argv[2] ?? "3001";
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const tab = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const waiters = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  if (m.method === "Log.entryAdded") errors.push("LOG: " + JSON.stringify(m.params.entry).slice(0, 300));
  if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq; waiters.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
await new Promise((r) => setTimeout(r, 4000));
const ev = (expression) => send("Runtime.evaluate", { expression, returnByValue: true })
  .then((r) => r.result?.result?.value ?? ("ERR:" + JSON.stringify(r.result?.exceptionDetails?.text)));
console.log("canvas:", await ev(`String(document.querySelector("#map canvas"))`));
console.log("conn:", await ev(`document.getElementById("conn-state").textContent`));
console.log("log:", await ev(`document.getElementById("log").innerText.slice(-200)`));
console.log("ERRORS:", JSON.stringify(errors.slice(0, 6), null, 1));
process.exit(0);
