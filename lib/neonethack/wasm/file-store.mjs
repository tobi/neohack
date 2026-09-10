// Bun-only durable implementation of the same append-only journal used in browsers.
// No game rules, replay codec or receipts live here. A failed completion remains
// a reserved input; core-worker reconstructs it with the original request ID.
export async function openFileStore(path) {
  if (!globalThis.process?.versions?.bun) throw Error('Filesystem WASM journals require Bun');
  const {Database} = await import('bun:sqlite');
  const {mkdir,chmod} = await import('node:fs/promises');
  const {dirname} = await import('node:path');
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  // A separate SQLite connection holds an OS file lock for the worker lifetime.
  // Unlike a persisted PID, this cannot confuse a reused PID after reboot/crash.
  const lease=new Database(path+'.lease',{create:true,strict:true});
  let db;
  try {
    await chmod(path+'.lease',0o600);
    try{lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');}
    catch(e){if(['SQLITE_BUSY','SQLITE_LOCKED'].includes(e.code))throw Error('Another process owns this WASM journal');throw e;}
    db=new Database(path,{create:true,strict:true});
    await chmod(path,0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    db.exec('CREATE TABLE IF NOT EXISTS kv (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS inputs (id TEXT NOT NULL, idx INTEGER NOT NULL, value TEXT NOT NULL, completion TEXT, PRIMARY KEY(id,idx)); CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, value TEXT NOT NULL, bytes BLOB NOT NULL);');
    if(Object.values(db.query('PRAGMA quick_check').get())[0]!=='ok')throw Error('Corrupt WASM journal');
  }catch(e){db?.close();lease.close();throw e;}
  const get=(kind,id)=>{const r=db.query('SELECT value FROM kv WHERE kind=? AND id=?').get(kind,id);return r?JSON.parse(r.value):undefined;};
  const put=(kind,id,value)=>db.query('INSERT INTO kv VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind,id,JSON.stringify(value));
  return {
    header:id=>get('run',id),
    headers:()=>db.query("SELECT value FROM kv WHERE kind='run'").all().map(r=>JSON.parse(r.value)),
    create:header=>db.query('INSERT INTO kv VALUES(?,?,?)').run('run',header.id,JSON.stringify(header)),
    updateHeader:header=>put('run',header.id,header),
    reserve:(id,index,record)=>db.query('INSERT INTO inputs VALUES(?,?,?,NULL)').run(id,index,JSON.stringify(record)),
    commit:(header,index,completion)=>db.transaction(()=>{
      const result=db.query('UPDATE inputs SET completion=? WHERE id=? AND idx=? AND completion IS NULL').run(JSON.stringify(completion),header.id,index);
      if(result.changes!==1)throw Error('Missing or already committed input reservation');
      put('run',header.id,header);
    }).immediate(),
    range:(id,from,limit=256)=>db.query('SELECT idx,value,completion FROM inputs WHERE id=? AND idx>=? ORDER BY idx LIMIT ?').all(id,from,limit).map((row,i)=>{
      if(row.idx!==from+i)throw Error('Local input journal has a missing input');
      return {...JSON.parse(row.value),...(row.completion?JSON.parse(row.completion):{})};
    }),
    upload:id=>get('upload',id),acknowledge:(id,value)=>put('upload',id,value),
    checkpoint:id=>{const row=db.query('SELECT * FROM checkpoints WHERE id=?').get(id);return row?{...JSON.parse(row.value),bytes:new Uint8Array(row.bytes)}:undefined;},
    saveCheckpoint:(id,{bytes,...value})=>db.query('INSERT INTO checkpoints VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,bytes=excluded.bytes').run(id,JSON.stringify(value),bytes),
    close:()=>{try{db.close();}finally{lease.close();}},
  };
}
