import {catalog, compass, position, type Schema} from './catalog.ts';
const point:Schema={type:'object',properties:{x:{type:'integer',minimum:1,maximum:79},y:{type:'integer',minimum:0,maximum:20}},required:['x','y'],additionalProperties:false};
const sid=catalog.methods.find(m=>m.name==='session.observe')!.schema.properties.sessionId;
const limit={type:'integer',minimum:1,maximum:1659};
const object=(properties:Record<string,Schema>,required=Object.keys(properties)):Schema=>({type:'object',properties,required,additionalProperties:false});
const itemId:Schema={type:'string',minLength:1,maxLength:64,description:'Exact opaque item id from inventory, here.items or the standing question.'};
const quantity:Schema={type:'integer',minimum:1,maximum:2147483647,description:'Explicit stack count; requires itemId.'};
const itemValue=object({itemId,quantity},['itemId']);
// Generated for the shared adapter: question syntax is presentation, not game logic.
export const agentAnswers:Record<string,{field:string;schema:Schema;instruction:string}>={
  confirmation:{field:'confirm',schema:{type:'boolean'},instruction:'true accepts; false declines. Choose explicitly.'},
  choice:{field:'choose',schema:{type:'array',minItems:1,maxItems:1024,uniqueItems:true,items:{oneOf:[{type:'integer',minimum:0,maximum:2147483647},{type:'string',minLength:1,maxLength:127}]}},instruction:'An array of returned option names or IDs. Select only the choices you intend.'},
  item:{field:'item',schema:itemValue,instruction:'An object with itemId from the returned candidates; quantity is optional.'},
  target:{field:'target',schema:{type:'string',enum:['self',...compass.enum,'up','down']},instruction:'One displayed target direction or self; engine restrictions still apply.'},
  position:{field:'position',schema:position,instruction:'A square {x,y}, a compass direction, finish or help.'},
  text:{field:'text',schema:{type:'string',minLength:0,maxLength:128},instruction:'Your text as a string, including an empty string when permitted.'},
};
export const agentInstructions='Start with create (once) or resume, and pass the returned short sessionId in subsequent calls. Replies include state, fresh messages for this call, and context from free perceived-state queries. context.nearby lists adjacent attempts and context lists known frontiers/stairs; use these without repeating inspect/navigation. An attempt is not a safety promise. context.status unavailable means enrichment failed, not that the action failed. messages are empty on observation; observation.heard is recent history, not new events. Navigation stop.kind explains witnessed changes. inputSubmitted:false marks rejected arguments, not uncertain execution. Observe reads the full current scene; inspect lists perceived attempts at here or an adjacent square. Go walks toward a destination; explore reveals frontiers; descend approaches known stairs. A normal navigation stop needs no recovery call: read the returned scene and choose what to do next. force:true on go attempts adjacent ordinary movement, not force attack; use attack separately. Item actions take itemId from perceived items, never a name disguised as an ID. A standing question includes reply.valueSchema: call answer with its exact decisionId and value, or cancel explicitly. A cancellation can spend turns or resources; read the actual outcome. The adapter owns revisions and operation IDs. After an error or lost reply, call observe: it checks any retained uncertain receipt without resending input and returns current state. If verification is unavailable, stop and follow its resume instruction; never repeat the action or navigation leg blindly. receipt is historical evidence nested under receipt, never current position or an active question. After a completely lost outer reply, the earlier operation ID may be unavailable; observe still reads current state, not a guessed old receipt. suspend releases a saved run; quit asks to end it. help lists all tools or one detailed schema.';
const names:Record<string,string>={'session.actions':'inspect','session.close':'suspend','decision.answer':'answer','decision.cancel':'cancel'};
export const agentMethods=catalog.methods.filter(m=>!['protocol.describe','game.move','game.attack','session.receipt'].includes(m.name)).map(m=>{
  const schema=structuredClone(m.schema);
  for(const field of ['requestId','expectedRevision']) {delete schema.properties[field];schema.required=schema.required.filter((k:string)=>k!==field);}
  if(schema.properties.item){
    delete schema.properties.item;
    Object.assign(schema.properties,{itemId,quantity});
    schema.dependentRequired={quantity:['itemId']};
  }
  if(m.name==='decision.answer') {
    delete schema.properties.answer;
    schema.properties.value={description:'Reply value matching the standing question’s reply.valueSchema. No kind tag is needed.',oneOf:[
      {type:'boolean'},agentAnswers.text!.schema,point,agentAnswers.choice!.schema,itemValue,
    ]};
    schema.required=schema.required.map((k:string)=>k==='answer'?'value':k);
  }
  const description=m.name==='decision.answer'?'Answer the exact decisionId using value in the returned reply.valueSchema; answering can spend turns or produce another question.':m.name==='session.observe'?'Read current state for free; after uncertainty, verify the retained receipt without resending input. Unverified input stays blocked.':m.description.split('. ')[0]+'.';
  return {name:names[m.name]??m.name.split('.')[1]!,method:m.name,schema,description,covers:[m.name],readOnly:m.readOnly===true};
});
agentMethods.push(
  {name:'go',method:'agent.go',schema:object({sessionId:sid,to:point,force:{type:'boolean'},maxActions:limit},['sessionId','to']),description:'Walk toward any square on the current level along known routes, stopping on changes or decisions; force:true attempts adjacent ordinary movement only.',covers:['session.route','session.actions','game.move'],readOnly:false},
  {name:'attack',method:'agent.attack',schema:object({sessionId:sid,target:{oneOf:[point,{type:'string',minLength:1,maxLength:128}]}}),description:'Force one engine attack at an adjacent square or returned creature reference; leave confirmations explicit.',covers:['session.actions','game.attack'],readOnly:false},
  {name:'explore',method:'agent.explore',schema:object({sessionId:sid,maxActions:limit,maxFrontiers:{...limit,description:'Maximum successive perceived frontiers to reach (default 1). The total maxActions budget and decision/change stops still apply. A door attempt always ends the call.'}},['sessionId']),description:'Explore toward unvisited frontiers within maxActions; maxFrontiers explicitly allows successive frontiers (default 1). Stop for changes, decisions, or one door attempt.',covers:['session.navigation','session.route','session.actions','game.move','game.open'],readOnly:false},
  {name:'descend',method:'agent.descend',schema:object({sessionId:sid,maxActions:limit},['sessionId']),description:'Approach a remembered reachable downward stair and attempt descent within a bounded leg.',covers:['session.navigation','session.route','game.move','game.climb'],readOnly:false},
  {name:'help',method:'agent.help',schema:object({name:{type:'string',minLength:1,maxLength:64}},[]),description:'List tool names and one-line descriptions, or get one tool schema by name.',covers:['protocol.describe'],readOnly:true},
  {name:'receipt',method:'agent.receipt',schema:object({sessionId:sid,operationId:{type:'string',minLength:1,maxLength:128}}),description:'Read exact historical evidence nested under receipt. It is not current state or an active question; use observe to play.',covers:['session.receipt'],readOnly:true},
);
export const agentTools=agentMethods.map(m=>({name:m.name,description:m.description,inputSchema:m.schema,annotations:{readOnlyHint:m.readOnly,destructiveHint:!m.readOnly,idempotentHint:m.readOnly,openWorldHint:false}}));
