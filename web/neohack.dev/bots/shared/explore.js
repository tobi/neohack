import { Navigator, NavigationError, WorldError } from "neonethack";
const key = ({ x, y }) => `${x},${y}`;
// Route geometry and frontier selection belong to the shared C navigator.
// This example only chooses exploration, descent, retreat or a bounded search.
export function createExplorer() {
    let level, navigator, game, destination;
    const visited = new Set();
    const searches = new Set();
    const probed = new Set();
    let quietTurns = 0;
    function update(hero) {
        if (game !== hero.game) {
            game = hero.game;
            navigator = new Navigator(game);
        }
        if (level !== hero.location.id) {
            level = hero.location.id;
            destination = null;
            visited.clear();
            searches.clear();
            probed.clear();
            quietTurns = 0;
        }
        if (!hero.position)
            return false;
        const position = key(hero.position);
        quietTurns = visited.has(position) ? quietTurns + 1 : 0;
        visited.add(position);
        return true;
    }
    return {
        async retreat({ hero, log }, enemies) {
            if (!update(hero)) {
                log("Position is unknown.");
                hero.stop();
                return;
            }
            if (quietTurns > 80) {
                log("No new ground while retreating. Stopping to review.");
                hero.stop();
                return;
            }
            destination = null;
            const distance = square => Math.min(...enemies.map(enemy => Math.max(Math.abs(square.x - enemy.position[0]), Math.abs(square.y - enemy.position[1]))));
            // The preference for distance is player strategy, not a safety prediction.
            const escapes = hero.steps.filter(step => step.walkable === true &&
                step.occupant?.kind !== "creature" && !step.hazards.length && !step.movement.knownRestriction &&
                (distance(step) > distance(hero.position) || (distance(hero.position) > 1 && distance(step) === distance(hero.position))))
                .sort((a, b) => distance(b) - distance(a) || Number(visited.has(key(a))) - Number(visited.has(key(b))));
            for (const square of escapes) {
                await hero.go({ to: { x: square.x, y: square.y }, force: true });
                return;
            }
            log("No further retreat route. Stopping here.");
            hero.stop();
        },
        async step({ hero, log }, { descend = true } = {}) {
            if (!update(hero)) {
                log("Position is unknown.");
                hero.stop();
                return;
            }
            if (quietTurns > 80) {
                log("No new ground after 80 decisions. Stopping to review.");
                hero.stop();
                return;
            }
            try {
                let result = null;
                if (descend && hero.map.some(cell => cell.terrain.type === "stairsDown"))
                    result = await navigator.descend({ maxActions: 1 });
                if (!result || result.reason === "noRoute") {
                    if (destination && key(destination) === key(hero.position))
                        destination = null;
                    if (!destination) {
                        const plan = await game.navigation();
                        const frontier = plan.frontiers.filter(frontier => frontier.distance !== null).sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x)[0];
                        if (frontier)
                            destination = { x: frontier.x, y: frontier.y };
                    }
                    result = destination ? await hero.go({ to: destination, maxActions: 1 }) : await navigator.explore({ maxActions: 1 });
                    if (["arrived", "noRoute", "interrupted"].includes(result.reason))
                        destination = null;
                }
                else
                    destination = null;
                if (result.reason !== "noRoute")
                    return;
                const unknown = hero.steps.find(step => ["unknown", "allyBump"].includes(step.movement.intent) &&
                    !step.movement.knownRestriction && !step.hazards.length && (!step.dx || !step.dy) &&
                    !probed.has(key(hero.position) + ">" + key(step)));
                if (unknown) {
                    probed.add(key(hero.position) + ">" + key(unknown));
                    log(unknown.movement.intent === "allyBump" ? "Trying to move past a companion." : "Trying one adjacent unexplored square.");
                    await hero.go({ to: { x: unknown.x, y: unknown.y }, force: true });
                    return;
                }
                const position = key(hero.position);
                if (!searches.has(position)) {
                    searches.add(position);
                    log("No known route. Searching here for up to five turns.");
                    await game.search({ turns: 5 });
                    return;
                }
                log("No unexplored route remains in this plan.");
                hero.stop();
            }
            catch (error) {
                const cause = error instanceof NavigationError ? error.cause : error;
                if (!(cause instanceof WorldError) || !("error" in cause.response) || cause.response.error?.code !== "unsupportedMovement")
                    throw error;
                log("The navigator cannot plan this movement:", error.message);
                hero.stop();
            }
        },
    };
}
