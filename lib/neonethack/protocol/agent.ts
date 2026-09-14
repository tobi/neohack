import {catalog, compass, position, type Schema} from './catalog.ts';
import {mcpResponseSchema} from './response.ts';
const point:Schema={type:'object',properties:{x:{type:'integer',minimum:1,maximum:79},y:{type:'integer',minimum:0,maximum:20}},required:['x','y'],additionalProperties:false};
const sid=catalog.methods.find(m=>m.name==='session.observe')!.schema.properties.sessionId;
const limit={type:'integer',minimum:1,maximum:1659};
const object=(properties:Record<string,Schema>,required=Object.keys(properties)):Schema=>({type:'object',properties,required,additionalProperties:false});
const viewId:Schema={type:'string',minLength:1,description:'Exact basis.viewId from the caller’s observed frame. Stale views reject without submitting input; never refresh silently.'};
const maxPlanningMs:Schema={type:'integer',minimum:0,maximum:2147483647,default:1000,description:'Planning budget in milliseconds (default 1000); zero stops before planning or input. Checked at safe query boundaries; does not cancel already submitted input.'};
const spatialTarget=(directions:Schema,scopes:string[]):Schema=>({oneOf:[
  object({direction:directions}),object({position:point}),
  object({ref:{type:'string',minLength:1,maxLength:128,description:'Exact perceived reference from the observed view.'}}),
  object({symbol:{type:'string',minLength:1,maxLength:1,pattern:'^[!-~]$'},scope:{type:'string',enum:scopes}}),
]});
const adjacentTarget=spatialTarget(compass,['adjacent']);
const inspectTarget=spatialTarget({type:'string',enum:['self',...compass.enum]},['adjacent','level']);
const rangedTarget=object({direction:{type:'string',enum:['self',...compass.enum,'up','down']}});
const itemId:Schema={type:'string',minLength:1,maxLength:64,description:'Exact opaque item id from inventory, here.items or the standing question.'};
const quantity:Schema={type:'integer',minimum:1,maximum:2147483647,description:'Explicit stack count; requires itemId.'};
const itemValue=object({itemId,quantity},['itemId']);
// Generated for the shared adapter: question syntax is presentation, not game logic.
export const agentAnswers:Record<string,{field:string;schema:Schema;instruction:string}>={
  confirmation:{field:'confirm',schema:{type:'boolean'},instruction:'true accepts; false declines. Choose explicitly.'},
  choice:{field:'choose',schema:{type:'array',minItems:0,maxItems:1024,uniqueItems:true,items:{oneOf:[{type:'integer',minimum:0,maximum:2147483647},{type:'string',minLength:1,maxLength:127}]}},instruction:'An array of returned option names or IDs. Select only the choices you intend; choose none with [] only when the standing valueSchema allows it.'},
  item:{field:'item',schema:itemValue,instruction:'An object with itemId from the returned candidates; quantity is optional.'},
  target:{field:'target',schema:{type:'string',enum:['self',...compass.enum,'up','down']},instruction:'One displayed target direction or self; engine restrictions still apply.'},
  position:{field:'position',schema:position,instruction:'A square {x,y}, a compass direction, finish or help.'},
  text:{field:'text',schema:{type:'string',minLength:0,maxLength:128},instruction:'Your text as a string, including an empty string when permitted.'},
};
export const agentInstructions='Use session {action:create|resume} once, then retain basis.sessionId and basis.viewId. Every reply is a version-2 DecisionFrame with basis, control.gate, outcome, perceived scene and fresh events. Ordinary replies already contain the next decision view. observe resynchronizes and verifies retained uncertain input without replay; observe {operationId} returns historical evidence under result only. use {itemId} and interact {target} WITHOUT action are free discovery, even when only one offer exists. They never execute, consume turns or randomness, or start engine questions. Returned offers provide exact executable tool arguments bound to the observed viewId. Supply action explicitly to attempt one; eligibility is not safety or guaranteed success. use without itemId lists perceived item offers and explicit general-use attempts; cast starts a genuine spell decision, never invents spell references. interact defaults to here/self for discovery; spatial targets are direction, position, ref, or symbol with scope. Symbols must match uniquely or return candidates without input. Item references are opaque; never infer identity from labels. travel mode step is one ordinary adjacent attempt including tame-ally swaps, refusing displayed non-allies. Modes to, explore and descend are bounded navigation legs over known walking routes; run and climb retain native semantics, with runMode selecting native run behavior. Planning defaults to 1000 ms; zero permits no planning or input. Mutating variants require the observed viewId except session create/resume/suspend and exact respond decisionId calls. A stale view rejects without retargeting. respond action answer uses the exact decision.reply.valueSchema; cancel only when offered. Never answer implicitly, repeat an uncertain action, or treat historical receipts as live questions. Queries preserve input authority and human focus. Scene snapshots are the default; includeWorld and sinceViewId only change encoding. Recovery and ownership loss block input. Terminal facts live in scene.end. session action quit asks to end a run; suspend only releases it. help lists these families or their strict variant schemas.';
const names:Record<string,string>={'session.observe':'syncState','session.actions':'inspect','session.close':'suspend','decision.answer':'answer','decision.cancel':'cancel'};
/** Low operations deliberately absent from the agent vocabulary, with the reason.
 * check:tools accepts these as intentionally uncovered; they stay available
 * through the low library, C API and NDJSON. */
