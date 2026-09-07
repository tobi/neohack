#!/usr/bin/env node
/* Small linker/calendar experiment, not a game-equivalence test. */
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--emcc')throw Error('Usage: probe-engine-wrappers.mjs --emcc /path/to/emcc');
const directory=await mkdtemp(join(tmpdir(),'neohack-wrapper-probe-'));
const run=(file,args,env=process.env)=>execFileSync(file,args,{encoding:'utf8',env,stdio:['ignore','pipe','pipe']}).trim();
try{
  const seed=join(directory,'seed.c'),main=join(directory,'main.c');
  await writeFile(seed,'unsigned long sys_random_seed(void){return 7;}\nunsigned long same_unit_seed(void){return sys_random_seed();}\n');
  await writeFile(main,`#include <stdio.h>
#include <time.h>
extern unsigned long sys_random_seed(void),same_unit_seed(void);
unsigned long __wrap_sys_random_seed(void){return 42;}
time_t __wrap_time(time_t *p){if(p)*p=0;return 0;}
int main(void){time_t t;time(&t);printf("external=%lu sameUnit=%lu epoch=%lld localHour=%d\\n",sys_random_seed(),same_unit_seed(),(long long)t,localtime(&t)->tm_hour);}
`);
  const cc=process.env.CC||'cc',emcc=args[1],common=['-O0',main,seed,'-Wl,--wrap=sys_random_seed','-Wl,--wrap=time'];
  const native=join(directory,'native'),wasm=join(directory,'wasm.cjs');
  run(cc,[...common,'-o',native]);
  run(emcc,[...common,'-sENVIRONMENT=node','-sSINGLE_FILE=1','-o',wasm]);
  const results=[];
  for(const timezone of ['UTC','Pacific/Honolulu']){
    const env={...process.env,TZ:timezone};
    for(const [target,file,argv]of [['native',native,[]],['wasm',process.execPath,[wasm]]]){
      const output=run(file,argv,env);
      if(!output.startsWith('external=42 '))throw Error(`External wrapper did not apply: ${target}: ${output}`);
      results.push({target,timezone,output});
    }
  }
  console.log(JSON.stringify({scope:'symbol and calendar probe, not engine parity',nativeCompiler:run(cc,['--version']).split('\n')[0],wasmCompiler:run(emcc,['--version']).split('\n')[0],results},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
