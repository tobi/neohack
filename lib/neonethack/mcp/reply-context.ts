import type {CellActions, Snapshot} from '../typescript/types.js';
import {markAt} from './map.js';
import {methods} from './agent-data.js';

/** Syntax derived from actual C offers; an attempt is not a safety promise. */
export function attemptsFor(cell:CellActions,sessionId:string) {
  return cell.actions.flatMap(offer=>{
    if(!('arguments' in offer))return [];
    // go {direction} is one ordinary step; it never attacks a displayed creature.
    if(offer.method==='game.move'&&cell.occupant&&cell.occupant.kind==='creature')return [];
    const tool=offer.method==='game.move'?'go':methods.find(m=>m.method===offer.method)?.name;
    if(!tool)return [];
    return [{tool,arguments:{sessionId,...offer.arguments},availability:offer.availability,cost:offer.cost,...('cautions' in offer?{cautions:offer.cautions}:{})}];
  });
}
export function actionMessages(frame:Snapshot) {
  return frame.events.flatMap(event=>(event.type==='heard'||event.type==='passage') && typeof event.text==='string' && event.text.trim()
    ? [{turn:frame.observation.turn,text:event.text}] : []);
}
export function stateSummary(frame:Snapshot) {
  return {revision:frame.revision,turn:frame.observation.turn,position:frame.observation.you??null,location:frame.observation.location,vitals:frame.observation.vitals};
}
const compassOf=(dx:number,dy:number)=>dx===0&&dy===0?'here':`${dy<0?'north':dy>0?'south':''}${dx<0?'west':dx>0?'east':''}`;
/** One line per adjacent square: perceived facts plus which tools the C
 * resolver offers there (tool → availability). Full executable syntax is the
 * inspect query's job; here `go` means go {direction}. */
export function nearbyContext(frame:Snapshot) {
  const neighborhood=frame.observation.neighborhood;
  if(neighborhood?.status!=='available')return {status:'unavailable',reason:neighborhood?.reason??'unavailable'};
  return {status:'available',inputGate:neighborhood.inputGate,cells:neighborhood.cells.filter(cell=>cell.inBounds&&Math.abs(cell.dx)<=1&&Math.abs(cell.dy)<=1).map(cell=>{
    const {relation,...movement}=cell.movement;
    const attempts:Record<string,string>={};
    for(const offer of cell.actions){
      if(!('arguments' in offer)||offer.availability==='knownBlocked')continue;
      if(offer.method==='game.move'&&cell.occupant&&cell.occupant.kind==='creature')continue;
      const tool=offer.method==='game.move'?'go':methods.find(m=>m.method===offer.method)?.name;
      if(tool)attempts[tool]=offer.availability;
    }
    const mark=markAt(frame.observation,cell.x,cell.y);
    return {
      direction:compassOf(cell.dx,cell.dy),position:{x:cell.x,y:cell.y},
      ...(cell.terrain?{terrain:cell.terrain.freshness==='current'?cell.terrain.type:`${cell.terrain.type} (${cell.terrain.freshness})`}:{}),
      ...(cell.door?{door:cell.door.lock}:{}),...(Object.keys(movement).length?{movement}:{}),
      ...(cell.occupant?{occupant:cell.occupant}:{}),...(cell.hazards?.length?{hazards:cell.hazards}:{}),
      attempts,...(mark!==undefined?{mark}:{}),
    };
  })};
}
/** Keep the next decision's essentials ahead of the complete observation. */
export function orderedReply(reply:Record<string,unknown>):Record<string,unknown> {
  const first:Record<string,unknown>={};
  for(const key of ['summary','error','state','messages','messageScope','navigation','decision','reply','cancel','map','context'])if(Object.hasOwn(reply,key))first[key]=reply[key];
  return {...first,...reply};
}