export const agentOmitted:Record<string,string>={
  'game.moveWithoutAttack':'The m-prefixed native movement remains low-level only; travel mode step supplies ordinary movement with explicit displayed-creature guards and tame-ally swaps.',
};
const operations=catalog.methods.filter(m=>!['protocol.describe','game.move','game.attack','session.receipt',...Object.keys(agentOmitted)].includes(m.name)).map(m=>{
  const schema=structuredClone(m.schema);
  for(const field of ['requestId','expectedRevision']) {delete schema.properties[field];schema.required=schema.required.filter((k:string)=>k!==field);}
  if(!m.readOnly&&!['session.create','session.resume','session.close','decision.answer','decision.cancel'].includes(m.name)) {
    schema.properties.viewId=viewId;
    schema.required.push('viewId');
  }
  if(['game.open','game.close','game.kick','game.chat'].includes(m.name)) schema.properties.target=adjacentTarget;
  if(['game.fire','game.throw','game.zap'].includes(m.name)) schema.properties.target=rangedTarget;
  if(m.name==='session.actions') schema.properties.target=inspectTarget;
  if(schema.properties.item){
    delete schema.properties.item;
    Object.assign(schema.properties,{itemId,quantity});
    schema.dependentRequired={quantity:['itemId']};
  }
  if(m.name==='decision.answer') {
    delete schema.properties.answer;
    schema.properties.value={description:'Reply value matching the standing question’s decision.reply.valueSchema. No kind tag is needed.',oneOf:[
      {type:'boolean'},agentAnswers.text!.schema,point,agentAnswers.choice!.schema,itemValue,
    ]};
    schema.required=schema.required.map((k:string)=>k==='answer'?'value':k);
  }
  const description=m.name==='decision.answer'?'Answer the exact decisionId using value in the returned decision.reply.valueSchema; answering can spend turns or produce another question.':m.name==='session.observe'?'Resynchronize for free: a DecisionFrame including the full perceived world and map. After a lost reply it verifies the retained receipt without resending input; unverified input stays blocked. Ordinary replies already contain the current view.':m.description.split('. ')[0]+'.';
  return {name:names[m.name]??m.name.split('.')[1]!,method:m.name,schema,description,covers:[m.name],readOnly:m.readOnly===true};
});
operations.push(
  {name:'step',method:'agent.step',schema:object({sessionId:sid,viewId,target:adjacentTarget}),description:'Attempt one ordinary adjacent step, including tame-ally swaps, opening doors and pushing boulders. Refuse a displayed non-ally; unseen hazards and real engine questions remain possible. Symbols must resolve uniquely in adjacent scope.',covers:['session.actions','game.move'],readOnly:false},
  {name:'go',method:'agent.go',schema:object({sessionId:sid,viewId,to:{...point,description:'Destination on the current level; walks a routed leg of known squares.'},maxActions:limit,maxPlanningMs},['sessionId','viewId','to']),description:'Walk toward a destination along known routes within the action and processing budgets. Swap with tame allies; stop for changes or decisions without automatically attacking. Use step for a single adjacent attempt.',covers:['session.route','session.actions','game.move'],readOnly:false},
  {name:'attack',method:'agent.attack',schema:object({sessionId:sid,viewId,target:adjacentTarget}),description:'Force one engine attack at an adjacent target; leave confirmations explicit. References bind to the observed view and symbols must resolve uniquely in adjacent scope.',covers:['session.actions','game.attack'],readOnly:false},
  {name:'explore',method:'agent.explore',schema:object({sessionId:sid,viewId,maxActions:limit,maxPlanningMs,maxFrontiers:{...limit,description:'Maximum successive perceived frontiers to reach (default 1). The total maxActions budget and decision/change stops still apply. A door attempt always ends the call.'}},['sessionId','viewId']),description:'Explore toward unvisited frontiers within action and processing budgets; maxFrontiers explicitly allows successive frontiers (default 1). Stop for changes, decisions, or one door attempt.',covers:['session.navigation','session.route','session.actions','game.move','game.open'],readOnly:false},
  {name:'descend',method:'agent.descend',schema:object({sessionId:sid,viewId,maxActions:limit,maxPlanningMs},['sessionId','viewId']),description:'Approach a remembered reachable downward stair and attempt descent within action and processing budgets.',covers:['session.navigation','session.route','game.move','game.climb'],readOnly:false},
  {name:'help',method:'agent.help',schema:object({name:{type:'string',minLength:1,maxLength:64}},[]),description:'List tool names and one-line descriptions, or get one tool schema by name.',covers:['protocol.describe'],readOnly:true},
  {name:'receipt',method:'agent.receipt',schema:object({sessionId:sid,operationId:{type:'string',minLength:1,maxLength:128}}),description:'Read exact historical evidence under result. Historical receipts are not the current scene or an active decision; use observe without operationId to play.',covers:['session.receipt'],readOnly:true},
);
for(const method of operations) {
  if(method.name==='help'||method.name==='receipt') continue;
  method.schema.properties.includeWorld={type:'boolean',description:'Include full perceived world in the scene. Encoding only; observe without operationId always includes world.'};
  if(method.name!=='create') method.schema.properties.sinceViewId={type:'string',minLength:1,description:'Request a scene delta against this last sent view, including in compact encoding. A missing baseline returns a snapshot; does not authorize input or replace viewId.'};
}

