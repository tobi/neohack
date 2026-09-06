import type { EquipmentSlot, ItemRef, Observation } from 'neonethack/types';
import { inventoryArt } from './symbol-art';

export const slotLabels: Record<EquipmentSlot, string> = {
  bodyArmor:'Body armor', cloak:'Cloak', helmet:'Head', shield:'Shield',
  gloves:'Hands', boots:'Feet', shirt:'Underlayer', amulet:'Amulet',
  leftRing:'Left ring', rightRing:'Right ring', eyewear:'Eyewear',
  weapon:'Main hand', offhand:'Off hand', alternateWeapon:'Alternate weapon',
  quiver:'Quiver', skin:'Merged skin', ball:'Attached ball', chain:'Attached chain',
};
const ready: EquipmentSlot[] = ['weapon','offhand','alternateWeapon','quiver','ball','chain'];
export function equipmentDescription(item: ItemRef) {
  return item.equipmentSlots?.length ? item.equipmentSlots.map(slot=>slotLabels[slot]).join(' · ') : item.equipmentSlots ? 'Carried' : 'Assignment unknown';
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const el=document.createElement(tag);el.className=className;if(text!==undefined)el.textContent=text;return el;
}

export function renderCharacterSheet(o: Observation, options: {
  name:string; role:string; portrait:string;
  equip(item:ItemRef, action:'equip'|'wield'|'quiver'):void;
  inspect(item:ItemRef):void; actions(host:HTMLElement,item:ItemRef):void;
}) {
  const root=element('div','character-sheet');
  const banner=element('header','sheet-hero');
  const portrait=element('img','sheet-portrait');portrait.src=options.portrait;portrait.alt='';
  const identity=element('div','sheet-identity');identity.append(element('p','sheet-eyebrow',options.role),element('h3','',options.name));
  const conditions=[o.vitals.hungerLabel,o.vitals.burdenLabel,...(Array.isArray(o.vitals.condition)?o.vitals.condition:[o.vitals.condition])].filter(Boolean).join(' · ');
  identity.append(element('p','sheet-depth','lvl: '+o.location.depthLabel.replace(/^Dlvl:/,'')));
  if(conditions)identity.append(element('p','sheet-condition',conditions));banner.append(portrait,identity);
  const stats=element('dl','sheet-stats');
  for(const [label,value] of [['Health',`${o.vitals.health??'?'} / ${o.vitals.maxHealth??'?'}`],['Energy',`${o.vitals.energy??'?'} / ${o.vitals.maxEnergy??'?'}`],['Armor class',o.vitals.armor??'?'],['Level',o.vitals.level??'?'],['Strength',o.vitals.strength??'?'],['Gold',o.vitals.gold??'?']]) {
    const stat=element('div','');stat.append(element('dt','',String(label)),element('dd','',String(value)));stats.append(stat);
  }
  identity.append(stats);root.append(banner);
  const attributes=element('details','sheet-attributes');attributes.append(element('summary','','Attributes & alignment'));
  const values=element('dl','sheet-stats');
  for(const [key,label] of [['strength','Strength'],['dexterity','Dexterity'],['constitution','Constitution'],['intelligence','Intelligence'],['wisdom','Wisdom'],['charisma','Charisma']] as const) {
    const value=element('div','');value.append(element('dt','',label),element('dd','',String(o.vitals[key]??'?')));values.append(value);
  }
  attributes.append(values,element('p','sheet-condition','Alignment · '+String(o.vitals.alignment??'Unknown')));root.append(attributes);
  const layout=element('div','sheet-columns');root.append(layout);
  const equipment=element('section','sheet-equipment');equipment.id='sheet-equipment';equipment.setAttribute('aria-label','Equipped and ready');
  const bag=element('section','sheet-bag');bag.id='sheet-bag';bag.setAttribute('aria-label','Backpack contents');layout.append(equipment,bag);
  const equipped=o.inventory.filter(i=>i.equipmentSlots?.length);
  const complete=o.inventoryKnown&&o.perception.inventory==='current'&&o.perception.equipment==='current'&&o.inventory.every(i=>i.equipmentSlots!==undefined);
  if(!complete)root.insertBefore(element('p','sheet-notice',o.perception.equipment==='lastKnown'?'Last known equipment. These assignments may have changed.':'Equipment assignments are not fully known.'),layout);
  if(o.perception.inventory!=='current')bag.append(element('p','sheet-notice',o.perception.inventory==='lastKnown'?'Last known possessions. Current contents are unavailable.':'Your possessions are not currently known.'));
  function row(item:ItemRef) {
    const entry=element('div','inventory-entry');entry.dataset.itemId=item.id;entry.draggable=complete;
    entry.ondragstart=event=>{if(!complete||!event.dataTransfer){event.preventDefault();return;}event.dataTransfer.setData('application/x-neohack-item',item.id);event.dataTransfer.effectAllowed='move';root.classList.add('sheet-dragging');};
    entry.ondragend=()=>root.classList.remove('sheet-dragging');
    const button=element('button','item-row');button.type='button';button.draggable=complete;button.ondragstart=entry.ondragstart;button.onclick=()=>options.inspect(item);
    const icon=element('span','item-icon');icon.setAttribute('aria-hidden','true');const image=element('img','');image.src=inventoryArt(item);image.alt='';image.draggable=false;icon.append(image);
    const copy=element('span','item-copy');copy.append(element('small','equipment-assignment',equipmentDescription(item)),element('span','',item.label));
    if(item.known?.beatitude==='cursed')copy.append(element('small','known-curse','Known cursed'));
    const quantity=element('span','item-quantity',item.quantity>1?String(item.quantity):'');
    button.append(icon,copy,quantity);entry.append(button);
    const actions=element('div','inventory-actions');options.actions(actions,item);entry.append(actions);return entry;
  }
  equipment.append(element('h4','sheet-section-heading','Equipment'));
  const board=element('div','equipment-board');
  const figure=element('img','equipment-figure');figure.src=options.portrait;figure.alt='';board.append(figure);
  const slots:EquipmentSlot[]=['helmet','amulet','eyewear','cloak','bodyArmor','shirt','weapon','gloves','shield','leftRing','boots','rightRing','offhand','alternateWeapon','quiver'];
  const feedback=element('p','sheet-equip-feedback','Drag an item onto equipment to wear or wield it. You can also use its action buttons.');feedback.setAttribute('role','status');
  for(const slot of slots) {
    const tile=element('div','equipment-slot');tile.dataset.slot=slot;
    const assigned=equipped.filter(item=>item.equipmentSlots!.includes(slot));
    tile.append(element('span','slot-label',slotLabels[slot]));
    for(const item of assigned) {
      const button=element('button','slot-item');button.type='button';button.title=item.label;button.setAttribute('aria-label',slotLabels[slot]+': '+item.label);button.onclick=()=>options.inspect(item);
      const icon=element('img','');icon.src=inventoryArt(item);icon.alt='';button.append(icon,element('span','slot-item-name',item.label));tile.append(button);
    }
    if(!assigned.length)tile.append(element('span','slot-empty',complete?'—':'?'));
    const operation=slot==='weapon'?'wield':slot==='quiver'?'quiver':ready.includes(slot)?null:'equip';
    tile.ondragover=event=>{if(complete&&operation&&event.dataTransfer?.types.includes('application/x-neohack-item')){event.preventDefault();event.dataTransfer.dropEffect='move';tile.classList.add('drop-target');}};
    tile.ondragleave=()=>tile.classList.remove('drop-target');
    tile.ondrop=event=>{
      event.preventDefault();tile.classList.remove('drop-target');root.classList.remove('sheet-dragging');
      const item=o.inventory.find(item=>item.id===event.dataTransfer?.getData('application/x-neohack-item'));
      if(!complete||!operation||!item)return;
      if(!item.actions?.includes(operation)){feedback.textContent='That item cannot use this equipment action right now.';return;}
      // Slots display actual assignments. The public equip operation owns the
      // destination and any ring-side/occupied-layer decision; never infer it.
      feedback.textContent='Requesting '+(operation==='equip'?'Wear':operation==='wield'?'Wield':'Ready')+' · '+item.label;
      options.equip(item,operation);
    };
    board.append(tile);
  }
  equipment.append(board,feedback);
  const attached=equipped.filter(item=>item.equipmentSlots!.some(slot=>['skin','ball','chain'].includes(slot)));
  for(const item of attached)equipment.append(element('p','sheet-condition',equipmentDescription(item)+' · '+item.label));
  bag.append(element('h4','sheet-section-heading',`Backpack${o.inventoryKnown?' · '+o.inventory.length:''}`));
  for(const item of o.inventory)bag.append(row(item));
  if(!o.inventory.length)bag.append(element('p','sheet-empty',complete?'Your backpack is empty.':'Your possessions are not currently known.'));
  return root;
}
