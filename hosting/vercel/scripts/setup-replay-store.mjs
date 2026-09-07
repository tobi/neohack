// Additive provisioning only: never modify an existing store or credential.
// API shapes match Vercel's CLI and terraform-provider-vercel/client/blob.go.
export async function setupReplayStore(env, request=fetch) {
  const {VERCEL_TOKEN:token,VERCEL_PROJECT_ID:project,VERCEL_ORG_ID:team}=env;
  if(!token||!project||!team)throw Error('Vercel deployment credentials are missing');
  async function api(path, body) {
    const url=new URL(path,'https://api.vercel.com');url.searchParams.set('teamId',team);
    const response=await request(url,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error(`Replay store setup failed: HTTP ${response.status} at ${url.pathname}`);
    const text=await response.text();return text?JSON.parse(text):{};
  }
  const envPath=`/v10/projects/${encodeURIComponent(project)}/env`;
  const variables=(await api(envPath)).envs??[];
  const production=variables.filter(e=>Array.isArray(e.target)?e.target.includes('production'):e.target==='production');
  const hasOrigin=production.some(e=>e.key==='PUBLIC_REPLAY_ORIGIN');
  const hasToken=production.some(e=>e.key==='PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN');
  if(hasOrigin&&hasToken)return;
  if(hasOrigin)throw Error('Existing replay origin has no credential; refusing to replace its store');
  const name=`neohack-public-replays-${project}`;
  const matches=((await api('/v1/storage/stores')).stores??[]).filter(s=>s.name===name);
  if(matches.length>1)throw Error('Ambiguous public replay store; refusing to choose');
  if(hasToken&&!matches.length)throw Error('Existing replay credential has no managed store; refusing to replace it');
  const store=matches[0]??(await api('/v1/storage/stores/blob',{name,access:'public',region:'iad1'})).store;
  if(store?.access!=='public'||store.type!=='blob'||!/^store_[a-zA-Z0-9]+$/.test(store.id)||store.ownerId!==team)
    throw Error('Replay store must be a separate public Blob store in the deployment team');
  const path=`/v1/storage/stores/${store.id}/connections`;
  const connections=(await api(path)).connections??[];
  const linked=connections.filter(c=>c.projectId===project);
  if(linked.length && !linked.some(c=>c.envVarPrefix==='PUBLIC_REPLAY_BLOB'&&c.envVarEnvironments?.includes('production')))
    throw Error('Existing replay connection has conflicting configuration');
  if(!linked.length){
    if(hasToken)throw Error('Existing replay credential is not bound to the managed store');
    await api(path,{projectId:project,envVarPrefix:'PUBLIC_REPLAY_BLOB',envVarEnvironments:['production']});
  }
  const after=(await api(envPath)).envs??[];
  if(!after.some(e=>e.key==='PUBLIC_REPLAY_BLOB_READ_WRITE_TOKEN'&&(Array.isArray(e.target)?e.target.includes('production'):e.target==='production')))
    throw Error('Vercel did not create the expected public replay credential');
  const origin=`https://${store.id.slice(6).toLowerCase()}.public.blob.vercel-storage.com`;
  if(env.PUBLIC_REPLAY_ORIGIN&&env.PUBLIC_REPLAY_ORIGIN.replace(/\/$/,'')!==origin)
    throw Error('GitHub replay origin disagrees with the managed store');
  await api(envPath,{key:'PUBLIC_REPLAY_ORIGIN',value:origin,type:'plain',target:['production']});
}
