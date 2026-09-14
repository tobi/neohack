import type {Snapshot,ItemRef} from '../typescript/types.js';
import {viewId} from './frame.js';
import {offeredCall} from './reply-context.js';

/** Only C-supplied candidate actions are item affordances. Labels and categories
 * never choose an operation or reveal an unidentified item's capabilities. */
export function itemActions(snapshot:Snapshot,itemId?:string):Record<string,unknown> {
  const o=snapshot.observation,basis={sessionId:snapshot.sessionId,viewId:viewId(snapshot)};
  const seen=[...o.inventory,...o.here.items];
  const selected=itemId?seen.filter(item=>item.id===itemId):seen;
  const describe=(item:ItemRef)=>{
    const freshness=item.location==='inventory'?o.perception.inventory:o.perception.here;
    const available=freshness==='current'&&item.actions!==undefined;
    return {itemId:item.id,label:item.label,location:item.location,status:available?'available':'unavailable',freshness,
      ...(available?{attempts:item.actions!.flatMap(action=>{
        const call=offeredCall(`game.${action}`,{...basis,itemId:item.id});
        return call?[{...call,availability:'attempt',instruction:'An eligible attempt is not a safety or success guarantee.'}]:[];
      })}:{})};
  };
  if(itemId&&selected.length!==1)return {kind:'itemActions',status:selected.length?'ambiguousItem':[o.perception.inventory,o.perception.here].every(f=>f==='current')?'itemNotFound':'unavailable',itemId,candidates:selected.map(item=>({itemId:item.id,label:item.label,location:item.location}))};
  const items=selected.map(describe);
  const freshness=[o.perception.inventory,o.perception.here];
  const status=itemId?(items[0]?.status??'unavailable'):freshness.every(f=>f==='current')?'available':freshness.some(f=>f==='current')?'partial':'unavailable';
  return {kind:'itemActions',status,perception:{inventory:o.perception.inventory,here:o.perception.here},items,
    ...(!itemId?{generalAttempts:['cast','fire','engrave'].map(action=>offeredCall(`game.${action}`,basis)),
      spells:o.perception.knowledge==='current'&&o.knowledge?{status:'available',values:o.knowledge.spells,instruction:'use action cast starts the engine spell decision. Select the exact returned choice through respond; these knowledge IDs are not decision IDs.'}:{status:'unavailable'}}:{})};
}
