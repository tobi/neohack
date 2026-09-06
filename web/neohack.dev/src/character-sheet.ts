import type { EquipmentSlot, ItemRef, Observation } from 'neonethack/types';
import { inventoryArt } from './symbol-art';

export const slotLabels: Record<EquipmentSlot, string> = {
  bodyArmor:'Body armor', cloak:'Cloak', helmet:'Head', shield:'Shield',
  gloves:'Hands', boots:'Feet', shirt:'Underlayer', amulet:'Amulet',
  leftRing:'Left ring', rightRing:'Right ring', eyewear:'Eyewear',
  weapon:'Main hand', offhand:'Off hand', alternateWeapon:'Alternate weapon',
  quiver:'Quiver', skin:'Merged skin', ball:'Attached ball', chain:'Attached chain',
};
const worn: EquipmentSlot[] = ['helmet','eyewear','amulet','cloak','bodyArmor','shirt','gloves','leftRing','rightRing','boots','shield','skin'];
const ready: EquipmentSlot[] = ['weapon','offhand','alternateWeapon','quiver','ball','chain'];
export function equipmentDescription(item: ItemRef) {
  return item.equipmentSlots?.length ? item.equipmentSlots.map(slot=>slotLabels[slot]).join(' · ') : item.equipmentSlots ? 'Carried' : 'Assignment unknown';
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const el=document.createElement(tag);el.className=className;if(text!==undefined)el.textContent=text;return el;
}

