import {Game,Neonethack,Navigator,NavigationError,WorldError,type Transport} from '../typescript/client.js';
import type {Compass,Request,Response,Snapshot,WorldEvent} from '../typescript/types.js';
import {methods,tools,instructions,answers} from './agent-data.js';
import {present,question,isSnapshot,uncertain,viewId,type DecisionFrame,type FrameOptions} from './frame.js';
import {resolveTarget,TargetError,type AgentTarget} from './targets.js';
import {valid,type Schema} from './schema.js';
import {itemActions} from './item-actions.js';
export {tools,instructions,present};
const itemSelector=(input:Record<string,unknown>)=>({id:input.itemId,...(input.quantity!==undefined?{quantity:input.quantity}:{})});
const answerFormats=answers as Record<string,{field:string;schema:Schema;instruction:string}>;
const isInput=(method:string)=>method.startsWith('game.')||method.startsWith('decision.');
const isLeg=(method:string)=>['agent.go','agent.explore','agent.descend'].includes(method);
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;

/** One session coordinator for every transport. Observed bases never refresh silently before input. */
export class AgentClient {
  readonly tools=tools;
  private readonly api:Neonethack;
  private readonly games=new Map<string,Game>();
  private readonly tails=new Map<string,Promise<unknown>>();
  private readonly pending=new Map<string,Request>();
  private readonly navigation=new Map<string,{view:string;value:Record<string,unknown>}>();
  private readonly priorScene=new Map<string,string>();
  private readonly repetitions=new Map<string,{view:string;intents:Map<string,number>}>();
  private readonly declines=new Map<string,Set<string>>();
  private creationUncertain=false;
  constructor(transport:Pick<Transport,'send'>) {
    this.api=new Neonethack({close:async()=>{},send:async request=>{
      const sid='sessionId' in request.params?request.params.sessionId:undefined;
      try {
        const response=await transport.send(request);
        if(sid&&isInput(request.method)){
          if(uncertain(response))this.pending.set(sid,structuredClone(request));
        }
        return response;
      }catch(error){if(sid&&isInput(request.method))this.pending.set(sid,structuredClone(request));throw error;}
    }});
  }
  private adopt(r:Response){
    if(isSnapshot(r)&&r.revision>=(this.games.get(r.sessionId)?.state.revision??-1)){
      this.games.set(r.sessionId,new Game(this.api,r,()=>globalThis.crypto.randomUUID()));
      if(!uncertain(r))this.creationUncertain=false;
    }
  }
  private situation(s:Snapshot):string|undefined {
    const d=s.decision;
    // This is a similarity key for a witnessed prompt, not an engine identity or authority.
    if(d?.kind!=='confirmation')return undefined;
    return JSON.stringify([s.observation.location.id,s.observation.you,d.action,d.about,d.context]);
  }
  private async reply(response:Response|undefined,options:FrameOptions={}):Promise<DecisionFrame>{
    const sid=response&&'sessionId' in response?response.sessionId:options.snapshot?.sessionId;
    const snapshot=response&&isSnapshot(response)?response:options.snapshot??(sid?this.games.get(sid)?.state:undefined);
    const pending=sid?this.pending.get(sid):undefined;
    const result=present(response,{...options,snapshot,...(pending?{uncertain:true,operationId:'requestId' in pending.params?pending.params.requestId:undefined}:{})});
    if(snapshot&&result.scene&&result.control.gate==='ready'){
      const basis=viewId(snapshot),cached=this.navigation.get(snapshot.sessionId);
      if(cached?.view===basis)result.scene.navigation=cached.value;
      else {
        const started=performance.now();
        let value:Record<string,unknown>;
        try{
          const q=await this.api.transport.send({version:1,method:'session.navigation',params:{sessionId:snapshot.sessionId,expectedRevision:snapshot.revision}});
          if('kind' in q&&q.kind==='navigation'&&q.sessionId===snapshot.sessionId&&q.basis.revision===snapshot.revision&&q.basis.levelId===snapshot.observation.location.id){
            value={status:'available',policy:q.policy,frontiers:q.frontiers,waysDown:q.waysDown,doors:q.doors};
          }else value={status:'unavailable',reason:'error' in q?q.error?.code:'unexpectedResponse'};
        }catch{value={status:'unavailable',reason:'queryUnavailable'};}
        // Only successful enrichment is cached; transient failure remains explicitly unavailable.
        if(value.status==='available')this.navigation.set(snapshot.sessionId,{view:basis,value});
        result.scene.navigation=value;result.diagnostics.enrichmentMs=performance.now()-started;
      }
    }
    if(snapshot&&result.scene){
      const key=this.situation(snapshot);
      if(key&&result.decision){result.decision.situationKey=key;result.decision.previouslyDeclined=this.declines.get(snapshot.sessionId)?.has(key)??false;}
      const signature=JSON.stringify([snapshot.observation,snapshot.decision,snapshot.ended,snapshot.end]);
      if(result.outcome)result.outcome.sceneChanged=this.priorScene.get(snapshot.sessionId)!==signature;
      this.priorScene.set(snapshot.sessionId,signature);
    }
    return result;
  }
  private reject(s:Snapshot|undefined,code:string,message:string,details:Record<string,unknown>={},full=false){
    return this.reply(undefined,{snapshot:s,rejected:true,full,error:{code,message,...details},summary:message});
  }
  /** Verify exact retained evidence, then obtain current state. Never resend gameplay. */
  private async sync(sid:string,resume=false):Promise<DecisionFrame>{
    let current:Response|undefined;
    if(resume){current=await this.api.transport.send({version:1,method:'session.resume',params:{sessionId:sid}});if(!isSnapshot(current)||uncertain(current))return this.reply(current,{readOnly:true,full:true});}
    const pending=this.pending.get(sid),operationId=pending&&'requestId' in pending.params?pending.params.requestId:undefined;
    let receipt:Snapshot|undefined;
    if(operationId){try{const r=await this.api.transport.send({version:1,method:'session.receipt',params:{sessionId:sid,requestId:operationId}});if(isSnapshot(r)&&r.sessionId===sid&&r.requestId===operationId&&!uncertain(r))receipt=r;}catch{/* Missing evidence keeps admission closed. */}}
    if(!current||pending)current=await this.api.transport.send({version:1,method:'session.observe',params:{sessionId:sid}});
    this.adopt(current);
    if(!pending)return this.reply(current,{readOnly:true,full:true});
    const n=isSnapshot(current)?current.observation.neighborhood:undefined;
    const settled=receipt&&isSnapshot(current)&&!uncertain(current)&&current.revision>=receipt.revision&&[current.storage,current.recording].every(d=>!d||d.status==='ok')&&(!n||(n.status==='available'?!['recoveryRequired','unavailable'].includes(n.inputGate.state):n.reason!=='recoveryRequired'));
    if(settled&&receipt){this.pending.delete(sid);return this.reply(current,{readOnly:true,full:true,verification:{status:'settled',operationId,outcome:receipt.outcome,...(receipt.error?{error:receipt.error}:{})}});}
    return this.reply(current,{readOnly:true,full:true,uncertain:true,verification:{status:'unresolved',operationId},error:{code:'uncertainExecution',message:'The previous input is not verified. Resume this same session; do not repeat the action.',retry:'verifyReceipt'}});
  }
  async call(name:string,args:Record<string,unknown>={},options:{signal?:AbortSignal}={}):Promise<DecisionFrame>{
    const tool=tools.find(t=>t.name===name),entry=methods.find(m=>m.name===name&&valid(args,m.schema as Schema)),sid=typeof args.sessionId==='string'?args.sessionId:undefined;
    if(!entry)return this.reject(sid?this.games.get(sid)?.state:undefined,tool?'invalidParams':'unknownTool','No operation was sent. Use the returned schema.',tool?{tool}:{tools:tools.map(({name,description})=>({name,description}))});
    const input=structuredClone(args),revision=sid?this.games.get(sid)?.state.revision:undefined,key=sid??'creation';
    const run=(this.tails.get(key)??Promise.resolve()).catch(()=>{}).then(async()=>{
      const game=sid?this.games.get(sid):undefined,full=input.includeWorld===true;
      if(options.signal?.aborted)return this.reject(game?.state,'cancelled','Cancelled before submission.',{},full);
      if(entry.method==='agent.help'){
        const tool=typeof input.name==='string'?tools.find(t=>t.name===input.name):undefined;
        return present(undefined,{readOnly:true,summary:tool?.description??instructions,result:tool?{tool}: {tools:tools.map(({name,description})=>({name,description}))}});
      }
      const safe=['session.create','session.resume','session.observe','agent.receipt'].includes(entry.method);
      if(entry.method==='session.create'&&this.creationUncertain)return this.reply(undefined,{uncertain:true,error:{code:'uncertainExecution',message:'Creation is uncertain. Recover the existing run token; do not create again.'}});
      if(!safe&&!game)return this.reject(undefined,'sessionUnavailable','Sync or resume the explicit session before acting.');
      if(!safe&&sid&&this.pending.has(sid))return this.reject(game?.state,'uncertainExecution','Verify the retained receipt with observe; do not resend gameplay.');
      if(!safe&&game&&game.state.revision!==revision)return this.reject(game.state,'staleRevision','State changed while the call was queued. Read the returned view before acting.');
      if(game&&'viewId' in input&&input.viewId!==viewId(game.state))return this.reject(game.state,'staleView','The supplied view is stale; no input submitted.');
      if(entry.method==='session.observe'||entry.method==='session.resume')return this.sync(sid!,entry.method==='session.resume');
      if(entry.method==='agent.itemActions'){
        const observed=await this.api.transport.send({version:1,method:'session.observe',params:{sessionId:sid!}});
        this.adopt(observed);
        return isSnapshot(observed)?this.reply(observed,{readOnly:true,full,result:itemActions(observed,input.itemId as string|undefined)}):this.reply(observed,{snapshot:game!.state,readOnly:true,full});
      }
      if(entry.method==='agent.receipt'){
        const r=await this.api.request('session.receipt',{sessionId:sid!,requestId:input.operationId as string});
        // Historical low evidence is deliberately not a live DecisionFrame or executable question.
        return this.reply(undefined,{snapshot:game?.state,readOnly:true,result:{kind:'receipt',historical:true,operationId:input.operationId,receipt:r},...('error' in r&&r.error?{error:{...r.error}}:{})});
      }
      const acting=isInput(entry.method)||entry.method==='agent.step'||entry.method==='agent.attack'||isLeg(entry.method);
      if(game?.decision&&acting&&!entry.method.startsWith('decision.'))return this.reject(game.state,'pendingDecision','Answer or cancel the exact standing question before acting.',{},full);
      if(game?.state.ended&&acting)return this.reject(game.state,'ended','This run no longer accepts gameplay.',{},full);
      let method=entry.method;
      const {viewId:_view,includeWorld:_include,sinceViewId:_since,...params0}=input;
      const params:Record<string,unknown>={...params0};
      for(const field of Object.keys(entry.selector))delete params[field];
      if(method==='session.actions'&&input.target===undefined)params.target='here';
      if(method==='game.run'&&'runMode' in params){params.mode=params.runMode;delete params.runMode;}
      const events:WorldEvent[]=[];
      try{
        if(isLeg(method)){
          const nav=new Navigator(game!),opts={maxActions:input.maxActions as number|undefined,maxPlanningMs:input.maxPlanningMs as number|undefined,signal:options.signal,onStep:(s:Snapshot)=>events.push(...s.events)};
          const leg=method==='agent.go'?await nav.go({...opts,to:input.to as {x:number;y:number}}):method==='agent.explore'?await nav.explore({...opts,maxFrontiers:input.maxFrontiers as number|undefined}):await nav.descend(opts);
          this.adopt(leg.snapshot);
          const {snapshot:_snapshot,...navigation}=leg;
          return this.reply(leg.snapshot,{full,events,navigation});
        }
        if(['agent.step','agent.attack','game.open','game.close','game.kick','game.chat','session.actions'].includes(method)&&input.target!==undefined){
          const resolved=resolveTarget(game!.state,input.target as AgentTarget,{scope:method==='session.actions'?'level':'adjacent',self:method==='session.actions'});
          if(method==='session.actions')params.target=resolved.direction==='self'?'here':resolved.position;
          else if(method==='agent.step'||method==='agent.attack'){
            if(!resolved.direction||['self','up','down'].includes(resolved.direction))throw new TargetError('targetOutOfScope','Choose an adjacent compass target.');
            const occupant=game!.observation.world.find(c=>c.x===resolved.position?.x&&c.y===resolved.position?.y)?.occupant;
            if(method==='agent.step'&&occupant?.kind==='creature')return this.reject(game!.state,'occupied','A displayed creature occupies this square. Choose an explicit interaction.',{target:resolved,occupant},full);
            method=method==='agent.step'?'game.move':'game.attack';params.direction=resolved.direction as Compass;delete params.target;
          }else params.target={direction:resolved.direction};
        }
        if(['game.fire','game.throw','game.zap'].includes(method)&&params.target&&typeof params.target==='object'&&'direction' in params.target&&(params.target as {direction:unknown}).direction==='self')params.target='self';
        if('itemId' in params){params.item=itemSelector(params);delete params.itemId;delete params.quantity;}
        if(method.startsWith('decision.')&&input.decisionId!==game!.decision?.id)return this.reject(game!.state,'staleDecision','The question changed; answer its exact current ID.',{},full);
        if(method==='decision.answer'){
          const d=game!.decision!,format=answerFormats[d.kind];
          const reply=question(game!.state.sessionId,d).reply;
          if(!format||!valid(input.value,reply!.valueSchema as Schema))return this.reject(game!.state,'invalidParams','Value does not match decision.reply.valueSchema.',{},full);
          let value=input.value;
          if(d.kind==='item')value=itemSelector(value as Record<string,unknown>);
          if(d.kind==='target'&&value!=='self')value={direction:value};
          if(d.kind==='choice'){
            const ids:number[]=[];
            for(const selected of value as Array<number|string>){
              if(typeof selected==='number'){ids.push(selected);continue;}
              const candidates=d.options.filter(o=>o.name===selected);
              if(candidates.length!==1)return this.reject(game!.state,'ambiguousChoice','Choose the exact returned option ID.',{candidates},full);
              ids.push(candidates[0]!.id);
            }
            value=ids;
          }
          params.answer={kind:d.kind,[format.field]:value};delete params.value;
        }
        if(isInput(method)){params.requestId=globalThis.crypto.randomUUID();params.expectedRevision=revision;}
        else if(['session.actions','session.route','session.navigation'].includes(method))params.expectedRevision=revision;
        if(options.signal?.aborted)return this.reject(game?.state,'cancelled','Cancelled before submission.',{},full);
        const decline=method==='decision.answer'&&input.value===false&&game?this.situation(game.state):undefined;
        const r=await this.api.transport.send({version:1,method,params} as Request);
        this.adopt(r);
        if(decline&&isSnapshot(r)&&!r.error&&r.decision?.id!==input.decisionId){
          const history=this.declines.get(sid!)??new Set<string>();history.add(decline);if(history.size>32)history.delete(history.values().next().value!);this.declines.set(sid!,history);
        }
        if(method==='session.close'&&!('error' in r)){this.games.delete(sid!);this.navigation.delete(sid!);this.declines.delete(sid!);}
        return this.reply(r,{full,readOnly:entry.readOnly,...(!isSnapshot(r)&&'error' in r?{rejected:true}:{}),snapshot:game?.state});
      }catch(error){
        if(error instanceof TargetError)return this.reject(game?.state,error.code,error.message,{...error.details},full);
        if(error instanceof NavigationError){
          const {snapshot,...leg}=error.result;this.adopt(snapshot);
          const original=error.cause instanceof WorldError?error.cause.response:undefined;
          return this.reply(snapshot,{full,events,navigation:{...leg,reason:'error'},error:{code:original&&'error' in original?original.error?.code??'navigationError':'navigationError',message:error.message}});
        }
        if(error instanceof WorldError){this.adopt(error.response);return this.reply(error.response,{full});}
        if(method==='session.create')this.creationUncertain=true;
        throw error;
      }
    });
    this.tails.set(key,run);
    let result:DecisionFrame;
    try{result=await run;}catch(error){
      const pending=sid?this.pending.get(sid):undefined;
      const message=error instanceof Error?error.message:String(error);
      result=await this.reply(undefined,{snapshot:sid?this.games.get(sid)?.state:undefined,uncertain:!!pending||this.creationUncertain,rejected:!pending&&!this.creationUncertain,error:{code:pending||this.creationUncertain?'uncertainExecution':'agentError',message:this.creationUncertain?`Creation reply unavailable. Do not resubmit create. Recover the existing run token, then observe or resume. ${message}`:pending?`Input receipt unresolved. Call observe; do not resend gameplay. ${message}`:message}});
    }
    if(sid){
      const {viewId:_view,includeWorld:_full,sinceViewId:_since,...intentArgs}=input;
      const intent=JSON.stringify([name,canonical(intentArgs),result.control.gate,result.error?.code]);
      const view=result.basis?.viewId??'unavailable',prev=this.repetitions.get(sid);
      const history=prev?.view===view?prev:{view,intents:new Map<string,number>()};
      const count=history.intents.get(intent)??0;
      history.intents.set(intent,count+1);
      if(history.intents.size>128)history.intents.delete(history.intents.keys().next().value!);
      this.repetitions.set(sid,history);result.diagnostics.repeatedIntent=count;
    }
    return result;
  }
}
