import type { Snapshot } from 'neonethack/types';
export async function accountApi(path = '', body?: unknown, method = 'POST') {
  let response: Response;
  try {
    response = await fetch('/api/account'+path, {
      method: body === undefined ? 'GET' : method,
      cache: 'no-store',
      headers: {accept:'application/json', ...(body === undefined ? {} : {'content-type':'application/json'})},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Error('Couldn’t reach the account service. Check your connection and try again.');
  }
  // A platform failure can return plain text or HTML before our handler starts.
  // Never expose that body or retry a credential ceremony automatically.
  if(response.status >= 500) throw Error('The account service is temporarily unavailable. Please try again in a moment.');
  let data: any;
  try { data = await response.json(); }
  catch { throw Error('The account service returned an unreadable response. Please try again.'); }
  if(!response.ok) throw Error(typeof data?.error === 'string' ? data.error : `Account request failed (${response.status})`);
  if(data === null || typeof data !== 'object') throw Error('The account service returned an unreadable response. Please try again.');
  return data;
}
export interface BotSource {
  version: 1;
  entrypoint: 'main.ts';
  files: Record<string,string>;
  compiledFiles: Record<string,string>;
  compiler: { name: 'typescript'; version: string };
  autoloot?: import('neonethack/types').AutomaticPickup;
}
type RunMetadata = {name:string;role:string;seed?:string|number;buildId:string;control?:'bot'|'interactive';source?:BotSource};
/** Optional account copy, never part of the engine's durability contract. */
export class RunRecorder {
  readonly id = crypto.randomUUID();
  private index = 0;
  private revision = -1;
  private noteIndex = 0;
  private tail = Promise.resolve();
  private pending = 0;
  private failed = false;
  constructor(private metadata: RunMetadata, private status: (message:string)=>void = ()=>{}) {
    this.metadata = structuredClone({control:'interactive',...metadata});
    window.addEventListener('accountchange',()=>{this.failed=true;this.status('Recording stopped: account changed.');},{once:true});
  }
  record(frame: Snapshot) {
    if(this.failed || frame.revision <= this.revision) return;
    this.revision = frame.revision;
    if(this.pending >= 100) { this.failed = true; this.status('Account recording stopped: upload queue full.'); return; }
    this.pending++;
    const copy = structuredClone(frame);
    // Optional action-query expansion is large and unnecessary for presentation.
    // Keep all world perception, events and decisions; the engine journal is separate.
    delete copy.observation.neighborhood;
    this.tail = this.tail.then(async()=>{
      if(this.failed) return;
      this.status('Saving replay…');
      const {source,...metadata} = this.metadata;
      await accountApi(`/runs/${this.id}/frames`,{...metadata,...(this.index===0 && source ? {source} : {}),index:this.index,frame:copy},'PUT');
      this.index++; this.status('Replay saved');
    }).catch(error=>{this.failed=true;this.status(`Recording stopped: ${error.message}. Saved frames, if any, remain in your history.`);}).finally(()=>{this.pending--;});
  }
  note(entry:import('../../../lib/neonethack/typescript/script').ScriptJournalEntry) {
    if(this.failed || this.metadata.control!=='bot')return;
    if(this.pending>=100){this.failed=true;this.status('Account recording stopped: upload queue full.');return;}
    this.pending++;const copy=structuredClone(entry);
    this.tail=this.tail.then(async()=>{
      if(this.failed)return;
      await accountApi(`/runs/${this.id}/journal`,{index:this.noteIndex,entry:copy},'PUT');this.noteIndex++;
    }).catch(error=>{this.failed=true;this.status(`Script journal recording stopped: ${error.message}`);}).finally(()=>{this.pending--;});
  }
  async flush() { await this.tail; return !this.failed; }
}
