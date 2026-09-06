import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  Neonethack,
  Game,
  defineBot,
  runBot,
} from "../../lib/neonethack/dist/typescript/client.js";

const pending = new Map();
let next = 0;
let hero;
const publish = (message) => process.send?.(message);
const log = (...values) =>
  hero
    ? hero.journal.log(...values)
    : publish({ type: "log", text: values.map(String).join(" ") });
console.log = log;
console.warn = log;
console.error = log;

process.on("message", async (message) => {
  if (message.type === "response") {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error
      ? request.reject(Error(message.error))
      : request.resolve(message.result);
    return;
  }
  if (message.type !== "start") return;
  try {
    const api = new Neonethack({
      send: (request) =>
        new Promise((resolve, reject) => {
          const id = ++next;
          pending.set(id, { resolve, reject });
          publish({ type: "request", id, request });
        }),
      close: async () => {},
    });
    const game = new Game(api, message.initial, randomUUID);
    const module = await import(pathToFileURL(message.entrypoint).href);
    const bot = defineBot(module.default);
    publish({ type: "ready", name: bot.name });
    const result = await runBot(game, bot, () => {}, {
      ready: (value) => {
        hero = value;
      },
      journal: (entry) => publish({ type: "log", text: entry.text }),
      controls: (controls) => publish({ type: "controls", controls }),
    });
    publish({ type: "done", reason: result.reason });
  } catch (error) {
    publish({ type: "done", reason: "error", error: String(error) });
  }
});
