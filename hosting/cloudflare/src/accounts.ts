import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';

const json = (body: unknown, status = 200, headers = {}) => Response.json(body,{status,headers:{'cache-control':'no-store',...headers}});
const cookie = (request: Request, key: string) => request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(key+'='))?.slice(key.length+1);
const token = () => crypto.randomUUID() + crypto.randomUUID();
const validName = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_-]{2,23}$/.test(name);
const setCookie = (name: string, value: string, age: number, secure: boolean) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure?'; Secure':''}`;
// One authority serializes unique handles, credential counters and replay appends.
export class Accounts {
  constructor(private ctx: DurableObjectState) {
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS account_runs (key TEXT PRIMARY KEY, owner TEXT NOT NULL, updated INTEGER NOT NULL, json TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS account_runs_owner ON account_runs(owner, updated DESC)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS account_frames (run TEXT NOT NULL, idx INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(run, idx))');
  }
  async fetch(request: Request) {
    const url = new URL(request.url), path = url.pathname.slice('/api/account'.length);
    const store = this.ctx.storage;
    const secure = url.protocol === 'https:';
    if(request.method !== 'GET' && request.headers.get('origin') !== url.origin) return json({error:'Origin rejected'},403);
    if(!['GET','POST','PUT'].includes(request.method)) return json({error:'Method not allowed'},405);
    if(Number(request.headers.get('content-length') ?? 0) > 2_000_000) return json({error:'Payload too large'},413);
    let body: any = {};
    if(request.method !== 'GET') {
      const text = await request.text();
      if(text.length > 2_000_000) return json({error:'Payload too large'},413);
      try { body = text ? JSON.parse(text) : {}; if(!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Invalid object'); } catch { return json({error:'Invalid JSON'},400); }
    }
    const now = Date.now();
    // Expired ceremonies and sessions never grant access, even before cleanup.
    if(path === '/options' && request.method === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') ?? 'local';
      const rateKey = `rate:${ip}:${Math.floor(now/60000)}`;
      const count = await store.get<number>(rateKey) ?? 0;
      if(count >= 30) return json({error:'Try again in a minute'},429);
      await store.put(rateKey,count+1);
      const register = body.register === true;
      if(register && !validName(body.name)) return json({error:'Use 3–24 letters, numbers, _ or -, starting with a letter'},400);
      if(register && await store.get('name:'+body.name.toLowerCase())) return json({error:'That name is already taken'},409);
      const userId = crypto.randomUUID();
      const options = register ? await generateRegistrationOptions({rpName:'NeoHack',rpID:url.hostname,userName:body.name,userID:new TextEncoder().encode(userId),attestationType:'none',authenticatorSelection:{residentKey:'required',userVerification:'required'}}) : await generateAuthenticationOptions({rpID:url.hostname,userVerification:'required'});
      const id = token();
      await store.put('challenge:'+id,{challenge:options.challenge,register,name:body.name,userId,expires:now+300000});
      await store.setAlarm(now+3600000);
      return json(options,200,{'set-cookie':setCookie('nh_ceremony',id,300,secure)});
    }
    if(path === '/verify' && request.method === 'POST') {
      const challengeKey = 'challenge:'+cookie(request,'nh_ceremony');
      const ceremony: any = await store.transaction(async txn => {const value = await txn.get(challengeKey); await txn.delete(challengeKey); return value;});
      if(!ceremony || ceremony.expires < now) return json({error:'Passkey request expired. Try again.'},400);
      try {
        let userId: string;
        if(ceremony.register) {
          const verified = await verifyRegistrationResponse({response:body,expectedChallenge:ceremony.challenge,expectedOrigin:url.origin,expectedRPID:url.hostname,requireUserVerification:true});
          if(!verified.verified || !verified.registrationInfo) throw Error('Unverified');
          const credential = verified.registrationInfo.credential;
          userId = ceremony.userId;
          const created = await store.transaction(async txn => {
            if(await txn.get('name:'+ceremony.name.toLowerCase()) || await txn.get('credential:'+credential.id)) return false;
            await txn.put('name:'+ceremony.name.toLowerCase(),userId);
            await txn.put('user:'+userId,{id:userId,name:ceremony.name});
            await txn.put('credential:'+credential.id,{...credential,userId});
            return true;
          });
          if(!created) return json({error:'Name or passkey already registered'},409);
        } else {
          const key = 'credential:'+body.id;
          const credential: any = await store.get(key);
          if(!credential) throw Error('Unknown passkey');
          const verified = await verifyAuthenticationResponse({response:body,credential,expectedChallenge:ceremony.challenge,expectedOrigin:url.origin,expectedRPID:url.hostname,requireUserVerification:true});
          if(!verified.verified) throw Error('Unverified');
          userId = credential.userId;
          await store.transaction(async txn => {
            const current: any = await txn.get(key);
            if(current.counter !== credential.counter) throw Error('Concurrent authentication');
            await txn.put(key,{...credential,counter:verified.authenticationInfo.newCounter});
          });
        }
        const session = token();
        await store.put('session:'+session,{userId,expires:now+30*86400000});
        return json(await store.get('user:'+userId),200,{'set-cookie':setCookie('nh_session',session,30*86400,secure)});
      } catch { return json({error:'Passkey verification failed. Start again.'},400); }
    }
    const sessionKey = 'session:'+cookie(request,'nh_session');
    const session: any = await store.get(sessionKey);
    if(!session || session.expires < now) return json({error:'Sign in with a passkey'},401);
    const uid = session.userId;
    if(path === '' && request.method === 'GET') return json(await store.get('user:'+uid));
    if(path === '/logout' && request.method === 'POST') { await store.delete(sessionKey); return json({ok:true},200,{'set-cookie':setCookie('nh_session','',0,secure)}); }
    if(path === '/bots' && request.method === 'GET') return json([... (await store.list({prefix:`bot:${uid}:`,limit:100})).values()]);
    if(path === '/bots' && request.method === 'PUT') {
      if(JSON.stringify(body).length > 100000 || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60 || !body.files || Object.keys(body.files).length > 20 || !Object.keys(body.files).length || !Object.entries(body.files).every(([name,code])=>/^[\w-]+\.(js|ts)$/.test(name) && typeof code === 'string' && code.length < 100000) || !Object.hasOwn(body.files,'main.ts') || !/^[a-z]+$/.test(body.role) || !(body.seed === 'random' || /^\d{1,10}$/.test(String(body.seed)))) return json({error:'Invalid bot project'},400);
      const id = body.id ?? crypto.randomUUID();
      if(!/^[a-f0-9-]{36}$/.test(id)) return json({error:'Invalid bot id'},400);
      const bot = {id,name:body.name.trim(),files:body.files,role:body.role,seed:body.seed,updated:now};
      await store.put(`bot:${uid}:${id}`,bot); return json(bot);
    }
    if(path === '/runs' && request.method === 'GET') return json(store.sql.exec('SELECT json FROM account_runs WHERE owner = ? ORDER BY updated DESC',uid).toArray().map(row=>JSON.parse(String(row.json))));
    const match = path.match(/^\/runs\/([\w-]{1,100})(?:\/frames)?$/);
    if(match) {
      const key = `run:${uid}:${match[1]}`;
      const frames = path.endsWith('/frames');
      if(request.method === 'GET') {
        const stored = store.sql.exec('SELECT json FROM account_runs WHERE key = ?', key).toArray()[0];
        const run = stored ? JSON.parse(String(stored.json)) : null;
        if(!run) return json({error:'Run not found'},404);
        if(!frames) return json(run);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if(!Number.isInteger(offset) || offset < 0) return json({error:'Invalid offset'},400);
        const values = [];
        for(let i=offset;i<Math.min(run.count,offset+25);i++) {
          const row = store.sql.exec('SELECT json FROM account_frames WHERE run = ? AND idx = ?',key,i).toArray()[0];
          const frame = row ? JSON.parse(String(row.json)) : null;
          if(!frame) return json({error:'Recording incomplete'},409);
          values.push(frame);
        }
        return json({frames:values,next:offset+values.length < run.count ? offset+values.length : null});
      }
      if(request.method === 'PUT' && frames) {
        const f = body.frame;
        if(!Number.isInteger(body.index) || body.index < 0 || body.index >= 100000 || !f || f.version !== 1 || typeof f.sessionId !== 'string' || !Number.isInteger(f.revision) || !f.observation || !Array.isArray(f.observation.world) || f.observation.world.length > 10000 || !Number.isFinite(f.observation.turn) || !f.observation.vitals || typeof f.observation.location?.depthLabel !== 'string' || JSON.stringify(f).length > 1000000 || typeof body.name !== 'string' || body.name.length > 60 || typeof body.role !== 'string' || body.role.length > 30 || !/^[a-f0-9]{64}$/.test(body.buildId)) return json({error:'Invalid public frame'},400);
        return store.transactionSync(() => {
          const stored = store.sql.exec('SELECT json FROM account_runs WHERE key = ?',key).toArray()[0];
          const run = stored ? JSON.parse(String(stored.json)) : null;
          if(body.index !== (run?.count ?? 0)) return json({error:'Recording sequence differs'},409);
          if(run && (run.sessionId !== f.sessionId || run.buildId !== body.buildId || f.revision <= run.revision)) return json({error:'Recording identity or revision differs'},409);
          const depth = f.observation.location.depthLabel;
          const reached = [...new Set([...(run?.locations ?? []),depth])].slice(0,500);
          store.sql.exec('INSERT INTO account_frames VALUES (?, ?, ?)',key,body.index,JSON.stringify(f));
          store.sql.exec('INSERT INTO account_runs VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET updated = excluded.updated, json = excluded.json',key,uid,now,JSON.stringify({id:match[1],sessionId:f.sessionId,name:body.name,role:body.role,seed:body.seed,buildId:body.buildId,count:body.index+1,revision:f.revision,turn:f.observation.turn,level:f.observation.vitals.level,maxLevel:Math.max(run?.maxLevel ?? 0,Number(f.observation.vitals.level)||0),depth,locations:reached,ended:!!f.ended,outcome:f.end?.kind ?? 'in progress',updated:now,partial:run?.partial ?? f.revision > 0}));
          return json({count:body.index+1});
        });
      }
    }
    return json({error:'Not found'},404);
  }
  async alarm() {
    const now = Date.now();
    for(const prefix of ['session:','challenge:','rate:']) {
      const entries = await this.ctx.storage.list({prefix});
      for(const [key,value] of entries) if(prefix === 'rate:' || (value as any).expires < now) await this.ctx.storage.delete(key);
    }
    await this.ctx.storage.setAlarm(now+3600000);
  }
}
