// Manual maintenance runner. Credentials stay in this process, never artifacts.
import {replayDeployOrigin} from './replay-deploy-env.mjs';
const env=process.env;
env.PUBLIC_REPLAY_ORIGIN=await replayDeployOrigin(env);
async function api(path){
 const url=new URL(path,'https://api.vercel.com');url.searchParams.set('teamId',env.VERCEL_ORG_ID);
 const response=await fetch(url,{headers:{authorization:`Bearer ${env.VERCEL_TOKEN}`},signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error(`Cannot load publication configuration: HTTP ${response.status}`);
 return response.json();
}
const project=encodeURIComponent(env.VERCEL_PROJECT_ID);
const vars=(await api(`/v10/projects/${project}/env`)).envs??[];
for(const key of ['BLOB_READ_WRITE_TOKEN','PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN']){
 const matches=vars.filter(v=>v.key===key&&(Array.isArray(v.target)?v.target.includes('production'):v.target==='production'));
 if(matches.length!==1)throw Error(`Expected exactly one production ${key}`);
 const result=await api(`/v1/projects/${project}/env/${encodeURIComponent(matches[0].id)}`);
 if(result.key!==key||typeof result.value!=='string'||!/^vercel_blob_rw_[A-Za-z0-9_]+$/.test(result.value))throw Error('Invalid publication credential');
 if(env.GITHUB_ACTIONS==='true')console.log(`::add-mask::${result.value}`);
 env[key]=result.value;
}
await import('./publish-replays.mjs');
