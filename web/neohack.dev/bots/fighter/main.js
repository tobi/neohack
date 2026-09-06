import { defineBot, entities } from "neonethack";
import { createExplorer } from "./explore.js";
import { handleDecision, eatWhenHungry } from "./care.js";

const bot = defineBot({ name: "Steady fighter" });
export default bot;

const explorer = createExplorer();
let attacks = 0;

bot.on("enterLevel", ({ to, log }) => {
  log("Heading deeper:", to.depthLabel);
});

bot.on("turn", async (context) => {
  const { hero, log } = context;
  if (await handleDecision(context)) return;

  const enemies = hero.sense(entities.Enemy);
  const nearby = enemies.filter((enemy) => enemy.distance <= 1);
  if (nearby.length) {
    const { health, maxHealth } = hero.vitals;
    const healthy =
      typeof health === "number" &&
      typeof maxHealth === "number" &&
      health >= maxHealth * 0.6;
    const eye = nearby.some((enemy) => enemy.appearance === "floating eye");
    if (!healthy || eye || nearby.length > 1 || attacks >= 12) {
      log("Giving this fight some distance.");
      await explorer.retreat(context, enemies);
    } else {
      attacks++;
      await hero.attack(nearby[0]);
    }
    return;
  }
  attacks = 0;
  if (await eatWhenHungry(context)) return;
  await explorer.step(context);
});
