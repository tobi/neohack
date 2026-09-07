#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const seeds=[7,42,123];
const identity={role:'valkyrie',race:'dwarf',gender:'female',align:'lawful'};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function standings(submissions){
  const groups=new Map();
  for(const {name,records} of submissions){
    if(!Array.isArray(records)||records.length!==seeds.length)throw Error(`${name}: require exactly seeds 7, 42, 123`);
    const ordered=[...records].sort((a,b)=>a.seed-b.seed);
    let cohort,policy;
    for(let i=0;i<ordered.length;i++){
      const r=ordered[i];
      if(r.format!=='neonethack.benchmark'||r.version!==1||r.seed!==seeds[i]||
        !['navigator','world-only'].includes(r.profile)||!hash(r.policyHash)||typeof r.buildId!=='string'||!r.buildId||
        r.calendarEpoch!==1788739200||r.legBudget!==200||r.policyVersion!==1||
        !r.identity||Object.keys(r.identity).length!==4||Object.entries(identity).some(([key,value])=>r.identity[key]!==value)||
        !['budget','ended','decision','target','noRoute','noStep'].includes(r.stopReason)||
        !integer(r.turns)||!integer(r.legs)||r.legs>r.legBudget||!integer(r.maxDepth)||
        ![0,1].includes(r.deaths)||typeof r.ended!=='boolean'||
        (r.deaths===1)!==(r.end?.kind==='death')||
        !r.lowCalls||!Object.keys(r.lowCalls).length||!Object.values(r.lowCalls).every(integer)||
        r.tokens!==null)throw Error(`${name}: invalid fixed-reference result for seed ${r.seed}`);
      if(r.profile==='world-only'&&(r.lowCalls['session.route']||r.lowCalls['session.navigation']))throw Error(`${name}: world-only used navigation`);
      const key=JSON.stringify({buildId:r.buildId,profile:r.profile,calendarEpoch:r.calendarEpoch,identity,legBudget:r.legBudget,seeds});
      if(cohort&&cohort!==key)throw Error(`${name}: mixed runtime or evaluation conditions`);
      if(policy&&policy!==r.policyHash)throw Error(`${name}: mixed policy sources`);
      cohort=key;policy=r.policyHash;
    }
    const total=fn=>ordered.reduce((sum,r)=>sum+fn(r),0);
    const entry={name,policyHash:policy,runs:ordered.length,meanDepth:total(r=>r.maxDepth)/ordered.length,
      deaths:total(r=>r.deaths),totalTurns:total(r=>r.turns),totalCalls:total(r=>Object.values(r.lowCalls).reduce((a,b)=>a+b,0)),tokens:null,
      outcomes:ordered.map(r=>({seed:r.seed,depth:r.maxDepth,ended:r.ended,end:r.end,stopReason:r.stopReason}))};
    if(!groups.has(cohort))groups.set(cohort,[]);
    groups.get(cohort).push(entry);
  }
  return {format:'neonethack.leaderboard',version:1,
    ranking:'Mean perceived depth descending, then deaths ascending. Calls and turns are reported, not treated as independent skill scores. Distinct runtimes/profiles are separate cohorts.',
    cohorts:[...groups].map(([key,entries])=>({conditions:JSON.parse(key),entries:entries.sort((a,b)=>b.meanDepth-a.meanDepth||a.deaths-b.deaths||a.name.localeCompare(b.name))}))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.length<3)throw Error('Usage: node examples/benchmark/leaderboard.mjs submission.jsonl [...]');
  console.log(JSON.stringify(standings(process.argv.slice(2).map(name=>({name,records:readFileSync(name,'utf8').trim().split('\n').map(JSON.parse)}))),null,2));
}
