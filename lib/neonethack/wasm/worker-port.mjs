// Runtime plumbing only. Node imports are never evaluated in a browser.
const node = typeof process !== 'undefined' && !!process.versions?.node;
const threads = node ? await import('node:worker_threads') : null;
export const inNode = node;
export function send(message) {
  if (node) threads.parentPort.postMessage(message);
  else globalThis.postMessage(message);
}
export function listen(callback) {
  if (node) threads.parentPort.on('message', callback);
  else globalThis.addEventListener('message', event => callback(event.data));
}
export function worker(url, onMessage, onError) {
  // Let Node inherit its own supported runtime flags by default. Explicitly
  // copying execArgv re-validates internal test-runner flags and can fail.
  const nodeOptions = node && process.execArgv.some(arg => arg.startsWith('--input-type'))
    ? { execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) } : {};
  const instance = node ? new threads.Worker(url, nodeOptions) : new Worker(url, { type: 'module' });
  let stopped = false;
  if (node) {
    instance.on('message', onMessage);
    instance.on('error', onError);
    instance.on('exit', code => { if (!stopped && code !== 0) onError(Error(`Worker exited (${code})`)); });
  } else {
    instance.addEventListener('message', event => onMessage(event.data));
    instance.addEventListener('error', event => onError(Error(event.message || 'Worker failed')));
    instance.addEventListener('messageerror', () => onError(Error('Worker message decoding failed')));
  }
  return {
    post: message => instance.postMessage(message),
    stop: () => { stopped = true; return instance.terminate(); },
  };
}
