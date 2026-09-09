import test from 'node:test';
import assert from 'node:assert/strict';
import {fuzzyMatch} from '../src/fuzzy-match.ts';

test('ordered fuzzy search prefers exact, contiguous and word-start matches', () => {
  const rank = (query, names) => names.map(name=>({name,match:fuzzyMatch(query,name)}))
    .filter(row=>row.match).sort((a,b)=>b.match.score-a.match.score).map(row=>row.name);
  assert.deepEqual(rank('read',['Ready ammunition','Read','Remove armor','Read a scroll']),['Read','Read a scroll','Ready ammunition']);
  assert.deepEqual(rank('rd',['Ready ammunition','Read','Rod of something']),['Read','Rod of something','Ready ammunition']);
  assert.ok(fuzzyMatch('zpw','Zap a wand'));
  assert.ok(fuzzyMatch('w eq','Wear equipment'));
  assert.equal(fuzzyMatch('dar','Read'),null,'letters must remain in order');
  assert.equal(fuzzyMatch('xx','Zap a wand'),null);
  assert.deepEqual(rank('', ['Wait','Eat','Read']),['Wait','Eat','Read'],'empty query preserves presentation order');
});

test('highlight positions preserve perceived Unicode labels and literal punctuation', () => {
  for (const [query,label,expected] of [['rd','Read','Rd'],['Öb','🪄 Örn’s book','Öb'],['foo','İ foo','foo'],['+1','a +1 dagger','+1'],['scroll','a scroll of light','scroll']]) {
    const match=fuzzyMatch(query,label);
    assert.ok(match);
    assert.equal(match.positions.map(i=>Array.from(label)[i]).join(''),expected);
  }
});
