import {mkdir,cp,writeFile,chmod,rename,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..'),prefix=resolve(process.argv[2]??join(root,'../..'));
const base=join(prefix,'libexec'),target=join(base,'neohack-mcp'),temp=join(base,'.neohack-mcp-'+process.pid),old=target+'.old-'+process.pid;
await mkdir(base,{recursive:true});await mkdir(join(prefix,'bin'),{recursive:true});
await cp(join(root,'dist'),temp,{recursive:true});
await cp(join(root,'NOTICE.md'),join(temp,'NOTICE.md'));await writeFile(join(temp,'package.json'),'{"type":"module"}\n');
try{await rename(target,old);}catch(e){if(e.code!=='ENOENT')throw e;}
try{await rename(temp,target);}catch(e){await rename(old,target).catch(()=>{});throw e;}
await rm(old,{recursive:true,force:true});
const launcher=join(prefix,'bin','neohack-mcp'),next=launcher+'.new-'+process.pid;
await writeFile(next,'#!/usr/bin/env bun\nimport "../libexec/neohack-mcp/mcp/cli.js";\n');await chmod(next,0o755);await rename(next,launcher);
console.log('Installed Bun/WASM MCP: '+launcher);
