#!/usr/bin/env node
// Local, disposable measurement. Never reads an existing run or prints RNG state.
import {mkdtemp,writeFile,readFile,rm,open} from 'node:fs/promises';
import {tmpdir,cpus,platform,arch} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {instrumentedNativeEngine} from '../tests/instrumented-native-engine.mjs';
import {fixture,identity} from '../tests/native-fixture.mjs';
const cleanups=[];
const t={after:fn=>cleanups.push(fn)};
const dir=await mkdtemp(join(tmpdir(),'neohack-rng-timing-'));
try {
  const report=join(dir,'fingerprint.json'),include=join(dir,'timing.inc');
  await writeFile(include,`#include <time.h>
static void rng_timing_prepare(void) {
    static int done;
    struct timespec before, after;
    char output[512], expected[512];
    int i;
    FILE *file;
    if (done++) return;
    if (!headless_rng_integrity(expected,sizeof expected)) panic("timing fingerprint");
    if (clock_gettime(CLOCK_MONOTONIC,&before)) panic("timing clock");
    for (i=0;i<2000;i++) {
        if (!headless_rng_integrity(output,sizeof output) || strcmp(expected,output)) panic("timing changed RNG");
    }
    if (clock_gettime(CLOCK_MONOTONIC,&after)) panic("timing clock");
    file=fopen(${JSON.stringify(report)},"w");
    if (!file) panic("timing report");
    fprintf(file,"{\\"iterations\\":2000,\\"elapsedMs\\":%.6f}\\n",
        (after.tv_sec-before.tv_sec)*1000.0+(after.tv_nsec-before.tv_nsec)/1000000.0);
    fclose(file);
}
`);
  const engine=await instrumentedNativeEngine(t,include,'rng_timing_prepare');
  const b=await fixture(t,{enginePath:engine});
  const game=await b.api.create(identity);
  const hash=JSON.parse(await readFile(report,'utf8'));
  // Measure actual driver+engine boundary latency, not an attributed delta.
  const actions=[];
  for(let i=0;i<30;i++){
    const started=performance.now();await game.search();actions.push(performance.now()-started);
    if(game.decision||game.state.ended)break;
  }
  // Isolate the durability syscalls added for one private boundary. This is
  // a filesystem microbenchmark, not a substitute for production storage timing.
  const file=await open(join(dir,'durability.jsonl'),'wx'),directory=await open(dir,'r');
  const writes=[];const bytes=Buffer.from(JSON.stringify({inputCount:2,inputId:1,kind:'getch',rng:{algorithm:'isaac64-sha256-v1',core:{draws:'0',seeds:'1',state:'0'.repeat(64)},display:{draws:'0',seeds:'1',state:'0'.repeat(64)}}})+'\n');
  try{for(let i=0;i<100;i++){const start=performance.now();await file.write(bytes);await file.sync();await directory.sync();writes.push(performance.now()-start);}}finally{await file.close();await directory.close();}
  const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:values.length,medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]};};
  console.log(JSON.stringify({kind:'neonethack.rng-overhead',version:1,host:{platform:platform(),arch:arch(),cpu:cpus()[0]?.model},fingerprint:{...hash,meanMs:hash.elapsedMs/hash.iterations},durability:stats(writes),oneTurnSearch:stats(actions),limits:'Local native microbenchmark. Durability includes Node async overhead; search includes the whole driver and engine. Neither measures incremental browser/remote-storage latency. No before/after total-latency claim.'},null,2));
} finally {
  for(const cleanup of cleanups.reverse())await cleanup();
  await rm(dir,{recursive:true,force:true});
}