// Explicit agent families, not an automatic one-tool-per-low-command export.
// Each variant retains its own exact schema and admission semantics.
const families:Record<string,[string,string,string]>={
 create:['session','action','create'],resume:['session','action','resume'],suspend:['session','action','suspend'],quit:['session','action','quit'],
 syncState:['observe','',''],receipt:['observe','',''],
 lookup:['lookup','',''],help:['help','',''],
 navigation:['plan','action','frontiers'],route:['plan','action','route'],
 step:['travel','mode','step'],run:['travel','mode','run'],climb:['travel','mode','climb'],
 go:['travel','mode','to'],explore:['travel','mode','explore'],descend:['travel','mode','descend'],
 inspect:['interact','',''],attack:['interact','action','attack'],kick:['interact','action','kick'],
 open:['interact','action','open'],close:['interact','action','close'],chat:['interact','action','chat'],
 loot:['interact','action','loot'],pay:['interact','action','pay'],pray:['interact','action','pray'],
 enhance:['interact','action','enhance'],search:['interact','action','search'],
 wait:['interact','action','rest'],rest:['interact','action','rest'],
 throw:['use','action','throw'],offer:['use','action','offer'],eat:['use','action','eat'],
 drink:['use','action','drink'],read:['use','action','read'],apply:['use','action','apply'],
 zap:['use','action','zap'],cast:['use','action','cast'],engrave:['use','action','engrave'],
 fire:['use','action','fire'],dip:['use','action','dip'],rub:['use','action','rub'],invoke:['use','action','invoke'],
 wield:['equipment','action','wield'],equip:['equipment','action','wear'],remove:['equipment','action','remove'],
 quiver:['equipment','action','quiver'],swap:['equipment','action','swap'],twoWeapon:['equipment','action','twoWeapon'],
 pickup:['inventory','action','pickup'],drop:['inventory','action','drop'],configurePickup:['inventory','action','configurePickup'],
 answer:['respond','action','answer'],cancel:['respond','action','cancel'],
};
export const agentMethods=operations.map(operation=>{
 const [name,field,value]=families[operation.name]??[];
 if(!name)throw Error('Missing explicit agent family: '+operation.name);
 const schema=structuredClone(operation.schema);
 if(operation.name==='inspect')schema.required=schema.required.filter((key:string)=>key!=='target');
 if(operation.name==='run'){
   schema.properties.runMode=schema.properties.mode;
   delete schema.properties.mode;
   schema.required=schema.required.map((key:string)=>key==='mode'?'runMode':key);
 }
 if(operation.name==='rest'&&!schema.required.includes('turns'))schema.required.push('turns');
 if(field){schema.properties[field]={const:value};schema.required.push(field);}
 return {...operation,name,schema,selector:field?{[field]:value}:{}};
});
agentMethods.push({
 name:'use',method:'agent.itemActions',schema:object({sessionId:sid,itemId,includeWorld:{type:'boolean'},sinceViewId:{type:'string',minLength:1}},['sessionId']),
 description:'Discover actions on a perceived item, or list perceived items and general-use attempts. No action means no input, even for one offer.',
 covers:[],readOnly:true,selector:{},
});
const descriptions:Record<string,string>={
 session:'Create, resume, suspend or explicitly quit a run. action is required; quit retains the engine confirmation.',
 observe:'Read current state and verify uncertain input for free. With operationId, read an exact historical receipt under result instead.',
 lookup:'Read the pinned game encyclopedia by name.',
 plan:'Read perceived frontiers or a route without moving. action: frontiers or route.',
 travel:'Explicit mode: step, run, climb, to, explore or descend. One step retains ordinary semantics; navigation legs are bounded. runMode selects native run behavior.',
 use:'Without action, discover perceived item actions for free. With explicit action, attempt item use, firing, casting or engraving. Never infer an operation; real engine decisions stay explicit.',
 interact:'Without action, discover perceived square attempts for free (default self). With action, explicitly attack, open, close, kick, chat, loot, pay, pray, enhance, search or rest.',
 equipment:'Explicitly wield, wear, remove, quiver, swap or toggle twoWeapon. Item discovery through use supplies equipment offers.',
 inventory:'Explicitly pickup, drop or configurePickup. Item discovery through use supplies inventory offers.',
 respond:'Answer or cancel the exact decisionId. action answer requires value matching decision.reply.valueSchema; cancellation must be permitted.',
 help:'List agent families or read one complete variant schema.',
};
function familyTools(readOnly=false){
 const variants=readOnly?agentMethods.filter(m=>m.readOnly):agentMethods;
 return [...new Set(variants.map(m=>m.name))].map(name=>{
   const members=variants.filter(m=>m.name===name);
   const read=members.every(m=>m.readOnly);
   const keys=[...new Set(members.flatMap(m=>Object.keys(m.schema.properties)))];
   const shared=new Set<string>();
   const properties=Object.fromEntries(keys.map(key=>{
     const definitions=members.filter(m=>key in m.schema.properties).map(m=>m.schema.properties[key]);
     const same=definitions.every(definition=>JSON.stringify(definition)===JSON.stringify(definitions[0]));
     if(same)shared.add(key);
     return [key,same?definitions[0]:{}];
   }));
   // Root validates shared types/bounds; each closed branch still determines
   // which fields are permitted and required. No permissive optional-field bag.
   const branches=members.map(m=>({...m.schema,properties:Object.fromEntries(Object.entries(m.schema.properties).map(([key,schema])=>[key,shared.has(key)?{}:schema]))}));
   return {name,description:descriptions[name]!,inputSchema:{type:'object',properties,additionalProperties:false,oneOf:branches},outputSchema:mcpResponseSchema,
     annotations:{readOnlyHint:read,destructiveHint:!read,idempotentHint:read,openWorldHint:false}};
 });
}
export const agentTools=familyTools();
export const agentReadOnlyTools=familyTools(true);
