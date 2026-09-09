import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
export const source = resolve(
  import.meta.dirname,
  "../../../lib/neonethack/engine/include/monsters.h",
);
// Match the supported engine: global.h always defines MAIL_STRUCTURES; CHARON
// is not enabled. Let the C preprocessor exclude deferred/obsolete definitions.
export function monsterRoster() {
  const text = execFileSync(
    "cc",
    ["-E", "-P", "-x", "c", "-DMON=MON", "-DMAIL_STRUCTURES", source],
    { encoding: "utf8" },
  );
  const rows = [];
  for (const match of text.matchAll(/\bMON\(/g)) {
    const args = [];
    let depth = 1,
      quoted = false,
      escaped = false,
      start = match.index + 4;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') {
        quoted = true;
        continue;
      }
      if (c === "(") depth++;
      if (c === ")") depth--;
      if ((c === "," && depth === 1) || depth === 0) {
        args.push(text.slice(start, i).trim());
        start = i + 1;
      }
      if (depth === 0) break;
    }
    if (args.length !== 14)
      throw Error(
        `Unexpected monster definition (${args.length} fields): ${args[0]}`,
      );
    const names = [...args[0].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      JSON.parse('"' + m[1] + '"'),
    );
    if (!names.length || !/^S_[A-Z_]+$/.test(args[1]))
      throw Error("Unrecognized monster name/class");
    // Deliberately discard attacks, flags, level, resistances, color and stats.
    rows.push({
      appearance: names.at(-1),
      aliases: [...new Set(names)],
      group: args[1],
    });
  }
  return {
    source: "lib/neonethack/engine/include/monsters.h",
    sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
    rows,
  };
}
