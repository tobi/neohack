import { WorldError } from "neonethack";

const triedFood = new WeakMap();

// Examples decline cancellable prompts. They never approve a warning for you.
export async function handleDecision({ hero, game, log }) {
  const choice = hero.decision;
  if (!choice) return false;
  if (choice.cancellable) {
    log("Cancelling", choice.action, "to reconsider the plan.");
    await game.cancel(choice.id);
  } else {
    log("This decision needs your strategy:", choice.kind, choice.action);
    hero.stop();
  }
  return true;
}

// Only select rations whose identity the hero actually knows. No corpse policy.
export async function eatWhenHungry({ hero, log }) {
  if (!hero.isHungry()) return false;
  const tried = triedFood.get(hero) ?? new Set();
  triedFood.set(hero, tried);
  const food =
    hero.inventory.freshness === "current" &&
    hero.inventory.items.find(
      (item) =>
        item.canEat() &&
        item.info &&
        !tried.has(item.info.id) &&
        item.info.known?.beatitude !== "cursed" &&
        ["food ration", "cram ration", "lembas wafer"].includes(
          item.info.known?.identity,
        ),
    );
  if (!food) {
    log("Hungry with no identified ration to try. Stopping here.");
    hero.stop();
    return true;
  }
  tried.add(food.info.id);
  log("Eating", food.info.label);
  try {
    const result = await food.eat();
    if (result.outcome.status === "completed" && !result.decision)
      tried.delete(food.info.id);
  } catch (error) {
    if (
      !(error instanceof WorldError) ||
      !("outcome" in error.response) ||
      error.response.outcome?.status !== "blocked"
    )
      throw error;
    log("That meal was blocked:", error.message);
  }
  return true;
}
