import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {renderMap} from './map.mjs';
import {formatItems} from './presentation.mjs';
import {createRunLifecycle} from './lifecycle.mjs';

/** Read-only CLI for the client envelope or a complete public snapshot. */
export async function inspect(path) {
  const value=JSON.parse(await readFile(path,'utf8'));
  const frame=value.snapshot??value;
  if (!frame?.observation || frame.update?.kind==='delta') throw Error('A reconstructed public snapshot is required.');
  const lifecycle=createRunLifecycle({sessionId:frame.sessionId});
  await lifecycle.acceptSnapshot(frame);
  if (value.snapshot && value.status!=='current') await lifecycle.disconnect();
  return {text:[JSON.stringify({status:value.status??'publicSnapshot',lifecycle:lifecycle.status()}),
    formatItems(frame),renderMap(frame.observation)].join('\n\n'),exitCode:lifecycle.status().exitCode};
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length!==3) throw Error('Usage: node examples/agent-harness/inspect.mjs PUBLIC_STATE.json');
    const result=await inspect(process.argv[2]);console.log(result.text);process.exitCode=result.exitCode;
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
