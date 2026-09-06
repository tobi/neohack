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
    const detail = document.createElement('p'); detail.textContent=`${run.role} · ${run.depth} · Level ${run.level ?? '?'} (peak ${run.maxLevel}) · ${run.turn} turns · ${run.outcome}`;
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
    card.append(title,detail,depths,button); $('runs').append(card);
  }
}
async function busy(action:()=>Promise<void>) {
  const buttons = [...document.querySelectorAll('button')]; buttons.forEach(b=>b.disabled=true); status.textContent='Working…';
  try { await action(); } catch(error) { status.textContent=String(error); } finally { buttons.forEach(b=>b.disabled=false); }
}
window.addEventListener('accountchange',()=>void refresh().catch(error=>{status.textContent=String(error);}));
void refresh().catch(error=>{status.textContent=String(error);});
