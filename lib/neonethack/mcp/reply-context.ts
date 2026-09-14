import type {CellActions, Snapshot} from '../typescript/types.js';
import {markAt} from './map.js';
import {methods} from './agent-data.js';

/** Convert a concrete low offer into the one public family variant. */
export function offeredCall(method:string,input:Record<string,unknown>) {
  const mapped=method==='game.move'?'agent.step':method==='game.attack'?'agent.attack':method;
  const entry=methods.find(m=>m.method===mapped);
  if(!entry)return undefined;
  const args:Record<string,unknown>={...input,...entry.selector};
  if(['agent.step','agent.attack'].includes(mapped)&&'direction' in args){args.target={direction:args.direction};delete args.direction;}
  if('item' in args){const item=args.item as {id:string;quantity?:number};args.itemId=item.id;if(item.quantity!==undefined)args.quantity=item.quantity;delete args.item;}
  return {tool:entry.name,arguments:args};
}

/** Syntax derived from actual C offers; an attempt is not a safety promise. */
export function attemptsFor(cell:CellActions,sessionId:string,viewId?:string) {
  return cell.actions.flatMap(offer=>{
    if(!('arguments' in offer))return [];
    // Ordinary stepping never attacks a displayed creature.
    if(offer.method==='game.move'&&cell.occupant&&cell.occupant.kind==='creature')return [];
    const args:Record<string,unknown>={sessionId,...(viewId?{viewId}:{}),...offer.arguments};
    const call=offeredCall(offer.method,args);
    return call?[{...call,availability:offer.availability,cost:offer.cost,...('cautions' in offer?{cautions:offer.cautions}:{})}]:[];
  });
}
const compassOf=(dx:number,dy:number)=>dx===0&&dy===0?'self':`${dy<0?'north':dy>0?'south':''}${dx<0?'west':dx>0?'east':''}`;
/** One line per adjacent square: perceived facts plus which tools the C
 * resolver offers there (tool → availability). Full executable syntax is the
 * actionless interact query's job. Keys include the explicit variant. */
export function nearbyContext(frame:Snapshot) {
  const neighborhood=frame.observation.neighborhood;
  if(neighborhood?.status!=='available')return {status:'unavailable',reason:neighborhood?.reason??'unavailable'};
  return {status:'available',inputGate:neighborhood.inputGate,cells:neighborhood.cells.filter(cell=>cell.inBounds&&Math.abs(cell.dx)<=1&&Math.abs(cell.dy)<=1).map(cell=>{
    const {relation,...movement}=cell.movement;
    const attempts:Record<string,string>={};
    for(const offer of cell.actions){
      if(!('arguments' in offer)||offer.availability==='knownBlocked')continue;
      if(offer.method==='game.move'&&cell.occupant&&cell.occupant.kind==='creature')continue;
      const call=offeredCall(offer.method,{});
      if(call)attempts[`${call.tool}.${call.arguments.action??call.arguments.mode}`]=offer.availability;
    }
    const mark=markAt(frame.observation,cell.x,cell.y);
    return {
      direction:compassOf(cell.dx,cell.dy),position:{x:cell.x,y:cell.y},
      ...(cell.terrain?{terrain:cell.terrain}:{}),
      ...(cell.door?{door:cell.door.lock}:{}),...(Object.keys(movement).length?{movement}:{}),
      ...(cell.occupant?{occupant:cell.occupant}:{}),...(cell.objects?{objects:cell.objects}:{}),...(cell.hazards?.length?{hazards:cell.hazards}:{}),
      attempts,...(mark!==undefined?{mark}:{}),
    };
  })};
}
