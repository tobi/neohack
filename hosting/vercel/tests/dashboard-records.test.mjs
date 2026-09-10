import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from '../../../web/neohack.dev/node_modules/playwright-core/index.mjs';
import {MemoryStorage, createTestHarness} from './server.mjs';
import {storageContext} from '../src/storage.ts';
import {ledgerStats, ledgerRun, saveLedgerRun} from '../src/ledger-store.ts';
import {sanitizeRun} from '../src/board.ts';
const DAY=86400000, now=Date.UTC(2026,8,8,18), today=Date.UTC(2026,8,8);
const run=(id,overrides={})=>({id,name:'Hero '+id,role:'wizard',actualClass:'wizard',turn:100,maxLevel:2,maxDepth:1,ended:false,updatedAt:now,...overrides});
const source=()=>[
 ...Array.from({length:250},(_,i)=>run('recent-'+String(i).padStart(3,'0'),{turn:i+1,updatedAt:now-i*1000,role:i%2?'wizard':'ranger',actualClass:i%2?'wizard':'ranger'})),
 run('today-depth',{name:'Deep Delver',turn:730,maxLevel:3,maxDepth:14,updatedAt:today}),
 run('today-level',{name:'Learned Hero',turn:950,maxLevel:9,maxDepth:5,updatedAt:today+1}),
 run('week-depth',{name:'Week Delver',turn:980,maxLevel:5,maxDepth:20,updatedAt:today-6*DAY}),
 run('week-level',{name:'Week Scholar',turn:1000,maxLevel:12,maxDepth:6,updatedAt:today-6*DAY+1}),
 run('outside',{maxLevel:30,maxDepth:99,updatedAt:today-6*DAY-1}),
 run('yesterday',{maxLevel:4,maxDepth:3,updatedAt:today-1}),
 run('unknown',{maxLevel:undefined,maxDepth:undefined,updatedAt:now+1}),
];

test('recent 200 are latest distinct runs; UTC records cover the entire ledger, not the plot or all-time leaders',async t=>{
 t.mock.method(Date,'now',()=>now);const store=new MemoryStorage(),original={runs:source(),errors:[]};await store.write('board/index.json',original);
 await storageContext.run(store,async()=>{
  const data=await ledgerStats();
  assert.equal(data.recent.length,200);assert.equal(new Set(data.recent.map(r=>r.id)).size,200);
  assert.deepEqual(data.recent.map(r=>r.id),source().sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id)).slice(0,200).map(r=>r.id));
  assert.ok(!data.recent.some(r=>r.id==='today-depth'));
  assert.equal(data.records.today.depth[0].id,'today-depth');assert.equal(data.records.today.level[0].id,'today-level');
  assert.equal(data.records.week.depth[0].id,'week-depth');assert.equal(data.records.week.level[0].id,'week-level');
  assert.equal(data.records.today.from,today);assert.equal(data.records.week.from,today-6*DAY);assert.equal(data.records.week.to,now);
  assert.equal(data.records.today.runs,253);assert.equal(data.records.week.runs,256);
  for(const period of [data.records.today,data.records.week])for(const metric of ['level','depth']){
   assert.equal(period[metric].length,3);assert.ok(!period[metric].some(r=>r.id==='unknown'||r.id==='outside'));
  }
  assert.deepEqual((await store.read('board/index.json')).value,original,'published predecessor is unchanged');
  const reads=[],read=store.read.bind(store);store.read=async path=>{reads.push(path);return read(path)};
  await ledgerStats();assert.equal(reads.length,32);assert.ok(reads.every(p=>p.startsWith('ledger/summaries/')));
  const tomorrow=await ledgerStats(today+DAY+1);assert.equal(tomorrow.records.today.runs,0);assert.deepEqual(tomorrow.records.today.depth,[]);
  assert.equal(tomorrow.records.week.depth[0].id,'today-depth','the oldest day expires without new uploads');
 });
});

