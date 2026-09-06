import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,cp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve,extname} from 'node:path';
import {chromium} from '../../../example/pixel-bun/node_modules/playwright-core/index.mjs';
import {stage,restore,root} from '../scripts/runtime-package.mjs';
import {compileIdentity} from '../../../lib/neonethack/scripts/wasm-inputs.mjs';
import {compiled} from '../../../lib/neonethack/scripts/check-package.mjs';
import {sha256} from '../../../lib/neonethack/scripts/source-files.mjs';

test('compiler cache identity follows engine/build inputs, independent of UI and JS glue',()=>{
  const files={'src/explorer.c':'a','engine/dat/data.base':'b','wasm/CMakeLists.txt':'c','wasm/core-worker.mjs':'d','docs/PROTOCOL.md':'e'};
  assert.equal(compileIdentity(files),compileIdentity({...files,'wasm/core-worker.mjs':'changed','docs/PROTOCOL.md':'changed'}));
  for(const path of ['src/explorer.c','engine/dat/data.base','wasm/CMakeLists.txt']) assert.notEqual(compileIdentity(files),compileIdentity({...files,[path]:'changed'}));
});

test('hosted packages reuse verified compiler bytes and new current preserves bookmarked runs', {timeout:90000}, async t=>{
  const temp=await mkdtemp('/tmp/neohack-runtime-registry-');
  let browser,server;
  t.after(async()=>{await browser?.close(); if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));} await rm(temp,{recursive:true,force:true});});
  const site=`${temp}/site`, packages=`${site}/runtime/wasm`, cache=`${temp}/cache`, original=`${root}/lib/neonethack/dist/wasm`;
  await mkdir(`${site}/runtime`,{recursive:true});
  await cp(`${root}/example/pixel-bun/public`,site,{recursive:true});
  await cp(`${root}/lib/neonethack/dist/typescript`,`${site}/runtime/typescript`,{recursive:true});
  await cp(`${root}/lib/neonethack/dist/mcp`,`${site}/runtime/mcp`,{recursive:true});
  await cp(`${root}/lib/neonethack/dist/protocol`,`${site}/runtime/protocol`,{recursive:true});
  await stage(packages,original,cache);
  const first=JSON.parse(await readFile(`${packages}/current.json`,'utf8'));
  let corrupt=false;
  server=createServer(async(req,res)=>{
    try{
      let path=new URL(req.url,'http://site').pathname;
      if(path==='/')path='/index.html';
      const file=resolve(site,'.'+path);
      if(!file.startsWith(site+'/'))throw Error('invalid path');
      let body=await readFile(file);
      if(corrupt && path.endsWith('/neonethack-core.wasm'))body=Buffer.from('damaged');
      res.setHeader('cache-control','no-store');
      res.setHeader('content-type',({'.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm','.html':'text/html','.css':'text/css','.png':'image/png','.woff2':'font/woff2'})[extname(file)]??'application/octet-stream');
      res.end(body);
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/`;
  assert.equal(await restore(base+'unpublished/',`${temp}/missing`,`${temp}/empty-cache`),false);
  const restored=`${temp}/restored`;
  assert.equal(await restore(base,restored,cache),true);
  for(const name of compiled) assert.deepEqual(await readFile(`${restored}/${name}`),await readFile(`${original}/${name}`));
  browser=await chromium.launch({executablePath:process.env.CHROMIUM ?? '/usr/bin/chromium',headless:true,chromiumSandbox:true});
  const page=await browser.newPage({reducedMotion:'reduce'});
  await page.goto(base);
  const ready=()=>page.waitForFunction(()=>document.querySelector('pixel-nethack').getAttribute('aria-busy')==='false');
  async function create(){
    await page.getByRole('button',{name:'Begin your adventure',exact:true}).click();
    await page.getByLabel('YOUR NAME',{exact:true}).fill('Package');
    await page.getByRole('button',{name:'Enter the dungeon'}).click();
    await page.waitForFunction(()=>document.querySelector('pixel-nethack').snapshot?.observation.turn===1);await ready();
  }
  await create();
  const saved=await page.evaluate(()=>({snapshot:document.querySelector('pixel-nethack').snapshot,buildId:document.querySelector('pixel-nethack').current.buildId}));
  assert.equal(saved.buildId,first.buildId);
  const bookmark=page.url();
  // A real, distinct package with the same compiled engine models a JS-only release.
  const next=`${temp}/next`;await cp(original,next,{recursive:true});
  await writeFile(`${next}/core-worker.mjs`,(await readFile(`${next}/core-worker.mjs`,'utf8'))+'\n// Next runtime release.\n');
  const manifest=JSON.parse(await readFile(`${next}/manifest.json`,'utf8'));
  manifest.files['core-worker.mjs']=sha256(await readFile(`${next}/core-worker.mjs`));manifest.buildId=sha256(JSON.stringify(manifest.files));
  await writeFile(`${next}/manifest.json`,JSON.stringify(manifest,null,2)+'\n');
  await stage(packages,next,cache);
  assert.notEqual(manifest.buildId,first.buildId);
  assert.deepEqual(JSON.parse(await readFile(`${packages}/current.json`,'utf8')),{version:1,buildId:manifest.buildId});
  for(const name of compiled) assert.deepEqual(await readFile(`${packages}/${first.buildId}/${name}`),await readFile(`${packages}/${manifest.buildId}/${name}`));
  await page.reload();
  await page.waitForFunction(id=>document.querySelector('pixel-nethack').snapshot?.sessionId===id,saved.snapshot.sessionId);await ready();
  assert.equal(page.url(),bookmark);
  assert.equal(await page.evaluate(()=>document.querySelector('pixel-nethack').runtimeBuildId),first.buildId);
  assert.deepEqual(await page.evaluate(()=>document.querySelector('pixel-nethack').snapshot.observation),saved.snapshot.observation);
  await page.evaluate(()=>document.querySelector('pixel-nethack').returnToDoorway());
  await page.reload();await create();
  assert.equal(await page.evaluate(()=>document.querySelector('pixel-nethack').current.buildId),manifest.buildId);
  assert.equal(await restore(base,`${temp}/another`,`${temp}/cache2`),true,'new wrapper package does not recompile the engine');
  corrupt=true;
  await assert.rejects(restore(base,`${temp}/bad`,`${temp}/cache3`),/Corrupt hosted runtime/);
});
