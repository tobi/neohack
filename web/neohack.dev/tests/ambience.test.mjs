import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
test('ambience respects perception, camera crops, reveal order and shared live/workshop rendering', async t => {
  const javascript = execFileSync('bun', ['build', 'src/dungeon-art.ts', '--target=browser'], {cwd: root, encoding: 'utf8'});
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, chromiumSandbox: true});
  t.after(() => browser.close());
  const page = await browser.newPage();
  const result = await page.evaluate(async javascript => {
    const {renderTerrain, renderDecals, renderDoor} = await import(URL.createObjectURL(new Blob([javascript], {type:'text/javascript'})));
    const cell = (x,y,type='floor') => ({x,y,terrain:{type}});
    const cells = Array.from({length: 80}, (_,i) => cell(i%16, Math.floor(i/16), i < 16 ? 'wall' : 'floor'));
    const options = {seed:'42:Dungeons:1',originX:0,originY:0,columns:16,rows:5};
    const paint = (input=cells, opts=options, full=false, split=false) => {
      const c = document.createElement('canvas'); c.width=opts.columns*16;c.height=opts.rows*16;
      const ctx=c.getContext('2d');
      if (full) {
        renderTerrain(ctx,input,{...opts,omitDoors:split});
        if (split) for (const cell of input) renderDoor(ctx,cell,input,opts.seed,(cell.x-opts.originX)*16,(cell.y-opts.originY)*16);
      } else renderDecals(ctx,input,opts);
      return c;
    };
    const check=(ok,message)=>{if(!ok) throw Error(message)};
    const base=paint();
    check(base.toDataURL()===paint([...cells].reverse()).toDataURL(),'input order changed art');
    check(base.toDataURL()===paint([...cells,cell(200,200)]).toDataURL(),'distant reveal changed art');
    check(base.toDataURL()!==paint(cells,{...options,seed:'314159:Dungeons:1'}).toDataURL(),'no seed variety');
    check(paint(cells,options,true).toDataURL()===paint(cells,options,true,true).toDataURL(),'live/workshop pass mismatch');
    const pixels=base.getContext('2d').getImageData(0,0,256,80).data;
    check(pixels.some((v,i)=>i%4===3&&v),'no decorations');
    check(pixels.slice(0,256*16*4).every(v=>v===0),'painted wall anchor');
    const crop=paint(cells,{...options,originX:4,columns:7}).getContext('2d').getImageData(0,0,112,80).data;
    const expected=base.getContext('2d').getImageData(64,0,112,80).data;
    check(crop.every((v,i)=>v===expected[i]),'camera crop changed art');
    for (const terrain of ['unknown','stone','corridor','stairsDown','water','closedDoor','trap']) {
      const empty=paint(cells.map(c=>cell(c.x,c.y,terrain))).getContext('2d').getImageData(0,0,256,80).data;
      check(empty.every(v=>v===0),`decorated ${terrain}`);
    }
    const visible = cells.map(cell=>({...cell,visible:true}));
    const lit = paint(visible,{...options,ambienceTimeMs:0},true).toDataURL();
    check(lit !== paint(visible,{...options,ambienceTimeMs:420},true).toDataURL(), 'visible sconces do not flicker');
    const remembered = cells.map(cell=>({...cell,visible:false}));
    check(paint(remembered,{...options,ambienceTimeMs:0},true).toDataURL() === paint(remembered,{...options,ambienceTimeMs:420},true).toDataURL(), 'remembered sconces animate');
    const room = [];
    for (let y=2;y<=8;y++) for (let x=1;x<=16;x++)
      room.push(cell(x,y,x===8&&y===8?'openDoor':x===1||x===16||y===2||y===8?'wall':'floor'));
    const sheet=document.createElement('canvas');sheet.width=864;sheet.height=2040;
    const ctx=sheet.getContext('2d');ctx.imageSmoothingEnabled=false;ctx.fillStyle='#192126';ctx.fillRect(0,0,864,2040);
    for (let i=0;i<4;i++) {
      const seed=['42:Dungeons:1','314159:Dungeons:1','1','8675309'][i];
      ctx.fillStyle='#ded7ba';ctx.font='14px monospace';ctx.fillText(`Seed ${seed} · complete room / 3×`,16,i*510+22);
      ctx.drawImage(paint(room,{...options,seed,columns:18,rows:10},true),0,i*510+30,864,480);
    }
    return sheet.toDataURL().split(',')[1];
  }, javascript);
  await mkdir(resolve(root,'test-results/art'),{recursive:true});
  await writeFile(resolve(root,'test-results/art/ambience-study.png'),Buffer.from(result,'base64'));
});

