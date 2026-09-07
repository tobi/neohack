#!/usr/bin/env node
// Optional player policy, not engine knowledge or a safety guarantee.
// Reads a complete agent observation; never reconstructs movement rules.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function recommend(frame) {
  const observation=frame.observation;
  const sessionId=frame.sessionId;
  const suggest=(priority,tool,args,reason)=>({priority,tool,args:tool?{sessionId,...args}:{},reason});
  if(frame.ended)return suggest(0,null,{},'This adventure ended. Review its terminal result.');
  if(frame.decision)return suggest(1,null,{},'Read the standing question and explicitly choose an answer or cancel. Eligibility is not safety.');
  if(!observation)return suggest(2,'session_observe',{},'Read the current perceived scene.');
  const vitals=observation.vitals;
  if(['hungry','weak','fainting','fainted','starved'].includes(vitals?.hunger))
    return suggest(3,'game_eat',{},'Ask the engine for edible candidates; choose deliberately. No corpse is classified as safe by this advisor.');
  const creature=observation.world?.find(cell=>cell.visible&&cell.occupant?.kind==='creature'&&observation.you&&Math.max(Math.abs(cell.x-observation.you.x),Math.abs(cell.y-observation.you.y))<=1);
  if(creature)return suggest(4,'session_actions',{target:{x:creature.x,y:creature.y}},'Inspect the perceived creature and available actions. Use session_lookup for game lore; attack remains an explicit choice.');
  const down=observation.world?.some(cell=>cell.terrain?.type==='stairsDown');
  if(down)return suggest(5,'descend',{maxActions:8},'Try one bounded leg toward remembered stairs. The shared navigator checks the route and stops for changes or decisions.');
  return suggest(6,'explore',{maxActions:8},'Explore one bounded leg using the shared perception-only navigator. A noRoute result needs a new deliberate plan.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(recommend(JSON.parse(readFileSync(process.argv[2],'utf8')))));
