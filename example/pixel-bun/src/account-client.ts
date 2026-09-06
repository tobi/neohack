import type { Snapshot } from 'neonethack/types';
export async function accountApi(path = '', body?: unknown, method = 'POST') {
  const response = await fetch('/api/account'+path,{method:body === undefined ? 'GET' : method,headers:body === undefined ? {} : {'content-type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)});
  const data = await response.json();
  if(!response.ok) throw Error(data.error ?? `Account request failed (${response.status})`);
  return data;
}
/** Optional account copy, never part of the engine's durability contract. */
export class RunRecorder {
  readonly id = crypto.randomUUID();
  private index = 0;
  private revision = -1;
  private tail = Promise.resolve();
  private pending = 0;
  private failed = false;
  constructor(private metadata: {name:string;role:string;seed?:string|number;buildId:string}, private status: (message:string)=>void = ()=>{}) {
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
      await accountApi(`/runs/${this.id}/frames`,{...this.metadata,index:this.index,frame:copy},'PUT');
      this.index++; this.status('Replay saved');
    }).catch(error=>{this.failed=true;this.status(`Recording stopped: ${error.message}. Saved frames, if any, remain in your history.`);}).finally(()=>{this.pending--;});
  }
  async flush() { await this.tail; }
}
