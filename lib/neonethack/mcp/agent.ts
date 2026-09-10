import {Game, Neonethack, Navigator, NavigationError, WorldError, type Transport} from '../typescript/client.js';
import type {Method, Request, Response, Snapshot} from '../typescript/types.js';
import {methods, tools, instructions, answers} from './agent-data.js';
export {tools,instructions};
type Schema={type?:string;properties?:Record<string,Schema>;required?:string[];dependentRequired?:Record<string,string[]>;additionalProperties?:boolean;oneOf?:Schema[];enum?:unknown[];const?:unknown;items?:Schema;minimum?:number;maximum?:number;minLength?:number;maxLength?:number;minItems?:number;maxItems?:number;uniqueItems?:boolean};
function valid(value:unknown,s:Schema):boolean {
  if(s.oneOf) return s.oneOf.filter(c=>valid(value,c)).length===1;
  if('const' in s && value!==s.const) return false;
  if(s.enum && !s.enum.includes(value)) return false;
  if(s.type==='object') {
    if(!value || typeof value!=='object' || Array.isArray(value)) return false;
    const v=value as Record<string,unknown>;
    return !(s.required??[]).some(k=>!(k in v)) && Object.entries(s.dependentRequired??{}).every(([k,needed])=>!(k in v)||needed.every(n=>n in v)) && Object.entries(v).every(([k,x])=>s.properties&&Object.hasOwn(s.properties,k)?valid(x,s.properties[k]!):s.additionalProperties!==false);
  }
  if(s.type==='array') return Array.isArray(value) && value.length>=(s.minItems??0) && value.length<=(s.maxItems??Infinity) && (!s.uniqueItems || new Set(value.map(v=>JSON.stringify(v))).size===value.length) && value.every(v=>!s.items||valid(v,s.items));
  if(s.type==='string') return typeof value==='string' && value.length>=(s.minLength??0) && value.length<=(s.maxLength??Infinity) && !/[\u0000-\u001f\u007f]/.test(value);
  if(s.type==='integer') return Number.isSafeInteger(value) && (value as number)>=(s.minimum??-Infinity) && (value as number)<=(s.maximum??Infinity);
  if(s.type==='boolean') return typeof value==='boolean';
  return true;
}
const uncertain=(r:Response)=>('outcome' in r && r.outcome.status==='unknown') || ('error' in r && !!r.error && ['incompleteRequest','recoveryRequired','metadataUnavailable','inputHistoryError'].includes(r.error.code));
const isSnapshot=(r:Response):r is Snapshot=>'observation' in r && 'outcome' in r;
const creatureId=(s:Snapshot,x:number,y:number)=>`c-${s.sessionId}-${s.revision}-${x}-${y}`;
const answerFormats=answers as Record<string,{field:string;schema:Schema;instruction:string}>;
const itemSelector=(input:Record<string,unknown>)=>({id:input.itemId,...(input.quantity!==undefined?{quantity:input.quantity}:{})});
function questionReply(sessionId:unknown,decision:Record<string,unknown>) {
  const format=answerFormats[String(decision.kind)];
  if(!format)return {};
  const args={sessionId,decisionId:decision.id};
  return {reply:{tool:'answer',arguments:args,valueSchema:format.schema,instruction:format.instruction},...(decision.cancellable?{cancel:{tool:'cancel',arguments:args}}:{})};
}
export function present(response:Response, extra:Record<string,unknown>={}, compact=false):Record<string,unknown> {
  const r=response as unknown as Record<string,unknown>;
  let summary='Perceived information.';
  if('error' in response && response.error) summary=response.error.message;
  else if(isSnapshot(response)) summary=`${response.outcome.action}: ${response.outcome.status}; ${response.outcome.turnsElapsed} turns elapsed.${response.decision ? ` Answer the ${response.decision.kind} decision: ${response.decision.about}` : ''}`;
  else if('kind' in response) summary=response.kind==='lore' ? (response.found?'Encyclopedia lore; reference text, not an observation.':'No encyclopedia entry found.') : response.kind==='route' ? `Known walking route: ${response.distance===null?`none known${'why' in response && response.why?` (${response.why})`:''}`:`${response.distance} steps`}.` : response.kind==='navigation' ? `${response.frontiers.length} reachable unvisited frontiers; ${response.waysDown.length} remembered downward stairs.` : 'Perceived attempts for this square.';
  if(extra.navigation) {
    const leg=extra.navigation as {reason:string;why?:string;hint?:string;recover?:string;actionsTaken:number;turnsElapsed:number};
    summary=`Navigation: ${leg.reason}${leg.why?` (${leg.why})`:''}; ${leg.actionsTaken} actions, ${leg.turnsElapsed} turns elapsed.${leg.hint?` ${leg.hint}`:''}${leg.recover?` ${leg.recover}`:''}`;
  }
  // Terminal facts lead even when a navigation leg or error supplies the detail.
  // A disconnected close ends the session connection, but the run can resume.
  if(isSnapshot(response) && response.ended && response.end?.kind!=='disconnected') summary=`Run ended (${response.end?.kind ?? 'unknown'})${response.end?.cause ? `: ${response.end.cause}` : ''}. ${summary}`;
  const creatures=isSnapshot(response) ? response.observation.world.filter(c=>c.occupant && c.occupant.kind!=='self').map(c=>({id:creatureId(response,c.x,c.y),position:{x:c.x,y:c.y},...c.occupant})) : undefined;
  // Put the witnessed outcome and actual question first; keep the complete snapshot.
  const {requestId,...rest}=r;
  const result:Record<string,unknown>={summary,...('outcome' in r?{outcome:r.outcome,events:r.events,decision:r.decision}:{}),...(creatures?{creatures}:{}),...rest,...(requestId?{operationId:requestId}:{}),...extra};
  if(result.decision)Object.assign(result,questionReply(r.sessionId,result.decision as Record<string,unknown>));
  // Inspect offers executable adapter syntax beside the unchanged low facts.
  // These are attempts, including needsSelection, never recommended actions.
  if('cell' in response)result.attempts=response.cell.actions.flatMap(offer=>{
    if(!('arguments' in offer))return [];
    const tool=offer.method==='game.move'?'go':methods.find(m=>m.method===offer.method)?.name;
    if(!tool)return [];
    const args=offer.method==='game.move'?{to:{x:response.cell.x,y:response.cell.y},force:true}:offer.arguments;
    return [{tool,arguments:{sessionId:response.sessionId,...args},availability:offer.availability,cost:offer.cost}];
  });
  if(extra.navigation && !extra.error)delete result.error;
  if((extra.navigation as {actionsTaken?:number}|undefined)?.actionsTaken===0){
    delete result.operationId;
    result.events=[];
    result.outcome={action:'navigation',status:'completed',turnsElapsed:0,positionChanged:false,effects:[]};
  }
  if(compact && isSnapshot(response)){
    const {neighborhood,...observation}=response.observation;
    const events=result.events as Array<{type:string;kind?:string;mark?:string}>;
    const retained=events.filter(e=>!(e.type==='saw'&&e.kind==='terrain'&&(e.mark==='\\u0000'||e.mark==='\u0000')));
    result.observation=observation;result.events=retained;
    result.presentation={kind:'compact',omitted:['observation.neighborhood'],omittedClearTerrainEvents:events.length-retained.length,fullObservation:'observe',attempts:'inspect',...(result.operationId?{fullInputReceipt:'receipt'}:{})};
  }
  return result;
}
/** Per-agent observation/revision and uncertainty state, separate from the live
 * human Game. Never refresh silently before an input based on an older view. */