export function renderCharacterSheet(o: Observation, options: {
  name:string; role:string; portrait:string; view:'equipment'|'bag';
  selectView(view:'equipment'|'bag'):void;
  inspect(item:ItemRef):void; actions(host:HTMLElement,item:ItemRef):void;
}) {
  const root=element('div','character-sheet');root.dataset.sheetView=options.view;
  const banner=element('header','sheet-hero');
  const portrait=element('img','sheet-portrait');portrait.src=options.portrait;portrait.alt='';
  const identity=element('div','sheet-identity');identity.append(element('p','sheet-eyebrow',options.role),element('h3','',options.name));
  const conditions=[o.vitals.hungerLabel,o.vitals.burdenLabel,...(Array.isArray(o.vitals.condition)?o.vitals.condition:[o.vitals.condition])].filter(Boolean).join(' · ');
  identity.append(element('p','sheet-condition',conditions || o.location.depthLabel));banner.append(portrait,identity);
  const stats=element('dl','sheet-stats');
  for(const [label,value] of [['Health',`${o.vitals.health??'?'} / ${o.vitals.maxHealth??'?'}`],['Energy',`${o.vitals.energy??'?'} / ${o.vitals.maxEnergy??'?'}`],['Armor class',o.vitals.armor??'?'],['Level',o.vitals.level??'?'],['Strength',o.vitals.strength??'?'],['Gold',o.vitals.gold??'?']]) {
    const stat=element('div','');stat.append(element('dt','',String(label)),element('dd','',String(value)));stats.append(stat);
  }
  root.append(banner,stats);
  const attributes=element('details','sheet-attributes');attributes.append(element('summary','','Attributes & alignment'));
  const values=element('dl','sheet-stats');
  for(const [key,label] of [['strength','Strength'],['dexterity','Dexterity'],['constitution','Constitution'],['intelligence','Intelligence'],['wisdom','Wisdom'],['charisma','Charisma']] as const) {
    const value=element('div','');value.append(element('dt','',label),element('dd','',String(o.vitals[key]??'?')));values.append(value);
  }
  attributes.append(values,element('p','sheet-condition','Alignment · '+String(o.vitals.alignment??'Unknown')));root.append(attributes);
  const tabs=element('nav','sheet-tabs');tabs.setAttribute('aria-label','Character sheet sections');
  for(const [view,label] of [['equipment','Equipment'],['bag','Backpack']] as const) {
    const b=element('button','',label);b.type='button';b.setAttribute('aria-pressed',String(options.view===view));b.setAttribute('aria-controls',`sheet-${view}`);
    b.onclick=()=>{root.dataset.sheetView=view;options.selectView(view);for(const button of tabs.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button===b));};tabs.append(b);
  }
  root.append(tabs);
  const layout=element('div','sheet-columns');root.append(layout);
  const equipment=element('section','sheet-equipment');equipment.id='sheet-equipment';equipment.setAttribute('aria-label','Equipped and ready');
  const bag=element('section','sheet-bag');bag.id='sheet-bag';bag.setAttribute('aria-label','Backpack contents');layout.append(equipment,bag);
  const equipped=o.inventory.filter(i=>i.equipmentSlots?.length);
  const carried=o.inventory.filter(i=>!i.equipmentSlots?.length);
  const complete=o.inventoryKnown&&o.perception.inventory==='current'&&o.perception.equipment==='current'&&o.inventory.every(i=>i.equipmentSlots!==undefined);
  if(!complete)root.insertBefore(element('p','sheet-notice',o.perception.equipment==='lastKnown'?'Last known equipment. These assignments may have changed.':'Equipment assignments are not fully known.'),layout);
  if(o.perception.inventory!=='current')bag.append(element('p','sheet-notice',o.perception.inventory==='lastKnown'?'Last known possessions. Current contents are unavailable.':'Your possessions are not currently known.'));
  function row(item:ItemRef) {
    const entry=element('div','inventory-entry');entry.dataset.itemId=item.id;
    const button=element('button','item-row');button.type='button';button.onclick=()=>options.inspect(item);
    const icon=element('span','item-icon');icon.setAttribute('aria-hidden','true');const image=element('img','');image.src=inventoryArt(item);image.alt='';icon.append(image);
    const copy=element('span','item-copy');copy.append(element('small','equipment-assignment',equipmentDescription(item)),element('span','',item.label));
    if(item.known?.beatitude==='cursed')copy.append(element('small','known-curse','Known cursed'));
    const quantity=element('span','item-quantity',item.quantity>1?String(item.quantity):'');
    button.append(icon,copy,quantity);entry.append(button);
    const actions=element('div','inventory-actions');options.actions(actions,item);entry.append(actions);return entry;
  }
  const shown=new Set<string>();
  for(const [label,slots] of [['Worn',worn],['In hand & ready',ready]] as const) {
    const section=element('div','equipment-group');section.append(element('h4','sheet-section-heading',label));
    const items=equipped.filter(item=>!shown.has(item.id)&&item.equipmentSlots!.some(slot=>slots.includes(slot))).sort((a,b)=>Math.min(...a.equipmentSlots!.map(s=>slots.indexOf(s)).filter(n=>n>=0))-Math.min(...b.equipmentSlots!.map(s=>slots.indexOf(s)).filter(n=>n>=0)));
    for(const item of items){shown.add(item.id);section.append(row(item));}
    if(!items.length)section.append(element('p','sheet-empty',complete?'Nothing assigned':'No assignments known'));
    equipment.append(section);
  }
  const vacant=Object.keys(slotLabels).filter(slot=>!['skin','ball','chain'].includes(slot)&&!equipped.some(i=>i.equipmentSlots!.includes(slot as EquipmentSlot)));
  if(vacant.length) {
    const details=element('details','sheet-vacancies');details.append(element('summary','',complete?`${vacant.length} unoccupied slots`:'Other slots · unknown'));
    const list=element('ul','');for(const slot of vacant)list.append(element('li','',slotLabels[slot as EquipmentSlot]));details.append(list);equipment.append(details);
  }
  bag.append(element('h4','sheet-section-heading',`Carried items${o.inventoryKnown?' · '+carried.length:''}`));
  for(const item of carried)bag.append(row(item));
  if(!carried.length)bag.append(element('p','sheet-empty',complete?(o.inventory.length?'Everything you carry is assigned above.':'Your backpack is empty.'):'No unassigned possessions known.'));
  return root;
}
