import type { Compass } from "neonethack/types";

export const commandDirections: Record<string, Compass> = {
  h: "west",
  j: "south",
  k: "north",
  l: "east",
  y: "northwest",
  u: "northeast",
  b: "southwest",
  n: "southeast",
  ArrowLeft: "west",
  ArrowDown: "south",
  ArrowUp: "north",
  ArrowRight: "east",
};
export const arrowLetters: Record<string, string> = {
  ArrowLeft: "h",
  ArrowDown: "j",
  ArrowUp: "k",
  ArrowRight: "l",
};
type RunMode = "normal" | "untilInteresting" | "pastBranches";
export type CommandIntent =
  | { kind: "search"; turns: number }
  | { kind: "rest"; turns: number }
  | { kind: "move" | "moveWithoutAttack" | "attack"; direction: Compass }
  | { kind: "run"; direction: Compass; mode: RunMode; noPickup: boolean };
export type CommandHint = {
  key: string;
  label: string;
  value: string;
  direction?: boolean;
};
export type CommandDraft = {
  description: string;
  hints: CommandHint[];
  error?: boolean;
  intent?: CommandIntent;
  directional?: boolean;
};
const directionKeys = [
  ["y", "↖"],
  ["k", "↑"],
  ["u", "↗"],
  ["h", "←"],
  ["l", "→"],
  ["b", "↙"],
  ["j", "↓"],
  ["n", "↘"],
] as const;

/** Keyboard grammar only. Execution and interruption belong to the public API. */
export function describeCommand(text: string): CommandDraft {
  const error = (description: string): CommandDraft => ({
    description,
    hints: [],
    error: true,
  });
  const hints = (choices: [string, string][]): CommandHint[] =>
    choices.map(([key, label]) => ({ key, label, value: text + key }));
  if (!text)
    return {
      description: "Type a count or movement prefix.",
      hints: hints([
        ["20", "Count turns"],
        ["m", "Move without pickup"],
        ["g", "Run cautiously"],
        ["G", "Run past forks"],
        ["F", "Force an attack"],
      ]),
    };
  const counted = /^(\d+)([s.]?)$/.exec(text);
  if (counted) {
    const turns = Number(counted[1]);
    if (turns < 1 || turns > 1000)
      return error("Use a count from 1 to 1,000. No action taken.");
    if (counted[2])
      return {
        description: "",
        hints: [],
        intent: { kind: counted[2] === "s" ? "search" : "rest", turns },
      };
    return {
      description: `Up to ${turns} turns. The dungeon can interrupt.`,
      hints: hints([
        ["s", `Search nearby · ${turns} turns`],
        [".", `Rest · ${turns} turns`],
      ]),
    };
  }
  if (/^\d/.test(text))
    return error("Counts work with s (search) or . (rest). No action taken.");
  if (text === "s" || text === ".")
    return {
      description: "",
      hints: [],
      intent: { kind: text === "s" ? "search" : "rest", turns: 1 },
    };
  const match = /^(m?[gG]?|[gG]m?|F)([hjklyubnHJKLYUBN]?)$/.exec(text);
  if (!match)
    return error("Use m, g, G or F, then a direction. No action taken.");
  const prefix = match[1]!,
    letter = match[2]!,
    noPickup = prefix.includes("m"),
    force = prefix === "F";
  const mode: RunMode = prefix.includes("g")
    ? "untilInteresting"
    : prefix.includes("G")
      ? "pastBranches"
      : "normal";
  const running = prefix.includes("g") || prefix.includes("G");
  if (letter) {
    const uppercase = letter !== letter.toLowerCase();
    if (uppercase && (force || running))
      return error(
        "Use a lowercase direction after g, G or F. No action taken.",
      );
    const direction = commandDirections[letter.toLowerCase()]!;
    const intent: CommandIntent = force
      ? { kind: "attack", direction }
      : running || uppercase
        ? { kind: "run", direction, mode, noPickup }
        : { kind: noPickup ? "moveWithoutAttack" : "move", direction };
    return { description: "", hints: [], intent };
  }
  const description = force
    ? "Force one attack, even into an apparently empty square."
    : running
      ? (mode === "untilInteresting"
          ? "Run until something interesting, including a fork."
          : "Run past corridor forks; stop for other discoveries.") +
        (noPickup ? " No pickup or fighting." : "")
      : "Move one step without picking up or fighting. Uppercase directions run.";
  const options: CommandHint[] = directionKeys.map(([key, arrow]) => ({
    key,
    label: arrow + " " + commandDirections[key],
    value: text + key,
    direction: true,
  }));
  if (noPickup && !running)
    options.push(
      ...hints([
        ["g", "Run · stop at forks"],
        ["G", "Run · pass forks"],
      ]),
    );
  if (running && !noPickup)
    options.push(...hints([["m", "Skip pickup & fighting"]]));
  return { description, hints: options, directional: true };
}
