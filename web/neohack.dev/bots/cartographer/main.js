import { defineBot, entities } from "neonethack";
import { createExplorer } from "./explore.js";
import { handleDecision, eatWhenHungry } from "./care.js";

const bot = defineBot({ name: "Cartographer" });
export default bot;

const explorer = createExplorer();

bot.on("enterLevel", ({ to, log }) => {
  log("Mapping", to.depthLabel, "before taking any stairs.");
});

bot.on("turn", async (context) => {
  const { hero } = context;
  if (await handleDecision(context)) return;
  const enemies = hero.sense(entities.Enemy);
  if (enemies.some((enemy) => enemy.distance <= 3)) {
    await explorer.retreat(context, enemies);
    return;
  }
  if (await eatWhenHungry(context)) return;

  // Stay on this level, revisit unfinished paths, and search unknown edges.
  await explorer.step(context, { descend: false });
});
