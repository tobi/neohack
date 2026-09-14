import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderMap} from '../dist/mcp/map.js';
import {resolveTarget,targetRef} from '../dist/mcp/targets.js';
import {SceneReader,SceneProjector} from '../dist/mcp/scene.js';

const cell=(x,y,mark='!')=>({x,y,terrain:{type:'floor',knowledge:'remembered',mark:'.'},objects:[{mark}]});
const frame=(world,you)=>({sessionId:'coordinate-test',revision:0,observation:{world,you}});
const directions=[['north',0,-1],['northeast',1,-1],['east',1,0],['southeast',1,1],['south',0,1],['southwest',-1,1],['west',-1,0],['northwest',-1,-1]];

// Decode each displayed row independently of world-array ordering. The row
// label and bounds must describe the same absolute square the resolver uses.
function assertMap(world,you){
  const map=JSON.parse(JSON.stringify(renderMap({world,you})));
  const rows=map.text.split('\n');
  const [left,right]=map.bounds.x,[top,bottom]=map.bounds.y;
  assert.equal(rows.length,bottom-top+3);
  for(let y=top;y<=bottom;y++){
    const row=rows[y-top+2];
    assert.equal(Number(row.slice(0,3)),y);
    assert.equal(row.length,4+right-left+1);
  }
  for(const c of [...world,...(you?[{...you,objects:[{mark:'@'}]}]:[])]){
    const expected=you&&c.x===you.x&&c.y===you.y?'@':c.objects[0].mark;
    assert.equal(rows[c.y-top+2][4+c.x-left],expected,`absolute square ${c.x},${c.y}`);
    assert.ok(map.positions[expected].some(p=>p.x===c.x&&p.y===c.y));
  }
  for(let x=left;x<=right;x++)if(rows[1][4+x-left]==='|')
    assert.equal(rows[0].slice(4+x-left,4+x-left+String(x).length),String(x));
  return map;
}

for(const y of [0,1,4,9,10,19,20])test(`all 79 columns round-trip cropped map, ruler, symbol and reference at y=${y}`,()=>{
  for(let x=1;x<=79;x++){
    const you={x:x===79?78:x+1,y},world=[cell(x,y)];
    assertMap(world,you);
    const s=frame(world,you),position={x,y};
    for(const target of [{position},{symbol:'!',scope:'level'},{ref:targetRef(s,x,y)}])
      assert.deepEqual(resolveTarget(s,target,{scope:'level'}).position,position);
  }
});

test('every map square and direction obeys asymmetric bounds without row wrapping',()=>{
  let cases=0;
  for(let y=0;y<=20;y++)for(let x=1;x<=79;x++){
    const s=frame([],{x,y});
    for(const [direction,dx,dy] of directions){
      const position={x:x+dx,y:y+dy},valid=position.x>=1&&position.x<=79&&position.y>=0&&position.y<=20;
      if(valid){
        const result=resolveTarget(s,{direction},{scope:'adjacent'});
        assert.deepEqual(result.position,position);
        assert.deepEqual(resolveTarget(s,{ref:result.ref},{scope:'adjacent'}),result);
      }else assert.throws(()=>resolveTarget(s,{direction},{scope:'adjacent'}),e=>e.code==='targetOutOfBounds');
      cases++;
    }
  }
  assert.equal(cases,13272);
});

test('all printable marks retain one column through JSON escaping and reordered world cells',()=>{
  for(let code=33;code<=126;code++){
    const mark=String.fromCharCode(code),world=[cell(9,9,mark),cell(10,10,mark),cell(79,20,mark),cell(1,0,mark)],you={x:40,y:10};
    const map=assertMap(world,you);
    assert.equal(assertMap([...world].reverse(),you).text,map.text);
    const s=frame(world,you);
    assert.throws(()=>resolveTarget(s,{symbol:mark,scope:'level'},{scope:'level',self:true}),e=>{
      assert.equal(e.code,'ambiguousTarget');
      const positions=e.details.candidates.map(c=>c.position);
      for(const c of world)assert.ok(positions.some(p=>p.x===c.x&&p.y===c.y));
      return true;
    });
  }
});

test('a hero drawn without a world cell remains addressable by its displayed symbol',()=>{
  for(const you of [{x:1,y:0},{x:79,y:20},{x:10,y:9}]){
    const s=frame([],you),map=renderMap(s.observation);
    assert.deepEqual(map.positions['@'],[you]);
    assert.deepEqual(resolveTarget(s,{symbol:'@',scope:'level'},{scope:'level',self:true}).position,you);
    assert.throws(()=>resolveTarget(s,{symbol:'@',scope:'adjacent'},{scope:'adjacent',self:true}),e=>e.code==='targetNotFound');
    s.observation.world=[cell(40,10,'@')];
    assert.throws(()=>resolveTarget(s,{symbol:'@',scope:'level'},{scope:'level',self:true}),e=>e.code==='ambiguousTarget'&&e.details.candidates.length===2);
  }
});

function sceneFrame(revision,world,you,levelId='level-1'){
  return {version:2,basis:{sessionId:'coordinate-test',revision,viewId:`view-${revision}`,levelId,turn:revision},
    control:{gate:'ready'},outcome:null,decision:null,events:[],diagnostics:{},
    scene:{kind:'snapshot',self:{position:you,location:{id:levelId},vitals:{}},
      nearby:{status:'unavailable',reason:'unavailable'},entities:[],features:[],
      map:renderMap({world,you}),world,inventory:[],inventoryKnown:true,
      here:{known:true,items:[]},perception:{version:1,inventory:'current',here:'current',equipment:'current'},end:null}};
}

test('map crops expand and shrink without rebasing world coordinates in scene deltas',()=>{
  const projector=new SceneProjector(),reader=new SceneReader();
  const worlds=[
    [cell(40,10)],
    [cell(1,0),cell(40,10),cell(79,20)],
    [cell(9,9),cell(10,10),cell(79,20)],
    [cell(79,20)],
    [cell(1,0)],
  ];
  let previous;
  for(const [revision,world] of worlds.entries()){
    const you={x:world[0].x,y:world[0].y},expected=sceneFrame(revision,world,you);
    const wire=projector.project(expected,previous?.basis.viewId);
    assert.equal(wire.scene.kind,revision?'delta':'snapshot');
    assert.deepEqual(reader.apply(JSON.parse(JSON.stringify(wire))),expected);
    assert.deepEqual(reader.current('coordinate-test').scene.map,assertMap(world,you));
    previous=expected;
  }
});

test('deep level transitions replace coordinates and never merge the previous level map',()=>{
  const projector=new SceneProjector(),reader=new SceneReader();
  let previous;
  for(let depth=1;depth<=50;depth++){
    const you={x:depth%2?79:1,y:depth%2?20:0};
    const world=[cell(you.x,you.y),cell(40,10,depth%2?'>':'<')].sort((a,b)=>a.y-b.y||a.x-b.x);
    const expected=sceneFrame(depth,world,you,`level-${depth}`);
    const wire=projector.project(expected,previous?.basis.viewId);
    assert.equal(wire.scene.kind,'snapshot');
    assert.deepEqual(reader.apply(wire),expected);
    assertMap(reader.current('coordinate-test').scene.world,you);
    if(previous){
      assert.throws(()=>reader.apply({...expected,basis:{...expected.basis,revision:depth+1,viewId:`bad-${depth}`},
        scene:{kind:'delta',baseViewId:previous.basis.viewId,world:previous.scene.world}}),/baseline/);
      assert.deepEqual(reader.current('coordinate-test'),expected,'rejected old-level delta cannot repaint this level');
    }
    previous=expected;
  }
});