test('accepted updates retain maximum depth and level; invalid/missing scores do not create zero-valued records',async t=>{
 t.mock.method(Date,'now',()=>now);const store=new MemoryStorage();
 await storageContext.run(store,async()=>{
  await saveLedgerRun(run('peak',{maxLevel:9,maxDepth:16}));
  await saveLedgerRun(run('peak',{turn:101,maxLevel:2,maxDepth:1}));
  const record=await ledgerRun('peak');assert.equal(record.maxLevel,9);assert.equal(record.maxDepth,16);
  await saveLedgerRun(run('unknown',{maxLevel:undefined,maxDepth:undefined}));
  const stats=await ledgerStats();assert.equal(stats.records.today.level.length,1);assert.equal(stats.records.today.depth.length,1);
  for(const value of [0,-1,1.5,Infinity,'6']){
   const clean=sanitizeRun({...run('invalid'),maxLevel:value,maxDepth:value},now);assert.equal(clean.maxLevel,undefined);assert.equal(clean.maxDepth,undefined);
  }
 });
});

test('old derived summaries refresh from their partitions once and never change run records',async t=>{
 t.mock.method(Date,'now',()=>now);const store=new MemoryStorage();
 await storageContext.run(store,async()=>{
  await saveLedgerRun(run('kept',{maxDepth:8}));const before=await store.read('ledger/runs/kept.json');
  for(const path of await store.list('ledger/summaries/')){
   const doc=await store.read(path);delete doc.value.format;delete doc.value.recent;delete doc.value.daily;await store.write(path,doc.value,doc.etag);
  }
  const stats=await ledgerStats();assert.equal(stats.recent[0].id,'kept');assert.equal(stats.records.today.depth[0].maxDepth,8);
  assert.deepEqual(await store.read('ledger/runs/kept.json'),before);
  const reads=[],read=store.read.bind(store);store.read=async path=>{reads.push(path);return read(path)};
  await ledgerStats();assert.equal(reads.length,32);assert.ok(reads.every(p=>p.startsWith('ledger/summaries/')));
 });
});

test('frontpage count is small and CDN-cacheable; a failed read is never cached as zero',async t=>{
 const store=new MemoryStorage();await store.write('board/index.json',{runs:source(),errors:[]});
 const server=createTestHarness({store}),{url}=await server.listen();t.after(()=>server.close());
 const response=await fetch(new URL('/api/stats?view=count',url));
 assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/s-maxage=60/);
 const text=await response.text();assert.deepEqual(JSON.parse(text),{runs:257});assert.ok(text.length<64);
 store.read=async()=>{throw Error('unavailable')};
 const unavailable=await fetch(new URL('/api/stats?view=count',url));
 assert.equal(unavailable.status,503);assert.equal(unavailable.headers.get('cache-control'),'no-store');
 assert.equal((await unavailable.json()).runs,undefined);
});

