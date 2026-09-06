// Raw bundled code is data here. It never executes in the account document.
// @ts-ignore Bun's text import is resolved during the ordered build.
import workerSource from '../public/build/bot-worker.js' with {type:'text'};
let started=false;
window.addEventListener('message',event=>{
  if(started || event.source !== parent || event.data?.type !== 'neohack-test' || !event.ports[0]) return;
  started=true;
  const url=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));
  const worker=new Worker(url);
  worker.postMessage(event.data.payload,[event.ports[0]]);
  URL.revokeObjectURL(url);
});
