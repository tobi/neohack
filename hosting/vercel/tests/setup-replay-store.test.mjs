import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setupReplayStore} from '../scripts/setup-replay-store.mjs';
const env={VERCEL_TOKEN:'test-only',VERCEL_PROJECT_ID:'project',VERCEL_ORG_ID:'team'};
function fixture({access='public',failOrigin=false}={}) {
 const vars=[{key:'BLOB_READ_WRITE_TOKEN',target:['production'],id:'private-never-read'}],stores=[],connections=[],writes=[];
 const request=async(url,options)=>{
  assert.equal(url.searchParams.get('teamId'),'team');
  const path=url.pathname,body=options.body&&JSON.parse(options.body);
  assert.ok(!path.includes('/secrets')&&!path.includes('/env/private'));
  if(body)writes.push({path,body});
  if(path.endsWith('/env')){
   if(body){assert.equal(body.key,'PUBLIC_REPLAY_ORIGIN');if(failOrigin){failOrigin=false;return new Response('',{status:503});}vars.push(body);}
   return Response.json({envs:vars});
  }
  if(path==='/v1/storage/stores')return Response.json({stores});
  if(path==='/v1/storage/stores/blob'){
   assert.equal(body.access,'public');stores.push({...body,id:'store_Abc123',type:'blob',ownerId:'team',access});return Response.json({store:stores[0]});
  }
  if(path.endsWith('/connections')){
   if(body){assert.equal(body.envVarPrefix,'PUBLIC_REPLAY_BLOB');assert.deepEqual(body.envVarEnvironments,['production']);connections.push(body);vars.push({key:'PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN',target:['production']});}
   return Response.json({connections});
  }
  throw Error('Unexpected endpoint');
 };
 return {request,vars,stores,connections,writes};
}
test('provisions a separate public store once without reading or modifying private credentials',async()=>{
 const f=fixture();await setupReplayStore(env,f.request);await setupReplayStore(env,f.request);
 assert.equal(f.stores.length,1);assert.equal(f.connections.length,1);assert.equal(f.writes.length,3);
 assert.deepEqual(f.vars[0],{key:'BLOB_READ_WRITE_TOKEN',target:['production'],id:'private-never-read'});
 assert.equal(f.vars.at(-1).value,'https://abc123.public.blob.vercel-storage.com');
});
test('a failed origin write resumes the same store and connection',async()=>{
 const f=fixture({failOrigin:true});await assert.rejects(setupReplayStore(env,f.request),/HTTP 503/);
 await setupReplayStore(env,f.request);assert.equal(f.stores.length,1);assert.equal(f.connections.length,1);
});
test('refuses a private store or unrelated existing replay credential',async()=>{
 const f=fixture({access:'private'});await assert.rejects(setupReplayStore(env,f.request),/separate public/);assert.equal(f.connections.length,0);
 const g=fixture();g.vars.push({key:'PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN',target:['production']});
 await assert.rejects(setupReplayStore(env,g.request),/refusing to replace/);assert.equal(g.writes.length,0);
});
