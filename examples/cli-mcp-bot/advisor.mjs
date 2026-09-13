#!/usr/bin/env node
// Optional player policy, not engine knowledge or a safety guarantee.
// Reads DecisionFrame v2 directly; never reconstructs movement rules.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function recommend(frame) {
  if(frame.version!==2)throw new TypeError('DecisionFrame v2 required.');
  const scene=frame.scene;
  const {sessionId,viewId}=frame.basis??{};
  const suggest=(priority,tool,args,reason)=>({priority,tool,args:tool?{sessionId,...(!['syncState','inspect'].includes(tool)?{viewId}:{}),...args}:{},reason});
  if(frame.control.gate==='ended')return suggest(0,null,{},'This adventure ended. Review its terminal result.');
  if(['recoveryRequired','ownershipLost'].includes(frame.control.gate))return suggest(0,null,{},'Input is blocked. Follow the returned recovery or ownership instructions.');
  if(frame.decision)return suggest(1,null,{},'Read the standing question and explicitly choose an answer or cancel. Eligibility is not safety.');
  if(scene?.kind!=='snapshot')return suggest(2,'syncState',{},'Read the current perceived scene.');
  const vitals=scene.self.vitals;
  if(['hungry','weak','fainting','fainted','starved'].includes(vitals?.hunger))
    return suggest(3,"eat",{},'Ask the engine for edible candidates; choose deliberately. No corpse is classified as safe by this advisor.');
  const creature=scene.entities.find(entity=>entity.kind==='creature'&&scene.self.position&&Math.max(Math.abs(entity.position.x-scene.self.position.x),Math.abs(entity.position.y-scene.self.position.y))<=1);
  if(creature)return suggest(4,'inspect',{target:{position:creature.position}},'Inspect the perceived creature and available actions. Use lookup for game lore; attack remains an explicit choice.');
  const down=scene.features.some(feature=>feature.terrain?.type==='stairsDown');
  if(down)return suggest(5,'descend',{maxActions:8},'Try one bounded leg toward remembered stairs. The shared navigator checks the route and stops for changes or decisions.');
  return suggest(6,'explore',{maxActions:8},'Explore one bounded leg using the shared perception-only navigator. A noRoute result needs a new deliberate plan.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(recommend(JSON.parse(readFileSync(process.argv[2],'utf8')))));
