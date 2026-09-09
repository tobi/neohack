import { runChart, renderRecords } from './dashboard-chart.js';
import { chronicleEligible, chronicleIcon, chronicleView, fetchChronicle, requestChronicle, chronicleLink } from '/build/chronicle.js';
const $ = selector => document.querySelector(selector);
const format = value => Number(value ?? 0).toLocaleString();
function element(tag, text) {const node=document.createElement(tag);node.textContent=text;return node;}
let data, openedInitial=false;
let activeRun;
const dialog=$('#replay-lightbox');
function openReplay(run) {
  activeRun=run;
  $('#replay-title').textContent=run.name;
  $('#copy-status').textContent='';$('#embed-code').hidden=true;
  taleButton(run);
  const world=document.createElement('neohack-world');
  world.setAttribute('src',new URL('/replays/'+encodeURIComponent(run.id),location.origin).href);
  world.setAttribute('autoplay','');world.setAttribute('controls','');world.setAttribute('speed','4');
  $('#replay-world').replaceChildren(world);
  if(!dialog.open)dialog.showModal();
}
// The chronicle is written once on the server; this button reads the cached tale or asks for it.
const taleController={abort:null};
function taleButton(run){
  const button=$('#tell-tale'),status=$('#tale-status');
  status.textContent='';taleController.abort?.abort();taleController.abort=null;
  const eligible=run.chronicleAvailable===true||chronicleEligible(run);
  button.hidden=!eligible;button.disabled=false;
  if(!eligible)return;
  const available=run.chronicleAvailable===true;
  button.innerHTML=chronicleIcon()+'<span>'+(available?'Read the chronicle':'Tell the tale')+'</span>';
  button.setAttribute('aria-label',(available?'Read the chronicle of ':'Tell the tale of ')+run.name);
  button.onclick=async()=>{
    button.disabled=true;
    const controller=new AbortController();taleController.abort=controller;
    try{
      const doc=(available&&await fetchChronicle(run.id,controller.signal))||await requestChronicle(run.id,{signal:controller.signal,onStatus:text=>{status.textContent=text;}});
      run.chronicleAvailable=true;status.textContent='';
      openChronicle(run,doc);
    }catch(error){if(controller.signal.aborted)return;status.textContent=error instanceof Error?error.message:'The chronicler could not finish this tale.';}
    finally{if(taleController.abort===controller)taleController.abort=null;button.disabled=false;}
  };
}
const chronicleDialog=$('#chronicle-lightbox');
let chronicleRun;
function openChronicle(run,doc){
  chronicleRun=run;
  $('#chronicle-status').textContent='';
  $('#chronicle-body').replaceChildren(chronicleView(doc));
  if(dialog.open)dialog.close();
  if(!chronicleDialog.open)chronicleDialog.showModal();
  $('#chronicle-body').scrollTop=0;
}
async function showChronicle(run){
  try{const doc=await fetchChronicle(run.id);if(doc){openChronicle(run,doc);return;}openReplay(run);$('#tale-status').textContent='No chronicle has been written for this run yet.';}
  catch(error){openReplay(run);$('#tale-status').textContent=error instanceof Error?error.message:'The chronicle could not be read.';}
}
$('#close-chronicle').onclick=()=>chronicleDialog.close();
chronicleDialog.addEventListener('click',event=>{if(event.target===chronicleDialog){const r=chronicleDialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)chronicleDialog.close();}});
$('#chronicle-replay').onclick=()=>{chronicleDialog.close();openReplay(chronicleRun);};
$('#copy-chronicle').onclick=async()=>{
  try{await navigator.clipboard.writeText(chronicleLink(chronicleRun.id));$('#chronicle-status').textContent='Link copied.';}
  catch{$('#chronicle-status').textContent=chronicleLink(chronicleRun.id);}
};
const chart = runChart(openReplay);
$('#close-replay').onclick=()=>dialog.close();
dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
dialog.addEventListener('close',()=>$('#replay-world').replaceChildren());
$('#copy-replay').onclick=async()=>{
  const src=new URL('/replays/'+encodeURIComponent(activeRun.id),location.origin).href;
  const code='<script type="module" src="'+location.origin+'/component/neohack.js"></script>\n<neohack-world src="'+src+'" autoplay speed="4" controls style="height:480px"></neohack-world>';
  try{await navigator.clipboard.writeText(code);$('#copy-status').textContent='Embed copied.';}
  catch{$('#embed-code').hidden=false;$('#embed-code').value=code;$('#embed-code').select();$('#copy-status').textContent='Copy the selected embed code.';}
};
function renderRuns() {
  const filter=$("#status").value;
  $('#leaders-description').textContent=filter==='recorded' ? 'Top 100 adventures with replays, ranked by level and turns.' : 'Top 100 across all recorded runs: ascensions first, then highest experience level, then turns survived.';
  const candidates=filter==='recorded' ? data.recorded??[] : data.best;
  const runs=candidates.filter(run=>filter==="all" || filter==="recorded" || filter==="living" && !run.ended || filter==="ended" && run.ended || filter==="ascended" && run.endKind==="ascended");
  $("#runs").replaceChildren(...runs.map(run=>{
    const row=document.createElement("tr"), name=element("td",run.name);
    name.append(element("small",run.role));row.append(name);
    for(const value of [run.maxLevel || "—",format(run.turn),run.depthLabel || "—",run.ended ? run.endKind || "Ended" : "Adventuring"]) row.append(element("td",value));
    const playback=element('td','');playback.className='replay-cell';
    if(run.replayAvailable===true){
      const tools=element('span','');tools.className='replay-tools';
      const replay=element('button','Show replay');replay.className='run-replay';replay.setAttribute('aria-label','Show replay for '+run.name);replay.onclick=()=>openReplay(run);tools.append(replay);
      if(run.chronicleAvailable===true){
        const tale=element('button','');tale.className='run-chronicle';tale.innerHTML=chronicleIcon();tale.title='Read the chronicle';
        tale.setAttribute('aria-label','Read the chronicle of '+run.name);tale.onclick=()=>void showChronicle(run);tools.append(tale);
      }
      playback.append(tools);
    }else{const missing=element('span','—');missing.title='No public recording';missing.setAttribute('aria-label','No public recording');playback.append(missing);}
    row.append(playback);return row;
  }));
  $("#empty").hidden=runs.length>0;
}
async function refresh() {
  $("#refresh").disabled=true;
  try {
    const response=await fetch("/api/stats",{cache:"no-store"});
    if(!response.ok) throw Error("The ledger is unavailable. Try refreshing.");
    data=await response.json();
    $("#ledger-error").hidden=true;
    chart.update(data.recent ?? []);
    renderRecords(data.records, openReplay);
    $("#metrics").replaceChildren(...[["Recorded runs",data.totals.runs],["Still adventuring",data.totals.living],["Ascensions",data.totals.ascended],["Longest run · turns",data.totals.longest]].map(([label,value])=>{
      const node=element("div","");node.className="metric";node.append(element("strong",format(value)),element("span",label));return node;
    }));
    renderRuns();
    if(!openedInitial){openedInitial=true;const url=new URL(location.href),id=url.searchParams.get("run");if(id){const run=data.best.find(r=>r.id===id)??{id,name:"Adventure replay"};if(url.searchParams.get("view")==="chronicle")void showChronicle(run);else openReplay(run);}}
    $("#roles").replaceChildren(...data.roles.map(role=>{
      const node=element("div","");node.className="role";const label=element("label",role.role);label.append(element("span",format(role.count)));
      const bar=element("div","");bar.className="bar";const fill=element("i","");fill.style.width=(100*role.count/Math.max(1,data.totals.runs))+"%";bar.append(fill);node.append(label,bar);return node;
    }));
    $("#freshness").textContent="Updated "+new Date(data.generatedAt).toLocaleString()+". Refreshes every minute.";
  } catch(error) {
    $("#freshness").textContent=data ? "Showing the last successfully loaded ledger." : "Ledger could not be loaded.";
    $("#ledger-error").hidden=false;
    $("#ledger-error").textContent="Online storage is unavailable. The ledger cannot be read right now; this is not a report of zero adventures. Try Refresh shortly.";
    $("#empty").hidden=true;
  }
  finally {$("#refresh").disabled=false;}
}
$("#refresh").addEventListener("click",refresh);
$("#status").addEventListener("change",()=>data && renderRuns());
const initialUrl=new URL(location.href),initialRun=initialUrl.searchParams.get('run');
if(initialRun){
  openedInitial=true;
  if(initialUrl.searchParams.get('view')==='chronicle')void showChronicle({id:initialRun,name:'Adventure replay'});
  else openReplay({id:initialRun,name:'Adventure replay'});
  $('#freshness').textContent='Replay loads directly from the CDN. Refresh to open the ledger.';
}else{
  setInterval(()=>{if(!document.hidden) void refresh();},60000);
  void refresh();
}
