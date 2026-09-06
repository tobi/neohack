import { defineBot, entities, WorldError, type Snapshot } from 'neonethack';
import { Explorer } from './strategy';

// A curious, cowardly imp. Simple policy, not a promise of safe play.
export default defineBot({
  initialize({ hero, game, log }) {
    const explorer = new Explorer();
    const gear = new Set<string>(), triedGear = new Set<string>();
    const triedFood = new Set<string>(), triedPickup = new Set<string>();
    hero.addEventListener('enterLevel', ({ detail }) => {
      explorer.reset(); log('Entered', detail.to.depthLabel);
    });
    hero.addEventListener('itemSeen', ({ detail: { sighting } }) => {
      if (sighting.source === 'inventory' && sighting.item.actions?.includes('equip'))
        gear.add(sighting.item.id);
    });
    hero.addEventListener('entitySeen', ({ detail: { entity } }) => {
      if (entity.attitude === 'hostile') log('Spotted', entity.appearance ?? 'a creature', entity.offset);
    });
    hero.addEventListener('end', ({ detail }) => log('Run ended:', detail.end?.cause));
    async function attempt(action: () => Promise<Snapshot>): Promise<boolean> {
      try { await action(); return true; }
      catch (error) {
        if (!(error instanceof WorldError) || !('outcome' in error.response)
            || error.response.outcome.status !== 'blocked') throw error;
        log('Blocked:', error.message); return false;
      }
    }
    hero.addEventListener('turn', async () => {
      const choice = hero.decision;
      if (choice) {
        // Choose a disclosed equipment option; never confirm a warning.
        if (choice.kind === 'choice' && choice.action === 'equip' && choice.options.length)
          await game.answer(choice.id, { kind: 'choice', choose: [choice.options[Math.floor(Math.random() * choice.options.length)]!.id] });
        else if (choice.cancellable) await game.cancel(choice.id);
        else if (choice.kind === 'confirmation') await game.answer(choice.id, { kind: 'confirmation', confirm: false });
        else { log('Needs your strategy:', choice); hero.stop(); }
        return;
      }
      explorer.visit(hero);
      const enemies = hero.sense(entities.Enemy);
      const escape = explorer.choose(hero, enemies);
      if (enemies.length && escape) { explorer.record(escape, await hero.go(escape.direction)); return; }
      if (hero.isHungry() && hero.inventory.freshness === 'current') {
        const food = hero.inventory.items.find(item => item.canEat() && !triedFood.has(item.info!.id));
        if (food) {
          triedFood.add(food.info!.id);
          if (await attempt(async () => {
            const frame = await food.eat();
            if (frame.outcome.status === 'completed' && !frame.decision) triedFood.delete(food.info!.id);
            return frame;
          })) return;
        }
      }
      if (hero.canDescend()) { log('Going down'); await hero.climb('down'); return; }
      for (const id of gear) {
        if (triedGear.has(id) || hero.inventory.freshness !== 'current') continue;
        const item = hero.inventory.byId(id); if (!item?.canEquip()) continue;
        triedGear.add(id); log('Trying to wear', item.info!.label);
        if (await attempt(() => item.equip())) return;
      }
      const loose = hero.itemsHere?.find(item => !triedPickup.has(hero.location.id + ':' + item.info!.id));
      if (loose) {
        triedPickup.add(hero.location.id + ':' + loose.info!.id);
        if (await attempt(() => loose.pickup())) return;
      }
      const step = explorer.choose(hero, []);
      if (step && Math.random() > 0.08) explorer.record(step, await hero.go(step.direction));
      else await hero.search();
    });
  },
});
