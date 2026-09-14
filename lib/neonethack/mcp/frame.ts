import type {Cell, Decision, End, Observation, Outcome, Response, Snapshot, WorldEvent} from '../typescript/types.js';
import {answers} from './agent-data.js';
import {renderMap, type PerceivedMap} from './map.js';
import {nearbyContext, attemptsFor, offeredCall} from './reply-context.js';
import {targetRef} from './targets.js';

export type Gate = 'ready'|'decision'|'recoveryRequired'|'ownershipLost'|'ended'|'unavailable';
export interface AgentError {code:string;message:string;retry?:'afterStateChange'|'afterArgumentCorrection'|'verifyReceipt'|'resume'|'never';[key:string]:unknown}
export interface AgentScene {
  kind:'snapshot';
  self:{position:Observation['you'];location:Observation['location'];vitals:Observation['vitals']};
  nearby:ReturnType<typeof nearbyContext>;
  entities:Array<NonNullable<Cell['occupant']>&{ref:string;position:{x:number;y:number};visible?:boolean}>;
  features:Array<{ref:string;position:{x:number;y:number};terrain:Cell['terrain'];objects?:Cell['objects'];visible?:boolean}>;
  map:PerceivedMap|null;
  inventory:Observation['inventory'];inventoryKnown:boolean;here:Observation['here'];perception:Observation['perception'];
  automaticPickup?:Observation['automaticPickup'];world?:Cell[];knowledge?:Observation['knowledge'];
  navigation?:Record<string,unknown>;end:End|null;
}
export interface DecisionFrame {
  version:2;
  basis:{sessionId:string;revision:number;viewId:string;levelId:string;turn:number}|null;
  control:{gate:Gate;decisionId?:string};
  outcome:({submission:'accepted'|'rejected'|'unknown'|'notSubmitted';status:string;actionsTaken:number;turnsElapsed:number;positionChanged:boolean;sceneChanged:boolean;operationId?:string;action?:string;effects?:string[];reason?:string})|null;
  scene:AgentScene|null;
  decision:(Decision&{reply?:Record<string,unknown>;cancel?:Record<string,unknown>;situationKey?:string;previouslyDeclined?:boolean})|null;
  events:WorldEvent[];
  diagnostics:Record<string,unknown>;
  summary:string;
  error?:AgentError;result?:Record<string,unknown>;verification?:Record<string,unknown>;
}
export interface FrameOptions {
  snapshot?:Snapshot;full?:boolean;readOnly?:boolean;rejected?:boolean;uncertain?:boolean;gate?:Gate;
  error?:AgentError;summary?:string;events?:WorldEvent[];navigation?:Record<string,unknown>;
  result?:Record<string,unknown>;verification?:Record<string,unknown>;sceneChanged?:boolean;operationId?:string;
}
export const isSnapshot=(r:Response):r is Snapshot=>'observation' in r&&'outcome' in r;
const views=new Map<string,{signature:string;id:string}>();
/** A standing question can change before a completed-input revision advances.
 * View identity therefore covers perceived state AND the actual question, not
 * merely the integrity revision. Bounded presentation state grants no authority. */
export function viewId(s:Snapshot):string {
  const signature=JSON.stringify([s.revision,s.observation,s.decision,s.ended,s.end]);
  const old=views.get(s.sessionId);
  if(old?.signature===signature)return old.id;
  const id=globalThis.crypto.randomUUID();
  views.delete(s.sessionId);views.set(s.sessionId,{signature,id});
  if(views.size>256)views.delete(views.keys().next().value!);
  return id;
}
export const uncertain=(r:Response)=>('outcome' in r&&r.outcome.status==='unknown')||('error' in r&&!!r.error&&['incompleteRequest','recoveryRequired','metadataUnavailable','inputHistoryError'].includes(r.error.code));