test('wall dressing occupies the projected masonry face, including side walls', async t => {
  const javascript = execFileSync('bun',['build','src/structure-sprites.ts','--target=browser'],{cwd:root,encoding:'utf8'});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.evaluate(async javascript=>{
    const {drawWallSprite}=await import(URL.createObjectURL(new Blob([javascript],{type:'text/javascript'})));
    const palette={cap:'#737765',edge:'#96957b',face:'#464d43',shade:'#323e39',moss:'#626e46'};
    const paint=(side,kind)=>{
      const c=document.createElement('canvas');c.width=c.height=64;
      drawWallSprite(c.getContext('2d'),24,24,{n:side==='side',s:side==='side',e:side==='front',w:side==='front',heights:[20,20,20,20]},20,palette,0,0,0,kind?{kind,side,flame:0}:undefined);
      return c.getContext('2d').getImageData(0,0,64,64).data;
    };
    for(const side of ['front','side']) for(const kind of ['shelf','chain','torch','vines']) {
      const base=paint(side),dressed=paint(side,kind);
      let changed=0;
      for(let i=0;i<base.length;i+=4) {
        if(base.slice(i,i+4).every((v,j)=>v===dressed[i+j])) continue;
        changed++;
        if(base[i+3]!==255||dressed[i+3]!==255) throw Error(`${kind}: decoration escaped masonry silhouette`);
        const x=(i/4)%64,y=Math.floor(i/4/64);
        // Front face y = 13 - .75*z; side face x = 13 - .375*z.
        if(side==='front' ? y>=37 : x>=37) throw Error(`${kind}: painted floor instead of wall face`);
      }
      if(changed<3) throw Error(`${side} ${kind}: wall fixture missing`);
    }
  },javascript);
});

test('east wall cutaways are local to supplied readable sprites and stable under camera movement', async t => {
  const javascript=execFileSync('bun',['build','src/dungeon-art.ts','--target=browser'],{cwd:root,encoding:'utf8'});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  const png=await page.evaluate(async javascript=>{
    const {renderTerrain}=await import(URL.createObjectURL(new Blob([javascript],{type:'text/javascript'})));
    const cells=[];
    for(let y=2;y<15;y++) for(let x=2;x<=8;x++) cells.push({x,y,terrain:{type:x===8?'wall':'floor'}});
    const options={seed:42,originX:0,originY:0,columns:10,rows:17};
    const paint=(readableCells=[],originX=0)=>{
      const c=document.createElement('canvas');c.width=(10-originX)*16;c.height=272;
      renderTerrain(c.getContext('2d'),cells,{...options,originX,columns:10-originX,readableCells});
      return c;
    };
    const bytes=c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    const check=(ok,msg)=>{if(!ok)throw Error(msg)};
    const base=paint(),target=[{x:7,y:8,rise:16}],near=paint(target),far=paint([{x:3,y:8,rise:16}]);
    check(base.toDataURL()===far.toDataURL(),'unobstructed center player lowered wall');
    check(base.toDataURL()!==near.toDataURL(),'adjacent player did not get a cutaway');
    const a=bytes(base),b=bytes(near);
    let changed=0;
    for(let y=0;y<272;y++)for(let x=0;x<160;x++) {
      const i=(y*160+x)*4;
      if(a.slice(i,i+4).every((v,j)=>v===b[i+j]))continue;
      changed++;
      check(x>=8*16-9&&x<9*16&&y>=5*16&&y<12*16,'local cutaway changed distant wall/unknown ground');
    }
    check(changed>0,'no actual changed pixels');
    const crop=bytes(paint(target,4)),expected=near.getContext('2d').getImageData(64,0,96,272).data;
    check(crop.every((v,i)=>v===expected[i]),'camera moved cutaway');
    check(base.toDataURL()===paint().toDataURL(),'wall did not restore after target left');
    const sheet=document.createElement('canvas');sheet.width=960;sheet.height=856;
    const ctx=sheet.getContext('2d');ctx.fillStyle='#171f23';ctx.fillRect(0,0,960,856);ctx.imageSmoothingEnabled=false;
    for(const [i,c] of [base,near].entries()) {
      ctx.fillStyle='#ded7ba';ctx.font='16px sans-serif';ctx.fillText(i?'Actor near wall: local notch':'Clear wall: retained height',i*480+16,24);
      ctx.drawImage(c,i*480,40,480,816);
    }
    return sheet.toDataURL().split(',')[1];
  },javascript);
  await mkdir(resolve(root,'test-results/art'),{recursive:true});
  await writeFile(resolve(root,'test-results/art/local-cutaway.png'),Buffer.from(png,'base64'));
});

