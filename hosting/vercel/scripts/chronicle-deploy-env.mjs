// The chronicle service authenticates to Vercel AI Gateway with the deployment's
// own OIDC token, which Vercel attaches to each function request. No API key is
// stored in the repository or created here. This preflight enables the project's
// OIDC federation when it is off, or accepts an operator-supplied
// AI_GATEWAY_API_KEY in Vercel production as the alternative. It never reads,
// decrypts or prints a credential.
import {pathToFileURL} from 'node:url';
export async function ensureChronicleModelAccess(env, request=fetch){
  const {VERCEL_TOKEN:token,VERCEL_PROJECT_ID:project,VERCEL_ORG_ID:team}=env;
  if(!token||!project||!team)throw Error('Vercel deployment credentials are missing');
  async function api(path, method='GET', body){
    const url=new URL(path,'https://api.vercel.com');url.searchParams.set('teamId',team);
    const response=await request(url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error(`Cannot verify chronicle model access: HTTP ${response.status} at ${url.pathname}`);
    const text=await response.text();return text?JSON.parse(text):{};
  }
  const variables=(await api(`/v10/projects/${encodeURIComponent(project)}/env`)).envs??[];
  const production=e=>Array.isArray(e.target)?e.target.includes('production'):e.target==='production';
  if(variables.some(e=>e.key==='AI_GATEWAY_API_KEY'&&production(e)))return {method:'api-key'};
  const settings=await api(`/v9/projects/${encodeURIComponent(project)}`);
  if(settings.oidcTokenConfig?.enabled===true)return {method:'oidc',issuerMode:settings.oidcTokenConfig.issuerMode};
  // Additive project setting: short-lived tokens replace a stored key entirely.
  const updated=await api(`/v9/projects/${encodeURIComponent(project)}`,'PATCH',{oidcTokenConfig:{enabled:true,issuerMode:'team'}});
  if(updated.oidcTokenConfig?.enabled!==true)throw Error('Vercel did not enable OIDC federation; configure AI_GATEWAY_API_KEY in production or enable Secure Backend Access in project settings');
  return {method:'oidc',issuerMode:'team',enabled:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await ensureChronicleModelAccess(process.env);
  console.log(result.method==='api-key'
    ? 'Chronicle model access: AI_GATEWAY_API_KEY is configured in Vercel production.'
    : `Chronicle model access: Vercel OIDC federation ${result.enabled?'enabled now':'already enabled'} (${result.issuerMode} issuer); functions authenticate to AI Gateway without a stored key.`);
}
