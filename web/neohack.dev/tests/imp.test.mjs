import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fixture,
  identity,
} from "../../../lib/neonethack/tests/native-fixture.mjs";
import {
  runBot,
  entities,
} from "../../../lib/neonethack/dist/typescript/client.js";

test(
  "the simple imp explores a real dungeon and stops before a situation needing a strategy",
  { timeout: 60000 },
  async (t) => {
    const dir = await mkdtemp("/tmp/neohack-imp-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const library = pathToFileURL(
      resolve(
        import.meta.dirname,
        "../../../lib/neonethack/dist/typescript/client.js",
      ),
    ).href;
    const source = await readFile(
      resolve(import.meta.dirname, "../bots/imp/main.js"),
      "utf8",
    );
    await writeFile(
      dir + "/main.mjs",
      source.replaceAll('"neonethack"', JSON.stringify(library)),
    );
    const { default: imp } = await import(
      pathToFileURL(dir + "/main.mjs").href
    );
    const { api } = await fixture(t);
    const game = await api.create(identity);
    const positions = new Set();
    const logs = [];
    let moves = 0;
    let attentionRevision;
    const result = await runBot(
      game,
      {
        name: imp.name,
        async initialize(context) {
          await imp.initialize(context);
          context.hero.on("snapshotChange", ({ snapshot }) => {
            if (snapshot.observation.you)
              positions.add(JSON.stringify(snapshot.observation.you));
            if (snapshot.outcome.positionChanged) moves++;
            if (
              context.hero.decision ||
              context.hero.isHungry() ||
              context.hero.sense(entities.Enemy).length ||
              (snapshot.outcome.action === "move" &&
                !snapshot.outcome.positionChanged)
            ) {
              attentionRevision ??= snapshot.revision;
            }
            assert.ok(
              snapshot.revision < 1000,
              "the teaching example must stop instead of looping indefinitely",
            );
          });
        },
      },
      (...values) => logs.push(values.join(" ")),
    );

    assert.equal(result.reason, "stopped");
    assert.ok(moves >= 10, "the starter must demonstrate real exploration");
    assert.ok(positions.size >= 10, "the starter must visit different squares");
    assert.notEqual(
      attentionRevision,
      undefined,
      "the real run must encounter a stopping condition",
    );
    assert.equal(
      game.state.revision,
      attentionRevision,
      "no further input after a decision, hunger, visible enemy or unsuccessful step",
    );
    assert.match(logs.at(-1), /needs attention|did not move/);
    t.diagnostic(
      JSON.stringify({
        moves,
        squares: positions.size,
        turn: game.observation.turn,
        reason: logs.at(-1),
      }),
    );
  },
);
