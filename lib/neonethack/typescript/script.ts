import type { Hero } from './hero.js';
import type { Snapshot } from './types.js';

export type ScriptValue = string | number | boolean | null | readonly ScriptValue[] | {readonly [key:string]:ScriptValue};
/** Strategy state, independent of the engine snapshot. Null suspends the script. */
export type ScriptState = string | {readonly [key:string]:ScriptValue} | null;
/** Boolean/undefined results leave state unchanged; false vetoes stateChange. Use {state:...} for structured state. */
export type ScriptResult = void | boolean | string | null | {readonly state:ScriptState};
export interface ScriptJournalEntry { readonly source:'script'; readonly author:string; readonly text:string; readonly turn:number; readonly revision:number }
export type ScriptControl =
  | {readonly kind:'button'; readonly id:string; readonly label:string}
  | {readonly kind:'checkbox'; readonly id:string; readonly label:string; readonly checked:boolean};
export interface ScriptHost {
  ready?(hero:Hero):void;
  state?(state:ScriptState):void;
  controls?(controls:readonly ScriptControl[]):void;
  journal?(entry:ScriptJournalEntry):void;
}
export function copyState(state:ScriptState):ScriptState {
  const seen=new Set<object>();
  const visit=(v:unknown):void=>{
    if(v===null || typeof v==='string' || typeof v==='boolean')return;
    if(typeof v==='number' && Number.isFinite(v))return;
    if(typeof v!=='object' || (!Array.isArray(v) && Object.getPrototypeOf(v)!==Object.prototype && Object.getPrototypeOf(v)!==null) || seen.has(v))throw Error('Script state must be JSON data without cycles.');
    seen.add(v);for(const value of Object.values(v))visit(value);seen.delete(v);
  };
  if(state!==null && typeof state!=='string' && (typeof state!=='object' || Array.isArray(state)))throw Error('Script state must be a string, object, or null.');
  visit(state);
  if(JSON.stringify(state).length>8192)throw Error('Script state exceeds 8192 characters.');
  const freeze=(v:any):any=>{if(v && typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
  return freeze(structuredClone(state));
}
export function returnedState(value:unknown):{state:ScriptState}|undefined {
  if(value===null || typeof value==='string')return {state:value};
  if(value && typeof value==='object' && Object.hasOwn(value,'state') && Object.keys(value).length===1)return {state:(value as {state:ScriptState}).state};
}
export class ScriptJournal {
  private readonly notes:ScriptJournalEntry[]=[];
  constructor(private readonly name:string,private readonly snapshot:()=>Snapshot,private readonly active:()=>boolean,private readonly publish:(entry:ScriptJournalEntry)=>void){}
  get entries():readonly ScriptJournalEntry[]{return Object.freeze([...this.notes]);}
  /** Script commentary, never injected into engine events or its input journal. */
  log(...values:unknown[]):void {
    if(!this.active())return;
    const text=values.map(v=>{if(typeof v==='string')return v;try{return JSON.stringify(v) ?? String(v);}catch{return String(v);}}).join(' ');
    if(text.length>2000)throw Error('Script journal entries are limited to 2000 characters.');
    if(this.notes.length>=10000)throw Error('Script journal is full (10000 entries).');
    const frame=this.snapshot();
    const entry=Object.freeze({source:'script' as const,author:this.name,text,revision:frame.revision,turn:frame.observation.turn});
    this.notes.push(entry);this.publish(entry);
  }
}
type ControlCallback=()=>ScriptResult|Snapshot|Promise<ScriptResult|Snapshot>;
export class ScriptControls {
  private readonly entries=new Map<string,{descriptor:ScriptControl; callback:(checked?:boolean)=>ReturnType<ControlCallback>}>();
  constructor(private readonly active:()=>boolean,private readonly enqueue:(callback:ControlCallback)=>Promise<boolean>,private readonly publish:(controls:readonly ScriptControl[])=>void){}
  get descriptors():readonly ScriptControl[]{return Object.freeze([...this.entries.values()].map(e=>Object.freeze({...e.descriptor})));}
  private register(descriptor:ScriptControl,callback:(checked?:boolean)=>ReturnType<ControlCallback>):void {
    if(!this.active())return;
    if(!/^[\w-]{1,60}$/.test(descriptor.id)||!descriptor.label.trim()||descriptor.label.length>120)throw Error('Controls need a stable id and a label of 1–120 characters.');
    if(this.entries.has(descriptor.id))throw Error('Control id already registered: '+descriptor.id);
    if(this.entries.size>=32)throw Error('Scripts can expose at most 32 controls.');
    this.entries.set(descriptor.id,{descriptor:Object.freeze(descriptor),callback});this.publish(this.descriptors);
  }
  button(options:{id:string;label:string;onClick:ControlCallback}):void {this.register({kind:'button',id:options.id,label:options.label},options.onClick);}
  checkbox(options:{id:string;label:string;checked:boolean;onChange:(checked:boolean)=>ReturnType<ControlCallback>}):void {
    this.register({kind:'checkbox',id:options.id,label:options.label,checked:options.checked},checked=>options.onChange(checked!));
  }
  /** Host input. Queued until the current script callback and engine input settle. */
  invoke(id:string,checked?:boolean):Promise<boolean> {
    const entry=this.entries.get(id);
    if(!entry || !this.active() || (entry.descriptor.kind==='checkbox' && typeof checked!=='boolean'))return Promise.resolve(false);
    return this.enqueue(async()=>{
      if(!this.active())return;
      if(entry.descriptor.kind==='checkbox'){entry.descriptor=Object.freeze({...entry.descriptor,checked:checked!});this.publish(this.descriptors);}
      return entry.callback(checked);
    });
  }
}
