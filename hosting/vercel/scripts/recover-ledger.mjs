// One-time recovery of public ledger records left at the pre-relocation path.
// This does not migrate game saves, journals, runtimes or account records.
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { read, update } from '../src/storage.ts';
import { sanitizeRun } from '../src/board.ts';

export async function recoverLedger({apply=false}={}) {
  const source=await read('board/runs.json');
  if(!Array.isArray(source))throw Error('Original ledger is missing or invalid; no recovery performed');
  const ids=new Set();
  const recovered=source.map(raw=>{
    if(!raw || !Number.isFinite(raw.updatedAt) || typeof raw.ended!=='boolean')throw Error('Original ledger has an invalid record');
    const run=sanitizeRun(raw,raw.updatedAt);
    if(!run || ids.has(run.id))throw Error('Original ledger has invalid or duplicate IDs');
    ids.add(run.id);return run;
  });
  const sourceHash=createHash('sha256').update(JSON.stringify(source)).digest('hex');
  function merge(doc){
    if(!doc || !Array.isArray(doc.runs) || !Array.isArray(doc.errors))throw Error('Current ledger is invalid');
    const currentIds=new Set();
    for(const run of doc.runs){
      if(!sanitizeRun(run,run.updatedAt) || currentIds.has(run.id))throw Error('Current ledger has invalid or duplicate IDs');
      currentIds.add(run.id);
    }
    // Existing records always win. Recovery must never rewind live reporting.
    const missing=recovered.filter(run=>!currentIds.has(run.id));
    const report={apply,sourceHash,sourceRuns:source.length,currentRuns:doc.runs.length,added:missing.length,total:doc.runs.length+missing.length};
    if(missing.length)doc.runs=[...doc.runs,...missing].sort((a,b)=>b.updatedAt-a.updatedAt);
    return report;
  }
  if(!apply)return merge((await read('board/index.json'))??{runs:[],errors:[]});
  // update re-reads and recomputes after CAS contention; errors and all current
  // records survive. Neither source nor any private document is written.
  return update('board/index.json',()=>({runs:[],errors:[]}),merge);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2);
  if(args.some(arg=>arg!=='--apply'))throw Error('Usage: node scripts/recover-ledger.mjs [--apply]');
  console.log(JSON.stringify(await recoverLedger({apply:args.includes('--apply')})));
}
