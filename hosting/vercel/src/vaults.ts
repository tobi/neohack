import { read, update, immutable } from "./storage.ts";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });
export async function vaults(
  request: Request,
  id: string,
  adventures: boolean,
) {
  if (!UUID.test(id)) return json({ error: "invalid vault" }, 400);
  const branch=new URL(request.url).searchParams.get("branch");
  if(branch && !UUID.test(branch))return json({error:"invalid backup stream"},400);
  const path = `vaults/${id}/${adventures ? "adventures" : branch ? "copies/"+branch : "journal"}.json`;
  if (request.method === "GET") {
    const doc = await read(path);
    if (!doc) return json(adventures ? [] : { error: "not found" }, 404);
    if (adventures) return json(doc.values);
const query=new URL(request.url).searchParams;
if(query.has('block')){
  if(query.get('revision')!==doc.revision)return json({error:'cloud head changed'},409);
  const id=query.get('block')!;
  if(!HASH.test(id)||!doc.blocks[id])return json({error:'block not found'},404);
  const block=await read(String(doc.blocks[id]));
  return block?json(block):json({error:'incomplete journal'},409);
}
if(query.get('manifest')==='1')return json({version:1,revision:doc.revision,files:doc.files,blockIds:Object.keys(doc.blocks)});
    const blocks = await Promise.all(
      Object.entries(doc.blocks).map(async ([id, ref]) => [
        id,
        await read(String(ref)),
      ]),
    );
    if (blocks.some(([, block]) => !block))
      return json({ error: "incomplete journal" }, 409);
    return json({
      version: 1,
      revision: doc.revision,
      files: doc.files,
      blocks,
    });
  }
  if (request.method === "POST" && !adventures) {
    const raw=await request.text();
    if(Buffer.byteLength(raw)>1024*1024)return json({error:"part too large"},413);
    let part;try{part=JSON.parse(raw)}catch{return json({error:"invalid part"},400)}
    if(!part || !UUID.test(part.commit) || typeof part.data!=="string" || Buffer.byteLength(part.data)>256*1024)return json({error:"invalid part"},400);
    const ref=await immutable({vault:id,commit:part.commit,data:part.data});
    return json({ref});
  }
  if (request.method !== "PUT")
    return json({ error: "method not allowed" }, 405);
  let body = await request.text();
  if (body.length > (adventures ? 256 * 1024 : 4 * 1024 * 1024))
    return json({ error: "commit too large" }, 413);
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  if (!adventures && Array.isArray(data?.parts)) {
    const commit=data.commit;
    if(!UUID.test(commit)||!data.parts.length||data.parts.length>512||data.parts.some((ref:any)=>typeof ref!=="string"||!/^objects\/[a-f0-9]{64}\.json$/.test(ref)))return json({error:"invalid upload manifest"},400);
    const pieces:string[]=[];let bytes=0;
    for(const ref of data.parts){
      const part=await read(ref);
      if(!part||part.vault!==id||part.commit!==commit||typeof part.data!=="string")return json({error:"upload part unavailable"},400);
      bytes+=Buffer.byteLength(part.data);if(bytes>64*1024*1024)return json({error:"commit too large"},413);
      pieces.push(part.data);
    }
    body=pieces.join("");
    try{data=JSON.parse(body)}catch{return json({error:"invalid assembled commit"},400)}
    if(data.commit!==commit)return json({error:"upload commit differs"},409);
  }
  if (adventures) {
    if (!Array.isArray(data)) return json({ error: "invalid adventures" }, 400);
    await update<any, void>(
      path,
      () => ({}),
      (doc) => {
        const values=new Map((doc.values??[]).map((v:any)=>[v.id,v]));
        for(const value of data) {
          if(!value || typeof value.id!=="string")continue;
          const old:any=values.get(value.id);
          if(!old || ((!old.ended || value.ended) && (value.turn??0)>=(old.turn??0)))values.set(value.id,value);
        }
        doc.values=[...values.values()];
      },
    );
    return new Response(null, { status: 204 });
  }
  if (
    !data ||
    data.version !== 1 ||
    typeof data.commit !== "string" ||
    !UUID.test(data.commit) ||
    (data.base !== null && !UUID.test(data.base)) ||
    !Array.isArray(data.files) ||
    !Array.isArray(data.blocks) ||
    data.files.length > 10000 ||
    data.blocks.length > 10000 ||
    data.files.some(
      (entry: any) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !entry[0].startsWith("/neonethack/") ||
        !Array.isArray(entry[1]?.blocks) ||
        !entry[1].blocks.every(
          (id: any) => typeof id === "string" && HASH.test(id),
        ),
    ) ||
    data.blocks.some(
      (entry: any) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !HASH.test(entry[0]) ||
        !entry[1] ||
        JSON.stringify(entry[1]).length > 100000,
    )
  )
    return json({ error: "invalid journal data" }, 400);
  if (
    new Set(data.files.map(([path]: any) => path)).size !== data.files.length ||
    new Set(data.blocks.map(([id]: any) => id)).size !== data.blocks.length
  )
    return json({ error: "duplicate journal entry" }, 400);
  const digest = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
  ).toString("hex");
  return update<any, Response>(
    path,
    () => ({ revision: null, files: [], blocks: {} }),
    async (doc) => {
      if (doc.revision === data.commit)
        return doc.digest === digest
          ? json({ revision: doc.revision })
          : json({ error: "commit differs" }, 409);
      if(doc.revision!==data.base)return json({error:"cloud progress changed"},409);
      const files=data.files;
      const supplied = new Map<string, any>(data.blocks),
        live = new Set<string>(files.flatMap(([, f]: any) => f.blocks));
      for (const id of live)
        if (!supplied.has(id) && !doc.blocks[id])
          return json({ error: "missing block" }, 400);
      const blocks: Record<string, string> = {};
      for (const id of live) {
        if (supplied.has(id)) {
          const ref = await immutable(supplied.get(id));
          if (doc.blocks[id] && doc.blocks[id] !== ref)
            return json({ error: "block differs" }, 409);
          blocks[id] = ref;
        } else blocks[id] = doc.blocks[id];
      }
      Object.assign(doc, {
        revision: data.commit,
        digest,
        files,
        blocks,
      });
      return json({ revision: data.commit });
    },
  );
}
