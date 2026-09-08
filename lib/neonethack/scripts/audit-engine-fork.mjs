#!/usr/bin/env node
/** Compare shipping engine sources with the exact pinned upstream snapshot.
 * No network, source mutation, runtime migration or game execution. */
import {readdir,readFile,readlink,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const base='04834a93165482a28257bac282543e3583658622';
const expectedTree='52df71058fde9066366b3780028248d2efa728a8ce8a791af3fc22195478d1ff';
const root=fileURLToPath(new URL('../engine/',import.meta.url));
const args=process.argv.slice(2);let upstream,out;
for(let i=0;i<args.length;i++){
  if(args[i]==='--upstream')upstream=args[++i];
  else if(args[i]==='--out')out=args[++i];
  else throw Error('Usage: audit-engine-fork.mjs --upstream PATH [--out FILE]');
}
if(!upstream)throw Error('Supply the unpacked pinned NetHack source with --upstream PATH; see docs/ENGINE_FORK.md.');
upstream=resolve(upstream);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function treeHash(directory){
  const entries=[];
  async function walk(dir=''){
    for(const e of await readdir(directory+'/'+dir,{withFileTypes:true})){
      if(!dir&&e.name==='.git')continue;
      const p=dir?dir+'/'+e.name:e.name;
      if(e.isDirectory())await walk(p);else entries.push([p,e.isSymbolicLink()?'link':'file']);
    }
  }
  await walk();entries.sort(([a],[b])=>a<b?-1:a>b?1:0);
  const h=createHash('sha256');
  for(const [p,kind]of entries){
    const bytes=kind==='link'?Buffer.from(await readlink(directory+'/'+p)):await readFile(directory+'/'+p);
    h.update(p+'\0'+kind+'\0'+bytes.length+'\0');h.update(bytes);h.update('\0');
  }
  return h.digest('hex');
}
const fingerprint=await treeHash(upstream);
if(fingerprint!==expectedTree)throw Error(`Upstream snapshot differs from ${base}: ${fingerprint}. Use the exact clean pinned archive.`);
const categories={
  registration:['include/extern.h','include/winprocs.h','src/mdlib.c','src/windows.c','sys/unix/Makefile.src','sys/unix/hints/include/multiw-2.500'],
  runtime:['src/calendar.c','src/options.c','src/u_init.c','sys/unix/unixmain.c'],
  occupationWitness:['src/allmain.c','src/eat.c','src/engrave.c','src/spell.c','src/detect.c','src/do.c'],
  explicitDecision:['src/do_wear.c','src/invent.c','src/potion.c','src/questpgr.c'],
  terminalWitness:['src/end.c'],
  perceivedKnowledge:['src/insight.c','src/weapon.c','src/lock.c','src/botl.c'],
  containerAndPickup:['src/pickup.c'],
  isolatedLore:['src/pager.c','src/objnam.c'],
  standaloneHost:['src/mail.c'],
  privateRngIntegrity:['src/rnd.c'],
};
const categoryOf=new Map(Object.entries(categories).flatMap(([category,paths])=>paths.map(p=>[p,category])));
const paths=JSON.parse(await readFile(root+'SOURCES.json','utf8'));
const changed=[],added=[],unchanged=[];const source=createHash('sha256');
for(const p of [...paths].sort()){
  if(typeof p!=='string'||p.startsWith('/')||p.split('/').some(s=>!s||s==='..'||s==='.'))throw Error('Invalid source path');
  const current=await readFile(root+p);source.update(p+'\0'+hash(current)+'\n');
  let original;try{original=await readFile(upstream+'/'+p);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!original){added.push({path:p,sha256:hash(current)});continue;}
  if(current.equals(original)){unchanged.push(p);continue;}
  const category=categoryOf.get(p);
  if(!category)throw Error(`Unreviewed upstream modification: ${p}. Record its purpose and update the audit classification.`);
  changed.push({path:p,category,upstreamSha256:hash(original),sha256:hash(current)});
}
if(new Set(paths).size!==paths.length)throw Error('Duplicate engine source inventory entry');
const report={base,upstreamTreeHash:fingerprint,shippingSourceHash:source.digest('hex'),counts:{unchanged:unchanged.length,changed:changed.length,added:added.length},changed,added};
const json=JSON.stringify(report,null,2)+'\n';
if(out)await writeFile(out,json);else process.stdout.write(json);
