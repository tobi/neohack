import type { Hero, Entity, Step, Snapshot } from 'neonethack';

// Only a policy over disclosed map facts. The engine still validates each step.
export class Explorer {
  private visits = new Map<string, number>();
  private failures = new Map<string, number>();
  reset() { this.visits.clear(); this.failures.clear(); }
  record(step: Step, frame: Snapshot) {
    const key = `${step.x - step.dx},${step.y - step.dy}:${step.direction}`;
    if (!frame.outcome.positionChanged && (frame.outcome.status === 'blocked' || frame.outcome.turnsElapsed === 0))
      this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
    else this.failures.delete(key);
  }
  visit(hero: Hero) {
    if (!hero.position) return;
    const key = `${hero.position.x},${hero.position.y}`;
    this.visits.set(key, (this.visits.get(key) ?? 0) + 1);
  }
  choose(hero: Hero, enemies: readonly Entity[]): Step | undefined {
    const map = new Map(hero.map.map(cell => [`${cell.x},${cell.y}`, cell]));
    const stairs = hero.map.filter(cell => cell.terrain.type === 'stairsDown');
    const candidates = hero.steps.filter(step =>
      !step.movement.knownRestriction && !step.hazards?.length
      && step.movement.intent !== 'creatureBump'
      && (step.walkable !== false || step.movement.intent === 'attemptOpen'));
    const position = hero.position;
    if (enemies.length && position) {
      const distance = (x: number, y: number) => Math.min(...enemies.map(enemy =>
        Math.max(Math.abs(x - enemy.position[0]), Math.abs(y - enemy.position[1]))));
      // A retreat must actually increase separation. Otherwise try another policy.
      const retreat = candidates.filter(step => distance(step.x, step.y) > distance(position.x, position.y));
      return retreat.map(step => ({step, score: distance(step.x, step.y) + Math.random() * 0.5 - (this.failures.get(`${step.x-step.dx},${step.y-step.dy}:${step.direction}`) ?? 0) * 8})).sort((a,b)=>b.score-a.score)[0]?.step;
    }
    const score = (step: Step) => {
      let frontier = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const x = step.x + dx, y = step.y + dy;
        if (x < 1 || x > 79 || y < 0 || y > 20) continue;
        const cell = map.get(`${x},${y}`);
        if (!cell || cell.terrain.type === 'unknown' || cell.terrain.type === 'dark') frontier++;
      }
      const visits = this.visits.get(`${step.x},${step.y}`) ?? 0;
      const stairDistance = stairs.length ? Math.min(...stairs.map(s => Math.max(Math.abs(s.x - step.x), Math.abs(s.y - step.y)))) : 0;
      const failures = this.failures.get(`${step.x-step.dx},${step.y-step.dy}:${step.direction}`) ?? 0;
      return frontier * 2 - visits * 3 - stairDistance - failures * 12 + Math.random() * 5;
    };
    return candidates.map(step => ({ step, score: score(step) })).sort((a, b) => b.score - a.score)[0]?.step;
  }
}
