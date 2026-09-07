import {Game, Neonethack, Navigator, WorldError, type Transport} from '../typescript/client.js';
import type {Method, Request, Response, Snapshot} from '../typescript/types.js';
import {methods, tools, instructions} from './agent-data.js';
export {tools,instructions};
type Schema={type?:string;properties?:Record<string,Schema>;required?:string[];additionalProperties?:boolean;oneOf?:Schema[];enum?:unknown[];const?:unknown;items?:Schema;minimum?:number;maximum?:number;minLength?:number;maxLength?:number;minItems?:number;maxItems?:number;uniqueItems?:boolean};
function valid(value:unknown,s:Schema):boolean {
  if(s.oneOf) return s.oneOf.filter(c=>valid(value,c)).length===1;
  if('const' in s && value!==s.const) return false;
  if(s.enum && !s.enum.includes(value)) return false;
  if(s.type==='object') {
    if(!value || typeof value!=='object' || Array.isArray(value)) return false;
    const v=value as Record<string,unknown>;
    return !(s.required??[]).some(k=>!(k in v)) && Object.entries(v).every(([k,x])=>s.properties?.[k]?valid(x,s.properties[k]):s.additionalProperties!==false);
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
export function present(response:Response, extra:Record<string,unknown>={}):Record<string,unknown> {
  const r=response as unknown as Record<string,unknown>;
  let summary='Perceived information.';
  if('error' in response && response.error) summary=response.error.message;
  else if(isSnapshot(response)) summary=response.ended ? `Run ended: ${response.end?.cause ?? response.outcome.status}.` : `${response.outcome.action}: ${response.outcome.status}; ${response.outcome.turnsElapsed} turns elapsed.${response.decision ? ` Answer the ${response.decision.kind} decision: ${response.decision.about}` : ''}`;
  else if('kind' in response) summary=response.kind==='lore' ? (response.found?'Encyclopedia lore; reference text, not an observation.':'No encyclopedia entry found.') : response.kind==='route' ? `Known walking route: ${response.distance===null?'none known':`${response.distance} steps`}.` : response.kind==='navigation' ? `${response.frontiers.length} reachable unvisited frontiers; ${response.waysDown.length} remembered downward stairs.` : 'Perceived attempts for this square.';
  if(extra.navigation) { const leg=extra.navigation as {reason:string;actionsTaken:number;turnsElapsed:number};summary=`Navigation: ${leg.reason}; ${leg.actionsTaken} actions, ${leg.turnsElapsed} turns elapsed.`; }
  const creatures=isSnapshot(response) ? response.observation.world.filter(c=>c.occupant && c.occupant.kind!=='self').map(c=>({id:creatureId(response,c.x,c.y),position:{x:c.x,y:c.y},...c.occupant})) : undefined;
  // Put the witnessed outcome and actual question first; keep the complete snapshot.
  const {requestId,...rest}=r;
  return {summary,...('outcome' in r?{outcome:r.outcome,events:r.events,decision:r.decision}:{}),...(creatures?{creatures}:{}),...rest,...(requestId?{operationId:requestId}:{}),...extra};
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
    if(!entry || !valid(args,entry.schema as unknown as Schema))return {version:1,error:{code:'invalidParams',message:'Unknown tool or invalid arguments.'},summary:'Unknown tool or invalid arguments.'};
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
      if(!safe && sid && this.pending.has(sid)) throw Error('An input is uncertain. Use retry for that exact pending operation, or inspect its receipt; do not submit a new action.');
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
          const leg=entry.method==='agent.go' ? await navigator.go({...legOptions,to:input.to as {x:number;y:number},force:input.force as boolean|undefined}) : entry.method==='agent.explore' ? await navigator.explore(legOptions) : await navigator.descend(legOptions);
          this.adopt(leg.snapshot);return present(leg.snapshot,{navigation:{reason:leg.reason,actionsTaken:leg.actionsTaken,turnsElapsed:leg.turnsElapsed}});
        }
        let method=entry.method, params:Record<string,unknown>={...input};
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
        if(method==='decision.answer' && game!.decision?.kind==='choice') {
          const answer=input.answer as {kind:string;choose?:Array<number|string>};
          if(answer.kind==='choice' && answer.choose) {
            const resolved:number[]=[];
            for(const selected of answer.choose) {
              if(typeof selected==='number'){resolved.push(selected);continue;}
              const candidates=game!.decision.options.filter(option=>option.name===selected);
              if(candidates.length!==1) return {
                version:1,sessionId:sid,revision,summary:candidates.length?'Several choices have that name. Select one candidate by ID.':'No choice has that name. Select a displayed name or ID.',
                clarification:{kind:'choice',reason:candidates.length?'ambiguousName':'unknownName',name:selected},
                decision:{...game!.decision,options:candidates.length?candidates:game!.decision.options},
              };
              resolved.push(candidates[0]!.id);
            }
            params.answer={...answer,choose:resolved};
          }
        }
        if(method.startsWith('game.')||method.startsWith('decision.')) {
          params.requestId=globalThis.crypto.randomUUID();params.expectedRevision=revision;
          if(method.startsWith('decision.')) {
            if(!game!.decision)throw Error('There is no standing decision.');
            params.decisionId=game!.decision.id;
          }
        } else if(method==='session.actions'||method==='session.route'||method==='session.navigation')params.expectedRevision=revision;
        if(options.signal?.aborted) throw Error('Tool call cancelled before submission.');
        const response=await this.api.transport.send({version:1,method,params} as Request);
        this.adopt(response);
        if(method==='session.close' && !('error' in response))this.games.delete(sid!);
        return present(response);
      } catch(error) {
        if(entry.method==='session.create' && !(error instanceof WorldError)) {
          this.creationUncertain=true;
          throw Error(`Creation reply unavailable; a run may already exist. Do not resubmit session.create. Recover the run token from the owning page or retained invocation, then observe or resume it. ${error instanceof Error?error.message:String(error)}`);
        }
        if(error instanceof WorldError){this.adopt(error.response);return present(error.response);}
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