/** The contract accompanies the actual question, never an automatically selected answer. */
export function question(sessionId:string,d:Decision):NonNullable<DecisionFrame['decision']> {
  const format=answers[d.kind];
  const schema:Record<string,unknown>=structuredClone(format.schema);
  if(d.kind==='choice'){
    schema.items={oneOf:[{type:'integer',enum:d.options.map(o=>o.id)},{type:'string',enum:d.options.map(o=>o.name)}]};
    if(d.selection){schema.minItems=d.selection.min;schema.maxItems=d.selection.max;}
  }
  if(d.kind==='item'){
    const properties=schema.properties as Record<string,Record<string,unknown>>;
    properties.itemId={...properties.itemId,enum:d.options.map(o=>o.id)};
  }
  if(d.kind==='target')schema.enum=[...(d.allowedTargets.includes('self')?['self']:[]),...(d.allowedTargets.includes('direction')?(d.allowedDirections??['north','northeast','east','southeast','south','southwest','west','northwest','up','down']):[])];
  const arguments_={sessionId,decisionId:d.id};
  return {...d,reply:{tool:'respond',arguments:{...arguments_,action:'answer'},valueSchema:schema,instruction:format.instruction},
    ...(d.cancellable?{cancel:{tool:'respond',arguments:{...arguments_,action:'cancel'}}}:{})};
}
function gateFor(s:Snapshot|undefined,options:FrameOptions):Gate {
  if(options.uncertain)return 'recoveryRequired';
  if(options.gate)return options.gate;
  if(['staleRevision','staleView','sessionUnavailable'].includes(options.error?.code??''))return 'unavailable';
  if(['ownershipLost','sessionClosed'].includes(options.error?.code??''))return 'ownershipLost';
  if(!s)return 'unavailable';
  if(uncertain(s)||[s.storage,s.recording].some(d=>d&&d.status!=='ok'))return 'recoveryRequired';
  if(s.ended)return s.end?.kind==='disconnected'?'ownershipLost':'ended';
  if(s.decision)return 'decision';
  const n=s.observation.neighborhood;
  return n?.status==='available'?n.inputGate.state:n?.reason==='recoveryRequired'?'recoveryRequired':'ready';
}
function sceneFor(s:Snapshot,full:boolean):AgentScene {
  const o=s.observation;
  const {turn:_turn,...vitals}=o.vitals;
  return {kind:'snapshot',self:{position:o.you,location:o.location,vitals},nearby:nearbyContext(s),
    entities:o.world.flatMap(c=>c.occupant&&c.occupant.kind!=='self'?[{...c.occupant,ref:targetRef(s,c.x,c.y),position:{x:c.x,y:c.y},...(c.visible!==undefined?{visible:c.visible}:{})}]:[]),
    features:o.world.filter(c=>c.objects?.length||!['floor','wall','corridor','unknown','dark'].includes(c.terrain.type)).map(c=>({ref:targetRef(s,c.x,c.y),position:{x:c.x,y:c.y},terrain:c.terrain,...(c.objects?{objects:c.objects}:{}),...(c.visible!==undefined?{visible:c.visible}:{})})),
    map:renderMap(o)??null,inventory:o.inventory,inventoryKnown:o.inventoryKnown,here:o.here,perception:o.perception,
    ...(o.automaticPickup?{automaticPickup:o.automaticPickup}:{}),...(full?{world:o.world,...(o.knowledge?{knowledge:o.knowledge}:{})}:{}),end:s.end};
}

/** Point endpoints describe net coordinate displacement, not the last input.
 * Level identity is absent from Point; only an explicit level-change stop can
 * establish a level change here, never matching coordinates or a climb label. */
function legPositionChanged(leg:Record<string,unknown>):boolean {
  const {startPosition:start,endPosition:end,stop}=leg;
  if(stop&&typeof stop==='object'&&'kind' in stop&&stop.kind==='levelChanged'&&
    'before' in stop&&typeof stop.before==='string'&&'after' in stop&&typeof stop.after==='string'&&stop.before!==stop.after)return true;
  if(!start||typeof start!=='object'||!end||typeof end!=='object')return false;
  if(!('x' in start)||typeof start.x!=='number'||!('y' in start)||typeof start.y!=='number'||
    !('x' in end)||typeof end.x!=='number'||!('y' in end)||typeof end.y!=='number')return false;
  return start.x!==end.x||start.y!==end.y;
}

