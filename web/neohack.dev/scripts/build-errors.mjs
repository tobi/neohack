import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const hero=(await readFile(resolve(root,'public/art/valkyrie.png'))).toString('base64');
const dog=(await readFile(resolve(root,'public/art/dog.png'))).toString('base64');
const digits={0:['01110','11011','11011','11011','11011','11011','01110'],4:['10010','10010','10010','11111','00010','00010','00010'],5:['11111','10000','10000','11110','00001','00001','11110']};
const rect=(x,y,w,h,fill)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
function art(code){
 let svg='';
 // Stone numerals follow the existing dungeon's olive masonry and amber lights.
 for(let y=103;y<134;y+=8)for(let x=24;x<234;x+=16){const ox=(y%16?0:8);svg+=rect(x+ox,y,15,7,'#303d35')+rect(x+ox,y,15,1,'#53604a');}
 svg+=rect(17,100,222,3,'#778063')+rect(24,134,218,3,'#111b1d');
 for(const [n,char] of [...String(code)].entries())for(let y=0;y<7;y++)for(let x=0;x<5;x++)if(digits[char][y][x]==='1'){
  const px=29+n*69+x*11,py=15+y*11;
  svg+=rect(px+3,py+4,11,11,'#101b1d')+rect(px,py,10,10,(x+y)%3?'#72785b':'#82866a')+rect(px,py,10,2,'#a2a185')+rect(px,py+8,10,2,'#434d3b');
  if((x*3+y+n)%6===0)svg+=rect(px,py+7,4,3,'#53673c');
 }
 for(const x of [14,237]){svg+=rect(x,72,5,24,'#344238')+rect(x-2,70,9,5,'#918767')+rect(x,60,5,10,'#dba751')+rect(x+1,58,3,9,'#ffe1a0')+rect(x+2,61,2,6,'#fff0bc');}
 svg+=rect(78,126,17,3,'#182322')+rect(133,126,17,3,'#182322');
 svg+=`<image href="data:image/png;base64,${hero}" x="78" y="96" width="16" height="32"/><image href="data:image/png;base64,${dog}" x="132" y="112" width="16" height="16"/>`;
 if(code===500){svg+=rect(172,117,8,8,'#7e6847')+rect(182,113,7,12,'#534e3a')+rect(171,115,7,2,'#b8a16b');}
 else{svg+=rect(173,115,2,13,'#796a4d')+rect(165,106,21,10,'#aa9770')+rect(168,110,14,2,'#4e503e');}
 for(const [x,y] of [[6,29],[249,38],[19,142],[221,148],[61,143],[143,4]])svg+=rect(x,y,2,2,'#4e6251');
 return `<svg class="scene" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 152" role="img" aria-label="${code} carved in torchlit dungeon stone, with an adventurer and a loyal dog" shape-rendering="crispEdges">${svg}</svg>`;
}
const css=await readFile(resolve(root,'art/errors/style.css'),'utf8');
const pages={
 400:{label:'400 · BAD REQUEST',title:'The scroll is unreadable.',copy:'Something about this request didn’t make it through. Check the address, or return to the dungeon entrance.',note:'A wrong turn is still part of the adventure.'},
 404:{label:'404 · NOT FOUND',title:'This passage leads nowhere.',copy:'There’s no page at this address. The dungeon has many secrets. This one is probably a missing link.',note:'Your next adventure is back through the doorway.'},
 500:{label:'500 · SERVER ERROR',title:'A little trouble below ground.',copy:'Something on our side has gone wrong. Take a breath, keep your run’s bookmark, and try again in a moment.',note:'Your browser may still hold progress that hasn’t synced. Don’t clear its site data.'},
};
for(const [code,page] of Object.entries(pages)){
 const html=`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="theme-color" content="#171f23"><title>${code} · ${page.title} · neohack</title><style>${css}</style></head><body><header><a href="/" class="brand"><span>neo</span>hack</a><span class="edition">A LITTLE COURAGE.</span></header><main>${art(Number(code))}<p class="code">${page.label}</p><h1>${page.title}</h1><p class="copy">${page.copy}</p><nav aria-label="Recovery"><a class="button" href="/">Back to the entrance <span aria-hidden="true">↗</span></a></nav><p class="note">${page.note}</p></main><footer><span>ONE DUNGEON. MANY POSSIBILITIES.</span><a href="https://limezu.itch.io/moderninteriors">Character art · LimeZu</a></footer></body></html>\n`;
 await writeFile(resolve(root,`public/${code}.html`),html);
}
console.log('Built self-contained 400, 404 and 500 dungeon pages.');
