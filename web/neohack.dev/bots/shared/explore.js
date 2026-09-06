import { WorldError } from "neonethack";

const key = ({ x, y }) => `${x},${y}`;
const edge = (from, to) => `${key(from)}>${key(to)}`;
const offsets = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];
const surfaces = new Set([
  "floor",
  "corridor",
  "doorway",
  "openDoor",
  "closedDoor",
  "stairsUp",
  "stairsDown",
  "altar",
  "fountain",
  "sink",
  "grave",
  "ice",
]);
const unknown = (cell) =>
  !cell || ["unknown", "dark"].includes(cell.terrain.type);
const passable = (cell) =>
  cell &&
  surfaces.has(cell.terrain.type) &&
  !cell.hazards?.length &&
  !cell.objects?.some((object) => object.kind === "boulder");

// A route is a plan over the disclosed map. Every actual step still uses
// the engine's current movement offers; remembered terrain is not a guarantee.
export function createExplorer() {
  let level;
  let quietTurns = 0;
  const visited = new Set();
  const blocked = new Set();
  const searches = new Map();

  function update(hero) {
    if (level !== hero.location.id) {
      level = hero.location.id;
      visited.clear();
      blocked.clear();
      searches.clear();
      quietTurns = 0;
    }
    if (!hero.position) return false;
    const here = key(hero.position);
    quietTurns = visited.has(here) ? quietTurns + 1 : 0;
    visited.add(here);
    return true;
  }

  function candidates(hero, probe = false) {
    return hero.steps.filter(
      (step) =>
        !step.movement.knownRestriction &&
        !step.hazards?.length &&
        !["creatureBump", "possiblePush"].includes(step.movement.intent) &&
        !blocked.has(edge(hero.position, step)) &&
        (step.walkable === true ||
          step.movement.intent === "attemptOpen" ||
          (probe &&
            step.movement.intent === "unknown" &&
            (!step.dx || !step.dy))),
    );
  }

  async function move({ hero, log }, step) {
    const from = hero.position;
    const before = step.terrain?.type;
    let result;
    try {
      result = await hero.go(step.direction);
    } catch (error) {
      if (
        !(error instanceof WorldError) ||
        !("outcome" in error.response) ||
        error.response.outcome?.status !== "blocked"
      )
        throw error;
      result = error.response;
    }
    const after = hero.map.find((cell) => key(cell) === key(step))?.terrain
      .type;
    // Opening a door is progress even though we have not walked through it yet.
    if (
      !result.outcome.positionChanged &&
      (before === after ||
        result.decision ||
        result.outcome.status === "blocked")
    ) {
      blocked.add(edge(from, step));
      quietTurns = 0;
      log(
        "Trying another route:",
        result.outcome.reason ?? result.outcome.status,
      );
    }
  }

  function route(hero, starts, goal, map) {
    const queue = starts.map((step) => ({ cell: step, first: step }));
    const seen = new Set([key(hero.position), ...starts.map(key)]);
    for (let index = 0; index < queue.length; index++) {
      const { cell, first } = queue[index];
      if (goal(cell)) return first;
      for (const [dx, dy] of offsets) {
        const next = map.get(`${cell.x + dx},${cell.y + dy}`);
        if (
          !passable(next) ||
          seen.has(key(next)) ||
          blocked.has(edge(cell, next))
        )
          continue;
        if (next.occupant && next.occupant.kind !== "self") continue;
        // Plan doorways orthogonally; the engine checks the actual first step.
        if (
          dx &&
          dy &&
          (cell.terrain.type.toLowerCase().includes("door") ||
            next.terrain.type.toLowerCase().includes("door"))
        )
          continue;
        seen.add(key(next));
        queue.push({ cell: next, first });
      }
    }
  }

  return {
    async retreat(context, enemies) {
      const { hero, log } = context;
      if (!update(hero)) {
        log("Position is unknown.");
        hero.stop();
        return;
      }
      const distance = (square) =>
        Math.min(
          ...enemies.map((enemy) =>
            Math.max(
              Math.abs(square.x - enemy.position[0]),
              Math.abs(square.y - enemy.position[1]),
            ),
          ),
        );
      const escape = candidates(hero)
        .filter(
          (step) =>
            step.walkable === true &&
            (distance(step) > distance(hero.position) ||
              (distance(hero.position) > 1 &&
                distance(step) === distance(hero.position))),
        )
        .sort(
          (a, b) =>
            distance(b) - distance(a) ||
            Number(visited.has(key(a))) - Number(visited.has(key(b))),
        )[0];
      if (!escape || quietTurns > 80) {
        log("No further retreat route. Stopping here.");
        hero.stop();
        return;
      }
      await move(context, escape);
    },

    async step(context, { descend = true } = {}) {
      const { hero, log } = context;
      if (!update(hero)) {
        log("Position is unknown.");
        hero.stop();
        return;
      }
      if (quietTurns > 80) {
        log("No new ground after 80 turns. Stopping to review the route.");
        hero.stop();
        return;
      }
      if (descend && hero.canDescend()) {
        log("Taking the stairs down.");
        await hero.climb("down");
        return;
      }
      const map = new Map(hero.map.map((cell) => [key(cell), cell]));
      const starts = candidates(hero);
      const stairs =
        descend &&
        route(hero, starts, (cell) => cell.terrain.type === "stairsDown", map);
      const fresh = route(hero, starts, (cell) => !visited.has(key(cell)), map);
      if (stairs || fresh) {
        await move(context, stairs || fresh);
        return;
      }

      // Try unexplored cardinal edges once, including edges of dark corridors.
      const probe = candidates(hero, true).find((step) => unknown(step));
      if (probe) {
        await move(context, probe);
        return;
      }
      const needsSearch = (cell) =>
        (searches.get(key(cell)) ?? 0) < 5 &&
        offsets
          .slice(0, 4)
          .some(([dx, dy]) =>
            unknown(map.get(`${cell.x + dx},${cell.y + dy}`)),
          );
      if (needsSearch(hero.position)) {
        searches.set(
          key(hero.position),
          (searches.get(key(hero.position)) ?? 0) + 1,
        );
        quietTurns = 0;
        await hero.search();
        return;
      }
      const frontier = route(hero, starts, needsSearch, map);
      if (frontier) {
        await move(context, frontier);
        return;
      }
      log("No unexplored route remains in this plan.");
      hero.stop();
    },
  };
}
