import { defineBot, entities } from "neonethack";

const bot = defineBot({ name: "Curious imp" });
export default bot;

// Remember where we have been, so we can try somewhere new.
const visits = new Map();
const key = ({ x, y }) => `${x},${y}`;
const visitCount = (square) => visits.get(key(square)) ?? 0;

bot.on("enterLevel", ({ to, log }) => {
  visits.clear();
  log("Exploring", to.depthLabel);
});

bot.on("turn", async ({ hero, log }) => {
  // This little explorer leaves decisions, food, and fights to you.
  if (hero.decision || hero.isHungry() || hero.sense(entities.Enemy).length) {
    log(
      "Time for your next idea: a decision, hunger, or an enemy needs attention.",
    );
    hero.stop();
    return;
  }

  if (!hero.position) {
    hero.stop();
    return;
  }
  visits.set(key(hero.position), visitCount(hero.position) + 1);

  if (hero.canDescend()) {
    log("Found the stairs. Going down!");
    await hero.climb("down");
    return;
  }

  // Pick the least-visited path offered by the current observation.
  const paths = hero.steps.filter(
    (step) =>
      !step.movement.knownRestriction &&
      !step.hazards?.length &&
      step.movement.intent !== "creatureBump" &&
      (step.walkable === true || step.movement.intent === "attemptOpen"),
  );
  paths.sort((a, b) => visitCount(a) - visitCount(b));
  const next = paths[0];

  if (!next) {
    log("No clear path. Try adding a search strategy!");
    hero.stop();
    return;
  }

  const result = await hero.go(next.direction);
  if (!result.outcome.positionChanged) {
    log("That step did not move us. Try a different action!");
    hero.stop();
  }
});