test('layout profiles inherit defaults, override surfaces and restrict decoration sets', async t => {
  const javascript=execFileSync('bun',['build','src/dungeon-art.ts','--target=browser'],{cwd:root,encoding:'utf8'});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});
  t.after(()=>browser.close());const page=await browser.newPage();
  await page.evaluate(async javascript=>{
    const {renderTerrain,renderDoor}=await import(URL.createObjectURL(new Blob([javascript],{type:'text/javascript'})));
    const cells=Array.from({length:40},(_,i)=>({x:i%8,y:Math.floor(i/8),terrain:{type:i<8?'wall':'floor'}}));
    cells.push({x:8,y:1,terrain:{type:'closedDoor',orientation:'horizontal'}});
    const paint=(layoutType,split=false)=>{
      const c=document.createElement('canvas');c.width=160;c.height=96;const ctx=c.getContext('2d');
      renderTerrain(ctx,cells,{seed:42,layoutType,originX:0,originY:0,columns:10,rows:6,omitDoors:split});
      if(split)for(const cell of cells)renderDoor(ctx,cell,cells,42,cell.x*16,cell.y*16,layoutType);
      return c.toDataURL();
    };
    if(paint()!==paint('dungeon'))throw Error('default dungeon profile changed');
    if(paint('cave')===paint('dungeon'))throw Error('cave override not applied');
    if(paint('cave')!==paint('cave',true))throw Error('cave doors disagree between live/workshop');
    let rejected=false;try{paint('missing')}catch{rejected=true}if(!rejected)throw Error('unknown layout silently accepted');
  },javascript);
  const {readFile}=await import('node:fs/promises');
  const profiles=await Promise.all(['defaults','dungeon','cave'].map(async n=>JSON.parse(await readFile(resolve(root,`art/layout-types/${n}/profile.json`),'utf8'))));
  if(profiles[1].palettes)throw Error('dungeon should inherit palette defaults');
  if(profiles.some(p=>p.decorations.includes('shelf')))throw Error('rejected shelf remains approved');
  if(profiles[2].decorations.some(k=>!['crack','puddle','vines'].includes(k)))throw Error('cave inherited inappropriate dressing');
});

test('cave changes geometry with identical colors across all 16 joins', async t => {
  const javascript=execFileSync('bun',['build','src/structure-sprites.ts','--target=browser'],{cwd:root,encoding:'utf8'});
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});
  t.after(()=>browser.close()); const page=await browser.newPage();
  await page.evaluate(async javascript=>{
    const {drawRockSprite,drawWallSprite}=await import(URL.createObjectURL(new Blob([javascript],{type:'text/javascript'})));
    const palette={cap:'#626d61',edge:'#89907a',face:'#4c574e',shade:'#2b3733',moss:'#546446'};
    for(let mask=0;mask<16;mask++)for(const height of [6,10,14,20]){
      const shape={n:!!(mask&1),e:!!(mask&2),s:!!(mask&4),w:!!(mask&8),heights:[height,height,height,height]};
      const paint=draw=>{const c=document.createElement('canvas');c.width=25;c.height=34;draw(c.getContext('2d'),9,18,shape,height,palette,mask*2197,mask,0);return c};
      const rock=paint(drawRockSprite),stone=paint(drawWallSprite);
      if(rock.toDataURL()===stone.toDataURL())throw Error(`same geometry ${mask}/${height}`);
      const data=rock.getContext('2d').getImageData(0,0,25,34).data;
      if(!data.some((v,i)=>i%4===3&&v===255))throw Error('empty rock tile');
      for(let i=3;i<data.length;i+=4)if(data[i]!==0&&data[i]!==255)throw Error('antialiased cave sprite');
    }
  },javascript);
});
