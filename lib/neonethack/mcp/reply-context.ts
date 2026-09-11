import type {CellActions, Snapshot} from '../typescript/types.js';
import {methods} from './agent-data.js';

/** Syntax derived from actual C offers; an attempt is not a safety promise. */
export function attemptsFor(cell:CellActions,sessionId:string) {
  return cell.actions.flatMap(offer=>{
    if(!('arguments' in offer))return [];
    const tool=offer.method==='game.move'?'go':methods.find(m=>m.method===offer.method)?.name;
    if(!tool)return [];
    const args=offer.method==='game.move'?{to:{x:cell.x,y:cell.y},force:true}:offer.arguments;
    return [{tool,arguments:{sessionId,...args},availability:offer.availability,cost:offer.cost,...('cautions' in offer?{cautions:offer.cautions}:{})}];
  });
}
export function actionMessages(frame:Snapshot) {
  return frame.events.flatMap(event=>(event.type==='heard'||event.type==='passage') && typeof event.text==='string' && event.text.trim()
    ? [{turn:frame.observation.turn,text:event.text}] : []);
}
export function stateSummary(frame:Snapshot) {
  return {revision:frame.revision,turn:frame.observation.turn,position:frame.observation.you??null,location:frame.observation.location,vitals:frame.observation.vitals};
}
export function nearbyContext(frame:Snapshot) {
  const neighborhood=frame.observation.neighborhood;
  if(neighborhood?.status!=='available')return {status:'unavailable',reason:neighborhood?.reason??'unavailable'};
  return {status:'available',inputGate:neighborhood.inputGate,cells:neighborhood.cells.filter(cell=>cell.inBounds&&Math.abs(cell.dx)<=1&&Math.abs(cell.dy)<=1).map(cell=>({
    position:{x:cell.x,y:cell.y},terrain:cell.terrain,movement:cell.movement,
    ...(cell.occupant?{occupant:cell.occupant}:{}),...(cell.hazards?.length?{hazards:cell.hazards}:{}),
    attempts:attemptsFor(cell,frame.sessionId),
  }))};
}
/** Keep the next decision's essentials ahead of the complete observation. */
export function orderedReply(reply:Record<string,unknown>):Record<string,unknown> {
  const first:Record<string,unknown>={};
  for(const key of ['summary','error','state','messages','messageScope','navigation','decision','reply','cancel','context'])if(Object.hasOwn(reply,key))first[key]=reply[key];
  return {...first,...reply};
}
