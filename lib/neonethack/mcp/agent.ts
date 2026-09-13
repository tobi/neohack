import {actionMessages,attemptsFor,nearbyContext,stateSummary,orderedReply} from './reply-context.js';
import {markAt,renderMap} from './map.js';
import {Game, Neonethack, Navigator, NavigationError, WorldError, type Transport} from '../typescript/client.js';
import {compassOffsets} from '../typescript/navigator.js';
import type {Compass, Request, Response, Snapshot} from '../typescript/types.js';
import {methods, tools, instructions, answers} from './agent-data.js';
export {tools,instructions};
type Schema={type?:string;properties?:Record<string,Schema>;required?:string[];dependentRequired?:Record<string,string[]>;additionalProperties?:boolean;oneOf?:Schema[];enum?:unknown[];const?:unknown;items?:Schema;minimum?:number;maximum?:number;minLength?:number;maxLength?:number;minItems?:number;maxItems?:number;uniqueItems?:boolean};
function valid(value:unknown,s:Schema):boolean {
  if(s.oneOf && s.oneOf.filter(c=>valid(value,c)).length!==1) return false;
  if('const' in s && value!==s.const) return false;
  if(s.enum && !s.enum.includes(value)) return false;
  if(s.type==='object') {
    if(!value || typeof value!=='object' || Array.isArray(value)) return false;
    const v=value as Record<string,unknown>;
    return !(s.required??[]).some(k=>!(k in v)) && Object.entries(s.dependentRequired??{}).every(([k,needed])=>!(k in v)||needed.every(n=>n in v)) && Object.entries(v).every(([k,x])=>s.properties&&Object.hasOwn(s.properties,k)?valid(x,s.properties[k]!):s.additionalProperties!==false);
  }
  if(s.type==='array') return Array.isArray(value) && value.length>=(s.minItems??0) && value.length<=(s.maxItems??Infinity) && (!s.uniqueItems || new Set(value.map(v=>JSON.stringify(v))).size===value.length) && value.every(v=>!s.items||valid(v,s.items));
  // oxlint-disable-next-line no-control-regex -- Reject or strip control characters at this text boundary.
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
    const leg=extra.navigation as {reason:string;why?:string;hint?:string;stop?:{kind:string};actionsTaken:number;turnsElapsed:number};
    summary=`Navigation: ${leg.reason}${leg.why?` (${leg.why})`:leg.stop?` (${leg.stop.kind})`:''}; ${leg.actionsTaken} actions, ${leg.turnsElapsed} turns elapsed.${leg.hint?` ${leg.hint}`:''}`;
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
  if('cell' in response)result.attempts=attemptsFor(response.cell,response.sessionId);
  if(extra.navigation && !extra.error)delete result.error;
  if((extra.navigation as {actionsTaken?:number}|undefined)?.actionsTaken===0){
    delete result.operationId;
    result.events=[];
    result.outcome={action:'navigation',status:'completed',turnsElapsed:0,positionChanged:false,effects:[]};
  }
  if(isSnapshot(response)) {
    // The text map is the agent's view of the perceived level; JSON cells stay
    // available through syncState. Both derive from the same world layers.
    result.map=renderMap(response.observation);
    if(compact){
      const {neighborhood,world,heard,knowledge,...observation}=response.observation;
      const events=result.events as Array<{type:string;kind?:string;mark?:string}>;
      const retained=events.filter(e=>!(e.type==='saw'&&e.kind==='terrain'&&(e.mark==='\\u0000'||e.mark==='\u0000')));
      result.observation=observation;result.events=retained;
      result.presentation={kind:'compact',omitted:['observation.world','observation.neighborhood','observation.heard','observation.knowledge'],
        omittedClearTerrainEvents:events.length-retained.length,map:'rendered from observation.world',fullObservation:'syncState',attempts:'inspect',...(result.operationId?{fullInputReceipt:'receipt'}:{})};
    }
    result.state=stateSummary(response);
    const scope=extra.messageScope??(extra.historical?'historical':'action');
    // Observation replies never carry fresh messages; say nothing instead of [].
    if(scope==='observation'||scope==='none'){result.events=[];delete result.messages;delete result.messageScope;}
    else {
      result.messages=extra.messages??((extra.navigation as {actionsTaken?:number}|undefined)?.actionsTaken===0?[]:actionMessages(response));
      result.messageScope=scope;
    }
  }
  return orderedReply(result);
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
    if(isSnapshot(r) && r.revision >= (this.games.get(r.sessionId)?.state.revision ?? -1)) {this.games.set(r.sessionId,new Game(this.api,r,()=>globalThis.crypto.randomUUID()));if(!uncertain(r))this.creationUncertain=false;}
  }
  private verificationHint(sid:string|undefined,response:Response):Record<string,unknown> {
    if(!sid||!this.pending.has(sid))return {};
    const message='The input is uncertain. Call syncState to verify its exact receipt and read current state; do not resend gameplay.';
    return {error:('error' in response&&response.error)||{code:'uncertainExecution',message},summary:message,
      next:{tool:'syncState',arguments:{sessionId:sid}}};
  }
  private async reply(frame:Response,extra:Record<string,unknown>={},compact=true):Promise<Record<string,unknown>> {
    const result=present(frame,extra,compact);
    if('cell' in frame){
      const game=this.games.get(frame.sessionId);
      if(game && 'basis' in frame && game.state.revision===frame.basis.revision){
        const mark=markAt(game.observation,frame.cell.x,frame.cell.y);
        if(mark!==undefined)result.mark=mark;
      }
    }
    if(!isSnapshot(frame)||frame.ended||uncertain(frame)||this.pending.has(frame.sessionId))return orderedReply(result);
    const context:Record<string,unknown>={revision:frame.revision,nearby:nearbyContext(frame)};
    result.context=context;
    if(frame.decision){context.status='decision';return orderedReply(result);}
    try {
      const query=await this.api.transport.send({version:1,method:'session.navigation',params:{sessionId:frame.sessionId,expectedRevision:frame.revision}});
      if('kind' in query&&query.kind==='navigation'&&!('error' in query)&&query.sessionId===frame.sessionId&&query.basis.revision===frame.revision&&query.basis.levelId===frame.observation.location.id) {
        const withMark=<T extends {x:number;y:number}>(entry:T)=>{
          const mark=markAt(frame.observation,entry.x,entry.y);
          return mark===undefined?entry:{...entry,mark};
        };
        context.status='available';context.frontiers=query.frontiers.map(withMark);context.waysDown=query.waysDown.map(withMark);context.doors=query.doors.map(withMark);
      } else {
        context.status='unavailable';context.reason='error' in query&&query.error&&typeof query.error==='object'&&'code' in query.error?query.error.code:'unexpectedResponse';
      }
    } catch {context.status='unavailable';context.reason='queryUnavailable';}
    return orderedReply(result);
  }
  private async invalidInput(frame:Snapshot,code:string,message:string,details:Record<string,unknown>={}) {
    const result=await this.reply(frame,{summary:message,error:{code,message,...details},inputSubmitted:false,messages:[],messageScope:'none'});
    delete result.outcome;delete result.operationId;result.events=[];
    if(result.presentation)delete (result.presentation as Record<string,unknown>).fullInputReceipt;
    return orderedReply(result);
  }
  /** Resolve only a proven completed receipt, never resend gameplay. Always
   * obtain a fresh scene AFTER the historical lookup; another participant may
   * have acted in between. A missing receipt keeps admission closed. */
  private async observe(sid:string,resume=false):Promise<Record<string,unknown>> {
    let current:Response|undefined;
    if(resume){
      current=await this.api.transport.send({version:1,method:'session.resume',params:{sessionId:sid}});
      if(!isSnapshot(current)||uncertain(current))return present(current,{messages:[],messageScope:'observation'});
    }
    const pending=this.pending.get(sid);
    const operationId=pending && 'requestId' in pending.params ? pending.params.requestId : undefined;
    let receipt:Snapshot|undefined;
    if(operationId){
      try{
        const response=await this.api.transport.send({version:1,method:'session.receipt',params:{sessionId:sid,requestId:operationId}});
        if(isSnapshot(response)&&response.sessionId===sid&&response.requestId===operationId&&!uncertain(response))receipt=response;
      }catch{/* An unavailable receipt cannot authorize more input. */}
    }
    if(!current||pending)current=await this.api.transport.send({version:1,method:'session.observe',params:{sessionId:sid}});
    this.adopt(current);
    if(!pending)return this.reply(current,{messages:[],messageScope:'observation'},false);
    const neighborhood=isSnapshot(current)?current.observation.neighborhood:undefined;
    const settled=receipt && isSnapshot(current) && !uncertain(current) && current.revision>=receipt.revision &&
      [current.storage,current.recording].every(d=>!d||d.status==='ok') &&
      (!neighborhood || (neighborhood.status==='available'
        ? !['recoveryRequired','unavailable'].includes(neighborhood.inputGate.state)
        : neighborhood.reason!=='recoveryRequired'));
    if(settled&&receipt){
      this.pending.delete(sid);
      return this.reply(current,{messages:[],messageScope:'observation',verification:{status:'settled',operationId,outcome:receipt.outcome,...(receipt.error?{error:receipt.error}:{})},
        summary:'Current scene. The previous uncertain input has a verified receipt; no action was resent. Read verification.outcome for its result.'},false);
    }
    const message='Current state does not verify the previous input. No new action is allowed. Reopen the transport if necessary and resume this same session; do not repeat the action or navigation leg.';
    return present(current,{messages:[],messageScope:'observation',verification:{status:'unresolved',operationId},error:{code:'uncertainExecution',message},summary:message,
      next:{tool:'resume',arguments:{sessionId:sid}}});
  }
  async call(name:string,args:Record<string,unknown>={},options:{signal?:AbortSignal}={}):Promise<Record<string,unknown>> {
    const entry=methods.find(m=>m.name===name);
    if(!entry || !valid(args,entry.schema as unknown as Schema)){
      const message=entry?`Invalid arguments for ${name}; no operation was sent. Use the included tool schema. Item actions take itemId; answer takes decisionId and value.`:'Unknown tool; no operation was sent. Call help with {} to list tool names.';
      return {version:1,inputSubmitted:false,error:{code:entry?'invalidParams':'unknownTool',message},summary:message,...(entry?{tool:tools.find(t=>t.name===name)}:{tools:tools.map(({name,description})=>({name,description}))})};
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
      if(entry.method==='session.create' && this.creationUncertain) throw Error('Creation is uncertain. Call syncState or resume on the existing run before creating another.');
      const safe=['session.create','session.resume','session.observe','agent.receipt'].includes(entry.method);
      if(!safe && !game) throw Error('Call syncState or resume on this session first.');
      if(!safe && sid && this.pending.has(sid)) throw Error('An input is uncertain. Call syncState to verify its receipt and read the current scene; do not submit a new action.');
      if(!safe && game && game.state.revision!==revision) return {version:1,sessionId:sid,summary:'State changed while this call was queued. Read the returned state before acting.',error:{code:'staleRevision',message:'State changed while this call was queued. Read the returned state before acting.'}};
      if(entry.method==='session.observe'||entry.method==='session.resume')return this.observe(sid!,entry.method==='session.resume');
      if(entry.method==='agent.receipt') {
        const response=await this.api.request('session.receipt',{sessionId:sid!,requestId:input.operationId as string});
        // History is deliberately NOT a live snapshot at the top level. Old
        // questions carry evidence, never executable answer/cancel suggestions.
        const receipt=present(response,{historical:true});delete receipt.reply;delete receipt.cancel;
        return {version:1,kind:'receipt',historical:true,sessionId:sid,operationId:input.operationId,
          summary:'Historical receipt only. This is not the current world or an active question. Use syncState for current state.',
          ...('error' in response && response.error?{error:response.error}:{}),receipt};
      }
      const messages:ReturnType<typeof actionMessages>=[];
      try {
        if(entry.method==='agent.go' || entry.method==='agent.explore' || entry.method==='agent.descend') {
          const direction=input.direction as Compass|undefined, you=game!.observation.you;
          if(direction){
            // go never attacks: a square displaying a creature is refused before any input.
            if(!you)return this.invalidInput(game!.state,'unknownPosition','Your position is unknown, so a single step has no target; no input submitted.',{direction});
            const target={x:you.x+compassOffsets[direction][0],y:you.y+compassOffsets[direction][1]};
            const occupant=game!.observation.world.find(c=>c.x===target.x&&c.y===target.y)?.occupant;
            if(occupant&&occupant.kind==='creature')return this.invalidInput(game!.state,'occupied',`A creature is displayed ${direction}; go never attacks. Use attack for a deliberate attack; no input submitted.`,{direction,target,occupant,attack:{tool:'attack',arguments:{sessionId:sid,target}}});
          }
          const navigator=new Navigator(game!);
          const legOptions={maxActions:input.maxActions as number|undefined,signal:options.signal,onStep:(frame:Snapshot)=>messages.push(...actionMessages(frame))};
          const leg=entry.method==='agent.go' ? await navigator.go(direction?{...legOptions,direction}:{...legOptions,to:input.to as {x:number;y:number}}) : entry.method==='agent.explore' ? await navigator.explore({...legOptions,maxFrontiers:input.maxFrontiers as number|undefined}) : await navigator.descend(legOptions);
          this.adopt(leg.snapshot);return this.reply(leg.snapshot,{messages,messageScope:'navigation',navigation:{reason:leg.reason,actionsTaken:leg.actionsTaken,turnsElapsed:leg.turnsElapsed,...(leg.stop?{stop:leg.stop}:{}),...(leg.hint?{hint:leg.hint}:{}),...(leg.why?{why:leg.why}:{}),...(leg.lastOperationId?{lastOperationId:leg.lastOperationId}:{})},...this.verificationHint(sid,leg.snapshot)},true);
        }
        let method=entry.method, params:Record<string,unknown>={...input};
        if('itemId' in params){params.item=itemSelector(params);delete params.itemId;delete params.quantity;}
        if(method==='agent.attack') {
          let point=input.target as {x:number;y:number};
          if(typeof input.target==='string') {
            const cell=game!.observation.world.find(c=>c.occupant && c.occupant.kind!=='self' && creatureId(game!.state,c.x,c.y)===input.target);
            if(!cell)return this.invalidInput(game!.state,'staleTarget','That creature reference is not in this observed revision; no input submitted.',{target:input.target});
            point={x:cell.x,y:cell.y};
          }
          const you=game!.observation.you;
          if(!you||Math.max(Math.abs(point.x-you.x),Math.abs(point.y-you.y))!==1)return this.invalidInput(game!.state,'notAdjacent','Choose an adjacent square for an attack; no input submitted.',{target:point,position:you});
          const query=await game!.actions(point,{expectedRevision:revision});
          const move=query.cell.actions.find(a=>a.method==='game.move');
          if(query.cell.movement.relation!=='adjacent'||!move?.arguments||!('direction' in move.arguments))return this.invalidInput(game!.state,'notAdjacent','Choose an adjacent square for an attack; no input submitted.',{target:point,position:game!.observation.you});
          method='game.attack';params={sessionId:sid,direction:move.arguments.direction};
        }
        if(method.startsWith('decision.') && input.decisionId!==game!.decision?.id) return {
          version:1,sessionId:sid,summary:'The decision changed. Read the returned decision and answer its exact decisionId; no input submitted.',
          error:{code:'staleDecision',message:'The decision changed. Read the returned decision and answer its exact decisionId; no input submitted.'},
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
        return this.reply(response,{...this.verificationHint(sid,response),...(entry.readOnly?{messages:[],messageScope:'observation'}:{})},true);
      } catch(error) {
        if(error instanceof NavigationError){
          const leg=error.result,cause=error.cause;
          const pending=sid?this.pending.get(sid):undefined;
          const lastOperationId=sid&&leg.actionsTaken>0?this.last.get(sid):undefined;
          const original=cause instanceof WorldError && 'error' in cause.response?cause.response.error:undefined;
          const message=`Navigation stopped after ${leg.actionsTaken} actions and ${leg.turnsElapsed} turns. Substep error: ${cause instanceof Error?cause.message:String(cause)}`;
          this.adopt(leg.snapshot);
          const result=present(leg.snapshot,{messages,messageScope:'navigation',navigation:{reason:'error',actionsTaken:leg.actionsTaken,turnsElapsed:leg.turnsElapsed,observation:pending?'lastConfirmed':'current',...(lastOperationId?{lastOperationId}:{}),hint:'Call syncState before choosing another action; do not blindly repeat this navigation leg.'},error:{code:original?.code??(pending?'uncertainExecution':'agentError'),message},next:{tool:'syncState',arguments:{sessionId:sid}}},true);
          delete result.operationId;
          if(pending && 'requestId' in pending.params)result.operationId=pending.params.requestId;
          const presentation=result.presentation as Record<string,unknown>;
          if(result.operationId)presentation.fullInputReceipt='receipt';else delete presentation.fullInputReceipt;
          return orderedReply(result);
        }
        if(entry.method==='session.create' && !(error instanceof WorldError)) {
          this.creationUncertain=true;
          throw Error(`Creation reply unavailable; a run may already exist. Do not resubmit create. Recover the run token from the owning page or retained invocation, then syncState or resume it. ${error instanceof Error?error.message:String(error)}`);
        }
        if(error instanceof WorldError){this.adopt(error.response);return present(error.response,{},true);}
        throw error;
      }
    });
    this.tails.set(key,run);
    try{return await run;}
    catch(error) {
      const pending=sid?this.pending.get(sid):undefined;
      const message=(error instanceof Error?error.message:String(error))+(pending?' Call syncState to verify the previous input and read current state. Do not resend the action.':'');
      return {version:1,...(sid?{sessionId:sid}:{}),summary:message,error:{code:pending?'uncertainExecution':'agentError',message},...(pending?{next:{tool:'syncState',arguments:{sessionId:sid}}}:{}),...(pending && 'requestId' in pending.params?{operationId:pending.params.requestId}:{})};
    }
  }
}
