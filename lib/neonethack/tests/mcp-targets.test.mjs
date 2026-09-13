import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveTarget, targetRef, TargetError} from '../dist/mcp/targets.js';

const adjacent = {scope: 'adjacent'}, level = {scope: 'level'};
const cell = (x, y, extra = {}) => ({x, y, terrain: {type: 'floor', knowledge: 'remembered', mark: '.'}, ...extra});
const snapshot = () => ({sessionId: 'session:with-delimiters', revision: 7, observation: {
  you: {x: 5, y: 5}, world: [cell(5, 5),
    cell(6, 5, {occupant: {kind: 'ally', mark: 'd', appearance: 'little dog', attitude: 'tame'}}),
    cell(4, 4, {occupant: {kind: 'creature', mark: 'd', appearance: 'dog', attitude: 'hostile'}}),
    cell(20, 10, {objects: [{mark: '!', known: {appearance: 'pink potion'}}]})],
}});
const fails = (fn, code) => assert.throws(fn, error => error instanceof TargetError && error.name === 'TargetError' && error.code === code && typeof error.details === 'object');

test('all compass directions resolve spatially without checking terrain or occupants', () => {
  const s = snapshot(), before = structuredClone(s);
  for (const [direction, dx, dy] of [['north',0,-1], ['northeast',1,-1], ['east',1,0], ['southeast',1,1], ['south',0,1], ['southwest',-1,1], ['west',-1,0], ['northwest',-1,-1]]) {
    assert.deepEqual(resolveTarget(s, {direction}, adjacent), {position: {x: 5+dx, y: 5+dy}, direction, ref: targetRef(s, 5+dx, 5+dy)});
  }
  assert.deepEqual(s, before);
});

test('runtime union validation rejects mixed branches, extra fields and malformed values', () => {
  for (const target of [null, [], {}, 'east', {direction: ['self']}, {direction: 'toString'}, {direction: 'east', position: {x:6,y:5}},
    {direction:'east', ref:'x'}, {position:{x:6,y:5,z:0}}, {position:{x:6.5,y:5}}, {position:{x:NaN,y:5}},
    {position:{x:'6',y:5}}, {ref:''}, {symbol:'d'}, {symbol:'dd',scope:'level'}, {symbol:' ',scope:'level'},
    {symbol:'\n',scope:'level'}, {symbol:'d',scope:'all'}, {symbol:'d',scope:'adjacent',ref:'x'}, {direction:'east', extra:true}])
    fails(() => resolveTarget(snapshot(), target, adjacent), 'invalidTarget');
});

test('coordinates enforce bounds, distance and explicit self permission', () => {
  const s = snapshot();
  for (const position of [{x:0,y:5}, {x:80,y:5}, {x:5,y:-1}, {x:5,y:21}])
    fails(() => resolveTarget(s, {position}, level), 'targetOutOfBounds');
  for (const position of [{x:7,y:5}, {x:5,y:7}]) fails(() => resolveTarget(s, {position}, adjacent), 'targetOutOfScope');
  fails(() => resolveTarget(s, {position:s.observation.you}, adjacent), 'targetOutOfScope');
  assert.equal(resolveTarget(s, {position:s.observation.you}, {...adjacent,self:true}).direction, 'self');
  assert.deepEqual(resolveTarget(s, {position:{x:79,y:20}}, level), {position:{x:79,y:20},ref:targetRef(s,79,20)});
  s.observation.you = {x:1,y:0};
  fails(() => resolveTarget(s, {direction:'west'}, adjacent), 'targetOutOfBounds');
});

