import { DungeonMap, loadArt } from './map';
import { DungeonSound } from './sound';
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
  static observedAttributes = ['src','autoplay','speed','sound','controls','loop','role','seed'];
  private loading?: AbortController;
  private sourceMessage?: string;
  private sourcePending = false;
  private audio?: DungeonSound;
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
    this.root.innerHTML = `<style>:host{display:block;position:relative;min-height:320px;height:100%;background:#10181d;color:#eee8d0;contain:content;font:14px system-ui} .surface{position:absolute;inset:0}canvas{display:block;width:100%;height:100%;image-rendering:pixelated;pointer-events:none}.hud{position:absolute;top:16px;left:16px;right:16px;display:flex;justify-content:space-between;gap:16px;pointer-events:none}span{background:#10181de8;padding:8px 12px}details{position:absolute;bottom:12px;left:12px;max-height:45%;overflow:auto;background:#10181df0;padding:8px}pre{white-space:pre-wrap;max-width:60ch}summary{cursor:pointer} :host([static]) details{display:none}
      .playback{position:absolute;bottom:0;left:0;right:0;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px;background:#10181df2}.playback[hidden]{display:none}button,select{min-height:44px;background:#25322f;color:inherit;border:1px solid #67745a;padding:6px 10px;font:inherit}input{min-width:70px;flex:1;accent-color:#b9ca9c;min-height:44px}button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid #e0c38a;outline-offset:2px}:host([controls]) details{bottom:124px}output{font-size:12px} .hud{font-size:12px}.hud span{min-width:0} @media(min-width:600px){:host([controls]) details{bottom:78px}}</style><div class="surface"><canvas aria-label="NetHack world" role="img"></canvas></div><div class="hud"><span id="status">A world, waiting for a story.</span><span>READ ONLY</span></div><details><summary>Text observation</summary><pre></pre></details><div class="playback" role="group" aria-label="Replay controls" hidden><button id="play" aria-label="Play replay">Play</button><input id="seek" type="range" min="0" max="0" value="0" aria-label="Replay frame"><output id="progress">No frames</output><select id="speed" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="4" selected>4×</option><option value="5">5×</option></select><button id="sound" aria-pressed="false">Sound: off</button></div>`;
    this.canvas = this.root.querySelector('canvas')!;
    this.status = this.root.querySelector('#status')!;
    this.text = this.root.querySelector('pre')!;
    this.root.querySelector('#play')!.addEventListener('click',()=>{void this.enableSound();this.timer ? this.pause() : this.play();});
    this.root.querySelector('#seek')!.addEventListener('input',event=>{this.pause();this.seek(Number((event.target as HTMLInputElement).value));});
    this.root.querySelector('#speed')!.addEventListener('change',event=>this.setAttribute('speed',(event.target as HTMLSelectElement).value));
    this.root.querySelector('#sound')!.addEventListener('click',()=>{
      if(this.audio?.enabled) this.removeAttribute('sound');
      else {this.setAttribute('sound','');void this.enableSound();}
    });
  }
  connectedCallback() {
    this.map ??= new DungeonMap(this.canvas, () => {});
    void artReady.then(() => { if(this.isConnected) this.paint(); }).catch(error=>this.dispatchEvent(new CustomEvent('error',{detail:String(error)})));
    this.updateControls();
    if(this.hasAttribute('src')) void this.loadSource();
    this.dispatchEvent(new CustomEvent('ready'));
  }
  disconnectedCallback() { this.loading?.abort(); this.audio?.dispose(); this.audio = undefined; this.pause(); this.map?.destroy(); this.map = undefined; }
  attributeChangedCallback(name:string, old:string|null, value:string|null) {
    if(old === value) return;
    if(name === 'src' && this.isConnected) void this.loadSource();
    if(name === 'speed' && this.timer) this.play();
    if(name === 'sound' && !this.flag('sound')) this.audio?.disable();
    if(name === 'autoplay' && this.isConnected) this.flag('autoplay') ? this.play() : this.pause();
    if(name === 'role' || name === 'seed') this.paint();
    this.updateControls();
  }
  private flag(name:string) { return this.hasAttribute(name) && this.getAttribute(name) !== 'false'; }
  private get speed() { const n=Number(this.getAttribute('speed') ?? 4);return Number.isFinite(n) && n >= .5 && n <= 5 ? n : 4; }
  private async enableSound() {
    if(!this.flag('sound')) return;
    this.audio ??= new DungeonSound(new URL('/audio/',import.meta.url).href);
    try { await this.audio.enable(); } catch { this.status.textContent='Sound could not start. Try Sound again.'; }
    this.updateControls();
  }
  private updateControls() {
    if(!this.root.querySelector('.playback')) return;
    (this.root.querySelector('.playback') as HTMLElement).hidden=!this.flag('controls');
    const play=this.root.querySelector('#play') as HTMLButtonElement;
    play.textContent=this.timer ? 'Pause' : 'Play'; play.setAttribute('aria-label',this.timer ? 'Pause replay' : 'Play replay');play.disabled=this.frames.length<2;
    const seek=this.root.querySelector('#seek') as HTMLInputElement;
    seek.max=String(Math.max(0,this.frames.length-1));seek.value=String(this.index);seek.disabled=!this.frames.length;
    this.root.querySelector("#progress")!.textContent=this.frames.length ? (this.index+1)+" / "+this.frames.length : this.sourcePending ? "Loading…" : this.sourceMessage ? "Unavailable" : "No frames";
    const speed=this.root.querySelector('#speed') as HTMLSelectElement;
    if(!Array.from(speed.options).some(o=>Number(o.value)===this.speed)) speed.add(new Option(this.speed+"×",String(this.speed)));
    speed.value=String(this.speed);
    const sound=this.root.querySelector('#sound')!;sound.textContent=this.audio?.enabled ? 'Sound: on' : 'Sound: off';sound.setAttribute('aria-pressed',String(!!this.audio?.enabled));
  }
  private async loadSource() {
    this.loading?.abort();const controller=this.loading=new AbortController();
    const source=this.getAttribute('src');
    this.sourcePending=!!source;this.sourceMessage=source?'Loading replay…':undefined;
    this.loadReplay([]);if(!source)return;
    try {
      const url=new URL(source,document.baseURI);
      if(!['http:','https:'].includes(url.protocol) || url.username || url.password)throw Error('Expected an HTTP replay URL');
      // A ledger link contains only its public run id, never a save capability.
      if(url.pathname==='/dashboard') {
        const id=url.searchParams.get('run');if(!id || !/^[\w-]{1,64}$/.test(id))throw Error('Ledger URL needs a run id');
        url.pathname='/api/runs/'+id+'/replay';url.search='';url.hash='';
      }
      const frames:Snapshot[]=[];let offset:number|null=0;
      do {
        if(offset)url.searchParams.set('offset',String(offset));
        const response=await fetch(url,{signal:controller.signal,credentials:'omit'});
        if(!response.ok) throw Error(response.status===404 ? 'Replay unavailable: no public frames were recorded for this run.' : 'Replay could not load.');
        const page=await response.json();
        if(controller.signal.aborted)return;
        const batch=Array.isArray(page)?page:page.frames;
        if(!Array.isArray(batch) || frames.length+batch.length>100000)throw Error('Invalid replay frames');
        frames.push(...batch);
        this.sourceMessage=`Loading replay… ${frames.length} frames received`;this.status.textContent=this.sourceMessage;
        const next=Array.isArray(page)?null:page.next ?? null;
        if(next!==null && (!Number.isSafeInteger(next)||next<=offset!||!batch.length))throw Error('Invalid replay pagination');
        offset=next;
        if(page.role)this.setAttribute('role',String(page.role));
        if(page.seed!==undefined)this.setAttribute('seed',String(page.seed));
      } while(offset!==null);
      if(controller.signal.aborted)return;
      this.sourcePending=false;this.sourceMessage=undefined;
      this.loadReplay(frames);
      if(!frames.length){this.sourceMessage='Replay unavailable: no frames recorded.';this.paint();this.updateControls();}
      this.dispatchEvent(new CustomEvent('replayload',{detail:{length:frames.length}}));
    } catch(error) {
      if(controller.signal.aborted)return;
      this.sourcePending=false;this.sourceMessage=error instanceof Error?error.message:String(error);
      this.paint();this.updateControls();
      this.dispatchEvent(new CustomEvent('error',{detail:this.status.textContent}));
    }
  }
  get snapshot() { return this.frame ? structuredClone(this.frame) : null; }
  set snapshot(value: Snapshot | null) {
    if(value && (typeof value!=='object' || !isSnapshot(value) || !Array.isArray(value.observation.world) || value.observation.world.length > 10000)) throw Error('Expected a public Snapshot');
    this.frame = value ? structuredClone(value) : null;
    this.paint();
    this.dispatchEvent(new CustomEvent('frame', {detail:this.snapshot}));
  }
  private paint() {
    const o = this.frame?.observation;
    this.map?.update(o ?? null, heroArt(this.getAttribute('role') ?? 'valkyrie'), this.getAttribute('seed') ?? '0', this.frame);
    this.canvas.setAttribute('aria-label', this.frame?.ended && this.frame.end?.kind === 'death' && o?.you ? 'NetHack world. A tombstone marks your final position.' : 'NetHack world');
    this.status.textContent = this.sourceMessage ?? (o ? `${o.location.depthLabel} · Level ${o.vitals.level ?? '?'} · HP ${o.vitals.health ?? '?'}/${o.vitals.maxHealth ?? '?'} · Turn ${o.turn}` : 'A world, waiting for a story.');
    this.text.textContent = o ? `${o.heard.join('\n')}\n${JSON.stringify(o, null, 2)}` : 'No observation supplied.';
  }
  loadReplay(frames: Snapshot[]) {
    if(!Array.isArray(frames) || frames.length > 100000 || frames.some(f=>!f || typeof f!=='object' || !isSnapshot(f) || !Array.isArray(f.observation.world) || f.observation.world.length>10000)) throw Error('Invalid replay');
    if(!this.sourcePending)this.sourceMessage=undefined;
    this.pause(); this.frames = structuredClone(frames); this.index = 0;
    this.snapshot = this.frames[0] ?? null;
    this.updateControls();
    if(this.isConnected && this.flag('autoplay'))this.play();
  }
  seek(index: number) {
    if(!Number.isInteger(index) || index < 0 || index >= this.frames.length) throw Error('Frame outside replay');
    if(index<this.index)this.audio?.reset();
    this.index = index; this.snapshot = this.frames[index]!;
    this.updateControls();
    this.dispatchEvent(new CustomEvent('replayframe',{detail:{index,length:this.frames.length}}));
    return {index, length:this.frames.length};
  }
  play(interval = 250 / this.speed) {
    if(!Number.isFinite(interval) || interval < 50 || interval > 10000) throw Error('Interval must be 50–10000 ms');
    this.pause();
    if(this.frames.length<2)return;
    if(this.index===this.frames.length-1)this.seek(0);
    this.timer = setInterval(() => {
      if(this.index + 1 >= this.frames.length) {
        if(this.flag('loop'))this.seek(0);
        else {this.pause();this.dispatchEvent(new Event('replayend'));}
      } else {
        const before=this.frame!;this.seek(this.index+1);
        this.audio?.observe(before,this.frame!,this.frame!.observation.heard);
      }
    }, interval);
    this.updateControls();
  }
  pause() { clearInterval(this.timer); this.timer = undefined; this.updateControls(); }
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
