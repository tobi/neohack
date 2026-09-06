import './component';
import { accountApi } from './account-client';
import { NeohackWorld } from './component';
const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const status = $('status');
async function refresh() {
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
    const button = document.createElement('button'); button.textContent=`Replay ${run.count} frames`;
    button.onclick=()=>void busy(async()=>{
      const viewer = $('replay') as NeohackWorld;
      viewer.setAttribute('role',run.role); viewer.setAttribute('seed',String(run.seed ?? 0));
      const frames = []; let offset: number|null=0;
      do { const page = await accountApi(`/runs/${run.id}/frames?offset=${offset}`); frames.push(...page.frames); offset=page.next; } while(offset !== null);
      viewer.loadReplay(frames); $('playback').hidden=false;
      const scrub = $<HTMLInputElement>('scrub'); scrub.max=String(Math.max(0,frames.length-1)); scrub.value='0';
      viewer.addEventListener('replayframe',event=>{scrub.value=String((event as CustomEvent).detail.index);});
      scrub.oninput=()=>{viewer.pause();viewer.seek(Number(scrub.value));};
      $('play').onclick=()=>viewer.play(Number($<HTMLSelectElement>('speed').value));
      $('pause').onclick=()=>viewer.pause();
      $('playback').scrollIntoView({behavior:'smooth'});
      status.textContent='Replay loaded. These are recorded public observations, reported by the browser.';
    });
    card.append(title,detail,depths,button);
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
window.addEventListener('accountchange',()=>void refresh().catch(error=>{status.textContent=String(error);}));
void refresh().catch(error=>{status.textContent=String(error);});
