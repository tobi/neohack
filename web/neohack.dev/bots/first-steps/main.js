import { defineBot } from "neonethack";

const bot = defineBot({ name: "First steps" });
export default bot;

bot.on("enterLevel", ({ to, log }) => {
  log("Welcome to", to.depthLabel);
});

bot.on("turn", async ({ hero, log }) => {
  await hero.search();
  log("Searched once. Try another action next time.");
  // Bounded C navigation is also on Hero: hero.explore({ maxActions: 8 })
  // and hero.descend({ maxActions: 8 }). They stop for decisions and changes.
  hero.stop();
});
