import './component';
import { accountApi } from './account-client';
import { NeohackWorld } from './component';
const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const status = $('status');
async function refresh() {
  const oldViewer=$('replay') as NeohackWorld;oldViewer.removeAttribute('src');oldViewer.loadReplay([]);$('playback').hidden=true;
  let user;
  try { user = await accountApi(); } catch { $('auth').hidden=false; $('account').hidden=true; $('playback').hidden=true; ($('replay') as NeohackWorld).loadReplay([]); $('runs').replaceChildren(); return; }
  $('auth').hidden=true; $('account').hidden=false; $('handle').textContent=user.name;
  const runs = await accountApi('/runs');
  $('runs').replaceChildren();
  if(!runs.length) $('runs').textContent='Your story starts here. Play a run or test a bot while signed in to record it.';
  for(const run of runs) {
    const card = document.createElement('article'); card.className='run';
    const title = document.createElement('h3'); title.textContent=run.name;
    const detail = document.createElement('p'); detail.textContent=`${run.control==='bot'?'Automated bot':run.control==='interactive'?'Interactive run':'Run type not recorded'} · ${run.role} · ${run.depth} · Level ${run.level ?? '?'} (peak ${run.maxLevel}) · ${run.turn} turns · ${run.outcome}`;
    const depths = document.createElement('p'); depths.className='muted'; depths.textContent=`Reached: ${run.locations.join(' → ')}. ${run.partial?'Recording begins partway through this run.':'Recorded from the first observation.'}`;
    const button = document.createElement('button'); button.textContent=`Replay ${run.count} ${run.inputRun?'actions':'frames'}`;
    button.onclick=()=>void busy(async()=>{
      const viewer = $('replay') as NeohackWorld;
      viewer.setAttribute('role',run.role); viewer.setAttribute('seed',String(run.seed ?? 0));
      $('playback').hidden=false;
      viewer.setAttribute('autoplay','');
      viewer.setAttribute('src',run.replayUrl??'/api/account/runs/'+encodeURIComponent(run.id)+'/frames');
      const scrub = $<HTMLInputElement>('scrub');scrub.max='0';scrub.value='0';scrub.disabled=true;
      scrub.oninput=()=>{viewer.pause();void Promise.resolve(viewer.seek(Number(scrub.value))).catch(()=>{});};
      $('play').onclick=()=>viewer.play(Number($<HTMLSelectElement>('speed').value));
      $('pause').onclick=()=>viewer.pause();
      $('playback').scrollIntoView({behavior:'smooth'});
      status.textContent='Loading your recording…';
    });
    card.append(title,detail,depths,button);
    const sharing=document.createElement('p');
    sharing.textContent=run.inputRun?'Anyone with this replay link can watch.':run.publishedCount>0?'Public replay · '+run.publishedCount+' frames published.':run.publicId?'Publication pending · your private recording is retained.':'Private recording · only you can view it.';
    card.append(sharing);
    if(run.publicId && run.publishedCount>0) {
      const link=document.createElement('a');link.href='/dashboard?run='+encodeURIComponent(run.publicId);link.textContent='Open public replay';card.append(link);
    }
    if(!run.inputRun&&(!run.publicId || (run.publishedCount??0)<run.count)) {
      const publish=document.createElement('button');publish.textContent=run.publicId?'Update public replay':'Make public';
      const explanation=document.createElement('p');explanation.className='muted';explanation.textContent='Anyone will be able to watch this run and future recorded frames. Your save, script source and script notes stay private. Published copies may be retained by viewers.';
      publish.onclick=()=>void busy(async()=>{
        await accountApi('/runs/'+encodeURIComponent(run.id)+'/publish',{public:true},'POST');
        await refresh();status.textContent='Your replay is public. Share its public replay link.';
      });
      card.append(explanation,publish);
    }
    if(run.automated) {
      const sourceButton=document.createElement('button'); sourceButton.textContent='View bot source';
      sourceButton.onclick=()=>void busy(async()=>{
        const saved=await accountApi(`/runs/${run.id}/source`);
        if(!card.isConnected)return;
        const source=JSON.parse(saved.artifact);
        const section=document.createElement('details'); section.open=true;
        const summary=document.createElement('summary'); summary.textContent='Recorded bot source'; section.append(summary);
        const provenance=document.createElement('p'); provenance.style.overflowWrap='anywhere'; provenance.textContent=`TypeScript ${source.compiler.version} · Entry: ${source.entrypoint} · SHA-256: ${saved.sha256}. Browser-reported source.`; section.append(provenance);
        for(const [name,code] of Object.entries(source.files)) {
          const heading=document.createElement('h4'); heading.textContent=name;
          const pre=document.createElement('pre'); pre.textContent=String(code); section.append(heading,pre);
        }
        const download=document.createElement('button'); download.textContent='Download source and compiled script';
        download.onclick=()=>{
          const url=URL.createObjectURL(new Blob([saved.artifact],{type:'application/json'}));
          const link=document.createElement('a'); link.href=url; link.download=`bot-${run.id}.json`; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
        };
        section.append(download); sourceButton.replaceWith(section); status.textContent='Source captured when this test started.';
      });
      card.append(sourceButton);
      const journalButton=document.createElement('button');journalButton.textContent='View script journal';
      journalButton.onclick=()=>void busy(async()=>{
        const entries=[];let offset:number|null=0;
        do {const page=await accountApi(`/runs/${run.id}/journal?offset=${offset}`);entries.push(...page.entries);offset=page.next;}while(offset!==null);
        if(!card.isConnected)return;
        const section=document.createElement('details');section.open=true;
        const heading=document.createElement('summary');heading.textContent='Script journal · browser-reported commentary';section.append(heading);
        const notes=document.createElement('pre');notes.textContent=entries.map(note=>`[Script · ${note.author} · Turn ${note.turn}] ${note.text}`).join('\n') || 'No script notes recorded.';
        section.append(notes);journalButton.replaceWith(section);
      });card.append(journalButton);
    }
    $('runs').append(card);
  }
}
async function busy(action:()=>Promise<void>) {
  const buttons = [...document.querySelectorAll('button')]; buttons.forEach(b=>b.disabled=true); status.textContent='Working…';
  try { await action(); } catch(error) { status.textContent=String(error); } finally { buttons.forEach(b=>b.disabled=false); }
}
$('replay').addEventListener('replayprogress',event=>{const detail=(event as CustomEvent).detail;const scrub=$<HTMLInputElement>('scrub');scrub.max=String(Math.max(0,detail.length-1));scrub.disabled=!detail.length;status.textContent=detail.length+(detail.format==='neonethack.inputs'?' recorded actions. Playback is ready.':' frames buffered. Playback can begin.');});
$('replay').addEventListener('replayframe',event=>{$<HTMLInputElement>('scrub').value=String((event as CustomEvent).detail.index);});
$('replay').addEventListener('replayload',()=>{status.textContent='Recording loaded. These are browser-reported observations.';});
$('replay').addEventListener('error',event=>{if(event instanceof CustomEvent)status.textContent=String(event.detail);});
window.addEventListener('accountchange',()=>void refresh().catch(error=>{status.textContent=String(error);}));
void refresh().catch(error=>{status.textContent=String(error);});
