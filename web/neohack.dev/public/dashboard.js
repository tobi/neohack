import { runChart, renderRecords } from './dashboard-chart.js';
import { chronicleIcon } from '/build/chronicle.js';
const $ = selector => document.querySelector(selector);
const format = value => Number(value ?? 0).toLocaleString();
function element(tag, text) {const node=document.createElement(tag);node.textContent=text;return node;}
let data;
// Every replay and every chronicle lives on its own page, /replays/<id>, which
// leads with the tale and is the link people share. The ledger only points there.
const replayHref=(id,view)=>{const url=new URL('/replays/'+encodeURIComponent(id),location.origin);if(view)url.searchParams.set('view',view);return url.href;};
function openReplay(run){location.assign(replayHref(run.id));}
const chart = runChart(openReplay);
function renderRuns() {
  const filter=$("#status").value;
  $('#leaders-description').textContent=filter==='recorded' ? 'Top 100 adventures with replays, ranked by level and turns.' : 'Top 100 runs with a public recording: ascensions first, then highest experience level, then turns survived.';
  const candidates=filter==='recorded' ? data.recorded??[] : data.best;
  const runs=candidates.filter(run=>filter==="all" || filter==="recorded" || filter==="living" && !run.ended || filter==="ended" && run.ended || filter==="ascended" && run.endKind==="ascended");
  $("#runs").replaceChildren(...runs.map(run=>{
    const row=document.createElement("tr"), name=element("td",run.name);
    if (run.webmcpAutomated === true || run.control === 'webmcp') {
      const badge = element('span', '');
      badge.className = 'webmcp-badge';
      const label = ['WebMCP automated', run.harness_name && 'Harness: '+run.harness_name, run.model_name && 'Model: '+run.model_name].filter(Boolean).join(' · ');
      badge.title = label; badge.setAttribute('aria-label', label); badge.tabIndex = 0;
      badge.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M9 2h2v3h5v3h2v7h-2v3H4v-3H2V8h2V5h5zm-3 5v9h8V7zm1 2h2v3H7zm4 0h2v3h-2zm-4 5h6v1H7z" fill="currentColor"/></svg>';
      name.append(badge);
    }
    name.append(element("small",run.role));row.append(name);
    for(const value of [run.maxLevel || "—",format(run.turn),run.depthLabel || "—",run.ended ? run.endKind || "Ended" : "Adventuring"]) row.append(element("td",value));
    const playback=element('td','');playback.className='replay-cell';
    if(run.replayAvailable===true || run.chronicleAvailable===true){
      const tools=element('span','');tools.className='replay-tools';
      if(run.replayAvailable===true){const replay=element('a','Show replay');replay.className='run-replay';replay.href=replayHref(run.id);replay.setAttribute('aria-label','Show replay for '+run.name);tools.append(replay);}
      if(run.chronicleAvailable===true){
        const tale=element('a','');tale.className='run-chronicle';tale.innerHTML=chronicleIcon();tale.title='Read the chronicle';tale.href=replayHref(run.id,'chronicle');
        tale.setAttribute('aria-label','Read the chronicle of '+run.name);tools.append(tale);
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
    $("#roles").replaceChildren(...data.roles.map(role=>{
      const node=element("div","");node.className="role";const label=element("label",role.role);label.append(element("span",format(role.count)));
      const bar=element("div","");bar.className="bar";const fill=element("i","");fill.style.width=(100*role.count/Math.max(1,data.totals.runs))+"%";bar.append(fill);node.append(label,bar);return node;
    }));
    $("#freshness").textContent="Updated "+new Date(data.generatedAt).toLocaleString()+". Refreshes every minute.";
  } catch {
    $("#freshness").textContent=data ? "Showing the last successfully loaded ledger." : "Ledger could not be loaded.";
    $("#ledger-error").hidden=false;
    $("#ledger-error").textContent="Online storage is unavailable. The ledger cannot be read right now; this is not a report of zero adventures. Try Refresh shortly.";
    $("#empty").hidden=true;
  }
  finally {$("#refresh").disabled=false;}
}
$("#refresh").addEventListener("click",refresh);
$("#status").addEventListener("change",()=>data && renderRuns());
// Older shared links (/dashboard?run=<id>[&view=chronicle]) land on the run's own page.
const initialUrl=new URL(location.href),initialRun=initialUrl.searchParams.get('run');
if(initialRun&&/^[A-Za-z0-9_-]{1,64}$/.test(initialRun)){
  location.replace(replayHref(initialRun,initialUrl.searchParams.get('view')==='chronicle'?'chronicle':undefined));
}else{
  setInterval(()=>{if(!document.hidden) void refresh();},60000);
  void refresh();
}
