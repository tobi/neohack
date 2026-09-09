import type { Snapshot } from "neonethack/types";
import {
  creaturePixels,
  creatureRecipe,
  familyPixels,
} from "./creature-families";
export type DeathTrace = {
  x: number;
  y: number;
  turn: number;
  appearance?: string;
};
/** Cosmetic, turn-aged impressions. They never create objects or action targets. */
export class DeathTraces {
  entries: DeathTrace[] = [];
  private revision = -1;
  private session = "";
  clear() {
    this.entries = [];
    this.revision = -1;
    this.session = "";
  }
  observe(before: Snapshot, after: Snapshot) {
    if (
      before.sessionId !== after.sessionId ||
      before.observation.location.id !== after.observation.location.id
    )
      return;
    if (
      before.revision === after.revision ||
      (this.session === after.sessionId && after.revision <= this.revision)
    )
      return;
    if (this.session && this.session !== after.sessionId) this.clear();
    this.session = after.sessionId;
    this.revision = after.revision;
    for (const event of after.events) {
      if (
        event.type !== "creatureDied" ||
        event.levelId !== after.observation.location.id ||
        event.turn > after.observation.turn
      )
        continue;
      this.entries.push({
        x: event.x,
        y: event.y,
        turn: event.turn,
        appearance: event.appearance,
      });
    }
    this.age(after.observation.turn);
  }
  age(turn: number) {
    this.entries = this.entries
      .filter((e) => turn >= e.turn && turn - e.turn < 7)
      .slice(-128);
  }
  draw(
    c: CanvasRenderingContext2D,
    trace: DeathTrace,
    x: number,
    y: number,
    turn: number,
  ) {
    const age = turn - trace.turn;
    if (age < 0 || age >= 7) return;
    const recipe = creatureRecipe(trace.appearance);
    const art =
      creaturePixels(trace.appearance) ??
      (recipe ? familyPixels(recipe) : undefined);
    const pixels = art?.pixels ?? ["..###..", ".#####.", "#######", ".#####."];
    const prone =
      recipe &&
      [
        "humanoid",
        "goblin",
        "giant",
        "robed",
        "mummy",
        "shambler",
        "golem",
        "demon",
        "skeleton",
        "tentacled",
      ].includes(recipe.family);
    const sourceWidth = prone ? pixels.length : pixels[0]!.length,
      sourceHeight = prone ? pixels[0]!.length : pixels.length;
    const width = Math.min(22, sourceWidth),
      height = Math.min(9, Math.max(4, Math.round(sourceHeight * 0.65)));
    c.save();
    c.globalAlpha = age < 5 ? 0.65 : age === 5 ? 0.4 : 0.2;
    for (let row = 0; row < height; row++)
      for (let col = 0; col < width; col++) {
        const u = Math.floor((col * sourceWidth) / width),
          v = Math.floor((row * sourceHeight) / height);
        const p = prone ? pixels[pixels.length - 1 - u]![v] : pixels[v]![u];
        if (p !== ".") {
          c.fillStyle =
            p === "#"
              ? "#27302c"
              : p === "s"
                ? "#586052"
                : (art?.body ?? "#8d9b8e");
          c.fillRect(
            x + Math.floor((16 - width) / 2) + col,
            y + 13 - height + row,
            1,
            1,
          );
        }
      }
    c.restore();
  }
}
