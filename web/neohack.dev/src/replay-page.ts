import './component';
import { NeohackWorld } from './component';
import { replayLink, embedCode } from './public-replay';
import { validReplayId } from './replay-links';
import { chronicleEligible, chronicleDraftView, chronicleView, fetchChronicle, requestChronicle, type ChronicleDocument } from './chronicle';
const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const id=location.pathname.split('/')[2]??'';
const viewer=$<NeohackWorld>('replay');
let summary:Record<string,unknown>={}, current:Record<string,unknown>={};
function renderDetails(id:string,values:unknown[][]){
  $(id).replaceChildren(...values.map(([label,value])=>{
    const item=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');
    dt.textContent=String(label);dd.textContent=value===undefined||value===null?'Not recorded':String(value);item.append(dt,dd);return item;
  }));
}
function details(){
  // The selected scene is authoritative for playback. Ledger totals describe a
  // later moment and must never replace its location, level, turn or outcome.
  renderDetails('run-details', [['Class',current.role],['Hero level',current.level],['Dungeon location',current.depth],['Turn',current.turn],['State',current.outcome]]);
  renderDetails('run-totals', [['Peak hero level',summary.maxLevel],['Deepest dungeon level',summary.maxDepth],['Recorded turns',summary.turn],['Last recorded location',summary.depthLabel],['Outcome',summary.endKind??(summary.ended===false?'Adventuring':undefined)],['Last recorded',typeof summary.updatedAt==='number'?new Date(summary.updatedAt).toLocaleString():undefined]]);
}
async function copy(id:string,success:string){
  const field=$<HTMLInputElement|HTMLTextAreaElement>(id);
  try{await navigator.clipboard.writeText(field.value);$('copy-status').textContent=success;}
  catch{field.focus();field.select();$('copy-status').textContent='Copy the selected text.';}
}
if(!validReplayId(id)){$('status').textContent='Invalid replay ID.';viewer.hidden=true;$('metadata-status').textContent='No run selected.';}
else {
  $('replay-id').textContent=id;
  $<HTMLInputElement>('share-url').value=replayLink(id);
  $<HTMLTextAreaElement>('embed-code').value=embedCode(id);
  $('copy-link').onclick=()=>void copy('share-url','Replay link copied.');
  $('copy-embed').onclick=()=>void copy('embed-code','Embed code copied.');
  viewer.addEventListener('frame',()=>{
    const s=viewer.snapshot;if(!s)return;
    current={...current,level:s.observation.vitals.level,depth:s.observation.location.depthLabel,turn:s.observation.turn,outcome:s.ended?s.end?.kind:'Adventuring'};details();
  });
  viewer.addEventListener('replaymetadata',event=>{current.role=(event as CustomEvent).detail.role;details();});
  viewer.addEventListener('replayload',event=>{$('status').textContent=`Replay ready · ${(event as CustomEvent).detail.length} recorded ${(event as CustomEvent).detail.format==='neonethack.inputs'?'actions':'frames'}.`;});
  viewer.addEventListener('error',event=>{if(event instanceof CustomEvent)$('status').textContent=String(event.detail);});
  viewer.setAttribute('src',replayLink(id));
  details();
  // Optional public ledger details never gate CDN playback or require sign-in.
  const ledger=fetch('/api/runs/'+encodeURIComponent(id),{credentials:'omit',signal:AbortSignal.timeout(10000)})
    .then(async response=>{if(!response.ok)throw Error('Details unavailable');summary=await response.json();
      if(typeof summary.name==='string'){$('replay-title').textContent=summary.name;document.title=summary.name+' · Replay · neohack';}
      $('metadata-status').textContent='Totals describe the full recording, independently of the selected moment.';details();return true;})
    .catch(()=>{$('metadata-status').textContent='Run totals and date are unavailable. Playback is still available.';return false;});
  void chronicle(ledger);
}

/** The chronicle is the first thing on the page when it exists, and a shared
 * link with ?view=chronicle scrolls straight to it. A dead hero deep enough
 * for a tale can have it told here; the story then streams in as it is written. */
async function chronicle(ledger:Promise<boolean>){
  const section=$('chronicle-section'),body=$('chronicle-body'),status=$('chronicle-status'),tell=$<HTMLButtonElement>('tell-tale'),copy=$<HTMLButtonElement>('copy-chronicle');
  const storyLink=()=>{const url=new URL(replayLink(id));url.searchParams.set('view','chronicle');return url.href;};
  const route=(open:boolean)=>{const url=new URL(location.href);if(open)url.searchParams.set('view','chronicle');else url.searchParams.delete('view');if(url.href!==location.href)history.replaceState(null,'',url);};
  const wanted=new URL(location.href).searchParams.get('view')==='chronicle';
  const show=(doc:ChronicleDocument)=>{
    body.replaceChildren(chronicleView(doc));
    section.hidden=false;tell.hidden=true;copy.hidden=false;status.textContent='';
    $('chronicle-lead').textContent=`An AI retelling of ${typeof summary.name==='string'?summary.name+"'s":'this'} recorded journey, written once from ${doc.coverage?.selectedEvents??'the'} witnessed moments.`;
    route(true);
  };
  copy.onclick=async()=>{try{await navigator.clipboard.writeText(storyLink());status.textContent='Story link copied.';}catch{status.textContent=storyLink();}};
  let doc:ChronicleDocument|null=null;
  try{doc=await fetchChronicle(id);}catch{status.textContent='The chronicle could not be read right now.';}
  if(doc){show(doc);if(wanted)section.scrollIntoView({block:'start'});return;}
  if(!(await ledger)||!chronicleEligible(summary as {ended?:boolean;endKind?:string;maxDepth?:number;maxLevel?:number}))return;
  section.hidden=false;tell.hidden=false;
  $('chronicle-lead').textContent=`${typeof summary.name==='string'?summary.name:'This hero'} died deep enough to deserve a story. The chronicler replays the recording and writes the tale from what was witnessed; it takes a little while and is kept with the replay.`;
  if(wanted)section.scrollIntoView({block:'start'});
  tell.onclick=async()=>{
    tell.disabled=true;
    const draft=chronicleDraftView(typeof summary.name==='string'?summary.name:undefined);
    body.replaceChildren(draft.element);route(true);
    try{show(await requestChronicle(id,{onStatus:text=>draft.status(text),onDraft:d=>draft.update(d)}));}
    catch(error){const message=error instanceof Error?error.message:'The chronicler could not finish this tale.';draft.status(message);status.textContent=message;tell.disabled=false;}
  };
}
