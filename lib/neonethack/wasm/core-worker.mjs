import { fetchCloudReplica } from './cloud-replica.mjs';
import { ReplicaUploader } from './replica-uploader.mjs';
import { listen, send, worker, inNode } from './worker-port.mjs';
import { loadManifest, checked } from './assets.mjs';
import { openBlockStore, hasStoredSession } from './block-store.mjs';
import {openProtocolStore} from './protocol-store.mjs';
import {randomRunId,digest,validateRecord,recordingFormat} from './protocol-recording.mjs';
import {captureFiles,restoreFiles} from './checkpoint-files.mjs';
import {ProtocolUploader} from './protocol-uploader.mjs';
import {inputManifest,inputRecords,validateManifest,checkpointBytes} from './protocol-reader.mjs';
import {decodeCheckpoint,checkpointBuffers} from './checkpoint-codec.mjs';
import {replayEvidence} from './replay-evidence.mjs';
let module, manifest, storage, releaseLock, store, runtimeBase;
let journal, readOnlyMethods=new Set(), journalHeaders=new Map(), journalLoaded=new Set(), journalPresent=new Set();
let playbackIndex=0;
let playbackScene;
let replayArchive;
const playbackRecords=[];
let checkpointSequence=0;
let protocolUploader;
let registrationSequence=0;
const registrations=new Map();
function registerUpload(sessionId,signal) {
  return new Promise((resolve,reject)=>{
    const id=++registrationSequence;
    const finish=ok=>{
      clearTimeout(timer);signal.removeEventListener('abort',abort);registrations.delete(id);
      ok?resolve():reject(Error('Run registration pending'));
    };
    const abort=()=>{send({type:'cancelRegistration',id});finish(false);};
    const timer=setTimeout(abort,15000);
    registrations.set(id,finish);
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted){abort();return;}
    send({type:'registerUpload',id,sessionId});
  });
}
let checkpointFlight,checkpointWorker;
let coreFactory,coreBinary,sessionsRoot;
let booted = false;
let requestActive = false, replica, replicaRevision = null, replicaFiles = [];
const queueReplica = () => replica?.queue();

let nextHandle = 1;
let tail = Promise.resolve();
const engines = new Map();
const retirements = [];
const encoder = new TextEncoder();
const progress = stage => send({type:'startup',stage});
const diagnostic = text => send({ type: 'diagnostic', text: String(text).slice(-4096) });

