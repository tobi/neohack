import { defineBot } from "neonethack";

const bot = defineBot({ name: "First steps" });
export default bot;

bot.on("enterLevel", ({ to, log }) => {
  log("Welcome to", to.depthLabel);
});

bot.on("turn", async ({ hero, log }) => {
  await hero.search();
  log("Searched once. Try another action next time.");
  hero.stop();
});