test('dashboard plot, class filtering, keyboard selection, metric switch and records work on desktop and phone',async t=>{
 t.mock.method(Date,'now',()=>now);
 const store=new MemoryStorage();
 const classes=['archeologist','barbarian','caveman','healer','knight','monk','priest','ranger','rogue','samurai','tourist','valkyrie','wizard'];
 const varied=source().map((r,i)=>r.id.startsWith('recent-')?{...r,turn:(i+1)*(1+i%19),maxLevel:1+i%7,maxDepth:1+i%11,role:classes[i%13],actualClass:classes[i%13]}:r);
 await store.write('board/index.json',{runs:varied,errors:[]});
 const server=createTestHarness({store}),{url}=await server.listen();
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});
 t.after(async()=>{await browser.close();await server.close()});
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).pathname));
 await page.goto(new URL('/dashboard',url).href);await page.locator('#run-chart [data-run]').first().waitFor();
 assert.equal(await page.locator('#run-chart [data-run]').count(),199);assert.match(await page.locator('#plot-missing').textContent(),/1 run has no recorded depth/);
 assert.match(await page.locator('[data-period=today][data-metric=depth]').textContent(),/Deep Delver/);
 assert.match(await page.locator('[data-period=week][data-metric=level]').textContent(),/Week Scholar/);
 assert.match(await page.locator('#period-records').textContent(),/UTC/);
 const first=page.locator('#run-chart [data-run]').first();await first.focus();const selected=await page.locator('#selected-run').textContent();await page.keyboard.press('ArrowRight');assert.notEqual(await page.locator('#selected-run').textContent(),selected);
 await page.locator('[data-class=ranger]').click();assert.ok((await page.locator('#run-chart [data-run]').count())<199);
 assert.equal(await page.locator('[data-class=ranger]').getAttribute('aria-pressed'),'true');
 await page.locator('#chart-metric').selectOption('level');assert.match(await page.locator('#run-chart svg').getAttribute('aria-label'),/best hero level/);
 await page.locator('[data-class=""]').click();assert.equal(await page.locator('#run-chart [data-run]').count(),199);
 await page.locator('#chart-metric').selectOption('depth');
 await page.locator('.plot-data summary').click();assert.equal(await page.locator('#recent-runs tr').count(),200);await page.locator('.plot-data summary').click();
 const out=resolve(import.meta.dirname,'../../../web/neohack.dev/test-results');await mkdir(out,{recursive:true});
 await page.screenshot({path:out+'/dashboard-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('#run-chart svg').viewBox.baseVal.width<400);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 for(const b of await page.locator('.class-filter').all())assert.ok((await b.boundingBox()).height>=44);
 assert.equal(await page.locator('#run-chart [data-run]').count(),199);
 await page.locator('#run-chart [data-run]').last().focus();assert.match(await page.locator('#selected-run').textContent(),/Hero recent-/);
 await page.screenshot({path:out+'/dashboard-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);assert.ok(!requests.some(p=>p==='/api/runs'||p.includes('/inputs')||p.includes('/replay')),'plotting never downloads journals or starts a replay');
});

test('empty, unknown and coincident chart values stay usable; replay needs an explicit button',async t=>{
 const server=createTestHarness(),{url}=await server.listen();
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});
 t.after(async()=>{await browser.close();await server.close()});
 const page=await browser.newPage(),errors=[],selected=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/stats',route=>route.fulfill({json:{generatedAt:now,totals:{runs:0,living:0,ascended:0,longest:0},best:[],roles:[],recent:[],records:{today:{runs:0,level:[],depth:[]},week:{runs:0,level:[],depth:[]}}}}));
 await page.goto(new URL('/dashboard',url).href);await page.getByText('No recent adventures yet.').waitFor();
 assert.equal(await page.getByText('None recorded yet.',{exact:true}).count(),4);
 await page.exposeFunction('recordReplaySelection',id=>selected.push(id));
 await page.evaluate(async()=>{
  const {runChart}=await import('/dashboard-chart.js');
  runChart(run=>window.recordReplaySelection(run.id)).update([
   {id:'same1',name:'<b>A</b>',role:'constructor',turn:20,maxDepth:3,maxLevel:2,replayAvailable:true},
   {id:'same2',name:'B',role:'wizard',turn:20,maxDepth:3,maxLevel:2,replayAvailable:true},
   {id:'missing',name:'Unknown',role:'wizard',turn:50,maxLevel:2},
  ]);
 });
 await page.locator('#run-chart [data-run=same1]').focus();
 assert.match(await page.locator('#selected-run').textContent(),/Unknown class/);
 assert.equal(await page.locator('#selected-run b').count(),0,'names stay plain text');
 const select=page.getByLabel('Runs at the selected point');assert.equal(await select.locator('option').count(),2);
 await select.selectOption('same2');assert.match(await page.locator('#selected-run').textContent(),/B/);assert.deepEqual(selected,[]);
 await page.locator('#selected-run').getByRole('button',{name:'Show replay',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#selected-run strong')?.textContent==='B');
 assert.deepEqual(selected,['same2']);assert.deepEqual(errors,[]);
});

test('ledger WebMCP badge exposes escaped harness and model attribution',async t=>{
 const store=new MemoryStorage();
 const entry=run('attributed',{name:'Agent hero',webmcpAutomated:true,automated:true,control:'script',harness_name:'Pi <browser>',model_name:'Muse & Spark'});
 await store.write('board/index.json',{runs:[entry],errors:[]});
 const server=createTestHarness({store}),{url}=await server.listen();t.after(()=>server.close());
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM??'/usr/bin/chromium',headless:true,chromiumSandbox:true});t.after(()=>browser.close());
 const page=await browser.newPage();await page.goto(new URL('/dashboard',url).href);
 const badge=page.locator('#runs .webmcp-badge');await badge.waitFor();
 assert.equal(await badge.getAttribute('title'),'WebMCP automated · Harness: Pi <browser> · Model: Muse & Spark');
 assert.equal(await badge.getAttribute('aria-label'),await badge.getAttribute('title'));
 assert.equal(await badge.locator('browser').count(),0);await badge.focus();assert.equal(await badge.evaluate(e=>document.activeElement===e),true);
 await page.screenshot({path:resolve(import.meta.dirname,'../../../web/neohack.dev/test-results/webmcp-badge.png')});
});
