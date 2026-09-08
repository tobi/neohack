import { listen, send } from './worker-port.mjs';
import {captureFiles,restoreFiles} from './checkpoint-files.mjs';
import {checkpointBuffers} from './checkpoint-codec.mjs';
import { checked } from './assets.mjs';
let started = false, engineModule;
const input = [];
let take = null;
let inputBytes = 0;
const encoder = new TextEncoder();
globalThis.__nhTakeLine = () => new Promise(resolve => {
  if (input.length) {
    const line = input.shift(); inputBytes -= encoder.encode(line).byteLength; resolve(line);
  } else take = resolve;
});
globalThis.__nhEmitLine = line => send({ type: 'line', line });
async function start({ base, manifest, args, checkpoint }) {
  if (started) throw Error('Engine worker can only start once');
  started = true;
  const [wasmBinary, data] = await Promise.all([
    checked(base, 'neonethack-engine.wasm', manifest),
    checked(base, 'neonethack-engine.data', manifest),
    checked(base, 'neonethack-engine.mjs', manifest),
  ]);
  const { default: factory } = await import(new URL('neonethack-engine.mjs', base));
  engineModule = await factory({
    wasmBinary,
    arguments: args,
    locateFile: name => new URL(name, base).href,
    getPreloadedPackage: () => data,
    preRun: [module => { module.ENV.NETHACKOPTIONS = '!tutorial,time'; module.ENV.USER = 'Explorer'; module.ENV.LOGNAME = 'Explorer'; }],
    print: text => send({ type: 'diagnostic', text: String(text) }),
    printErr: text => send({ type: 'diagnostic', text: String(text) }),
    onExit: code => send({ type: 'exit', code }),
    onAbort: reason => send({ type: 'fatal', message: String(reason) }),
  });
  if(checkpoint){restoreFiles(engineModule,checkpoint.files);engineModule.nnhCheckpoint.restore(checkpoint.state);}
  send({type:'booted'});
  // A resolved factory can mean Asyncify is parked at input, NOT engine exit.
}
listen(message => {
  if (message?.type === 'start') {
    start(message).catch(error => send({ type: 'fatal', message: String(error) }));
  } else if (message?.type === 'checkpoint') {
    try {if(!engineModule||!take||input.length)throw Error('Engine has no stable input boundary');const value={state:engineModule.nnhCheckpoint.capture(),files:captureFiles(engineModule,{staticData:true})};send({type:'checkpoint',id:message.id,value},checkpointBuffers(value));}catch(error){send({type:'checkpoint',id:message.id,error:String(error)});}
  } else if (message?.type === 'line' && typeof message.line === 'string') {
    if (take) { const resolve = take; take = null; resolve(message.line); }
    else {
      inputBytes += encoder.encode(message.line).byteLength;
      if (inputBytes > 1024 * 1024) { send({ type: 'fatal', message: 'Engine input queue limit exceeded' }); return; }
      input.push(message.line);
    }
  }
});