test('vertical and self directions require explicit permission; vertical needs no hero coordinate', () => {
  const s = snapshot();
  fails(() => resolveTarget(s, {direction:'self'}, adjacent), 'targetOutOfScope');
  assert.equal(resolveTarget(s, {direction:'self'}, {...adjacent,self:true}).direction, 'self');
  s.observation.you = null;
  for (const direction of ['up','down']) {
    fails(() => resolveTarget(s, {direction}, adjacent), 'targetOutOfScope');
    assert.deepEqual(resolveTarget(s, {direction}, {...adjacent,vertical:true}), {direction});
  }
  for (const target of [{direction:'east'}, {direction:'self'}, {position:{x:6,y:5}}, {symbol:'d',scope:'adjacent'}])
    fails(() => resolveTarget(s, target, {...adjacent,self:true}), 'targetNotFound');
  assert.equal(resolveTarget(s, {position:{x:6,y:5}}, level).direction, undefined);
});

test('references are deterministic, session/revision bound, and obey spatial restrictions', () => {
  const s = snapshot(), ref = targetRef(s,6,5);
  assert.equal(targetRef(structuredClone(s),6,5), ref);
  assert.deepEqual(resolveTarget(s,{ref},adjacent),resolveTarget(s,{position:{x:6,y:5}},adjacent));
  for (const changed of [{...s,revision:8},{...s,sessionId:'other'}]) fails(() => resolveTarget(changed,{ref},adjacent),'staleTarget');
  fails(() => resolveTarget(s,{ref:'seen-17'},adjacent),'invalidTarget');
  fails(() => resolveTarget(s,{ref:targetRef(s,20,10)},adjacent),'targetOutOfScope');
  fails(() => resolveTarget(s,{ref:targetRef(s,80,10)},level),'targetOutOfBounds');
});

test('ambiguous symbols retain allies and hostiles and disclose only perceived descriptions', () => {
  const s = snapshot(), before = structuredClone(s);
  assert.throws(() => resolveTarget(s,{symbol:'d',scope:'adjacent'},adjacent), error => {
    assert.equal(error.code,'ambiguousTarget');
    assert.deepEqual(error.details.candidates, [
      {position:{x:6,y:5},direction:'east',ref:targetRef(s,6,5),description:'little dog'},
      {position:{x:4,y:4},direction:'northwest',ref:targetRef(s,4,4),description:'dog'},
    ]);
    return true;
  });
  assert.deepEqual(s,before);
  s.observation.world.splice(2,1);
  assert.equal(resolveTarget(s,{symbol:'d',scope:'adjacent'},adjacent).direction,'east');
});

test('symbols obey requested scope and map layer priority, preserving remembered appearances', () => {
  const s = snapshot();
  fails(() => resolveTarget(s,{symbol:'!',scope:'adjacent'},level),'targetNotFound');
  fails(() => resolveTarget(s,{symbol:'!',scope:'level'},adjacent),'targetOutOfScope');
  assert.deepEqual(resolveTarget(s,{symbol:'!',scope:'level'},level).position,{x:20,y:10});
  s.observation.world.push(cell(30,10,{objects:[{mark:'!',known:{appearance:'murky potion'}}]}));
  assert.throws(() => resolveTarget(s,{symbol:'!',scope:'level'},level), error => {
    assert.deepEqual(error.details.candidates.map(c=>[c.direction,c.description]), [['southeast','pink potion'],['southeast','murky potion']]);
    return true;
  });
  s.observation.world = [cell(6,5,{terrain:{type:'stairsDown',mark:'>'},objects:[{mark:'!'}],occupant:{kind:'creature',mark:'X'}})];
  for (const symbol of ['>','!']) fails(() => resolveTarget(s,{symbol,scope:'adjacent'},adjacent),'targetNotFound');
  assert.equal(resolveTarget(s,{symbol:'X',scope:'adjacent'},adjacent).direction,'east');
});

test('adjacent symbols always exclude self; level self matches use the hero map override', () => {
  const s = snapshot();
  fails(() => resolveTarget(s,{symbol:'@',scope:'adjacent'},{...adjacent,self:true}),'targetNotFound');
  fails(() => resolveTarget(s,{symbol:'@',scope:'level'},level),'targetNotFound');
  assert.equal(resolveTarget(s,{symbol:'@',scope:'level'},{...level,self:true}).direction,'self');
});