function engineStop(handle) {
  const entry = engines.get(handle);
  if (!entry) return;
  entry.ended = true;
  entry.waiter?.(null);
  entry.waiter = null;
  retirements.push(Promise.resolve(entry.worker.stop()));
  engines.delete(handle);
}
function startEngine(args, restored) {
  const handle = restored?.handle ?? nextHandle++;
  const entry = { args, queue: restored?.queue??[], bytes: restored?.bytes??0, waiter: null, ended: false, worker: null, checkpoints:new Map() };
  entry.ready=new Promise((resolve,reject)=>{entry.boot=resolve;entry.rejectBoot=reject;});
  entry.ready.catch(()=>{});
  const fail = error => { diagnostic(error);entry.rejectBoot(error);for(const p of entry.checkpoints.values())p.reject(error);entry.checkpoints.clear(); entry.ended = true; entry.waiter?.(null); entry.waiter = null; };
  entry.worker = worker(new URL('./engine-worker.mjs', import.meta.url), message => {
    if (message.type === 'line') {
      if (typeof message.line !== 'string' || encoder.encode(message.line).byteLength > 16 * 1024 * 1024) { fail('Invalid engine frame'); engineStop(handle); return; }
      if (entry.waiter) { const resolve = entry.waiter; entry.waiter = null; resolve(message.line); }
      else {
        entry.bytes += encoder.encode(message.line).byteLength;
        if (entry.bytes > 32 * 1024 * 1024) { fail('Engine output queue limit exceeded'); engineStop(handle); return; }
        entry.queue.push(message.line);
      }
    } else if(message.type==='booted')entry.boot();
    else if(message.type==='checkpoint'){
      const pending=entry.checkpoints.get(message.id);entry.checkpoints.delete(message.id);
      if(pending)message.error?pending.reject(Error(message.error)):pending.resolve(message.value);
    } else if (message.type === 'diagnostic') diagnostic(message.text);
    else if (message.type === 'exit') { entry.ended = true; if (!entry.queue.length) { entry.waiter?.(null); entry.waiter = null; } }
    else if (message.type === 'fatal') fail(message.message);
  }, fail);
  engines.set(handle, entry);
  entry.worker.post({ type: 'start', base: runtimeBase.href, manifest, args, checkpoint:restored?.process });
  return handle;
}
async function acquireStore(name) {
  if (inNode || !globalThis.navigator?.locks || !globalThis.indexedDB) throw Error('Persistent WASM storage requires IndexedDB and Web Locks in a secure browser context');
  let ready, reject;
  const acquired = new Promise((resolve, bad) => { ready = resolve; reject = bad; });
  const lifetime = new Promise(resolve => { releaseLock = resolve; });
  navigator.locks.request(`neonethack:v1:${name}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) { reject(Error('Another worker or tab owns this WASM store')); return; }
    ready();
    await lifetime;
  }).catch(reject);
  await acquired;
}
async function initialize(options) {
  if (booted) throw Error('WASM runtime is already initialized');
  booted = true;
  storage = options.storage ?? { kind: 'memory' };
  replayArchive=options.playbackArchive;
  if (!['memory','indexeddb','journal'].includes(storage.kind)) throw Error('Unknown WASM storage kind');
  if (storage.kind !== 'memory') {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(storage.name ?? '')) throw Error('Storage name must be 1..64 ASCII letters, digits, underscores or hyphens');
    progress('ownership');
    await acquireStore(storage.name);
  }
  const base = runtimeBase = new URL(options.runtimeUrl ?? './', import.meta.url);
  progress('assets');
  manifest = await loadManifest(base);
  if(replayArchive){
    validateManifest(replayArchive.manifest);
    const source=new URL(replayArchive.url);
    if(storage.kind!=='memory'||replayArchive.manifest.buildId!==manifest.buildId||!['http:','https:'].includes(source.protocol)||source.username||source.password)throw Error('Invalid playback archive');
  }
  const [wasmBinary] = await Promise.all([checked(base, 'neonethack-core.wasm', manifest), checked(base, 'neonethack-core.mjs', manifest)]);
  globalThis.__nnhHost = {
    identity: `neonethack-wasm-build-v1:${manifest.buildId}\n`,
    protocolJournal:storage.kind==='journal',
    receipt:historicalReceipt,
    diagnostic,
    persistence: storage.kind === 'journal' ? 'indexeddb' : storage.kind,
    async sync() {
      if (storage.kind !== 'indexeddb') return;
      const started=performance.now();
      await store.sync();
      const duration=performance.now()-started;
      if(duration>50)send({type:'timing',stage:'durability',duration});

    },
    start: startEngine,
    write(handle, line) {
      const entry = engines.get(handle);
      if (!entry || entry.ended) return false;
      entry.worker.post({ type: 'line', line }); return true;
    },
    read(handle, timeout) {
      const entry = engines.get(handle);
      if (!entry) return Promise.resolve(null);
      if (entry.queue.length) {
        const line = entry.queue.shift(); entry.bytes -= encoder.encode(line).byteLength;
        return Promise.resolve(line);
      }
      if (entry.ended) return Promise.resolve(null);
      return new Promise(resolve => {
        const timer = timeout < 0 ? null : setTimeout(() => { entry.waiter = null; resolve(null); }, timeout);
        entry.waiter = line => { if (timer !== null) clearTimeout(timer); resolve(line); };
      });
    },
    ended: handle => !engines.has(handle) || engines.get(handle).ended,
    stop: engineStop,
  };
  const { default: factory } = await import(new URL('neonethack-core.mjs', base));
  coreFactory=factory;coreBinary=wasmBinary;
  progress('compile');
  module = await factory({ wasmBinary, print: diagnostic, printErr: diagnostic, onAbort: diagnostic });
  const fs = module.FS;
  let replicaBranch;
  const sessions = storage.kind === 'indexeddb' ? `/neonethack/${storage.name}` : '/sessions';
  sessionsRoot=sessions;
  fs.mkdirTree(sessions);
  if (storage.kind === 'indexeddb') {
    let seed, remoteAvailable = false;
    progress('local');
    const localSession=await hasStoredSession(storage.name,storage.replicaSession);
    if (!localSession && typeof storage.replicaUrl === 'string' && storage.replicaUrl && storage.replicaRestore !== false) {
      try {
progress('cloud');
seed = await fetchCloudReplica(storage.replicaUrl);
if (seed) {
  replicaRevision = seed.revision;
  replicaFiles = seed.files;
}
        remoteAvailable = true;
      } catch { seed = undefined; replicaRevision = null; replicaFiles = []; }
    }
    progress('local');
    store = await openBlockStore(module, sessions, storage.name, seed);
    if (storage.replicaUrl && !remoteAvailable) {
      // Local journals remain authoritative when the network is unavailable.
      // Keep the acknowledged base and exact outbox; server CAS still rejects forks.
      replicaRevision = await store.replicaCursor();
    }
    if (storage.replicaUrl && remoteAvailable) {
      let cursor = await store.replicaCursor();
      const pending = await store.replicaOutbox();
      if (pending && pending.commit === replicaRevision) {
        // The cloud accepted this exact durable upload before the browser lost its acknowledgement.
        await store.replicaCursor(replicaRevision, pending.files);
        await store.replicaOutbox(null);
        cursor = replicaRevision;
      }
      replicaRevision = cursor;
    }
    if(storage.replicaBranches) {
      replicaBranch=await store.replicaBranch();
      replicaRevision=await store.replicaCursor();
    }
    replicaFiles=await store.replicaAcknowledged();
  }
  if (storage.replicaUrl && store) {
    const url=new URL(storage.replicaUrl);
    if(replicaBranch)url.searchParams.set('branch',replicaBranch);
    replica = new ReplicaUploader({store,url:url.href,revision:replicaRevision,files:replicaFiles,
      active:()=>requestActive,status:(state,message='')=>send({type:'replica',state,message,branch:replicaBranch,sessions:state==='saved'?replica.files.filter(([p])=>p.split('/').length===5&&p.endsWith('/meta.json')).map(([p])=>p.split('/')[3]):undefined})});
    replica.queue();
  }
  fs.mkdir('/template');
  fs.writeFile('/engine-build', globalThis.__nnhHost.identity, { mode: 0o700 });
  progress('engine');
  const status = await module.ccall('nnh_wasm_open', 'number', ['string', 'string', 'string'], ['/engine-build', '/template', sessions], { async: true });
  if (status !== 0) throw Error(`Cannot open WASM world store (${status})`);
  const discovery=await dispatch({version:1,method:'protocol.describe',params:{}});
  readOnlyMethods=new Set(discovery.catalog.methods.filter(m=>m.readOnly).map(m=>m.name));
  if(storage.kind==='journal'){
    journal=await openProtocolStore(storage.name);
    for(const header of await journal.headers())journalHeaders.set(header.id,header);
    if(storage.uploadUrl&&storage.uploadToken){
      protocolUploader=new ProtocolUploader({store:journal,headers:journalHeaders,url:storage.uploadUrl,token:storage.uploadToken,
        ...(options.registerUploads?{register:registerUpload}:{}),
        active:()=>requestActive,status:state=>send({type:'replica',state,message:''})});
      for(const header of journalHeaders.values())protocolUploader.queue(header.id);
    }
  }
  progress('ready');
  return { buildId: manifest.buildId, persistence: storage.kind };
}
async function close() {
  try {
    requestActive = true;
    try { if (module) await module.ccall('nnh_wasm_close', null, [], [], { async: true }); }
    finally { requestActive = false; }
    if (storage?.replicaUrl && store) {
      queueReplica();
      await replica?.close();
    }
  } finally {
    for (const handle of engines.keys()) engineStop(handle);
    await Promise.allSettled(retirements);
    store?.close();
    journal?.close();
    protocolUploader?.close();
    await checkpointWorker?.stop();
    releaseLock?.();
  }
}
async function dispatch(request,creation) {
  globalThis.__nnhHost.creation=creation;
  globalThis.__nnhHost.witnesses=[];
  requestActive=true;
  try {
    const response=await module.ccall('nnh_wasm_request','string',['string'],[JSON.stringify(request)],{async:true});
    if(!response)throw Error('WASM core could not allocate a result');
    return JSON.parse(response);
  } finally {requestActive=false;globalThis.__nnhHost.creation=undefined;}
}
async function replayRecord(record) {
  validateRecord(record,record.index);
  const result=await dispatch(record.request,record.creation);
  if(record.digest && await digest(JSON.stringify(result))!==record.digest)throw Error(`Replay differs at input ${record.index}; no later input was sent`);
  if(record.integrity&&JSON.stringify(record.integrity)!==JSON.stringify(globalThis.__nnhHost.witnesses))throw Error(`Replay RNG boundaries differ at input ${record.index}; no later input was sent`);
  return result;
}
function summarize(header,result){
  if(result.observation)header.summary={revision:result.revision,turn:result.observation.turn,level:Number(result.observation.vitals.level)||0,depth:result.observation.location.depthLabel,
    maxLevel:Math.max(header.summary?.maxLevel??0,Number(result.observation.vitals.level)||0),outcome:result.end?.kind??'in progress'};
}
async function historicalReceipt(id,rid) {
  // Cold receipts cost replay work only when explicitly requested. Nothing in
  // live play copies full historical responses into another storage system.
  let sequence=0;
  const pending=new Map();
  const instance=worker(new URL('./core-worker.mjs',import.meta.url),message=>{
    const p=pending.get(message.id);
    if(message.type==='result'&&p){pending.delete(message.id);p.resolve(message.result);}
    else if(message.type==='fatal'){for(const p of pending.values())p.reject(Error(message.message));pending.clear();}
  },error=>{for(const p of pending.values())p.reject(error);pending.clear();});
  function exchange(type,payload){return new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Receipt reconstruction timed out'));},120000);
    pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
    instance.post({type,id,...payload});
  });}
  try {
    await exchange('init',{options:{storage:{kind:'memory'},runtimeUrl:runtimeBase.href}});
    const remote=replayArchive?inputRecords(replayArchive.manifest,replayArchive.url,{signal:AbortSignal.timeout(120000)}):undefined;
    let from=0;
    for(;;){
      let records;
      if(remote){const next=await remote.next();records=next.done?[]:[next.value];}
      else records=journal?await journal.range(id,from,128):playbackRecords.slice(from,from+128);
      if(!records.length)return null;
      for(const record of records){
        await exchange('playback',{record});from++;
        if(record.request.params.requestId===rid){
          const result=await exchange('request',{request:{version:1,method:'session.receipt',params:{sessionId:id,requestId:rid}}});
          if(result.error?.code!=='receiptUnavailable'){
            delete result.version;return JSON.stringify(result);
          }
        }
      }
    }
  } finally {await instance.stop();}
}
async function restoreJournal(id) {
  let header=journalHeaders.get(id);
  if(!header&&storage.archiveConfigUrl){
    progress('cloud');
    const signal=AbortSignal.timeout(30000);
    const response=await fetch(storage.archiveConfigUrl,{signal,credentials:'omit'});
    if(!response.ok)throw Error('Cannot find the online input archive');
    const config=await response.json(),base=new URL(config.base,storage.archiveConfigUrl);
    if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw Error('Invalid archive origin');
    let url=new URL('replays/'+id+'/manifest.json',base.href.endsWith('/')?base.href:base.href+'/');
    if(storage.uploadUrl&&storage.uploadToken){
      const head=await fetch(new URL(encodeURIComponent(id)+'/inputs',storage.uploadUrl),{signal,cache:'no-store',headers:{authorization:'Bearer '+storage.uploadToken}});
      if(!head.ok)throw Error('Cannot resolve the latest backed-up input prefix');
      const value=await head.json(),exact=new URL(value.manifest);
      if(exact.origin!==base.origin||!exact.pathname.startsWith(new URL('replays/'+id+'/',base.href.endsWith('/')?base.href:base.href+'/').pathname)||!/^manifest-[a-f0-9]{64}\.json$/.test(exact.pathname.split('/').at(-1))||exact.username||exact.password)throw Error('Invalid immutable input manifest');
      url=exact;
    }
    const remote=await inputManifest(url,signal);
    if(remote.id!==id||remote.buildId!==manifest.buildId)throw Error('Online run package differs');
    // Commit each downloaded range locally. No whole-run buffer is assembled.
    header={format:recordingFormat,version:1,id,buildId:remote.buildId,count:0,updatedAt:Date.now(),complete:false,importing:{manifest:remote,url:url.href}};
    await journal.create(header);journalHeaders.set(id,header);
  }
  if(header?.importing){
    const {manifest:remote,url}=header.importing;
    for await(const record of inputRecords(remote,url,{signal:AbortSignal.timeout(120000),from:header.count})){
      const {digest:hash,integrity,...intent}=record;
      const pending=(await journal.range(id,record.index,1))[0];
      if(pending){if(JSON.stringify(pending)!==JSON.stringify(intent))throw Error('Interrupted import bytes differ');}
      else await journal.reserve(id,record.index,intent);
      header.count++;
      await journal.commit(header,record.index,{digest:hash,integrity});
    }
    // Inputs are authoritative and fully durable before importing an optional
    // acceleration cache. Normal local resume validates its decoded pin/cursor.
    const cached=remote.checkpoints?.at(-1);
    if(cached){
      try{
        await journal.saveCheckpoint(id,await checkpointBytes(cached,url,AbortSignal.timeout(10000)));
      }catch(error){diagnostic('Optional cloud checkpoint unavailable: '+String(error));}
    }
    header.complete=remote.complete;delete header.importing;
    await journal.updateHeader(header);
    await journal.acknowledge(id,{count:header.count,manifest:url});
  }
  if(!header)throw Error('This run is not stored on this device');
  if(header.buildId!==manifest.buildId)throw Error('This run requires its original engine package');
  let index=0;
  const checkpoint=await journal.checkpoint(id);
  if(checkpoint&&!engines.size&&!journalPresent.size){
    try{
      const value=await decodeCheckpoint(checkpoint.bytes,checkpoint.sha256);
      if(value.index!==checkpoint.index)throw Error('Checkpoint cursor differs');
      if(value.index>header.count)throw Error('Checkpoint extends beyond the committed inputs');
      await restoreCheckpoint(value);index=value.index;
    }catch(error){
      // A derived cache may be discarded. The authoritative inputs are still
      // verified in full, and no live process is repaired or replayed twice.
      diagnostic('Ignoring invalid optional checkpoint: '+String(error));
      for(const handle of engines.keys())engineStop(handle);
      await Promise.allSettled(retirements);
      module=await coreFactory({wasmBinary:coreBinary,print:diagnostic,printErr:diagnostic,onAbort:diagnostic});
      module.FS.mkdirTree(sessionsRoot);module.FS.mkdir('/template');
      module.FS.writeFile('/engine-build',globalThis.__nnhHost.identity,{mode:0o700});
      if(await module.ccall('nnh_wasm_open','number',['string','string','string'],['/engine-build','/template',sessionsRoot],{async:true}))throw Error('Cannot open a fresh engine for log restoration');
      index=0;
    }
  }
  for(;;){
    const records=await journal.range(id,index,128);
    if(!records.length)break;
    for(const record of records){
      validateRecord(record,index);
      if(!record.digest&&index!==header.count)throw Error('Local input journal is missing a committed completion');
      const result=await replayRecord(record);
      summarize(header,result);
      index++;
      if(!record.digest){
        // Finish a previously reserved input only in this freshly reconstructed
        // process. Its original request ID still owns the operation.
        header.count=index;header.updatedAt=Date.now();header.complete=!!result.ended;
        await journal.commit(header,record.index,{digest:await digest(JSON.stringify(result)),integrity:globalThis.__nnhHost.witnesses});
      }
    }
  }
  if(index!==header.count)throw Error('Local input journal is incomplete');
  await journal.updateHeader(header);
  journalPresent.add(id);journalLoaded.add(id);
  protocolUploader?.queue(id);
}
async function journalRequest(request) {
  let id=request.params?.sessionId;
  if(request.method==='session.resume'){
    if(!journalPresent.has(id))await restoreJournal(id);
    const result=await dispatch({version:1,method:journalLoaded.has(id)?'session.observe':'session.resume',params:{sessionId:id}});
    journalLoaded.add(id);return result;
  }
  if(request.method==='session.close'){
    const result=await dispatch(request);journalLoaded.delete(id);return result;
  }
  if(readOnlyMethods.has(request.method)||(!id&&request.method!=='session.create'))return dispatch(request);
  let creation,header;
  if(request.method==='session.create'){
    id=randomRunId();creation={id,epoch:Math.floor(Date.now()/1000)};
    request=structuredClone(request);
    request.params.seed??=crypto.getRandomValues(new Uint32Array(1))[0];
    header={format:recordingFormat,version:1,id,buildId:manifest.buildId,count:0,updatedAt:Date.now(),complete:false};
    await journal.create(header);journalHeaders.set(id,header);
  }else header=journalHeaders.get(id);
  if(!header||!journalLoaded.has(id)&&request.method!=='session.create')return dispatch(request);
  const record={index:header.count,request,...(creation?{creation}:{})};
  await journal.reserve(id,record.index,record);
  const result=await dispatch(request,creation);
  header.count++;header.updatedAt=Date.now();header.complete=!!result.ended;
  summarize(header,result);
  const level=result.observation?.location.id,entered=!creation&&level&&level!==header.level;
  if(level)header.level=level;
  await journal.commit(header,record.index,{digest:await digest(JSON.stringify(result)),integrity:globalThis.__nnhHost.witnesses});
  if(result.sessionId){journalPresent.add(id);journalLoaded.add(id);}
  send({type:'recorded',id,count:header.count,complete:header.complete});
  protocolUploader?.queue(id);
  // Repeatedly crossing the same stairs must not store a heap on every turn.
  // Capture first entry, then at most once per 256 inputs for that known level.
  if(entered&&(!header.checkpointed?.[level]||header.count-header.checkpointed[level]>=256)&&!result.ended&&engines.size===1&&!checkpointFlight){
    try{
      const started=performance.now(),value=await captureCheckpoint(header.count);
      value.preview=result;
      send({type:'timing',stage:'checkpoint',duration:performance.now()-started});
      checkpointFlight=new Promise((resolve,reject)=>{
        checkpointWorker=worker(new URL('./checkpoint-worker.mjs',import.meta.url),m=>m.error?reject(Error(m.error)):resolve(m.value),reject);
        checkpointWorker.post({id:1,value},checkpointBuffers(value));
      }).then(async encoded=>{
        if(encoded.bytes.length>4*1024*1024)return;
        const saved={...encoded,index:value.index,level,turn:result.observation.turn};
        await journal.saveCheckpoint(id,saved);
        header.checkpoint={index:saved.index,sha256:saved.sha256};
        (header.checkpointed??={})[level]=saved.index;
        await journal.updateHeader(header);protocolUploader?.queue(id);
      }).catch(error=>diagnostic('Optional checkpoint unavailable: '+String(error)))
        .finally(async()=>{await checkpointWorker?.stop();checkpointWorker=undefined;checkpointFlight=undefined;});
    }catch(error){diagnostic('Optional checkpoint unavailable: '+String(error));}
  }
  return result;
}
async function captureCheckpoint(index) {
  if(requestActive)throw Error('Checkpoint requires a completed protocol boundary');
  const processes=[];
  for(const [handle,entry] of engines){
    if(entry.ended)continue;
    const id=++checkpointSequence;
    const process=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{entry.checkpoints.delete(id);reject(Error('Checkpoint timed out'));},10000);
      entry.checkpoints.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
      entry.worker.post({type:'checkpoint',id});
    });
    processes.push({handle,args:entry.args,queue:entry.queue.slice(),bytes:entry.bytes,process});
  }
  return {version:1,buildId:manifest.buildId,index,nextHandle,processes,core:{state:module.nnhCheckpoint.capture(),files:captureFiles(module)}};
}
async function restoreCheckpoint(value) {
  if(value?.version!==1||value.buildId!==manifest.buildId||!Number.isSafeInteger(value.index)||value.index<0||!Array.isArray(value.processes)||value.processes.length>64)throw Error('Checkpoint package or format differs');
  if(value.processes.reduce((n,p)=>n+p.process.state.memorySize,value.core.state.memorySize)>256*1024*1024)throw Error('Checkpoint exceeds the process memory budget');
  if(engines.size)throw Error('Restore requires a fresh worker');
  globalThis.__nnhHost.protocolJournal=true;
  restoreFiles(module,value.core.files);module.nnhCheckpoint.restore(value.core.state);
  nextHandle=value.nextHandle;
  for(const process of value.processes)startEngine(process.args,process);
  await Promise.all([...engines.values()].map(entry=>entry.ready));
  playbackIndex=value.index;
}
listen(message => {
  // Network dependencies never enter the ordered C/local-durability queue.
  if(message.type==='uploadRegistered'){
    registrations.get(message.id)?.(message.ok===true);return;
  }
  if(message.type==='flushRecording'){
    // Deliberate publication requests must not hold up gameplay dispatch.
    void (async()=>{await protocolUploader?.flush();const cursor=await journal?.upload(message.sessionId);
      send({type:'result',id:message.id,result:cursor?{count:cursor.count,manifest:cursor.manifest}:{count:0}});
    })().catch(()=>send({type:'result',id:message.id,result:{count:0}}));
    return;
  }
  tail = tail.then(async () => {
    let result;
    if (message.type === 'init') result = await initialize(message.options ?? {});
    else if (message.type === 'request') {
      if (!module) throw Error('WASM runtime has not been initialized');
      const json = JSON.stringify(message.request);
      if (encoder.encode(json).byteLength > 4096) throw Error('Request exceeds 4096 UTF-8 bytes');
      result=journal?await journalRequest(message.request):await dispatch(message.request);
      queueReplica();
    } else if(message.type==='playback') {
      if(journal||storage.kind!=='memory')throw Error('Playback requires isolated volatile storage');
      globalThis.__nnhHost.protocolJournal=true;
      validateRecord(message.record,playbackIndex);result=await replayRecord(message.record);playbackIndex++;
      if(result.observation)playbackScene=result;
      if(!replayArchive)playbackRecords.push(message.record);
    } else if(message.type==='playbackBatch'||message.type==='playbackEvidence') {
      if(journal||storage.kind!=='memory'||!Array.isArray(message.records)||message.records.length<1||message.records.length>128)throw Error('Invalid playback batch');
      const evidence=message.type==='playbackEvidence'?{format:'neohack.replay-evidence',version:1,from:playbackIndex,count:message.records.length,entries:[]}:null;
      globalThis.__nnhHost.protocolJournal=true;
      for(const record of message.records){
        validateRecord(record,playbackIndex);
        if(evidence&&!record.digest)throw Error('Replay evidence requires a recorded receipt digest');
        result=await replayRecord(record);
        if(evidence)evidence.entries.push(replayEvidence(result,playbackIndex));
        playbackIndex++;
        if(result.observation)playbackScene=result;
        if(!replayArchive)playbackRecords.push(record);
      }
      // Rejected or stale attempts are part of the log too. They do not erase
      // the last scene; their exact error response was still verified above.
      result=evidence??playbackScene??result;
    } else if(message.type==='checkpoint') {
      result=await captureCheckpoint(message.index??playbackIndex);
    } else if(message.type==='integrity') {
      result=globalThis.__nnhHost.witnesses;
    } else if(message.type==='restoreCheckpoint') {
      await restoreCheckpoint(message.value);result={};
    } else if(message.type==='restoreCheckpointBytes') {
      const value=await decodeCheckpoint(message.value.bytes,message.value.sha256);
      if(value.index!==message.value.index)throw Error('Checkpoint cursor differs');
      await restoreCheckpoint(value);playbackScene=value.preview;result={index:value.index,preview:value.preview};
    } else if(message.type==='journalInfo') {
      result=journalHeaders.get(message.sessionId)??null;
    } else if(message.type==='journalRange') {
      if(!journal)throw Error('No protocol journal');
      result=await journal.range(message.sessionId,message.from,Math.min(message.limit??256,256));
    } else if (message.type === 'close') { await close(); result = {}; }
    else throw Error('Unknown worker message');
    send({ type: 'result', id: message.id, result });
  }).catch(async error => {
    diagnostic(error?.stack ?? error);
    await close().catch(diagnostic);
    send({ type: 'fatal', id: message.id, message: String(error) });
  });
});