export class AgentClient {
  readonly tools=tools;
  private readonly api:Neonethack;
  private readonly games=new Map<string,Game>();
  private readonly tails=new Map<string,Promise<unknown>>();
  private readonly pending=new Map<string,Request>();
  private readonly last=new Map<string,string>();
  private creationUncertain=false;
  constructor(transport:Pick<Transport,'send'>) {
    this.api=new Neonethack({close:async()=>{},send:async request=>{
      const sid='sessionId' in request.params?request.params.sessionId:undefined;
      try {
        const response=await transport.send(request);
        if(sid && (request.method.startsWith('game.')||request.method.startsWith('decision.'))) {
          if(uncertain(response))this.pending.set(sid,structuredClone(request));
          else if('requestId' in response && response.requestId && 'requestId' in request.params && response.requestId===request.params.requestId)this.last.set(sid,response.requestId);
        }
        return response;
      }
      catch(error) {if(sid && (request.method.startsWith('game.')||request.method.startsWith('decision.')))this.pending.set(sid,structuredClone(request));throw error;}
    }});
  }
  private adopt(r:Response) {
    if(isSnapshot(r)) {this.games.set(r.sessionId,new Game(this.api,r,()=>globalThis.crypto.randomUUID()));if(!uncertain(r))this.creationUncertain=false;}
  }
  async call(name:string,args:Record<string,unknown>={},options:{signal?:AbortSignal}={}):Promise<Record<string,unknown>> {
    const entry=methods.find(m=>m.name===name);
    if(!entry || !valid(args,entry.schema as unknown as Schema)){
      const message=entry?`Invalid arguments for ${name}; no operation was sent. Call help with {name:"${name}"} for the schema. Item actions take itemId; answer takes decisionId and value.`:'Unknown tool; no operation was sent. Call help with {} to list tool names.';
      return {version:1,error:{code:'invalidParams',message},summary:message};
    }
    const input=structuredClone(args), sid=typeof input.sessionId==='string'?input.sessionId:undefined;
    const revision=sid?this.games.get(sid)?.state.revision:undefined;
    const key=sid??'creation';
    const run=(this.tails.get(key)??Promise.resolve()).catch(()=>{}).then(async()=>{
      if(options.signal?.aborted) throw Error('Tool call cancelled before submission.');
      if(entry.method==='agent.help') {
        if(typeof input.name==='string') {
          const tool=tools.find(t=>t.name===input.name);
          return tool?{version:1,summary:tool.description,tool}:{version:1,summary:'Unknown tool.',error:{code:'unknownTool',message:'Unknown tool.'}};
        }
        return {version:1,summary:instructions,tools:tools.map(({name,description})=>({name,description}))};
      }
      const game=sid?this.games.get(sid):undefined;
      if(entry.method==='session.create' && this.creationUncertain) throw Error('Creation is uncertain. Observe or resume the existing run before creating another.');
      const safe=['session.create','session.resume','session.observe','agent.receipt','agent.retry'].includes(entry.method);
      if(!safe && !game) throw Error('Observe or resume this session first.');
      if(!safe && sid && this.pending.has(sid)) throw Error('An input is uncertain. Use recover for that exact pending operation, or inspect its receipt; do not submit a new action.');
      if(!safe && game && game.state.revision!==revision) return {version:1,sessionId:sid,summary:'State changed while this call was queued. Observe before acting.',error:{code:'staleRevision',message:'State changed while this call was queued. Observe before acting.'}};
      if(entry.method==='agent.retry') {
        const request=sid?this.pending.get(sid):undefined;
        if(!request) {
          const operationId=sid?this.last.get(sid):undefined;
          if(!operationId)throw Error('No recent input is retained. Use receipt with an operationId to inspect historical results.');
          const response=await this.api.request('session.receipt',{sessionId:sid!,requestId:operationId});
          return present(response,{historical:true});
        }
        const response=await this.api.transport.send(request);
        if(!uncertain(response))this.pending.delete(sid!);
        this.adopt(response);return present(response);
      }
      if(entry.method==='agent.receipt') {
        const response=await this.api.request('session.receipt',{sessionId:sid!,requestId:input.operationId as string});
        // Historical receipts never replace the agent's current observation.
        return present(response,{historical:true});
      }
      try {
        if(entry.method==='agent.go' || entry.method==='agent.explore' || entry.method==='agent.descend') {
          const navigator=new Navigator(game!);
          const legOptions={maxActions:input.maxActions as number|undefined,signal:options.signal};
          const leg=entry.method==='agent.go' ? await navigator.go({...legOptions,to:input.to as {x:number;y:number},force:input.force as boolean|undefined}) : entry.method==='agent.explore' ? await navigator.explore({...legOptions,maxFrontiers:input.maxFrontiers as number|undefined}) : await navigator.descend(legOptions);
          this.adopt(leg.snapshot);return present(leg.snapshot,{navigation:{reason:leg.reason,actionsTaken:leg.actionsTaken,turnsElapsed:leg.turnsElapsed,...(leg.why?{why:leg.why,hint:leg.hint}:{}),...(leg.lastOperationId?{lastOperationId:leg.lastOperationId}:{}),...(leg.recover?{recover:leg.recover}:{})}},true);
        }
        let method=entry.method, params:Record<string,unknown>={...input};
        if('itemId' in params){params.item=itemSelector(params);delete params.itemId;delete params.quantity;}
        if(method==='agent.attack') {
          let point=input.target as {x:number;y:number};
          if(typeof input.target==='string') {
            const cell=game!.observation.world.find(c=>c.occupant && c.occupant.kind!=='self' && creatureId(game!.state,c.x,c.y)===input.target);
            if(!cell)throw Error('Stale or foreign creature reference. Observe and select a current creature or adjacent square.');
            point={x:cell.x,y:cell.y};
          }
          const query=await game!.actions(point,{expectedRevision:revision});
          const move=query.cell.actions.find(a=>a.method==='game.move');
          if(query.cell.movement.relation!=='adjacent'||!move?.arguments||!('direction' in move.arguments))throw Error('Choose an adjacent square for an attack.');
          method='game.attack';params={sessionId:sid,direction:move.arguments.direction};
        }
        if(method.startsWith('decision.') && input.decisionId!==game!.decision?.id) return {
          version:1,sessionId:sid,summary:'The decision changed. Observe and answer the exact returned decisionId; no input submitted.',
          error:{code:'staleDecision',message:'The decision changed. Observe and answer the exact returned decisionId; no input submitted.'},
        };
        if(method==='decision.answer') {
          const kind=game!.decision!.kind,format=answerFormats[kind];
          if(!format||!valid(input.value,format.schema))return {version:1,sessionId:sid,summary:'Value does not match the standing question; no input submitted.',error:{code:'invalidParams',message:'Use the standing question’s reply.valueSchema.'},decision:game!.decision,...questionReply(sid,game!.decision! as unknown as Record<string,unknown>)};
          let value=input.value;
          if(kind==='item')value=itemSelector(value as Record<string,unknown>);
          if(kind==='target'&&value!=='self')value={direction:value};
          params.answer={kind,[format.field]:value};delete params.value;
        }
        if(method==='decision.answer' && game!.decision?.kind==='choice') {
          const answer=params.answer as {kind:string;choose?:Array<number|string>};
          if(answer.kind==='choice' && answer.choose) {
            const resolved:number[]=[];
            for(const selected of answer.choose) {
              if(typeof selected==='number'){resolved.push(selected);continue;}
              const candidates=game!.decision.options.filter(option=>option.name===selected);
              if(candidates.length!==1) return {
                version:1,sessionId:sid,revision,summary:candidates.length?'Several choices have that name. Select one candidate by ID.':'No choice has that name. Select a displayed name or ID.',
                clarification:{kind:'choice',reason:candidates.length?'ambiguousName':'unknownName',name:selected},
                decision:{...game!.decision,options:candidates.length?candidates:game!.decision.options},...questionReply(sid,game!.decision as unknown as Record<string,unknown>),
              };
              resolved.push(candidates[0]!.id);
            }
            params.answer={...answer,choose:resolved};
          }
        }
        if(method.startsWith('game.')||method.startsWith('decision.')) {
          params.requestId=globalThis.crypto.randomUUID();params.expectedRevision=revision;
        } else if(method==='session.actions'||method==='session.route'||method==='session.navigation')params.expectedRevision=revision;
        if(options.signal?.aborted) throw Error('Tool call cancelled before submission.');
        const response=await this.api.transport.send({version:1,method,params} as Request);
        this.adopt(response);
        if(method==='session.close' && !('error' in response))this.games.delete(sid!);
        return present(response,{},method!=='session.observe');
      } catch(error) {
        if(error instanceof NavigationError){
          const leg=error.result,cause=error.cause;
          const pending=sid?this.pending.get(sid):undefined;
          const lastOperationId=sid?this.last.get(sid):undefined;
          const original=cause instanceof WorldError && 'error' in cause.response?cause.response.error:undefined;
          const message=`Navigation stopped after ${leg.actionsTaken} actions and ${leg.turnsElapsed} turns. Substep error: ${cause instanceof Error?cause.message:String(cause)}`;
          this.adopt(leg.snapshot);
          const result=present(leg.snapshot,{navigation:{reason:'error',actionsTaken:leg.actionsTaken,turnsElapsed:leg.turnsElapsed,observation:pending?'lastConfirmed':'current',...(lastOperationId?{lastOperationId}:{}),recover:'Call recover; do not resubmit this navigation leg.'},error:{code:original?.code??(pending?'uncertainExecution':'agentError'),message}},true);
          delete result.operationId;
          if(pending && 'requestId' in pending.params)result.operationId=pending.params.requestId;
          const presentation=result.presentation as Record<string,unknown>;
          if(result.operationId)presentation.fullInputReceipt='receipt';else delete presentation.fullInputReceipt;
          return result;
        }
        if(entry.method==='session.create' && !(error instanceof WorldError)) {
          this.creationUncertain=true;
          throw Error(`Creation reply unavailable; a run may already exist. Do not resubmit create. Recover the run token from the owning page or retained invocation, then observe or resume it. ${error instanceof Error?error.message:String(error)}`);
        }
        if(error instanceof WorldError){this.adopt(error.response);return present(error.response,{},true);}
        throw error;
      }
    });
    this.tails.set(key,run);
    try{return await run;}
    catch(error) {
      const pending=sid?this.pending.get(sid):undefined;
      const message=error instanceof Error?error.message:String(error);
      return {version:1,...(sid?{sessionId:sid}:{}),summary:message,error:{code:pending?'uncertainExecution':'agentError',message},...(pending && 'requestId' in pending.params?{operationId:pending.params.requestId}:{})};
    }
  }
}
