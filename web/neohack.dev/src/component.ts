import { replayIdentity } from './replay-links';
import { displayText, type NameCorrection } from './public-names.mjs';
import { scrollbarStyles } from './scrollbars.mjs';
import { DungeonMap, loadArt } from './map';
import { DungeonSound } from './sound';
import { heroArt } from './characters';
import {InputPlayback} from './input-playback';
import {replayDocument} from '../../../lib/neonethack/wasm/protocol-reader.mjs';
import { Neonethack, isSnapshot, type Transport } from '../../../lib/neonethack/typescript/client';
import { McpService, tools, readOnlyTools } from '../../../lib/neonethack/mcp/service';
import {valid,type Schema} from '../../../lib/neonethack/mcp/schema';
import { catalog } from '../../../lib/neonethack/mcp/protocol-data';
import { registerWebMcp, type WebMcpContext, type WebMcpRegistration } from '../../../lib/neonethack/typescript/webmcp';
import type { Snapshot, Request } from 'neonethack/types';
export { Neonethack as default, Neonethack, Game, WorldError, UncertainExecution, Hero, Entity, Inventory, InventoryItem, direction, entities, defineBot, runBot } from '../../../lib/neonethack/typescript/client';
export { tools, readOnlyTools, registerWebMcp };
declare const __NEOHACK_ART__: Record<string,string>;
const artReady = loadArt(__NEOHACK_ART__);