/** No engine envelope escapes this boundary; low receipts remain untouched. */
export function present(response:Response|undefined,options:FrameOptions={}):DecisionFrame {
  const s=response&&isSnapshot(response)?response:options.snapshot;
  const error=options.error??(response&&'error' in response?response.error:undefined);
  const gate=gateFor(s,{...options,...(error?{error:{...error}}:{})}), read=options.readOnly===true, rejected=options.rejected===true;
  const leg=options.navigation;
  const actual:Outcome|undefined=response&&isSnapshot(response)?response.outcome:undefined;
  const actions=typeof leg?.actionsTaken==='number'?leg.actionsTaken:actual&&!read&&!rejected?1:0;
  const status=gate==='recoveryRequired'?'unknown':gate==='ended'?'ended':gate==='decision'?'needsDecision':rejected?'blocked':leg?String(leg.reason):actual&&!read?actual.status:'completed';
  const operationId=options.operationId??(actions>0&&response&&isSnapshot(response)?response.requestId:undefined);
  const frame:DecisionFrame={version:2,basis:s?{sessionId:s.sessionId,revision:s.revision,viewId:viewId(s),levelId:s.observation.location.id,turn:s.observation.turn}:null,
    control:{gate,...(gate==='decision'&&s?.decision?{decisionId:s.decision.id}:{})},
    outcome:{submission:options.uncertain||gate==='recoveryRequired'?'unknown':rejected?'rejected':actions>0?'accepted':'notSubmitted',status,actionsTaken:actions,
      turnsElapsed:read||rejected?0:typeof leg?.turnsElapsed==='number'?leg.turnsElapsed:actual?.turnsElapsed??0,
      positionChanged:read||rejected?false:leg?actions>0&&legPositionChanged(leg):actual?.positionChanged??false,sceneChanged:options.sceneChanged??false,
      ...(operationId?{operationId}:{}),...(actual&&!read?{action:actual.action,effects:actual.effects,...(actual.reason?{reason:actual.reason}:{})}:{})},
    scene:s?sceneFor(s,options.full===true):null,decision:s?.decision?question(s.sessionId,s.decision):null,
    events:read||rejected?[]:options.events??(response&&isSnapshot(response)?response.events:[]),
    diagnostics:{},summary:gate==='ended'?`Run ended (${s?.end?.kind??'unknown'}): ${s?.end?.cause??'The run is over'}. ${options.summary??error?.message??''}`:options.summary??error?.message??(s?.decision?s.decision.about??'Answer the standing question.':`Operation ${status}.`),
    ...(error?{error:{...error,retry:options.error?.retry??(gate==='recoveryRequired'?'verifyReceipt':['staleRevision','staleView','occupied','unsupportedMovement'].includes(error.code)?'afterStateChange':'afterArgumentCorrection')}}:{}),
    ...(leg?{result:{kind:'navigationLeg',policy:'knownWalking',...leg}}:{}),...(options.result?{result:options.result}:{}),...(options.verification?{verification:options.verification}:{})};
  if(response&&!isSnapshot(response)&&'kind' in response){
    const {version:_version,sessionId:_sessionId,...data}=response;
    frame.result={...data,executableNow:gate==='ready',...('cell' in response?{attempts:attemptsFor(response.cell,response.sessionId,s?viewId(s):undefined)}:{})};
    if('cell' in response&&s&&response.cell.dx===0&&response.cell.dy===0){
      frame.result.commands=['pay','pray','enhance'].map(action=>({...offeredCall(`game.${action}`,{sessionId:s.sessionId,viewId:viewId(s)}),instruction:'Explicit engine command; applicability and consequences are not predicted.'}));
    }else if('cell' in response&&s&&response.cell.inBounds&&Math.max(Math.abs(response.cell.dx),Math.abs(response.cell.dy))===1){
      const target={position:{x:response.cell.x,y:response.cell.y}};
      frame.result.commands=['attack','chat'].map(action=>({...offeredCall(`game.${action}`,{sessionId:s.sessionId,viewId:viewId(s),target}),instruction:'Explicit engine command; applicability and consequences are not predicted.'}));
    }
  }
  return frame;
}
