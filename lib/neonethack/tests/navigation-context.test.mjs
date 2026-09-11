import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Navigator} from '../dist/typescript/navigator.js';
function fixture(change={}) {
  const observation={turn:1,you:{x:10,y:10},location:{id:'one'},vitals:{health:12,hunger:'not_hungry',condition:[]},world:[]};
  const game={state:{revision:0,observation,decision:null,ended:false},get observation(){return this.state.observation;},get decision(){return this.state.decision;},
    route:async()=>({distance:2,steps:[{direction:'east'}]}),
    move:async()=>{game.state={...game.state,revision:1,outcome:{status:'completed',turnsElapsed:1,positionChanged:true},observation:{...observation,turn:2,you:{x:11,y:10},...change}};return game.state;}};
  return game;
}
for(const [kind,change,before,after] of [
  ['healthLost',{vitals:{health:8,hunger:'not_hungry',condition:[]}},12,8],
  ['hungerChanged',{vitals:{health:12,hunger:'hungry',condition:[]}},'not_hungry','hungry'],
  ['conditionChanged',{vitals:{health:12,hunger:'not_hungry',condition:['blind']}},[],['blind']],
  ['levelChanged',{location:{id:'two'}},'one','two'],
])test(`navigator identifies ${kind} from the returned scene`,async()=>{
  const result=await new Navigator(fixture(change)).go({to:{x:12,y:10}});
  assert.equal(result.actionsTaken,1);assert.equal(result.turnsElapsed,1);
  assert.deepEqual(result.stop,{kind,before,after});
});
test('diagonal exploration probes only a C-offered move, skipping rejected corners',async()=>{
  const game=fixture(),queries=[],moves=[];
  game.navigation=async()=>({frontiers:[],waysDown:[],doors:[]});
  game.actions=async point=>{queries.push(point);return {cell:{movement:{relation:'adjacent',intent:'unknown',...(point.x===11&&point.y===9?{knownRestriction:'intactDoorDiagonal'}:{})},actions:point.x===11&&point.y!==10?[{method:'game.move',arguments:{direction:point.y===11?'southeast':'northeast'}}]:[]}};};
  game.move=async direction=>{moves.push(direction);return {...game.state,outcome:{status:'completed',turnsElapsed:1}};};
  const result=await new Navigator(game).explore();
  assert.deepEqual(moves,['southeast']);assert.equal(result.actionsTaken,1);
  assert.ok(queries.some(p=>p.x===11&&p.y===9),'ineligible diagonal examined before eligible one');
});
