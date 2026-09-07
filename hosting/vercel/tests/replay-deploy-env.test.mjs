import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replayDeployOrigin} from '../scripts/replay-deploy-env.mjs';
const env={VERCEL_TOKEN:'test-only',VERCEL_PROJECT_ID:'project',VERCEL_ORG_ID:'team'};
const origin='https://example.public.blob.vercel-storage.com';
test('deployment reads only the public origin and refuses missing or conflicting configuration',async()=>{
 const calls=[];
 const vars=[{key:'PUBLIC_REPLAY_ORIGIN',id:'origin',target:['production']},{key:'PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN',id:'never-decrypt-this',target:['production']}];
 const request=async url=>{calls.push(url.pathname);return Response.json(url.pathname.includes('/v10/')?{envs:vars}:{key:'PUBLIC_REPLAY_ORIGIN',value:origin});};
 assert.equal(await replayDeployOrigin(env,request),origin);
 assert.deepEqual(calls,['/v10/projects/project/env','/v1/projects/project/env/origin']);
 await assert.rejects(replayDeployOrigin({...env,PUBLIC_REPLAY_ORIGIN:'https://different.public.blob.vercel-storage.com'},request),/disagree/);
 await assert.rejects(replayDeployOrigin(env,async()=>Response.json({envs:vars.slice(0,1)})),/Configure/);
 await assert.rejects(replayDeployOrigin(env,async()=>Response.json({envs:vars.map(v=>({...v,target:['preview']}))})),/Configure/);
 await assert.rejects(replayDeployOrigin(env,async()=>new Response('private error',{status:403})),/HTTP 403/);
});
