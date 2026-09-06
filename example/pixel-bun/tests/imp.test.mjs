import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import {fixture,identity} from '../../../lib/neonethack/tests/native-fixture.mjs';
import {runBot} from '../../../lib/neonethack/dist/typescript/client.js';

test('the editable imp uses lifecycle events to explore a real dungeon', {timeout:60000}, async t=>{
 const dir=await mkdtemp('/tmp/neohack-imp-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const library=pathToFileURL(resolve(import.meta.dirname,'../../../lib/neonethack/dist/typescript/client.js')).href;
 for(const name of ['main','strategy']){
  const source=await readFile(resolve(import.meta.dirname,'../bots/imp/'+name+'.ts'),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replaceAll("'neonethack'",JSON.stringify(library)).replaceAll("'./strategy'","'./strategy.mjs'");
  await writeFile(dir+'/'+name+'.mjs',code);
 }
 const random=Math.random;let rng=123;Math.random=()=>((rng=(Math.imul(rng,1664525)+1013904223)>>>0)/4294967296);t.after(()=>{Math.random=random;});
 const {default:imp}=await import(pathToFileURL(dir+'/main.mjs').href);
 const {api}=await fixture(t),game=await api.create(identity);
 const logs=[],levels=[],positions=new Set();let newItems=0, mapChanges=0, moves=0,food=0, equipment=0;
 const result=await runBot(game,{initialize(context){
   imp.initialize(context);
   context.hero.addEventListener('enterLevel',({detail})=>levels.push(detail.to.depthLabel));
   context.hero.addEventListener('mapChange',()=>mapChanges++);
   context.hero.addEventListener('itemSeen',()=>newItems++);
   context.hero.addEventListener('stateChange',({detail:{snapshot:s}})=>{
     if(s.observation.you)positions.add(s.observation.location.id+JSON.stringify(s.observation.you));
     if(s.outcome.positionChanged)moves++;
     if(s.outcome.action==='eat')food++;
     if(s.outcome.action==='equip')equipment++;
     if(s.revision>=1000)context.hero.stop();
   });
 }},(...values)=>logs.push(values.join(' ')));
 t.diagnostic(JSON.stringify({reason:result.reason,turn:game.observation.turn,levels,moves,positions:positions.size,food,equipment,end:game.state.end,log:logs.slice(-8)}));
 assert.ok(['ended','stopped','decision'].includes(result.reason), result.reason+'\n'+logs.slice(-20).join('\n'));
 assert.ok(moves>=10, 'imp must make real exploration progress');assert.ok(positions.size>=10);assert.ok(mapChanges>10);assert.ok(newItems>0);assert.ok(levels.length>=2, 'imp must discover and descend real stairs');

});
