import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cellMark, markAt, renderMap} from '../dist/mcp/map.js';
import {AgentClient} from '../dist/mcp/agent.js';

const cell=(x,y,type,extra={})=>{
  const {terrain,...rest}=extra;
  return {x,y,terrain:{type,knowledge:'remembered',...terrain},...rest};
};

test('a narrow map between five-column ticks still has a labelled coordinate',()=>{
  const map=renderMap({world:[],you:{x:7,y:4}});
  assert.deepEqual(map.bounds.x,[6,8]);
  assert.deepEqual(map.text.split('\n').slice(0,2),['  x 6','    |  ']);
});

test('map renders known cells with rulers, y prefixes and a legend built from the layers present',()=>{
  const world=[
    cell(10,4,'wall',{terrain:{orientation:'horizontal',mark:'-'}}),
    cell(10,5,'wall',{terrain:{orientation:'vertical',mark:'|'}}),
    cell(11,5,'floor',{terrain:{mark:'.'}}),cell(12,5,'floor',{terrain:{mark:'.'},occupant:{kind:'ally',mark:'f',appearance:'kitten',attitude:'tame'}}),
    cell(13,5,'closedDoor',{terrain:{mark:'+'}}),cell(14,5,'openDoor',{terrain:{orientation:'vertical',mark:'-'}}),
    cell(11,6,'floor',{terrain:{mark:'.'},objects:[{mark:'$',color:8}]}),cell(12,6,'floor',{terrain:{mark:'.'},objects:[{mark:'(',color:8,category:'tool',known:{appearance:'chest'}}]}),
    cell(13,6,'floor',{terrain:{mark:'.'},objects:[{mark:'`',color:7,kind:'boulder'}]}),cell(14,6,'stairsDown',{terrain:{mark:'>'}}),
    cell(20,6,'dark'),cell(21,6,'unknown'),
  ];
  const map=renderMap({world,you:{x:11,y:5}});
  assert.deepEqual(map.bounds,{x:[9,15],y:[3,7]});
  assert.deepEqual(map.you,{x:11,y:5});
  assert.deepEqual(map.positions,{
    '@':[{x:11,y:5}],f:[{x:12,y:5}],'+':[{x:13,y:5}],'-':[{x:14,y:5}],
    '$':[{x:11,y:6}],'(':[{x:12,y:6}],'`':[{x:13,y:6}],'>':[{x:14,y:6}],
  });
  assert.deepEqual(map.text.split('\n'),[
    '  x  10   15',
    '     |    |',
    '  3        ',
    "  4  -     ",
    '  5  |@f+- ',
    '  6   $(`> ',
    '  7        ',
  ]);
  assert.deepEqual(map.legend,{
    '-':'wall, open door','|':'wall','@':'you',f:'kitten (tame)','+':'closed door',
    $:'object','(':'object: chest','`':'boulder','>':'stairs down',' ':'unknown or dark',
  });
});

test('mark coordinates retain duplicate appearances and align after JSON decoding',()=>{
  const world=[cell(9,2,'floor',{terrain:{mark:'.'},objects:[{mark:'"'}]}),
    cell(10,2,'throne',{terrain:{mark:'\\'}}),cell(11,2,'floor',{terrain:{mark:'.'},objects:[{mark:'"'}]}),
    cell(12,2,'closedDoor',{terrain:{mark:'+'},occupant:{kind:'creature',mark:'g',appearance:'goblin'}})];
  const map=JSON.parse(JSON.stringify(renderMap({world,you:{x:8,y:2}})));
  assert.deepEqual(map.positions['"'],[{x:9,y:2},{x:11,y:2}]);
  assert.equal(map.positions['+'],undefined,'covered door is not indexed as a displayed mark');
  const rows=map.text.split('\n');
  for(const [mark,points] of Object.entries(map.positions)) for(const {x,y} of points){
    const column=4+x-map.bounds.x[0];
    if(x%5===0){
      assert.equal(rows[0].slice(column,column+String(x).length),String(x));
      assert.equal(rows[1][column],'|');
    }
    assert.equal(rows[2+y-map.bounds.y[0]][column],mark);
  }
});

