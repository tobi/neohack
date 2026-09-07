import {storage} from '../src/storage.ts';
import {publishReplay} from '../src/publish-replay.ts';
const args=process.argv.slice(2);if(args.some(a=>a!=='--apply'))throw Error('Usage: node scripts/publish-replays.mjs [--apply]');
const ids=(await storage().list('replays/')).flatMap(p=>{const m=p.match(/^replays\/([\w-]{1,64})\.json$/);return m?[m[1]]:[];});
if(!args.includes('--apply'))console.log(JSON.stringify({publicRecordings:ids.length,action:'Pass --apply to publish existing PUBLIC recordings to the public Blob store; no records are deleted.'}));
else {let published=0;for(const id of ids){await publishReplay(id);published++;}console.log(JSON.stringify({published}));}
