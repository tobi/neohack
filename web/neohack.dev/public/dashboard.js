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
  const world=document.createElement('neohack-world');
  world.setAttribute('src',new URL('/dashboard?run='+encodeURIComponent(run.id),location.origin).href);
  world.setAttribute('autoplay','');world.setAttribute('controls','');world.setAttribute('speed','4');
  $('#replay-world').replaceChildren(world);
  if(!dialog.open)dialog.showModal();
}
$('#close-replay').onclick=()=>dialog.close();
dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
dialog.addEventListener('close',()=>$('#replay-world').replaceChildren());
$('#copy-replay').onclick=async()=>{
  const src=new URL('/dashboard?run='+encodeURIComponent(activeRun.id),location.origin).href;
  const code='<script type="module" src="'+location.origin+'/component/neohack.js"></script>\n<neohack-world src="'+src+'" autoplay speed="4" controls style="height:480px"></neohack-world>';
  try{await navigator.clipboard.writeText(code);$('#copy-status').textContent='Embed copied.';}
  catch{$('#embed-code').hidden=false;$('#embed-code').value=code;$('#embed-code').select();$('#copy-status').textContent='Copy the selected embed code.';}
};
function renderRuns() {
  const filter=$("#status").value;
  $('#leaders-description').textContent=filter==='recorded' ? 'Top 100 adventures with public replay frames, ranked by level and turns.' : 'Top 100 across all recorded runs: ascensions first, then highest experience level, then turns survived.';
  const candidates=filter==='recorded' ? data.recorded??[] : data.best;
  const runs=candidates.filter(run=>filter==="all" || filter==="recorded" || filter==="living" && !run.ended || filter==="ended" && run.ended || filter==="ascended" && run.endKind==="ascended");
  $("#runs").replaceChildren(...runs.map(run=>{
    const row=document.createElement("tr"), name=element("td",run.name);
    name.append(element("small",run.role));row.append(name);
    for(const value of [run.maxLevel || "—",format(run.turn),run.depthLabel || "—",run.ended ? run.endKind || "Ended" : "Adventuring"]) row.append(element("td",value));
    const playback=element('td','');playback.className='replay-cell';
    if(run.replayAvailable===true){
      const replay=element('button','Show replay');replay.className='run-replay';replay.setAttribute('aria-label','Show replay for '+run.name);replay.onclick=()=>openReplay(run);playback.append(replay);
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
    $("#metrics").replaceChildren(...[["Recorded runs",data.totals.runs],["Still adventuring",data.totals.living],["Ascensions",data.totals.ascended],["Longest run · turns",data.totals.longest]].map(([label,value])=>{
      const node=element("div","");node.className="metric";node.append(element("strong",format(value)),element("span",label));return node;
    }));
    renderRuns();
    if(!openedInitial){openedInitial=true;const id=new URL(location.href).searchParams.get("run");if(id)openReplay(data.best.find(r=>r.id===id)??{id,name:"Adventure replay"});}
    $("#roles").replaceChildren(...data.roles.map(role=>{
      const node=element("div","");node.className="role";const label=element("label",role.role);label.append(element("span",format(role.count)));
      const bar=element("div","");bar.className="bar";const fill=element("i","");fill.style.width=(100*role.count/Math.max(1,data.totals.runs))+"%";bar.append(fill);node.append(label,bar);return node;
    }));
    const reportCount=data.errors.reduce((sum,error)=>sum+error.count,0);
    $('#error-summary').hidden=reportCount===0;
    $('#error-summary-count').textContent=format(reportCount)+' reports in the displayed groups · last 14 days';
    $("#errors").replaceChildren(...data.errors.map(error=>{
      const row=document.createElement("tr");for(const value of [error.day,error.code.replaceAll("_"," "),format(error.count),error.build ? error.build.slice(0,12) : "Unavailable"]) row.append(element("td",value));return row;
    }));
    if(!data.errors.length){const row=element("tr","");const cell=element("td","No error reports in this window.");cell.colSpan=4;row.append(cell);$("#errors").append(row);}
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
setInterval(()=>{if(!document.hidden) void refresh();},60000);
void refresh();
