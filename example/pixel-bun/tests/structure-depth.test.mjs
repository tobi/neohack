import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright-core';
const root=resolve(import.meta.dirname,'..');
test('shared structure depth agrees with independent ray/box intersections across door states and cutaways',async t=>{
 const source=execFileSync('bun',['build','src/structure-sprites.ts','--target=browser'],{cwd:root,encoding:'utf8'});
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});
 t.after(()=>browser.close());const page=await browser.newPage();
 const result=await page.evaluate(async source=>{
  const {drawWallSprite,drawDoorSprite,structureLayer}=await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'})));
  const canvas=()=>Object.assign(document.createElement('canvas'),{width:96,height:96});
  const pixels=c=>c.getContext('2d').getImageData(0,0,96,96).data;
  const wallPalette={cap:'#687565',edge:'#9a9e82',face:'#4d594c',shade:'#29392f',moss:'#68744c'};
  const doorPalette={cap:'#7d7357',edge:'#afa37a',face:'#66583e',shade:'#433b2f',moss:'#78754f'};
  // Intersect a world-space ray (sx+.375*z, sy+.75*z, z) with an axis-aligned box.
  // This reference uses geometry only, independently of the triangle rasterizer.
  const hit=(sx,sy,b)=>{
   const low=Math.max(b[2],(b[0]-sx)/.375,(b[1]-sy)/.75);
   const high=Math.min(b[5],(b[3]-sx)/.375,(b[4]-sy)/.75);
   return high>low+1e-6?high:-Infinity;
  };
  const sheet=Object.assign(document.createElement('canvas'),{width:768,height:1152});
  const sc=sheet.getContext('2d');sc.imageSmoothingEnabled=false;sc.fillStyle='#171f23';sc.fillRect(0,0,sheet.width,sheet.height);
  let checked=0,wrongPainter=0,index=0;
  for(const vertical of [false,true])for(const type of ['closedDoor','openDoor','doorway'])for(const height of [6,10,14,20]){
   const wx=vertical?32:48,wy=vertical?48:32;
   const shape={n:vertical,s:vertical,e:!vertical,w:!vertical,heights:[0,0,0,0]};
   const wallBox=vertical?[wx+3,wy,0,wx+13,wy+16,height]:[wx,wy+3,0,wx+16,wy+13,height];
   let boxes=[[0,3,0,2,13,24],[14,3,0,16,13,24],[2,3,20,14,13,24]];
   if(type==='closedDoor')boxes.push([2,12,1,14,13,20],[11,13,9,12,14,11]);
   if(type==='openDoor')boxes.push([2,3,1,3,13,20],[3,4,9,4,5,11]);
   boxes=boxes.map(([x,y,z,X,Y,Z])=>vertical?[y+32,x+32,z,Y+32,X+32,Z]:[x+32,y+32,z,X+32,Y+32,Z]);
   const paint=(mode)=>{
    const c=canvas(),ctx=c.getContext('2d');const layer=mode==='shared'||mode==='reverse'?structureLayer(ctx,96,96):undefined;
    const wall=()=>drawWallSprite(ctx,wx,wy,shape,height,wallPalette,42,wx/16,wy/16,undefined,layer);
    const door=()=>drawDoorSprite(ctx,32,32,type,vertical,doorPalette,42,layer);
    if(mode==='reverse'){door();wall();}else {if(mode!=='door')wall();if(mode!=='wall')door();}
    layer?.paint(ctx);return c;
   };
   const combined=paint('shared'),actual=pixels(combined),reversed=pixels(paint('reverse'));
   const wall=pixels(paint('wall')),door=pixels(paint('door')),old=pixels(paint('old'));
   if(!actual.every((v,i)=>v===reversed[i]))throw Error('Submission order changed depth: '+[vertical,type,height]);
   for(let y=0;y<96;y++)for(let x=0;x<96;x++){
    const at=(y*96+x)*4;if(!wall[at+3]||!door[at+3])continue;
    const wz=hit(x+.5,y+.5,wallBox),dz=Math.max(...boxes.map(b=>hit(x+.5,y+.5,b)));
    if(!Number.isFinite(wz)||!Number.isFinite(dz)||Math.abs(wz-dz)<1e-5)continue;
    const expected=wz>dz?wall:door;
    for(let k=0;k<4;k++)if(actual[at+k]!==expected[at+k])throw Error('Wrong physical occlusion: '+[vertical,type,height,x,y,wz,dz]);
    if([0,1,2].some(k=>old[at+k]!==expected[at+k]))wrongPainter++;
    checked++;
   }
   const col=index%4,row=Math.floor(index/4);sc.drawImage(combined,col*192,row*192,192,192);index++;
  }
  if(checked<100||wrongPainter<10)throw Error('Fixture did not exercise enough genuine overlaps: '+[checked,wrongPainter]);
  return {checked,wrongPainter,image:sheet.toDataURL().split(',')[1]};
 },source);
 await mkdir(resolve(root,'test-results'),{recursive:true});
 await writeFile(resolve(root,'test-results/structure-depth.png'),Buffer.from(result.image,'base64'));
 t.diagnostic(JSON.stringify({overlapPixels:result.checked,oldPainterWrongPixels:result.wrongPainter}));
});
