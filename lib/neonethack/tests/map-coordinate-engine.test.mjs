import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,identity} from './native-fixture.mjs';
import {scenarioEngine} from './pickup-engine-fixture.mjs';
import {WasmTransport} from '../dist/typescript/wasm.js';
import {McpService} from '../dist/mcp/service.js';
import {SceneReader} from '../dist/mcp/scene.js';

const directions=[['north',0,-1],['northeast',1,-1],['east',1,0],['southeast',1,1],['south',0,1],['southwest',-1,1],['west',-1,0],['northwest',-1,-1]];
function mapAt(map,x,y){return map.text.split('\n')[2+y-map.bounds.y[0]][4+x-map.bounds.x[0]];}

for(const wasm of [false,true])test(`${wasm?'WASM':'native'} real engine map axes, landmarks, query targets and movement survive boundary origins`,async t=>{
  const options=await scenarioEngine(t,wasm,'map-coordinate-fixture.inc','map_coordinate_fixture');
  for(const [x,y] of [[1,0],[79,0],[1,20],[79,20],[9,10],[10,9],[40,10]])await t.test(`origin ${x},${y}`,async t=>{
    const transport=wasm?await WasmTransport.create(options):(await fixture(t,options)).transport;
    if(wasm)t.after(()=>transport.close());
    let low;const inputs=[];
    const service=new McpService({send:async request=>{
      if(request.method.startsWith('game.')||request.method.startsWith('decision.'))inputs.push(request);
      const result=await transport.send(request);if('observation' in result)low=result;return result;
    }});
    const reader=new SceneReader();
    const call=async(name,args)=>{
      const response=await service.call(name,args);
      assert.equal(response.isError,false,JSON.stringify({tool:name,code:response.structuredContent.error?.code,message:response.structuredContent.error?.message}));
      assert.deepEqual(JSON.parse(response.content[0].text),response.structuredContent);
      const frame=reader.apply(response.structuredContent);
      if(frame.scene.map)assert.ok(response.content.some(part=>part.text.includes(frame.scene.map.text)));
      return frame;
    };
    const created=await call('session',{action:'create',...identity,name:`Coord${x}x${y}`,automaticPickup:{enabled:false,itemTypes:[],arrows:false,leaveCorpses:true,leaveKnownCursed:true},includeWorld:true});
    const sid={sessionId:created.basis.sessionId},dx=x>40?-1:1,dy=y>10?-1:1;
    assert.deepEqual(low.observation.you,{x,y});
    assert.deepEqual(created.scene.self.position,{x,y});
    assert.equal(mapAt(created.scene.map,x,y),'@');
    const at=(cx,cy)=>low.observation.world.find(c=>c.x===cx&&c.y===cy);
    assert.equal(at(x+2*dx,y+dy).terrain.type,'fountain');
    assert.equal(at(x+dx,y+2*dy).terrain.type,'sink');
    assert.equal(at(x+dx,y).objects[0].mark,'$');
    assert.equal(mapAt(created.scene.map,x+2*dx,y+dy),'{');
    assert.equal(mapAt(created.scene.map,x+dx,y+2*dy),'{'); // pinned engine defsym.h uses { for sinks too
    assert.equal(mapAt(created.scene.map,x+dx,y),'$');
    assert.ok(low.observation.here.items.some(i=>i.category==='gem'));
    assert.ok(low.observation.world.every(c=>c.x>=1&&c.x<=79&&c.y>=0&&c.y<=20));
    const neighborhood=low.observation.neighborhood;
    assert.equal(neighborhood.cells.length,81);
    for(let i=0;i<81;i++){
      const c=neighborhood.cells[i],cx=x+i%9-4,cy=y+Math.floor(i/9)-4;
      assert.equal(c.x,cx);assert.equal(c.y,cy);
      assert.equal(c.dx,cx-x);assert.equal(c.dy,cy-y);
      assert.equal(c.inBounds,cx>=1&&cx<=79&&cy>=0&&cy<=20);
    }
    for(const [direction,ox,oy] of directions){
      const cx=x+ox,cy=y+oy;
      if(cx<1||cx>79||cy<0||cy>20){
        const rejected=await service.call('travel',{...sid,viewId:created.basis.viewId,mode:'step',target:{direction}});
        assert.equal(rejected.structuredContent.error.code,'targetOutOfBounds');continue;
      }
      for(const target of [{direction},{position:{x:cx,y:cy}}]){
        const query=await call('interact',{...sid,target});
        assert.equal(query.result.cell.x,cx);assert.equal(query.result.cell.y,cy);
        assert.deepEqual(query.result.basis.origin,{x,y});
        assert.equal(query.basis.turn,created.basis.turn);
      }
    }
    const coin=await call('interact',{...sid,target:{symbol:'$',scope:'adjacent'}});
    assert.equal(coin.result.cell.x,x+dx);assert.equal(coin.result.cell.y,y);
    assert.deepEqual(inputs,[]);
    const moved=await call('travel',{...sid,viewId:coin.basis.viewId,mode:'step',target:{position:{x:x+dx,y}},includeWorld:true,sinceViewId:coin.basis.viewId});
    assert.deepEqual(moved.scene.self.position,{x:x+dx,y});
    assert.equal(mapAt(moved.scene.map,x+dx,y),'@');
    assert.equal(mapAt(moved.scene.map,x,y),'*','departed hero square reveals its actual underfoot gem');
    assert.equal(inputs.length,1);assert.equal(inputs[0].params.direction,dx===1?'east':'west');
    assert.equal(moved.basis.turn,created.basis.turn+1);
    const accepted=structuredClone(low);
    assert.deepEqual(await transport.send(inputs[0]),accepted,'exact movement receipt never shifts or repeats');
    await call('session',{...sid,action:'suspend'});
    const resumed=await call('session',{...sid,action:'resume',includeWorld:true});
    assert.deepEqual(resumed.scene.self.position,moved.scene.self.position);
    assert.equal(resumed.scene.map.text,moved.scene.map.text);
  });
});
