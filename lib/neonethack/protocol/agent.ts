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
export const agentInstructions='Create once or resume, then retain basis.sessionId and basis.viewId. Every reply is a version-2 DecisionFrame: basis holds the canonical turn and revision; control.gate says whether input is ready, awaiting an exact decision, recovering, lost ownership, ended or unavailable. outcome distinguishes accepted, rejected, unknown and notSubmitted input and reports actual actions and elapsed turns. scene.self contains position, location and vitals; scene.nearby, entities, features, map, inventory, here and perception describe the same perceived scene. events are fresh for this call. Use the returned frame directly for the next decision. Mutations require the exact observed viewId except create, resume, suspend, answer and cancel. Stale views reject without input. step {target:{direction}} attempts one adjacent ordinary move including tame-ally swaps; it refuses displayed non-allies. go {to} is destination-only travel; explore and descend are bounded legs. maxActions bounds actions and maxPlanningMs bounds planning (default 1000 ms). Read the reported stop and progress before continuing. run retains native direction, mode and noPickup behavior. Adjacent actions use target:{direction}, {position:{x,y}}, {ref}, or {symbol,scope:adjacent}; symbols must match uniquely, never choose a nearest match. inspect additionally permits direction self and symbol scope level. fire, throw and zap only accept target:{direction} with compass, self, up or down; omit target for an engine decision. Item actions use opaque itemId, never display names or slots. At gate decision use decision.reply with its exact decisionId and valueSchema, or decision.cancel when offered; do not replace questions or answer implicitly. Queries are free. syncState always includes full world and verifies retained uncertain receipts without replaying gameplay. Other scene replies are snapshots by default; includeWorld requests full world, and sinceViewId requests a delta against the last sent baseline, including in compact encoding. These options only control encoding. Historical receipt and query data live under result, never become a current scene or active question. RecoveryRequired blocks new input until verified; never blindly repeat an uncertain action or leg. Terminal details live in scene.end. An attempt is not a safety promise. suspend releases the saved run; quit asks to end it. help lists tools or one schema.';
const names:Record<string,string>={'session.observe':'syncState','session.actions':'inspect','session.close':'suspend','decision.answer':'answer','decision.cancel':'cancel'};
/** Low operations deliberately absent from the agent vocabulary, with the reason.
 * check:tools accepts these as intentionally uncovered; they stay available
 * through the low library, C API and NDJSON. */
export const agentOmitted:Record<string,string>={
  'game.moveWithoutAttack':'The m-prefixed native movement remains low-level only; step supplies ordinary movement with explicit displayed-creature guards and tame-ally swaps.',
};
export const agentMethods=catalog.methods.filter(m=>!['protocol.describe','game.move','game.attack','session.receipt',...Object.keys(agentOmitted)].includes(m.name)).map(m=>{
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
agentMethods.push(
  {name:'step',method:'agent.step',schema:object({sessionId:sid,viewId,target:adjacentTarget}),description:'Attempt one ordinary adjacent step, including tame-ally swaps, opening doors and pushing boulders. Refuse a displayed non-ally; unseen hazards and real engine questions remain possible. Symbols must resolve uniquely in adjacent scope.',covers:['session.actions','game.move'],readOnly:false},
  {name:'go',method:'agent.go',schema:object({sessionId:sid,viewId,to:{...point,description:'Destination on the current level; walks a routed leg of known squares.'},maxActions:limit,maxPlanningMs},['sessionId','viewId','to']),description:'Walk toward a destination along known routes within the action and processing budgets. Swap with tame allies; stop for changes or decisions without automatically attacking. Use step for a single adjacent attempt.',covers:['session.route','session.actions','game.move'],readOnly:false},
  {name:'attack',method:'agent.attack',schema:object({sessionId:sid,viewId,target:adjacentTarget}),description:'Force one engine attack at an adjacent target; leave confirmations explicit. References bind to the observed view and symbols must resolve uniquely in adjacent scope.',covers:['session.actions','game.attack'],readOnly:false},
  {name:'explore',method:'agent.explore',schema:object({sessionId:sid,viewId,maxActions:limit,maxPlanningMs,maxFrontiers:{...limit,description:'Maximum successive perceived frontiers to reach (default 1). The total maxActions budget and decision/change stops still apply. A door attempt always ends the call.'}},['sessionId','viewId']),description:'Explore toward unvisited frontiers within action and processing budgets; maxFrontiers explicitly allows successive frontiers (default 1). Stop for changes, decisions, or one door attempt.',covers:['session.navigation','session.route','session.actions','game.move','game.open'],readOnly:false},
  {name:'descend',method:'agent.descend',schema:object({sessionId:sid,viewId,maxActions:limit,maxPlanningMs},['sessionId','viewId']),description:'Approach a remembered reachable downward stair and attempt descent within action and processing budgets.',covers:['session.navigation','session.route','game.move','game.climb'],readOnly:false},
  {name:'help',method:'agent.help',schema:object({name:{type:'string',minLength:1,maxLength:64}},[]),description:'List tool names and one-line descriptions, or get one tool schema by name.',covers:['protocol.describe'],readOnly:true},
  {name:'receipt',method:'agent.receipt',schema:object({sessionId:sid,operationId:{type:'string',minLength:1,maxLength:128}}),description:'Read exact historical evidence under result. Historical receipts are not the current scene or an active decision; use syncState to play.',covers:['session.receipt'],readOnly:true},
);
for(const method of agentMethods) {
  if(method.name==='help'||method.name==='receipt') continue;
  method.schema.properties.includeWorld={type:'boolean',description:'Include full perceived world in the scene. Encoding only; syncState always includes world.'};
  if(method.name!=='create') method.schema.properties.sinceViewId={type:'string',minLength:1,description:'Request a scene delta against this last sent view, including in compact encoding. A missing baseline returns a snapshot; does not authorize input or replace viewId.'};
}
export const agentTools=agentMethods.map(m=>({name:m.name,description:m.description,inputSchema:m.schema,outputSchema:mcpResponseSchema,annotations:{readOnlyHint:m.readOnly,destructiveHint:!m.readOnly,idempotentHint:m.readOnly,openWorldHint:false}}));
