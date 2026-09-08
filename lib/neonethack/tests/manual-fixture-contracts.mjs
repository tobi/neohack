import assert from 'node:assert/strict';
const identity={seed:42,name:'ManualFixture',role:'wizard',race:'human',gender:'female',align:'neutral'};
const named=(game,name)=>{const item=game.observation.inventory.find(i=>i.label.includes(name));assert.ok(item,name);return {id:item.id};};
async function resume(api,game){await game.close();return api.resume(game.id);}
async function choose(game,text){assert.equal(game.decision?.kind,'choice');const option=game.decision.options.find(o=>o.label.includes(text));assert.ok(option,text);return game.answer(game.decision.id,{kind:'choice',choose:[option.id]});}
export async function manualFixtureContracts(t,fixture){
  await t.test('statue subjects and weapon shapes agree across perceived world, local and inventory views',async t=>{
    const {api}=await fixture(t);let g=await api.create({...identity,name:'ArtShapes'});
    const subjects=['human','dog','housecat','raven','python','red dragon'];
    const cell=(x,y)=>g.observation.world.find(c=>c.x===x&&c.y===y);
    for(const [i,subject] of subjects.entries()) {
      const item=g.observation.inventory.find(item=>item.label.includes('art-statue-'+i));
      assert.equal(item.known.appearance,'statue');assert.equal(item.known.depictedCreature,subject);
      const obj=cell(37+i,9)?.objects?.[0];
      assert.equal(obj?.category,'object',JSON.stringify({i,subject,cell:cell(37+i,9)}));assert.deepEqual(obj.known,{appearance:'statue',depictedCreature:subject});
      const local=g.observation.neighborhood.cells.find(c=>c.x===37+i&&c.y===9);
      assert.deepEqual(local.objects,cell(37+i,9).objects);
      if (Math.abs(37+i-40)<=1) assert.deepEqual((await g.actions({x:37+i,y:9})).cell.objects,local.objects);
    }
    assert.equal(cell(40,11).objects[0].known.appearance,'crossbow bolt');
    assert.equal(cell(41,11).objects[0].known.appearance,'long sword');
    assert.equal(cell(43,10).occupant,undefined);
    assert.equal(cell(43,10).objects[0].known.appearance,'long sword','mimic remains its perceived disguise');
    const before=await g.observe();assert.deepEqual(await g.observe(),before);
    g=await resume(api,g);assert.deepEqual(g.observation,before.observation);
  });
  await t.test('hallucination withholds structured statue subjects and map item shapes',async t=>{
    const {api}=await fixture(t);const g=await api.create({...identity,name:'ArtHallucinated'});
    assert.ok(g.observation.inventory.length);
    for(const item of g.observation.inventory) {assert.equal(item.known?.depictedCreature,undefined);assert.equal(item.known?.appearance,undefined);}
    for(const cell of g.observation.world)for(const obj of cell.objects??[])assert.equal(obj.known,undefined);
    const before=await g.observe();assert.deepEqual(await g.observe(),before);
  });
  for (const [mode,x] of [['untilInteresting',39],['pastBranches',37]]) await t.test('native run '+mode+' uses its own corridor-fork stopping rule',async t=>{
    const {api,transport}=await fixture(t);let g=await api.create({...identity,name:'RunBranch'});
    const result=await g.run('west',{mode,noPickup:true});
    assert.equal(result.error,undefined);assert.deepEqual(result.observation.you,{x,y:10});
    assert.equal(result.outcome.turnsElapsed,40-x);assert.equal(result.decision,null);
    const request={version:1,method:'game.run',params:{sessionId:g.id,requestId:result.requestId,expectedRevision:result.revision-1,direction:'west',mode,noPickup:true}};
    assert.deepEqual(await transport.send(request),result);
    const turn=result.observation.turn;g=await resume(api,g);assert.equal(g.observation.turn,turn);assert.deepEqual(g.observation.you,{x,y:10});
  });
  for (const noPickup of [false,true]) await t.test('native run noPickup='+noPickup+' controls actual floor transfer',async t=>{
    const {api}=await fixture(t);const g=await api.create({...identity,name:'RunPickup',automaticPickup:{enabled:true,itemTypes:['gold'],arrows:false,leaveCorpses:false,leaveKnownCursed:false}});
    const gold=Number(g.observation.vitals.gold);const result=await g.run('west',{noPickup});
    assert.equal(result.error,undefined);assert.equal(Number(result.observation.vitals.gold)-gold,noPickup?0:19);
    assert.equal(result.decision,null);
  });
  await t.test('running preserves a real pickup decision and its command context across resume',async t=>{
    const {api,transport}=await fixture(t);let g=await api.create({...identity,name:'RunPickup',automaticPickup:{enabled:true,itemTypes:['gold'],arrows:false,leaveCorpses:false,leaveKnownCursed:false,review:true}});
    const result=await g.run('west',{mode:'pastBranches'});assert.equal(result.error,undefined);
    assert.ok(result.decision?.cancellable);const id=result.decision.id, turn=result.observation.turn;
    await g.observe();assert.equal(g.decision.id,id);assert.equal(g.observation.turn,turn);
    g=await resume(api,g);assert.equal(g.decision.id,id);assert.equal(g.observation.turn,turn);
    const request={version:1,method:'decision.cancel',params:{sessionId:g.id,requestId:'cancel-run-pickup',expectedRevision:g.state.revision,decisionId:id}};
    const cancelled=await transport.send(request);assert.equal(cancelled.error,undefined);assert.equal(cancelled.decision,null);
    assert.deepEqual(await transport.send(request),cancelled);
  });
  await t.test('invalid running parameters are rejected without input or a new revision',async t=>{
    const {api,transport}=await fixture(t);const g=await api.create({...identity,name:'RunWall'});const before=g.state;
    for (const args of [{mode:'g'},{noPickup:1},{turns:5},{direction:'up'}]) {
      const result=await transport.send({version:1,method:'game.run',params:{sessionId:g.id,requestId:'invalid-run',expectedRevision:before.revision,direction:'west',...args}});
      assert.equal(result.error.code,'invalidParams');
    }
    await g.observe();assert.equal(g.state.revision,before.revision);assert.equal(g.observation.turn,before.observation.turn);
  });
  await t.test("native uppercase running stops at a wall, retries exactly and resumes",async t=>{
    const {api,transport}=await fixture(t);let g=await api.create({...identity,name:"RunWall"});
    const request={version:1,method:"game.run",params:{sessionId:g.id,requestId:"run-west",expectedRevision:g.state.revision,direction:"west"}};
    const result=await transport.send(request);assert.equal(result.error,undefined);
    assert.deepEqual(result.observation.you,{x:37,y:10});assert.equal(result.outcome.turnsElapsed,3);
    assert.deepEqual(await transport.send(request),result);
    await g.observe();g=await resume(api,g);assert.deepEqual(g.observation.you,result.observation.you);
    const wall=await g.run("west");assert.equal(wall.outcome.turnsElapsed,0);assert.equal(wall.outcome.status,"blocked");
  });
  await t.test("native uppercase running stops before attacking an adjacent hostile creature",async t=>{
    const {api}=await fixture(t);const g=await api.create({...identity,name:"RunCreature"});
    const before=g.observation;const result=await g.run("west");
    assert.equal(result.error,undefined);assert.deepEqual(result.observation.you,before.you);
    assert.equal(result.outcome.turnsElapsed,0);assert.equal(result.observation.vitals.health,before.vitals.health);
  });
  await t.test('inventory equipment slots preserve layers, sides, empty assignments and real removal across resume',async t=>{
    const {api}=await fixture(t);let g=await api.create({...identity,name:'EquipmentSlots'});
    const item=name=>g.observation.inventory.find(i=>i.label.includes(name));
    const expected={body:'bodyArmor',cloak:'cloak',head:'helmet',shield:'shield',hands:'gloves',feet:'boots',shirt:'shirt',neck:'amulet',left:'leftRing',right:'rightRing',eyes:'eyewear',weapon:'weapon',alternate:'alternateWeapon',quiver:'quiver'};
    for(const [name,slot] of Object.entries(expected)) assert.deepEqual(item('slot-'+name).equipmentSlots,[slot]);
    assert.deepEqual(item('writing-marker').equipmentSlots,[]);
    assert.equal(g.observation.perception.equipment,'current');
    const before=await g.observe();assert.deepEqual(await g.observe(),before);
    const equipped=g.observation.inventory.map(i=>[i.id,i.equipmentSlots]);
    g=await resume(api,g);assert.deepEqual(g.observation.inventory.map(i=>[i.id,i.equipmentSlots]),equipped);
    const cloak=item('slot-cloak');const removed=await g.remove({id:cloak.id});
    assert.equal(removed.decision,null);assert.ok(removed.outcome.turnsElapsed>0);
    assert.deepEqual(item('slot-cloak').equipmentSlots,[]);
    assert.deepEqual(item('slot-body').equipmentSlots,['bodyArmor']);
    assert.deepEqual(item('slot-shirt').equipmentSlots,['shirt']);
    await g.drop({id:cloak.id});
    assert.equal(g.observation.here.items.find(i=>i.label.includes('slot-cloak')).equipmentSlots,undefined);
  });
  await t.test('explicit equipment destinations validate before input, select ring side and preserve receipts across resume',async t=>{
    const {api,transport}=await fixture(t);let g=await api.create({...identity,name:'ItemAppearance'});
    const shield=g.observation.inventory.find(i=>i.label.includes('icon-shield'));
    const ring=g.observation.inventory.find(i=>i.label.includes('wearable-meat'));
    assert.ok(shield.equipmentTargets.some(t=>t.slot==='shield'&&t.action==='equip'));
    assert.ok(!shield.equipmentTargets.some(t=>t.slot==='helmet'));
    const revision=g.state.revision,turn=g.observation.turn;
    await assert.rejects(g.equip({id:shield.id},{slot:'helmet'}),/destination|slot/i);
    assert.equal(g.state.revision,revision);assert.equal(g.observation.turn,turn);
    const result=await g.equip({id:ring.id},{slot:'rightRing'});
    assert.equal(result.decision,null);assert.deepEqual(g.observation.inventory.find(i=>i.id===ring.id).equipmentSlots,['rightRing']);
    const receipt=await transport.send({version:1,method:'game.equip',params:{sessionId:g.id,requestId:result.requestId,expectedRevision:revision,item:{id:ring.id},slot:'rightRing'}});
    assert.deepEqual(receipt,result);
    g=await resume(api,g);assert.deepEqual(g.observation.inventory.find(i=>i.id===ring.id).equipmentSlots,['rightRing']);
    await g.remove({id:ring.id});await g.equip({id:ring.id},{slot:'leftRing'});
    assert.deepEqual(g.observation.inventory.find(i=>i.id===ring.id).equipmentSlots,['leftRing']);
    await g.equip({id:shield.id},{slot:'shield'});
    assert.deepEqual(g.observation.inventory.find(i=>i.id===shield.id).equipmentSlots,[], 'two-handed staff still blocks a valid shield attempt');
    await g.wield(named(g,'selected-daggers'));
    await g.equip({id:shield.id},{slot:'shield'});
    assert.deepEqual(g.observation.inventory.find(i=>i.id===shield.id).equipmentSlots,['shield']);
  });
  await t.test('item appearance describes shapes without nicknames or unidentified magic',async t=>{
    const {api}=await fixture(t);let g=await api.create({...identity,name:'ItemAppearance'});
    const item=name=>g.observation.inventory.find(i=>i.label.includes(name));
    for(const [name,appearance] of [['icon-shield','wooden shield'],['icon-mace','mace'],['icon-chest','chest']])
      assert.equal(item(name).known.appearance,appearance);
    const gloves=item('icon-gloves');
    assert.match(gloves.known.appearance,/gloves|gauntlets/);
    assert.equal(gloves.known.identity,undefined);
    assert.equal(gloves.known.enchantment,undefined);
    assert.ok(!gloves.known.appearance.includes('icon-gloves'));
    const before=await g.observe();assert.deepEqual(await g.observe(),before);
    g=await resume(api,g);assert.deepEqual(item('icon-gloves').known,gloves.known);
  });
  await t.test('known properties and menu-equivalent spell/skill information are pure; hidden charges and curses remain absent',async t=>{
    const {api}=await fixture(t);const a=await api.create({...identity,name:'KnowledgeA'}),b=await api.create({...identity,name:'KnowledgeB'});
    const unknown=g=>g.observation.inventory.find(i=>i.label.includes('unknown-wand'));
    assert.deepEqual(unknown(a).known,{appearance:'marble'});assert.deepEqual(unknown(a),unknown(b));
    const known=a.observation.inventory.find(i=>i.label.includes('warning-wand'));
    assert.equal(known.known.charges,3);assert.equal(known.known.beatitude,'uncursed');
    assert.ok(a.observation.knowledge.spells.length>0);assert.ok(a.observation.knowledge.skills.length>0);
    assert.ok(a.observation.knowledge.spells.every(s=>Number.isInteger(s.failurePercent)&&typeof s.retention==='string'));
    assert.ok(a.observation.knowledge.skills.some(s=>s.name==='dagger'&&s.advancement==='available'));
    assert.ok(a.observation.knowledge.achievements.some(a=>a.name.startsWith('attained the rank of ')));
    const before=await a.observe();for(let i=0;i<5;i++)assert.deepEqual(await a.observe(),before);
    assert.equal(a.observation.knowledge.observedTurn,a.observation.turn);
    assert.ok(!JSON.stringify(a.observation.knowledge).includes('nutrition'));
  });
  await t.test('cast spell choice and target survive resume; a real cast spends engine time',async t=>{
    const {api,transport}=await fixture(t);let g=await api.create(identity);
    await g.cast();assert.equal(g.decision?.kind,'choice');g=await resume(api,g);
    const cast=await choose(g,'force bolt');assert.equal(cast.decision?.kind,'target');g=await resume(api,g);
    const request={version:1,method:'decision.answer',params:{sessionId:g.id,requestId:'cast-up',expectedRevision:g.state.revision,decisionId:g.decision.id,answer:{kind:'target',target:{direction:'up'}}}};
    const result=await transport.send(request);assert.equal(result.error,undefined);assert.equal(result.decision,null);assert.ok(result.outcome.turnsElapsed>0);assert.deepEqual(await transport.send(request),result);
  });
  await t.test('earned skill advancement changes the actual engine rank and survives resume',async t=>{
    const {api}=await fixture(t);let g=await api.create(identity);await g.enhance();g=await resume(api,g);const r=await choose(g,'dagger');assert.equal(r.outcome.turnsElapsed,0);assert.equal(g.observation.knowledge.skills.find(s=>s.name==='dagger').level,'Skilled');
  });
  await t.test('wand breaking warning is cancellable and an initial item cannot answer the next item choice',async t=>{
    const {api}=await fixture(t);let g=await api.create(identity);const wand=named(g,'warning-wand');await g.apply(wand);assert.equal(g.decision?.kind,'confirmation');assert.match(g.decision.about,/break/);g=await resume(api,g);const r=await g.cancel(g.decision.id);assert.equal(r.outcome.turnsElapsed,0);assert.ok(g.observation.inventory.some(i=>i.id===wand.id));
    await g.apply(named(g,'writing-marker'));assert.equal(g.decision?.kind,'item');assert.match(g.decision.about,/write on/);g=await resume(api,g);await g.answer(g.decision.id,{kind:'item',item:named(g,'blank-paper')});assert.equal(g.decision?.kind,'text');await g.cancel(g.decision.id);
  });
  await t.test('dip selects its second item separately and rub/invoke execute distinct commands',async t=>{
    const {api}=await fixture(t);let g=await api.create(identity);await g.dip(named(g,'selected-daggers'));assert.equal(g.decision?.kind,'item');g=await resume(api,g);const namedWater=await g.answer(g.decision.id,{kind:'item',item:named(g,'water-stack')});assert.equal(namedWater.error,undefined);assert.equal(namedWater.decision.kind,'text');g=await resume(api,g);const r=await g.answer(g.decision.id,{kind:'text',text:'rust water'});assert.ok(r.outcome.turnsElapsed>0);assert.equal(r.decision,null);
    const rub=await g.rub(named(g,'ordinary-lamp'));assert.equal(rub.decision,null);assert.equal(rub.outcome.action,'rub');
    const invoke=await g.invoke(named(g,'ordinary-lamp'));assert.equal(invoke.decision,null);assert.equal(invoke.outcome.action,'invoke');
  });
  await t.test('engraving explicitly selects hands and text, then requires separate consent to append',async t=>{
    const {api}=await fixture(t);let g=await api.create(identity);await g.engrave();assert.equal(g.decision?.kind,'item');g=await resume(api,g);await g.answer(g.decision.id,{kind:'item',item:{id:'hands'}});assert.equal(g.decision?.kind,'text');const r=await g.answer(g.decision.id,{kind:'text',text:'A visitor was here'});assert.ok(r.outcome.turnsElapsed>0);assert.equal(r.decision,null);
    await g.engrave();await g.answer(g.decision.id,{kind:'item',item:{id:'hands'}});assert.equal(g.decision?.kind,'confirmation');await g.cancel(g.decision.id);
  });
  await t.test('quiver, fire, swapping and two-weapon controls preserve genuine item/target choices',async t=>{
    const {api}=await fixture(t);const g=await api.create(identity);const daggers=named(g,'selected-daggers');await g.quiver(daggers);assert.ok(g.observation.inventory.find(i=>i.id===daggers.id).usage.includes('quivered'));assert.deepEqual(g.observation.inventory.find(i=>i.id===daggers.id).equipmentSlots,['quiver']);
    await g.fire();assert.equal(g.decision?.kind,'target');await g.cancel(g.decision.id);
    const count=g.observation.inventory.find(i=>i.id===daggers.id).quantity;const fired=await g.fire({direction:'down'});assert.equal(fired.decision,null);assert.ok(fired.outcome.turnsElapsed>0);assert.equal(g.observation.inventory.find(i=>i.id===daggers.id).quantity,count-1);
    await g.quiver();assert.equal(g.decision?.kind,'item');await g.answer(g.decision.id,{kind:'item',item:{id:'hands'}});assert.ok(!g.observation.inventory.some(i=>i.usage.includes('quivered')));assert.ok(!g.observation.inventory.some(i=>i.equipmentSlots.includes('quiver')));
    await g.fire();assert.equal(g.decision?.kind,'item');await g.cancel(g.decision.id);
    assert.equal((await g.swap()).decision,null);assert.equal((await g.twoWeapon()).decision,null);
  });
  await t.test('nearby danger interrupts real engraving without restarting the occupation on observe, retry or resume',async t=>{
    const {api,transport}=await fixture(t);let g=await api.create({...identity,name:'EngraveInterrupted'});
    await g.engrave();await g.answer(g.decision.id,{kind:'item',item:{id:'hands'}});
    const request={version:1,method:'decision.answer',params:{sessionId:g.id,requestId:'interrupted-writing',expectedRevision:g.state.revision,decisionId:g.decision.id,answer:{kind:'text',text:'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz'}}};
    const r=await transport.send(request);assert.equal(r.decision,null);assert.equal(r.outcome.status,'interrupted');assert.ok(r.outcome.turnsElapsed>0&&r.outcome.turnsElapsed<8);
    assert.deepEqual(await transport.send(request),r);await g.observe();const turn=g.observation.turn;g=await resume(api,g);assert.equal(g.observation.turn,turn);assert.equal(g.decision,null);
  });
  await t.test('forced attack remains in place; no-fight movement executes one ordinary step',async t=>{
    const {api}=await fixture(t);const g=await api.create(identity),p=g.observation.you;
    const attack=await g.attack('east');assert.deepEqual(attack.observation.you,p);assert.ok(attack.outcome.turnsElapsed>0);
    const moved=await g.moveWithoutAttack('west');assert.deepEqual(moved.observation.you,{x:p.x-1,y:p.y});assert.equal(moved.outcome.turnsElapsed,1);
  });
  await t.test('refused attempts and cancelled spell selection preserve costs without choosing substitutes',async t=>{
    const {api}=await fixture(t);const g=await api.create(identity),dagger=named(g,'selected-daggers');
    const self=await g.throw(dagger,'self');assert.equal(self.decision,null);assert.equal(self.outcome.turnsElapsed,0);assert.match(self.observation.heard.join('\n'),/yourself/);
    const pay=await g.pay();assert.equal(pay.decision,null);assert.equal(pay.outcome.turnsElapsed,0);
    const chat=await g.chat('west');assert.equal(chat.decision,null);assert.equal(chat.outcome.turnsElapsed,0);
    await g.cast();assert.equal(g.decision?.kind,'choice');assert.equal((await g.cancel(g.decision.id)).outcome.turnsElapsed,0);
    const warrior=await api.create({...identity,role:'barbarian'});const none=await warrior.cast();assert.equal(none.decision,null);assert.equal(none.outcome.turnsElapsed,0);assert.match(none.observation.heard.join('\n'),/any spells/);
  });
  await t.test('invocation fixture: explicit candle attachment, lighting, bell and Book create the real invocation area',async t=>{
    const {api}=await fixture(t);const g=await api.create({...identity,name:'Ritual'});
    await g.apply(named(g,'ritual-candles'));assert.equal(g.decision?.kind,'confirmation');await g.answer(g.decision.id,{kind:'confirmation',confirm:true});
    assert.equal((await g.apply(named(g,'ritual-candelabrum'))).decision,null);
    assert.equal((await g.apply(named(g,'ritual-bell'))).decision,null);
    const r=await g.read(named(g,'ritual-book'));assert.equal(r.decision,null);
    assert.ok(r.observation.knowledge.achievements.some(a=>a.name==='performed the invocation'),JSON.stringify(r.observation.heard));
    assert.ok(r.observation.world.some(c=>c.x===r.observation.you.x&&c.y===r.observation.you.y&&c.terrain.type==='stairsDown'));
  });
  await t.test('commerce executes actual shop chat and pays a real engine debt',async t=>{
    const {api}=await fixture(t);const g=await api.create({...identity,name:'Commerce'});const before=Number(g.observation.vitals.gold);
    const chat=await g.chat('east');assert.equal(chat.decision,null);
    const paid=await g.pay();assert.equal(paid.decision,null);assert.equal(paid.error,undefined);assert.equal(Number(paid.observation.vitals.gold),before-25);
  });
  await t.test('itemized payment retains explicit bill selection across resume and cancellation',async t=>{
    const {api}=await fixture(t);let g=await api.create({...identity,name:'CommerceBill'});const gold=Number(g.observation.vitals.gold);
    await g.pay();assert.equal(g.decision?.kind,'choice');assert.match(g.decision.about,/Pay for which items/);
    g=await resume(api,g);await g.cancel(g.decision.id);assert.equal(Number(g.observation.vitals.gold),gold);
    await g.pay();g=await resume(api,g);const scroll=g.decision.options.find(o=>o.label.includes('billed-scroll'));assert.ok(scroll);
    await g.answer(g.decision.id,{kind:'choice',choose:[scroll.id]});assert.equal(g.decision,null);assert.ok(Number(g.observation.vitals.gold)<gold&&Number(g.observation.vitals.gold)>gold-120);
    assert.ok(g.observation.inventory.find(i=>i.label.includes('billed-gem')).label.includes('unpaid'));assert.ok(!g.observation.inventory.find(i=>i.label.includes('billed-scroll')).label.includes('unpaid'));
  });
  await t.test('recognized accessory exceptions can be worn and removed; empty hands remain an explicit wield choice',async t=>{
    const {api}=await fixture(t);let g=await api.create(identity);const towel=named(g,'wearable-towel');
    await g.equip(towel);assert.ok(g.observation.inventory.find(i=>i.id===towel.id).usage.includes('worn'));
    g=await resume(api,g);await g.remove(towel);assert.ok(!g.observation.inventory.find(i=>i.id===towel.id).usage.includes('worn'));
    await g.wield();assert.equal(g.decision?.kind,'item');await g.answer(g.decision.id,{kind:'item',item:{id:'hands'}});
    assert.ok(!g.observation.inventory.some(i=>i.usage.includes('wielded')));
    await g.equip(named(g,'wearable-meat'));if(g.decision){assert.equal(g.decision.kind,'choice');await g.answer(g.decision.id,{kind:'choice',choose:[g.decision.options[0].id]});}
    assert.ok(g.observation.inventory.find(i=>i.label.includes('wearable-meat')).usage.includes('worn'));
    const shirt=await g.read(named(g,'readable-shirt'));assert.equal(shirt.decision,null);assert.equal(shirt.error,undefined);assert.ok(shirt.observation.heard.some(s=>/shirt|read/.test(s)));
  });
  await t.test('a perceived metallivorous polymorph can actually eat a non-food item',async t=>{
    const {api}=await fixture(t);const g=await api.create({...identity,name:'Diet'}),daggers=named(g,'selected-daggers');
    const before=g.observation.inventory.find(i=>i.id===daggers.id).quantity;
    const eaten=await g.eat(daggers);assert.equal(eaten.error,undefined);assert.equal(eaten.decision,null);assert.ok(eaten.outcome.turnsElapsed>0);
    assert.equal(g.observation.inventory.find(i=>i.id===daggers.id)?.quantity,before-1);
  });
  await t.test('duplicate private inventory slots cannot substitute a different bound object',async t=>{
    const {api}=await fixture(t);const g=await api.create({...identity,name:'DuplicateSlots'}),wanted=named(g,'warning-wand'),other=named(g,'unknown-wand');
    await g.drop(wanted);assert.ok(!g.observation.inventory.some(i=>i.id===wanted.id));assert.ok(g.observation.inventory.some(i=>i.id===other.id));
    assert.ok(g.observation.here.items.some(i=>i.label.includes('warning-wand')));
  });
  await t.test('artifact invocation changes real levitation and two-weapon mode uses explicitly prepared slots',async t=>{
    const {api}=await fixture(t);const g=await api.create({...identity,name:'Artifact',role:'barbarian'});
    const stone=g.observation.inventory.find(i=>i.label.includes('Heart of Ahriman'));assert.ok(stone);
    const invoked=await g.invoke({id:stone.id});assert.equal(invoked.decision,null);assert.match(invoked.observation.heard.join('\n'),/float/);
    await g.wield(named(g,'selected-daggers'));await g.swap();await g.wield(named(g,'warning-wand'));
    /* Non-weapons are an engine refusal, without automatic substitution. */
    const refused=await g.twoWeapon();assert.equal(refused.decision,null);assert.ok(!g.observation.inventory.some(i=>i.usage.includes('offhand')));
    await g.wield(named(g,'other-weapon'));const enabled=await g.twoWeapon();assert.equal(enabled.decision,null);
    assert.ok(g.observation.inventory.some(i=>i.usage.includes('offhand')));assert.deepEqual(g.observation.inventory.find(i=>i.usage.includes('offhand')).equipmentSlots,['offhand']);
    await g.twoWeapon();assert.ok(!g.observation.inventory.some(i=>i.usage.includes('offhand')));assert.ok(!g.observation.inventory.some(i=>i.equipmentSlots.includes('offhand')));assert.ok(g.observation.inventory.some(i=>i.equipmentSlots.includes('alternateWeapon')));
  });
}