/** Presentation only until the host explicitly supplies a transport. No global message listener. */
export class NeohackWorld extends HTMLElement {
  static observedAttributes = ['src','autoplay','speed','sound','controls','loop','role','seed'];
  private loading?: AbortController;
  private sourceMessage?: string;
  private sourcePending = false;
  private sourceTotal?: number;
  private nameOverride?: NameCorrection;
  private audio?: DungeonSound;
  private map?: DungeonMap;
  private frame: Snapshot | null = null;
  private frames: Snapshot[] = [];
  private inputPlayback?:InputPlayback;
  private inputStepping=false;
  private timer?: ReturnType<typeof setInterval>;
  private transport?: Pick<Transport, 'send'>;
  private writable = false;
  private connectionId = 0;
  private agent?: McpService;
  private agentTransport?: Pick<Transport, 'send'>;
  private registrations = new Set<WebMcpRegistration>();
  private index = 0;
  private root = this.attachShadow({mode:'open'});
  private status: HTMLElement;
  private canvas: HTMLCanvasElement;
  private text: HTMLElement;
  constructor() {
    super();
    this.root.innerHTML = `<style>${scrollbarStyles}:host{display:block;position:relative;min-height:320px;height:100%;background:#10181d;color:#eee8d0;contain:content;font:14px system-ui} .surface{position:absolute;inset:0}canvas{display:block;width:100%;height:100%;image-rendering:pixelated;pointer-events:none}.hud{position:absolute;top:16px;left:16px;right:16px;display:flex;justify-content:space-between;gap:16px;pointer-events:none}span{background:#10181de8;padding:8px 12px}details{position:absolute;bottom:12px;left:12px;max-height:45%;overflow:auto;background:#10181df0;padding:8px}pre{white-space:pre-wrap;max-width:60ch}summary{cursor:pointer} :host([static]) details{display:none}
      .playback{position:absolute;bottom:0;left:0;right:0;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px;background:#10181df2}.playback[hidden]{display:none}button,select,.playback a{box-sizing:border-box;min-height:44px;background:#25322f;color:inherit;border:1px solid #67745a;padding:6px 10px;font:inherit}input{min-width:70px;flex:1;accent-color:#b9ca9c;min-height:44px}button:focus-visible,.playback a:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid #e0c38a;outline-offset:2px}:host([controls]) details{bottom:124px}output{font-size:12px} .playback a{flex:none;align-self:flex-end;margin-left:auto;text-align:center;text-decoration:none;white-space:nowrap;font-size:12px;line-height:1.2}.hud{font-size:12px}.hud span{min-width:0} @media(min-width:600px){:host([controls]) details{bottom:78px}}</style><div class="surface"><canvas aria-label="NetHack world" role="img"></canvas></div><div class="hud"><span id="status">A world, waiting for a story.</span><span id="read-only">READ ONLY</span></div><details><summary>Text observation</summary><pre></pre></details><div class="playback" role="group" aria-label="Replay controls" hidden><button id="play" aria-label="Play replay">Play</button><input id="seek" type="range" min="0" max="0" value="0" aria-label="Replay frame"><output id="progress">No frames</output><select id="speed" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="4" selected>4×</option><option value="5">5×</option><option value="10">10×</option><option value="20">20×</option></select><a id="replay-page" href="${new URL('/',import.meta.url).href}" target="_blank" rel="noopener" aria-label="Open neohack.dev">Open<br>neohack.dev</a></div>`;
    this.canvas = this.root.querySelector('canvas')!;
    this.status = this.root.querySelector('#status')!;
    this.text = this.root.querySelector('pre')!;
    this.root.querySelector('#play')!.addEventListener('click',()=>{void this.enableSound();this.timer ? this.pause() : this.play();});
    this.root.querySelector('#seek')!.addEventListener('input',event=>{const index=Number((event.target as HTMLInputElement).value);this.pause();void Promise.resolve(this.seek(index)).catch(()=>{});});
    this.root.querySelector('#speed')!.addEventListener('change',event=>this.setAttribute('speed',(event.target as HTMLSelectElement).value));
  }
  connectedCallback() {
    this.map ??= new DungeonMap(this.canvas, () => {});
    void artReady.then(() => { if(this.isConnected) this.paint(); }).catch(error=>this.dispatchEvent(new CustomEvent('error',{detail:String(error)})));
    this.updateControls();
    if(this.hasAttribute('src')) void this.loadSource();
    this.dispatchEvent(new CustomEvent('ready'));
  }
  disconnectedCallback() { this.loading?.abort();const player=this.inputPlayback;this.inputPlayback=undefined;this.inputStepping=false;void player?.close(); this.audio?.dispose(); this.audio = undefined; this.pause(); this.map?.destroy(); this.map = undefined; }
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
  private get speed() { const n=Number(this.getAttribute('speed') ?? 4);return Number.isFinite(n) && n >= .5 && n <= 20 ? n : 4; }
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
    play.textContent=this.timer ? 'Pause' : 'Play'; play.setAttribute('aria-label',this.timer ? 'Pause replay' : 'Play replay');play.disabled=this.frames.length<2 && !(this.sourcePending && this.frames.length);
    const seek=this.root.querySelector('#seek') as HTMLInputElement;
    seek.max=String(Math.max(0,this.frames.length-1));seek.value=String(this.index);seek.disabled=!this.frames.length;
    this.root.querySelector("#progress")!.textContent=this.frames.length ? (this.index+1)+" / "+(this.sourceTotal ?? this.frames.length)+(this.sourcePending ? " · "+this.frames.length+" buffered" : "") : this.sourcePending ? "Loading…" : this.sourceMessage ? "Unavailable" : "No frames";
    const speed=this.root.querySelector('#speed') as HTMLSelectElement;
    if(!Array.from(speed.options).some(o=>Number(o.value)===this.speed)) speed.add(new Option(this.speed+"×",String(this.speed)));
    speed.value=String(this.speed);
    if(this.inputPlayback){
      play.disabled=this.sourcePending||!this.sourceTotal;
      seek.max=String(Math.max(0,(this.sourceTotal??1)-1));seek.value=String(this.index);seek.disabled=this.inputStepping||this.sourcePending;
      this.root.querySelector('#progress')!.textContent=this.sourcePending?'Loading…':`${this.index+1} / ${this.sourceTotal} actions`;
    }
  }
  private async loadSource() {
    this.loadReplay([]);
    const controller=this.loading=new AbortController(), source=this.getAttribute('src');
    this.sourcePending=!!source;this.sourceMessage=source?'Loading replay…':undefined;
    this.paint();this.updateControls();if(!source)return;
    try {
      const url=new URL(source,document.baseURI);
      if(!['http:','https:'].includes(url.protocol) || url.username || url.password)throw Error('Expected an HTTP replay URL');
      const identity=replayIdentity(source,document.baseURI,import.meta.url);
      const privateId=url.pathname.match(/^\/api\/account\/runs\/([\w-]{1,100})\/frames$/)?.[1];
      if(privateId)this.root.querySelector('#read-only')!.textContent='Private replay '+privateId+' · READ ONLY';
      const link=this.root.querySelector<HTMLAnchorElement>('#replay-page')!;
      if(identity)link.href=identity.href;
      if(url.pathname==='/dashboard' || /^\/replays\/[\w-]{1,64}\/?$/.test(url.pathname)) {
        const id=identity?.id;if(!id || !/^[\w-]{1,64}$/.test(id))throw Error('Ledger URL needs a run id');
        const configResponse=await fetch(new URL('/replay-config.json',url),{signal:controller.signal,credentials:'omit'});
        if(!configResponse.ok)throw Error('Public replay delivery is unavailable');
        const config=await configResponse.json();
        if(typeof config.base!=='string'||!config.base)throw Error('Public replay delivery is not configured');
        const base=new URL(config.base,url);
        if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw Error('Invalid replay origin');
        url.href=new URL('replays/'+id+'/manifest.json',base.href.endsWith('/')?base.href:base.href+'/').href;
      }
      if(url.pathname.startsWith('/api/account/'))url.searchParams.set('limit','3');
      const get=async(target:URL)=>{
        const privateSource=target.origin===location.origin && target.pathname.startsWith('/api/account/');
        const response=await fetch(target,{signal:controller.signal,credentials:privateSource?'same-origin':'omit'});
        if(!response.ok)throw Error(response.status===404?'Replay unavailable: no public frames were recorded for this run.':'Replay could not load.');
        return replayDocument(response);
      };
      let page=await get(url), offset=0;
      this.nameOverride = page.nameOverride;
      if(controller.signal.aborted)return;
      this.dispatchEvent(new CustomEvent('replaymetadata',{detail:{id:identity?.id,role:page.role,count:page.count,partial:page.partial,complete:page.complete,summary:page.summary}}));
      if(page.role)this.setAttribute('role',String(page.role));
      if(page.seed!==undefined)this.setAttribute('seed',String(page.seed));
      if(page.format==='neonethack.inputs'){
        const player=this.inputPlayback=new InputPlayback(page,url,controller.signal);
        this.sourceTotal=page.count;this.updateControls();
        const frame=await player.seek(0);
        if(controller.signal.aborted)return;
        this.index=0;this.snapshot=frame;this.sourceMessage=undefined;this.sourcePending=false;
        this.paint();this.updateControls();
        this.dispatchEvent(new CustomEvent('replayprogress',{detail:{length:page.count,total:page.count,format:page.format}}));
        this.dispatchEvent(new CustomEvent('replayload',{detail:{length:page.count,format:page.format}}));
        if(this.flag('autoplay'))this.play();
        return;
      }
      const append=(batch:Snapshot[])=>{
        if(!Array.isArray(batch)||this.frames.length+batch.length>100000||batch.some(f=>!f||typeof f!=='object'||!isSnapshot(f)||!Array.isArray(f.observation.world)||f.observation.world.length>10000))throw Error('Invalid replay frames');
        const first=this.frames.length===0;
        this.frames.push(...batch);this.sourceMessage=undefined;
        if(first && batch.length)this.snapshot=batch[0]!;
        this.updateControls();
        if(first && batch.length && this.isConnected && this.flag('autoplay'))this.play();
        this.dispatchEvent(new CustomEvent('replayprogress',{detail:{length:this.frames.length,total:this.sourceTotal}}));
      };
      if(Array.isArray(page.chunks)) {
        if(page.version!==1||!Number.isSafeInteger(page.count)||page.count<0||page.count>100000||page.chunks.length>100000)throw Error('Invalid replay manifest');
        this.sourceTotal=page.count;
        for(const path of page.chunks) {
          if(controller.signal.aborted)return;
          if(typeof path!=='string')throw Error('Invalid replay chunk');
          const chunk=new URL(path,url);
          if(chunk.origin!==url.origin||!chunk.pathname.startsWith(new URL('./chunks/',url).pathname)||chunk.username||chunk.password||!/^\/[\w/.-]+\.json$/.test(chunk.pathname))throw Error('Invalid replay chunk URL');
          const result=await get(chunk);if(controller.signal.aborted)return;
          append(result.frames);
        }
        if(this.frames.length!==this.sourceTotal)throw Error('Replay length differs');
      } else {
        while(true) {
          if(controller.signal.aborted)return;
          const batch=Array.isArray(page)?page:page.frames;
          const next=Array.isArray(page)?null:page.next??null;
          if(next!==null && (!Number.isSafeInteger(next)||next!==offset+batch?.length||next<=offset))throw Error('Invalid replay pagination');
          append(batch);if(next===null)break;
          offset=next;url.searchParams.set('offset',String(offset));url.searchParams.set('limit','25');
          page=await get(url);
        }
      }
      if(controller.signal.aborted)return;
      this.sourcePending=false;
      if(!this.frames.length)this.sourceMessage='Replay unavailable: no frames recorded.';
      this.paint();this.updateControls();
      this.dispatchEvent(new CustomEvent('replayload',{detail:{length:this.frames.length}}));
    } catch(error) {
      if(controller.signal.aborted)return;
      this.sourcePending=false;this.sourceMessage=(this.frames.length?'Replay interrupted. Buffered frames remain available. ':'')+(error instanceof Error?error.message:String(error));
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
    this.text.textContent = displayText(o ? `${o.heard.join('\n')}\n${JSON.stringify(o, null, 2)}` : 'No observation supplied.', this.nameOverride);
  }
  loadReplay(frames: Snapshot[]) {
    this.nameOverride = undefined;
    void this.inputPlayback?.close();this.inputPlayback=undefined;
    if(!Array.isArray(frames) || frames.length > 100000 || frames.some(f=>!f || typeof f!=='object' || !isSnapshot(f) || !Array.isArray(f.observation.world) || f.observation.world.length>10000)) throw Error('Invalid replay');
    this.root.querySelector<HTMLAnchorElement>('#replay-page')!.href=new URL('/',import.meta.url).href;
    this.root.querySelector('#read-only')!.textContent='READ ONLY';
    this.loading?.abort();this.sourcePending=false;this.sourceTotal=undefined;this.sourceMessage=undefined;
    this.pause(); this.frames = structuredClone(frames); this.index = 0;
    this.snapshot = this.frames[0] ?? null;
    this.updateControls();
    if(this.isConnected && this.flag('autoplay'))this.play();
  }
  seek(index: number) {
    if(this.inputPlayback)return this.seekInput(index);
    if(!Number.isInteger(index) || index < 0 || index >= this.frames.length) throw Error('Frame outside replay');
    if(index<this.index)this.audio?.reset();
    this.index = index; this.snapshot = this.frames[index]!;
    this.updateControls();
    this.dispatchEvent(new CustomEvent('replayframe',{detail:{index,length:this.frames.length}}));
    return {index, length:this.frames.length};
  }
  private async seekInput(index:number){
    const player=this.inputPlayback!;this.inputStepping=true;this.updateControls();
    try {
      const frame=await player.seek(index);
      if(this.inputPlayback!==player)return {index,length:player.manifest.count};
      const before=this.frame;this.index=index;this.snapshot=frame;
      if(before)this.audio?.observe(before,frame,frame.observation.heard);
      this.dispatchEvent(new CustomEvent('replayframe',{detail:{index,length:player.manifest.count}}));
      return {index,length:player.manifest.count};
    }catch(error){
      if(this.inputPlayback!==player)return {index,length:player.manifest.count};
      this.pause();this.sourceMessage=error instanceof Error?error.message:String(error);this.paint();throw error;
    }finally{if(this.inputPlayback===player){this.inputStepping=false;this.updateControls();}}
  }
  play(interval = 250 / this.speed) {
    if(!Number.isFinite(interval) || interval < 12.5 || interval > 10000) throw Error('Interval must be 12.5–10000 ms');
    this.pause();
    if(this.inputPlayback){
      if(this.index+1>=(this.sourceTotal??0) && !this.inputStepping)void this.seekInput(0).catch(()=>{});
      this.timer=setInterval(()=>{
        if(this.inputStepping)return;
        if(this.index+1>=(this.sourceTotal??0)){
          if(this.flag('loop'))void this.seekInput(0).catch(()=>{});
          else{this.pause();this.dispatchEvent(new Event('replayend'));}
        }else void this.seekInput(this.index+1).catch(()=>{});
      },interval);
      this.updateControls();return;
    }
    if(this.frames.length<2 && !(this.sourcePending && this.frames.length))return;
    if(this.index===this.frames.length-1 && !this.sourcePending && !this.sourceMessage)this.seek(0);
    this.timer = setInterval(() => {
      if(this.index + 1 >= this.frames.length) {
        if(this.sourcePending)return; // Buffer at the frontier; never loop or end a partial download.
        if(this.flag('loop') && !this.sourceMessage)this.seek(0);
        else {this.pause();if(!this.sourceMessage)this.dispatchEvent(new Event('replayend'));}
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
    this.disconnectTransport();
    this.transport = transport; this.writable = options.writable === true;
    const connectionId = this.connectionId;
    const guarded = this.agentTransport = {send: (request: Request) => this.send(request, connectionId)};
    this.agent = new McpService(guarded);
    return new Neonethack({...guarded, close: async () => {
      if(this.connectionId === connectionId) this.disconnectTransport();
    }});
  }
  private disconnectTransport() {
    this.connectionId++;
    for(const registration of this.registrations) registration.dispose();
    this.registrations.clear();
    this.transport = undefined;
    this.agentTransport = undefined;
    this.agent = undefined;
  }
  private async send(request: Request, connectionId = this.connectionId) {
    if(connectionId !== this.connectionId || !this.transport) throw Error('No game transport connected');
    // Capability admission for the public low client, not another tool dispatcher.
    const method = catalog.methods.find(method => method.name === request.method);
    if(!method || (!this.writable && !method.readOnly)) throw Error('This connection is read-only');
    const result = await this.transport.send(structuredClone(request));
    if(connectionId === this.connectionId && isSnapshot(result)) this.snapshot = result;
    return result;
  }
  async registerWebMcp(context?: WebMcpContext) {
    if(!this.agentTransport || !this.agent) return {supported:false,toolCount:0,dispose(){}};
    const connectionId = this.connectionId;
    const shared = await registerWebMcp(this.agentTransport, context, {
      service: this.agent, tools: this.availableTools(),
    });
    const registration = {...shared, dispose: () => {
      this.registrations.delete(registration);
      shared.dispose();
    }};
    if(connectionId !== this.connectionId) registration.dispose();
    else this.registrations.add(registration);
    return registration;
  }
  private availableTools() { return this.transport ? this.writable?tools:readOnlyTools : []; }
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
          const tool=this.availableTools().find(tool => tool.name === m.params?.name);
          if(!this.agent || !tool || !valid(m.params.arguments??{},tool.inputSchema as Schema)) throw Error('Tool variant is unavailable on this connection');
          result = await this.agent.call(m.params.name, m.params.arguments ?? {}); break;
        }
        case 'world.snapshot': result = this.snapshot; break;
        case 'world.render': this.snapshot = m.params.snapshot; result = {}; break;
        case 'replay.load': this.loadReplay(m.params.frames); result = {length:this.frames.length}; break;
        case 'replay.seek': result = await this.seek(m.params.index); break;
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
