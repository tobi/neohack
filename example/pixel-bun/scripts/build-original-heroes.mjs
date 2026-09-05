import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root=resolve(import.meta.dirname,'..');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',chromiumSandbox:true});
try {
  const page=await browser.newPage();
  const previews=[];
  for(const role of ['valkyrie','wizard','ranger']) {
    const recipe=JSON.parse(await readFile(resolve(root,`art/original-heroes/${role}.json`),'utf8'));
    const result=await page.evaluate(recipe=>{
      const sheet=document.createElement('canvas');sheet.width=576;sheet.height=64;
      const ctx=sheet.getContext('2d');
      const frames=recipe.frames.map(frame=>{
        const canvas=document.createElement('canvas');canvas.width=24;canvas.height=32;
        const c=canvas.getContext('2d');
        frame.pixels.forEach((line,y)=>[...line].forEach((token,x)=>{if(token!=='.'){if(!recipe.palette[token])throw Error('Unknown palette token');c.fillStyle=recipe.palette[token];c.fillRect(x,y,1,1);}}));
        const direction=frame.row%4,state=Math.floor(frame.row/4);
        ctx.drawImage(canvas,direction*144+frame.col*24,state*32);
        return {row:frame.row,col:frame.col,url:canvas.toDataURL(),bounds:frame.pixels.map((line,y)=>line.includes('.')&&line==='........................'?null:y).filter(y=>y!==null)};
      });
      return {sheet:sheet.toDataURL(),portrait:frames.find(f=>f.row===3&&f.col===0).url,frames};
    },recipe);
    const name=`${role}-original`;
    for(const [suffix,url] of [['-motion',result.sheet],['',result.portrait]])await writeFile(resolve(root,`public/art/${name}${suffix}.png`),Buffer.from(url.split(',')[1],'base64'));
    // Only runtime PNGs belong in public/art. Portable source provenance and
    // animation parameters remain in art/original-heroes/*.json and art/recipe.json.
    previews.push({role,...result});
  }
  await page.setContent('<body style="margin:0;background:#454b44;display:flex;gap:24px;padding:16px;color:#e8d7ab;font:16px monospace"></body>');
  await page.evaluate(previews=>{for(const actor of previews){const box=document.createElement('div');box.innerHTML='<p>'+actor.role+'</p>';for(const row of [3,0,1,2,7]){const strip=document.createElement('div');strip.style.display='flex';for(const f of actor.frames.filter(f=>f.row===row).slice(0,3)){const img=new Image();img.src=f.url;img.style='width:96px;height:128px;image-rendering:pixelated';strip.append(img)}box.append(strip)}document.body.append(box)}},previews);
  await mkdir(resolve(root,'test-results/art'),{recursive:true});
  await page.screenshot({path:resolve(root,'test-results/art/original-heroes.png'),fullPage:true});
  console.log('Three original hero sheets built from editable pixel grids.');
}finally{await browser.close()}