test('map merges meanings sharing a mark, keeps the hero when the world lacks a self cell and clamps to the level',()=>{
  const world=[cell(1,0,'floor',{terrain:{mark:'.'}}),cell(2,0,'corridor',{terrain:{mark:'#'}}),cell(3,0,'sink',{terrain:{mark:'#'}}),cell(79,20,'floor',{terrain:{mark:'.'},occupant:{kind:'creature',mark:'n',appearance:'newt',attitude:'hostile'}})];
  const map=renderMap({world,you:{x:1,y:0}});
  assert.deepEqual(map.bounds,{x:[0,79],y:[0,20]});
  assert.equal(map.legend['#'],'corridor, sink');
  assert.equal(map.legend['n'],'newt (hostile)');
  const rows=map.text.split('\n');
  assert.equal(rows[2].slice(4),' @##'.padEnd(80),'x=0 is padding; the level starts at x=1');
  assert.equal(rows.at(-1).slice(4).at(-1),'n');
  assert.equal(renderMap({world:[cell(5,5,'unknown')],you:null}),undefined,'nothing known renders nothing');
  const cellsOnly=renderMap({world:[cell(5,5,'floor',{occupant:{kind:'self',mark:'@'}})],you:null});
  assert.equal(cellsOnly.legend['@'],'you');
  assert.equal(renderMap({world:[cell(5,5,'floor',{occupant:{kind:'creature',mark:'\u0000',appearance:'newt'}})],you:null}),undefined,'an unprintable engine mark is not placed');
});

test('cellMark and markAt share renderMap glyphs from engine marks, including the hero override',()=>{
  const you={x:11,y:5};
  assert.equal(cellMark(cell(11,5,'floor',{occupant:{kind:'self',mark:'@'}})),'@');
  assert.equal(cellMark(cell(11,5,'floor',{terrain:{mark:'.'},objects:[{mark:'$'}]}),you),'@');
  assert.equal(cellMark(cell(12,5,'floor',{occupant:{kind:'creature',mark:'\u0000',appearance:'newt'}})),undefined);
  assert.equal(cellMark(cell(11,6,'floor',{objects:[{mark:'\u0000'}]})),undefined);
  assert.equal(cellMark(cell(13,6,'floor',{objects:[{mark:'`',kind:'boulder'}]})),'`');
  assert.equal(cellMark(cell(10,4,'wall',{terrain:{orientation:'horizontal',mark:'-'}})),'-');
  assert.equal(cellMark(cell(10,5,'wall',{terrain:{orientation:'vertical',mark:'|'}})),'|');
  assert.equal(cellMark(cell(20,6,'dark')),undefined);
  assert.equal(cellMark(cell(21,6,'unknown')),undefined);
  const observation={world:[cell(11,5,'floor',{terrain:{mark:'.'},objects:[{mark:'$'}]}),cell(12,5,'floor',{terrain:{mark:'.'},occupant:{kind:'creature',mark:'f'}}),cell(20,6,'dark')],you};
  assert.equal(markAt(observation,11,5),'@');
  assert.equal(markAt(observation,12,5),'f');
  assert.equal(markAt(observation,20,6),undefined);
  assert.equal(markAt(observation,0,0),undefined);
  const map=renderMap(observation);
  assert.equal(cellMark(observation.world[1]), map.text.split('\n')[2+5-map.bounds.y[0]][4+12-map.bounds.x[0]]);
});

test('go occupied details carry the engine occupant mark without submitting input',async()=>{
  const snapshot={
    version:1,sessionId:'sess',requestId:'create-1',revision:0,
    outcome:{action:'create',status:'completed',turnsElapsed:0,positionChanged:false,effects:[]},
    observation:{
      turn:1,location:{id:'level',depthLabel:'Dlvl:1'},you:{x:5,y:5},vitals:{},
      inventory:[],inventoryKnown:true,here:{known:true,items:[]},
      perception:{version:1,inventory:'current',here:'current',equipment:'current'},
      world:[
        cell(5,5,'floor',{terrain:{mark:'.'},occupant:{kind:'self',mark:'@'}}),
        cell(6,5,'floor',{terrain:{mark:'.'},occupant:{kind:'creature',mark:'d',appearance:'dog',attitude:'hostile'}}),
      ],
      heard:[],neighborhood:{version:1,status:'unavailable',reason:'unknownPosition'},
    },
    events:[],decision:null,ended:false,end:null,
  };
  const agent=new AgentClient({send:async request=>{
    if(request.method==='session.create')return snapshot;
    throw Error(`unexpected ${request.method}`);
  }});
  await agent.call('create',{role:'valkyrie'});
  const blocked=await agent.call('go',{sessionId:'sess',direction:'east'});
  assert.equal(blocked.error.code,'occupied');
  assert.equal(blocked.inputSubmitted,false);
  assert.equal(blocked.error.occupant.mark,'d');
  assert.deepEqual(blocked.error.attack.arguments.target,{x:6,y:5});
});
