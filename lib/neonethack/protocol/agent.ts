import {catalog, type Schema} from './catalog.ts';
const point:Schema={type:'object',properties:{x:{type:'integer',minimum:1,maximum:79},y:{type:'integer',minimum:0,maximum:20}},required:['x','y'],additionalProperties:false};
const sid=catalog.methods.find(m=>m.name==='session.observe')!.schema.properties.sessionId;
const limit={type:'integer',minimum:1,maximum:1659};
const object=(properties:Record<string,Schema>,required=Object.keys(properties)):Schema=>({type:'object',properties,required,additionalProperties:false});
export const agentInstructions='Create or resume a run and pass its short sessionId back. Use go for destinations anywhere on the current level, explore to reveal more of it, and descend to approach known stairs and go down; force:true attempts only an adjacent ordinary move, never a force attack. Attack is separate. Answers and warnings stay explicit. The adapter manages operation IDs, revisions and complete observations. If execution is uncertain, use retry for the pending exact operation or receipt for its operationId; never repeat a new action blindly. Observe when state changes. help gives brief tool names or one detailed schema.';
export const agentMethods=catalog.methods.filter(m=>!['protocol.describe','game.move','game.attack','session.receipt'].includes(m.name)).map(m=>{
  const schema=structuredClone(m.schema);
  for(const field of ['requestId','expectedRevision','decisionId']) {delete schema.properties[field];schema.required=schema.required.filter((k:string)=>k!==field);}
  if(m.name==='decision.answer') {
    const choice=schema.properties.answer.oneOf.find((branch:Schema)=>branch.properties.kind.const==='choice');
    choice.properties.choose.items={oneOf:[choice.properties.choose.items,{type:'string',minLength:1,maxLength:127}]};
  }
  return {name:m.name.replaceAll('.','_'),method:m.name,schema,description:m.description.split('. ')[0]+'.',covers:[m.name],readOnly:m.readOnly===true};
});
agentMethods.push(
  {name:'go',method:'agent.go',schema:object({sessionId:sid,to:point,force:{type:'boolean'},maxActions:limit},['sessionId','to']),description:'Walk toward any square on the current level along known routes, stopping on changes or decisions; force:true attempts adjacent ordinary movement only.',covers:['session.route','session.actions','game.move'],readOnly:false},
  {name:'attack',method:'agent.attack',schema:object({sessionId:sid,target:{oneOf:[point,{type:'string',minLength:1,maxLength:128}]}}),description:'Force one engine attack at an adjacent square or returned creature reference; leave confirmations explicit.',covers:['session.actions','game.attack'],readOnly:false},
  {name:'explore',method:'agent.explore',schema:object({sessionId:sid,maxActions:limit},['sessionId']),description:'Explore one bounded leg toward an unvisited frontier, or approach and attempt a closed door once.',covers:['session.navigation','session.route','session.actions','game.move','game.open'],readOnly:false},
  {name:'descend',method:'agent.descend',schema:object({sessionId:sid,maxActions:limit},['sessionId']),description:'Approach a remembered reachable downward stair and attempt descent within a bounded leg.',covers:['session.navigation','session.route','game.move','game.climb'],readOnly:false},
  {name:'help',method:'agent.help',schema:object({name:{type:'string',minLength:1,maxLength:64}},[]),description:'List tool names and one-line descriptions, or get one tool schema by name.',covers:['protocol.describe'],readOnly:true},
  {name:'receipt',method:'agent.receipt',schema:object({sessionId:sid,operationId:{type:'string',minLength:1,maxLength:128}}),description:'Read an exact historical receipt by operationId; this does not execute input or report current state.',covers:['session.receipt'],readOnly:true},
  {name:'retry',method:'agent.retry',schema:object({sessionId:sid}),description:'Recover the pending exact input, or read the most recent completed input receipt; never repeat an action or restart a navigation leg.',covers:['session.receipt'],readOnly:false},
);
export const agentTools=agentMethods.map(m=>({name:m.name,description:m.description,inputSchema:m.schema,annotations:{readOnlyHint:m.readOnly,destructiveHint:!m.readOnly,idempotentHint:m.readOnly,openWorldHint:false}}));
