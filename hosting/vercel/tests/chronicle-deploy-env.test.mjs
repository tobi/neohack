import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureChronicleModelAccess} from '../scripts/chronicle-deploy-env.mjs';
const env={VERCEL_TOKEN:'test-only',VERCEL_PROJECT_ID:'project',VERCEL_ORG_ID:'team'};
test('deployment prefers the project OIDC token and enables it additively; a configured key is accepted without being read',async()=>{
 const calls=[];
 const server=(state)=>async(url,init={})=>{
  calls.push((init.method??'GET')+' '+url.pathname);
  if(url.pathname.endsWith('/env'))return Response.json({envs:state.envs});
  if((init.method??'GET')==='PATCH'){state.oidc=JSON.parse(init.body).oidcTokenConfig;return Response.json({oidcTokenConfig:state.oidc});}
  return Response.json({oidcTokenConfig:state.oidc});
 };
 let state={envs:[],oidc:{enabled:false}};
 assert.deepEqual(await ensureChronicleModelAccess(env,server(state)),{method:'oidc',issuerMode:'team',enabled:true});
 assert.deepEqual(calls,['GET /v10/projects/project/env','GET /v9/projects/project','PATCH /v9/projects/project']);
 calls.length=0;state={envs:[],oidc:{enabled:true,issuerMode:'global'}};
 assert.deepEqual(await ensureChronicleModelAccess(env,server(state)),{method:'oidc',issuerMode:'global'});
 assert.ok(!calls.some(c=>c.startsWith('PATCH')),'an enabled project is left alone');
 calls.length=0;state={envs:[{key:'AI_GATEWAY_API_KEY',id:'never-read',target:['production']}],oidc:{enabled:false}};
 assert.deepEqual(await ensureChronicleModelAccess(env,server(state)),{method:'api-key'});
 assert.deepEqual(calls,['GET /v10/projects/project/env'],'the key value endpoint is never requested');
 await assert.rejects(ensureChronicleModelAccess(env,async()=>new Response('x',{status:403})),/HTTP 403/);
 await assert.rejects(ensureChronicleModelAccess({VERCEL_TOKEN:'t'},server(state)),/credentials/);
});
