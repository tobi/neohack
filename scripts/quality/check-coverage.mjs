import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const limits=JSON.parse(await readFile(new URL('./coverage-limits.json',import.meta.url),'utf8'));
const report=JSON.parse(await readFile('coverage/unit/coverage-summary.json','utf8'));
const config=JSON.parse(await readFile('.c8rc.json','utf8'));
if(JSON.stringify([...config.include].sort())!==JSON.stringify(Object.keys(limits).sort()))
 throw Error('Coverage includes and per-file limits must describe the same sources.');
let failed=false;
for(const [file,minimum] of Object.entries(limits)){
 const row=report[resolve(file)];
 for(const metric of ['lines','statements','functions','branches']){
  if(!row || row[metric].pct<minimum[metric]){
   console.error(`${file}: ${metric} ${row?.[metric]?.pct??'missing'} < ${minimum[metric]}`);
   failed=true;
  }
 }
}
if(failed)process.exitCode=1;
