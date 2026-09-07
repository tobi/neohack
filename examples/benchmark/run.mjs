#!/usr/bin/env node
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWasm} from '../../lib/neonethack/dist/typescript/wasm.js';
import {Navigator} from '../../lib/neonethack/dist/typescript/navigator.js';
if(!process.execArgv.includes('--import')){
  const r=spawnSync(process.execPath,['--import',fileURLToPath(new URL('./clock.mjs',import.meta.url)),fileURLToPath(import.meta.url),...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);
}
if(Date.now()!==1788739200000)throw Error('Benchmark requires its fixed clock preload');
const policyDigest=createHash('sha256');
for(const name of ['./run.mjs','./clock.mjs',...readdirSync(new URL('../../lib/neonethack/dist/typescript/',import.meta.url)).filter(n=>n.endsWith('.js')).sort().map(n=>'../../lib/neonethack/dist/typescript/'+n)]){
  policyDigest.update(name+'\0');policyDigest.update(readFileSync(new URL(name,import.meta.url)));policyDigest.update('\0');
}
const policyHash=policyDigest.digest('hex');
const profile=process.argv[2]??'navigator';
if(!['navigator','world-only'].includes(profile))throw Error('Use navigator or world-only');
const seeds=process.argv.slice(3).length?process.argv.slice(3).map(Number):[7,42,123];
if(seeds.some(s=>!Number.isSafeInteger(s)))throw Error('Seeds must be safe integers');
for(const seed of seeds){
  const api=await createWasm(),calls={};
  const send=api.transport.send.bind(api.transport);
  api.transport.send=async request=>{
    if(profile==='world-only'&&['session.route','session.navigation'].includes(request.method))throw Error('world-only profile cannot use the navigator');
    calls[request.method]=(calls[request.method]??0)+1;return send(request);
  };
  let result;
  try{
    const game=await api.create({name:'Reference',seed,role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'});
    const initialTurn=game.observation.turn;
    const navigator=new Navigator(game),visited=new Map(),locations=new Set();let reason='budget',legs=0,descents=0,maxDepth=null;
    const depths=new Map();
    for(;legs<200;legs++){
      const state=game.state,observation=game.observation;locations.add(observation.location.id);
      const known=observation.knowledge?.levels?.find(level=>level.id===observation.location.id);
      if(known){depths.set(known.id,{branch:known.branch,depth:known.depth});maxDepth=Math.max(maxDepth??known.depth,known.depth);}
      if(state.ended){reason='ended';break;}
      if(state.decision){reason='decision';break;}
      if(descents>=2){reason='target';break;}
      const here=await game.actions('here');
      const down=here.cell.actions.find(a=>a.method==='game.climb'&&a.arguments?.direction==='down'&&a.availability==='attemptable');
      if(down){const old=observation.location.id;await game.climb('down');if(game.observation.location.id!==old)descents++;continue;}
      if(profile==='navigator'){
        const nav=await game.navigation();
        const r=nav.waysDown.some(p=>p.distance!==null)?await navigator.descend({maxActions:8}):await navigator.explore({maxActions:8});
        if(game.observation.location.id!==observation.location.id)descents++;
        if(r.reason==='noRoute'){reason='noRoute';break;}
      }else{
        const options=[];
        for(const direction of ['north','east','south','west','northeast','southeast','southwest','northwest']){
          const offer=await game.actions({direction}),c=offer.cell;
          if(c.walkable===true&&!c.occupant&&!c.hazards.length&&!c.movement.knownRestriction)
            options.push({direction,key:`${observation.location.id}:${c.x},${c.y}`});
        }
        options.sort((a,b)=>(visited.get(a.key)??0)-(visited.get(b.key)??0));
        if(!options.length){reason='noStep';break;}
        const step=options[0];visited.set(step.key,(visited.get(step.key)??0)+1);await game.move(step.direction);
      }
    }
    const finalKnown=game.observation.knowledge?.levels?.find(level=>level.id===game.observation.location.id);
    locations.add(game.observation.location.id);
    if(finalKnown){depths.set(finalKnown.id,{branch:finalKnown.branch,depth:finalKnown.depth});maxDepth=Math.max(maxDepth??finalKnown.depth,finalKnown.depth);}
    result={format:'neonethack.benchmark',version:1,identity:{role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'},legBudget:200,profile,seed,buildId:api.transport.buildId,calendarEpoch:1788739200,policyVersion:1,policyHash,legs,lowCalls:calls,turns:game.observation.turn-initialTurn,maxDepth,visitedDepths:[...depths.values()],downwardTransitions:descents,levelsVisited:locations.size,lastLocation:game.observation.location,ended:game.state.ended,deaths:game.state.end?.kind==='death'?1:0,end:game.state.end??null,stopReason:reason,tokens:null};
  }finally{await api.close();}
  console.log(JSON.stringify(result));
}
