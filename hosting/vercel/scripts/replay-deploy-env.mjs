// Read only the public origin value; never decrypt or export Blob credentials.
import {appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {setupReplayStore} from './setup-replay-store.mjs';
export async function replayDeployOrigin(env, request=fetch){
  const {VERCEL_TOKEN:token,VERCEL_PROJECT_ID:project,VERCEL_ORG_ID:team}=env;
  if(!token||!project||!team)throw Error('Vercel deployment credentials are missing');
  async function get(path){
    const url=new URL(path,'https://api.vercel.com');url.searchParams.set('teamId',team);
    const response=await request(url,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error(`Cannot check replay deployment configuration: HTTP ${response.status}`);
    return response.json();
  }
  const list=await get(`/v10/projects/${encodeURIComponent(project)}/env`);
  const production=(Array.isArray(list)?list:list.envs??[]).filter(e=>Array.isArray(e.target)?e.target.includes('production'):e.target==='production');
  const origins=production.filter(e=>e.key==='PUBLIC_REPLAY_ORIGIN');
  if(origins.length!==1||!production.some(e=>e.key==='PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN'))
    throw Error('Configure PUBLIC_REPLAY_ORIGIN and PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN for the dedicated public Blob store in Vercel production');
  const value=await get(`/v1/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(origins[0].id)}`);
  if(value.key!=='PUBLIC_REPLAY_ORIGIN'||typeof value.value!=='string'||!/^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/?$/.test(value.value))throw Error('Vercel PUBLIC_REPLAY_ORIGIN must be the public Blob store origin');
  const origin=value.value.replace(/\/$/,'');
  if(env.PUBLIC_REPLAY_ORIGIN&&env.PUBLIC_REPLAY_ORIGIN.replace(/\/$/,'')!==origin)throw Error('GitHub and Vercel replay origins disagree');
  return origin;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  await setupReplayStore(process.env);
  const origin=await replayDeployOrigin(process.env);
  if(!process.env.GITHUB_ENV)throw Error('Run this deployment preflight in GitHub Actions');
  await appendFile(process.env.GITHUB_ENV,`PUBLIC_REPLAY_ORIGIN=${origin}\n`);
  console.log('Verified Vercel production replay configuration; staging uses its public origin.');
}
