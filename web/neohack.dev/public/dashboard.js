const $ = selector => document.querySelector(selector);
const format = value => Number(value ?? 0).toLocaleString();
function element(tag, text) {const node=document.createElement(tag);node.textContent=text;return node;}
let data;
function renderRuns() {
  const filter=$("#status").value;
  const runs=data.best.filter(run=>filter==="all" || filter==="living" && !run.ended || filter==="ended" && run.ended || filter==="ascended" && run.endKind==="ascended");
  $("#runs").replaceChildren(...runs.map(run=>{
    const row=document.createElement("tr"), name=element("td",run.name);
    name.append(element("small",run.role)); row.append(name);
    for(const value of [run.maxLevel || "—",format(run.turn),run.depthLabel || "—",run.ended ? run.endKind || "Ended" : "Adventuring"]) row.append(element("td",value));
    return row;
  }));
  $("#empty").hidden=runs.length>0;
}
async function refresh() {
  $("#refresh").disabled=true;
  try {
    const response=await fetch("/api/stats",{cache:"no-store"});
    if(!response.ok) throw Error("The ledger is unavailable. Try refreshing.");
    data=await response.json();
    $("#metrics").replaceChildren(...[["Recorded runs",data.totals.runs],["Still adventuring",data.totals.living],["Ascensions",data.totals.ascended],["Longest run · turns",data.totals.longest]].map(([label,value])=>{
      const node=element("div","");node.className="metric";node.append(element("strong",format(value)),element("span",label));return node;
    }));
    renderRuns();
    $("#roles").replaceChildren(...data.roles.map(role=>{
      const node=element("div","");node.className="role";const label=element("label",role.role);label.append(element("span",format(role.count)));
      const bar=element("div","");bar.className="bar";const fill=element("i","");fill.style.width=(100*role.count/Math.max(1,data.totals.runs))+"%";bar.append(fill);node.append(label,bar);return node;
    }));
    $("#errors").replaceChildren(...data.errors.map(error=>{
      const row=document.createElement("tr");for(const value of [error.day,error.code.replaceAll("_"," "),format(error.count),error.build ? error.build.slice(0,12) : "Unavailable"]) row.append(element("td",value));return row;
    }));
    if(!data.errors.length){const row=element("tr","");const cell=element("td","No error reports in this window.");cell.colSpan=4;row.append(cell);$("#errors").append(row);}
    $("#freshness").textContent="Updated "+new Date(data.generatedAt).toLocaleString()+". Refreshes every minute.";
  } catch(error) {$("#freshness").textContent=error.message;}
  finally {$("#refresh").disabled=false;}
}
$("#refresh").addEventListener("click",refresh);
$("#status").addEventListener("change",()=>data && renderRuns());
setInterval(()=>{if(!document.hidden) void refresh();},60000);
void refresh();
