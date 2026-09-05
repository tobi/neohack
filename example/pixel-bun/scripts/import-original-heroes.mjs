import { chromium } from 'playwright-core';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', chromiumSandbox: true });
const palette = ['#121b24','#25303d','#414c58','#637687','#94a6ac','#d6d9c2',
  '#351f25','#63333b','#955145','#472e24','#765036','#ac7747','#d5a55e','#f0cf87',
  '#f1b98b','#c77d57','#7a4537','#292239','#403061','#604a80','#8e779a',
  '#283620','#42572b','#6b7939','#959850','#b8b67d','#e8d7ab'];
try {
  const page = await browser.newPage();
  for (const role of ['valkyrie', 'wizard', 'ranger']) {
    const bytes = await readFile(resolve(root, `art/original-heroes/${role}-source.png`));
    const result = await page.evaluate(async ({ url, palette }) => {
      const source = new Image(); source.src = url; await source.decode();
      const rgb = palette.map(hex => [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)));
      const frames = [];
      for (let row=0; row<8; row++) for (let col=0; col<6; col++) {
        const cell = document.createElement('canvas'); cell.width=24; cell.height=32;
        const ctx=cell.getContext('2d', {willReadFrequently:true});
        ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
        // Whole, fixed cells: no independent bounding-box resize or mirroring.
        const x0=Math.round(col*source.width/6), x1=Math.round((col+1)*source.width/6);
        const y0=Math.round(row*source.height/8), y1=Math.round((row+1)*source.height/8);
        ctx.drawImage(source,x0,y0,x1-x0,y1-y0,0,0,24,32);
        const pixels=ctx.getImageData(0,0,24,32).data;
        const grid=[];
        for(let y=0;y<32;y++) { let line=''; for(let x=0;x<24;x++) {
          const offset=(y*24+x)*4;
          if(pixels[offset+3]<160){line+='.';continue;}
          let best=0, score=Infinity;
          rgb.forEach((color,i)=> {const distance=color.reduce((n,c,k)=>n+(c-pixels[offset+k])**2,0);if(distance<score){score=distance;best=i;}});
          line+=String.fromCharCode(65+best);
        } grid.push(line); }
        frames.push({row,col,sourceRect:[x0,y0,x1-x0,y1-y0],pixels:grid});
      }
      // Register each complete clip to one ground baseline. Never resize or
      // register each walking pose independently: lifted feet keep their motion.
      for (let row=0; row<8; row++) {
        const clip=frames.filter(frame=>frame.row===row);
        const bottom=frame=>frame.pixels.findLastIndex(line=>/[^.]/.test(line));
        const dy=31-(row<4?bottom(clip[0]):Math.max(...clip.map(bottom)));
        const translated=frame=>Array.from({length:32},(_,y)=>frame.pixels[y-dy]??'.'.repeat(24));
        const idle=translated(clip[0]);
        for (const frame of clip) {
          frame.pixels=row<4?[...idle]:translated(frame);
          frame.registrationOffset=[0,dy];
          if(row<4){frame.sourceFrame=0;frame.sourceRect=[...clip[0].sourceRect];}
        }
      }
      return {sourceSize:[source.width,source.height],frames};
    }, {url:'data:image/png;base64,'+bytes.toString('base64'),palette});
    const recipe={version:1,role,source:`${role}-source.png`,sourceSha256:createHash('sha256').update(bytes).digest('hex'),
      generation:{tool:'built-in image_gen',model:'not reported by tool',prompt:`${role}-prompt.txt`,seed:null},
      normalization:'Fixed 6x8 source cells; area reduction to 24x32; alpha >=160; nearest shared palette color. Per-clip vertical ground registration; no per-frame resizing or mirroring. Idle holds the first directional drawing across six timing cells to avoid generated shimmer. Walking retains all six generated poses.',
      frameSize:[24,32],pivot:[12,32],directions:['right','up','left','down'],fps:{idle:6,walk:10},
      palette:Object.fromEntries(palette.map((c,i)=>[String.fromCharCode(65+i),c])),...result};
    await writeFile(resolve(root,`art/original-heroes/${role}.json`),JSON.stringify(recipe,null,2)+'\n');
    console.log(`${role}: ${result.sourceSize.join('x')} source → 48 editable 24x32 frames`);
  }
} finally { await browser.close(); }
