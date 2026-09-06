import type { Snapshot } from 'neonethack/types';
export function replayLink(id:string) { return new URL('/dashboard?run='+encodeURIComponent(id),location.origin).href; }
export function embedCode(id:string) {
  return '<script type="module" src="'+location.origin+'/component/neohack.js"></script>\n<neohack-world src="'+replayLink(id)+'" autoplay speed="4" controls style="height:480px"></neohack-world>';
}
/** Optional browser-reported public presentation; never a durability receipt. */
export class PublicReplayRecorder {
  private tail=Promise.resolve();private revision=-1;private index=0;private pending=0;private failed=false;private prepared=false;private savedRevision=-1;
  constructor(private id:string,private vault:string,private prepare:()=>Promise<void>,private status:(message:string)=>void) {}
  record(frame:Snapshot) {
    if(this.failed || frame.revision<=this.revision)return;
    this.revision=frame.revision;
    if(this.pending>=100){this.failed=true;this.status('Public replay stopped: upload queue full.');return;}
    const copy=structuredClone(frame);delete copy.observation.neighborhood;this.pending++;
    this.tail=this.tail.then(async()=>{
      if(this.failed)return;
      if(!this.prepared){
        await this.prepare();
        const existing=await fetch('/api/runs/'+encodeURIComponent(this.id)+'/replay');
        if(existing.ok){const data=await existing.json();if(!Number.isSafeInteger(data.count)||data.count<0||!Number.isSafeInteger(data.revision))throw Error('Invalid recording metadata');this.index=data.count;this.savedRevision=data.revision;}
        else if(existing.status!==404)throw Error('Could not inspect recording');
        this.prepared=true;
      }
      if(copy.revision<=this.savedRevision)return;
      const response=await fetch('/api/runs/'+encodeURIComponent(this.id)+'/replay',{method:'PUT',headers:{'content-type':'application/json',authorization:'Bearer '+this.vault},body:JSON.stringify({index:this.index,frame:copy})});
      if(!response.ok)throw Error('Upload failed ('+response.status+')');
      this.savedRevision=copy.revision;this.index++;this.status('Public replay saved · recording from this visit.');
    }).catch(()=>{this.failed=true;this.status('Public replay recording stopped. Saved frames remain available.');}).finally(()=>this.pending--);
  }
  async flush(){await this.tail;return this.index>0;}
}
