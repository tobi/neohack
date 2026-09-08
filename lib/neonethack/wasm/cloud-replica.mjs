/** Fetch one pinned cloud head in bounded responses; never mix revisions. */
export async function fetchCloudReplica(url) {
  const deadline=Date.now()+30000;
  const timeout=limit=>{const remaining=deadline-Date.now();if(remaining<=0)throw Error('Cloud download deadline exceeded');return AbortSignal.timeout(Math.min(limit,remaining));};
  const manifestUrl=new URL(url);manifestUrl.searchParams.set('manifest','1');
  const response=await fetch(manifestUrl,{signal:timeout(3000)});
  if(response.status===404)return null;
  if(!response.ok)throw Error(`Cloud manifest HTTP ${response.status}`);
  const seed=await response.json();
  if(seed.version!==1||typeof seed.revision!=='string'||!Array.isArray(seed.files)||!Array.isArray(seed.blockIds)||seed.blockIds.length>10000||seed.blockIds.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw Error('Invalid cloud manifest');
  const blocks=new Array(seed.blockIds.length);let next=0;
  await Promise.all(Array.from({length:Math.min(4,blocks.length)},async()=>{
    for(;;){const i=next++;if(i>=blocks.length)return;
      const part=new URL(url);part.searchParams.set('block',seed.blockIds[i]);part.searchParams.set('revision',seed.revision);
      const result=await fetch(part,{signal:timeout(10000)});
      if(!result.ok)throw Error(`Cloud block HTTP ${result.status}`);
      blocks[i]=[seed.blockIds[i],await result.json()];
    }
  }));
  return {version:1,revision:seed.revision,files:seed.files,blocks};
}
