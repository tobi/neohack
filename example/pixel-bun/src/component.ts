import { DungeonMap, loadArt } from './map';
import { heroArt } from './characters';
import { Neonethack, isSnapshot, type Transport } from '../../../lib/neonethack/typescript/client';
import { tools, toolMethods } from '../../../lib/neonethack/mcp/tools';
import { registerWebMcp, type WebMcpContext } from '../../../lib/neonethack/typescript/webmcp';
import type { Snapshot, Request } from 'neonethack/types';
export { Neonethack as default, Neonethack, Game, WorldError, UncertainExecution, Hero, Entity, Inventory, InventoryItem, direction, entities, defineBot, runBot } from '../../../lib/neonethack/typescript/client';
export { tools, registerWebMcp };
declare const __NEOHACK_ART__: Record<string,string>;
const artReady = loadArt(__NEOHACK_ART__);

/** Presentation only until the host explicitly supplies a transport. No global message listener. */
export class NeohackWorld extends HTMLElement {
  private map?: DungeonMap;
  private frame: Snapshot | null = null;
  private frames: Snapshot[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private transport?: Pick<Transport, 'send'>;
  private writable = false;
  private index = 0;
  private root = this.attachShadow({mode:'open'});
  private status: HTMLElement;
  private canvas: HTMLCanvasElement;
  private text: HTMLElement;
  constructor() {
    super();
    this.root.innerHTML = `<style>:host{display:block;position:relative;min-height:320px;height:100%;background:#10181d;color:#eee8d0;contain:content;font:14px system-ui} .surface{position:absolute;inset:0}canvas{display:block;width:100%;height:100%;image-rendering:pixelated;pointer-events:none}.hud{position:absolute;top:16px;left:16px;right:16px;display:flex;justify-content:space-between;gap:16px;pointer-events:none}span{background:#10181de8;padding:8px 12px}details{position:absolute;bottom:12px;left:12px;max-height:45%;overflow:auto;background:#10181df0;padding:8px}pre{white-space:pre-wrap;max-width:60ch}summary{cursor:pointer} :host([static]) details{display:none}</style><div class="surface"><canvas aria-label="NetHack world" role="img"></canvas></div><div class="hud"><span id="status">A world, waiting for a story.</span><span>READ ONLY</span></div><details><summary>Text observation</summary><pre></pre></details>`;
    this.canvas = this.root.querySelector('canvas')!;
    this.status = this.root.querySelector('#status')!;
    this.text = this.root.querySelector('pre')!;
  }
  connectedCallback() {
    this.map ??= new DungeonMap(this.canvas, () => {});
    void artReady.then(() => { if(this.isConnected) this.paint(); }).catch(error=>this.dispatchEvent(new CustomEvent('error',{detail:String(error)})));
    this.dispatchEvent(new CustomEvent('ready'));
  }
  disconnectedCallback() { this.pause(); this.map?.destroy(); this.map = undefined; }
  get snapshot() { return this.frame ? structuredClone(this.frame) : null; }
  set snapshot(value: Snapshot | null) {
    if(value && (!isSnapshot(value) || !Array.isArray(value.observation.world) || value.observation.world.length > 10000)) throw Error('Expected a public Snapshot');
    this.frame = value ? structuredClone(value) : null;
    this.paint();
    this.dispatchEvent(new CustomEvent('frame', {detail:this.snapshot}));
  }
  private paint() {
    const o = this.frame?.observation;
    this.map?.update(o ?? null, heroArt(this.getAttribute('role') ?? 'valkyrie'), this.getAttribute('seed') ?? '0');
    this.status.textContent = o ? `${o.location.depthLabel} · Level ${o.vitals.level ?? '?'} · HP ${o.vitals.health ?? '?'}/${o.vitals.maxHealth ?? '?'} · Turn ${o.turn}` : 'A world, waiting for a story.';
    this.text.textContent = o ? `${o.heard.join('\n')}\n${JSON.stringify(o, null, 2)}` : 'No observation supplied.';
  }
  loadReplay(frames: Snapshot[]) {
    if(!Array.isArray(frames) || frames.length > 100000) throw Error('Invalid replay');
    this.pause(); this.frames = structuredClone(frames); this.index = 0;
    this.snapshot = this.frames[0] ?? null;
  }
  seek(index: number) {
    if(!Number.isInteger(index) || index < 0 || index >= this.frames.length) throw Error('Frame outside replay');
    this.index = index; this.snapshot = this.frames[index]!;
    this.dispatchEvent(new CustomEvent('replayframe',{detail:{index,length:this.frames.length}}));
    return {index, length:this.frames.length};
  }
  play(interval = 250) {
    if(!Number.isFinite(interval) || interval < 50 || interval > 10000) throw Error('Interval must be 50–10000 ms');
    this.pause();
    this.timer = setInterval(() => { if(this.index + 1 >= this.frames.length) { this.pause(); this.dispatchEvent(new Event('replayend')); } else this.seek(this.index + 1); }, interval);
  }
  pause() { clearInterval(this.timer); this.timer = undefined; }
  /** Host opts into execution; default connections expose only catalog read-only tools. */
  connect(transport: Pick<Transport,'send'>, options: {writable?: boolean} = {}) {
    this.transport = transport; this.writable = options.writable === true;
    return new Neonethack({send: request => this.send(request), close: async () => { this.transport = undefined; }});
  }
  private async send(request: Request) {
    const tool = tools.find(t => toolMethods.get(t.name) === request.method);
    if(!tool || (!this.writable && !tool.annotations.readOnlyHint)) throw Error('This connection is read-only');
    if(!this.transport) throw Error('No game transport connected');
    const result = await this.transport.send(structuredClone(request));
    if(isSnapshot(result)) this.snapshot = result;
    return result;
  }
  async registerWebMcp(context?: WebMcpContext) {
    const actual = context ?? (document as Document & {modelContext?:WebMcpContext}).modelContext ?? (navigator as Navigator & {modelContext?:WebMcpContext}).modelContext;
    if(!actual) return {supported:false,toolCount:0,dispose(){}};
    const controller = new AbortController(), names:string[] = [];
    const dispose=()=>{controller.abort();for(const name of names.splice(0))actual.unregisterTool?.(name);};
    try {
      for(const tool of this.availableTools()) {
        await actual.registerTool({...tool,execute:async input=>{
          const response=await this.send({version:1,method:toolMethods.get(tool.name)!,params:input} as Request);
          return {content:[{type:'text',text:JSON.stringify(response)}],isError:'error' in response};
        }},{signal:controller.signal});
        names.push(tool.name);
      }
    } catch(error){dispose();throw error;}
    return {supported:true,toolCount:names.length,dispose};
  }
  private availableTools() { return this.transport ? tools.filter(t=>this.writable || t.annotations.readOnlyHint) : []; }
  /** JSON-RPC / WebMCP vocabulary, delivered on this element's message event. */
  async postMessage(message: {jsonrpc:'2.0'; id:string|number; method:string; params?:any}) {
    let reply: any;
    const m = structuredClone(message);
    try {
      if(m.jsonrpc !== '2.0' || !['string','number'].includes(typeof m.id)) throw Error('Expected JSON-RPC 2.0 and a correlation id');
      let result: unknown;
      switch(m.method) {
        case 'tools/list': result = {tools:this.availableTools()}; break;
        case 'tools/call': {
          const method = toolMethods.get(m.params?.name);
          if(!method) throw Error('Unknown tool');
          const response = await this.send({version:1,method,params:m.params.arguments ?? {}} as Request);
          result = {content:[{type:'text',text:JSON.stringify(response)}],structuredContent:response,isError:'error' in response}; break;
        }
        case 'world.snapshot': result = this.snapshot; break;
        case 'world.render': this.snapshot = m.params.snapshot; result = {}; break;
        case 'replay.load': this.loadReplay(m.params.frames); result = {length:this.frames.length}; break;
        case 'replay.seek': result = this.seek(m.params.index); break;
        case 'replay.play': this.play(m.params?.interval); result = {}; break;
        case 'replay.pause': this.pause(); result = {}; break;
        default: throw Error('Unknown method');
      }
      reply = {jsonrpc:'2.0',id:m.id,result};
    } catch(error) { reply = {jsonrpc:'2.0',id:m?.id ?? null,error:{code:-32602,message:String(error)}}; }
    this.dispatchEvent(new MessageEvent('message',{data:reply}));
    return reply;
  }
}
if(!customElements.get('neohack-world')) customElements.define('neohack-world',NeohackWorld);
