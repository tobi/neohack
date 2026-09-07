import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness, MemoryStorage } from "./server.mjs";
import {
  storageContext,
  update,
  read,
  AuthStore,
  immutable,
} from "../src/storage.ts";
import { handler } from "../api/index.ts";

test("two independent servers cannot both commit the same journal base", async (t) => {
  const store = new MemoryStorage(),
    a = createTestHarness({ store }),
    b = createTestHarness({ store });
  t.after(async () => {
    await a.close();
    await b.close();
  });
  const one = (await a.listen()).url,
    two = (await b.listen()).url,
    id = crypto.randomUUID();
  const commit = {
    version: 1,
    base: null,
    commit: crypto.randomUUID(),
    files: [],
    blocks: [],
  };
  const put = (url, body) =>
    fetch(new URL(`/api/vaults/${id}`, url), {
      method: "PUT",
      body: JSON.stringify(body),
    });
  const other = { ...commit, commit: crypto.randomUUID() };
  const results = await Promise.all([put(one, commit), put(two, other)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const winner = results[0].ok ? commit : other;
  assert.equal((await put(two, winner)).status, 200);
  assert.equal(
    (
      await put(one, {
        ...winner,
        files: [["/neonethack/changed", { blocks: [] }]],
      })
    ).status,
    409,
  );
  assert.equal(
    (await (await fetch(new URL(`/api/vaults/${id}`, two))).json()).revision,
    winner.commit,
  );
});

test("CAS retries preserve independent updates and consume a challenge once", async () => {
  const store = new MemoryStorage();
  await storageContext.run(store, async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        update(
          "counter",
          () => ({ values: [] }),
          async (doc) => {
            await Promise.resolve();
            doc.values.push(i);
          },
        ),
      ),
    );
    assert.deepEqual(
      (await read("counter")).values.sort(),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    const auth = new AuthStore();
    await auth.put("challenge:once", { expires: Date.now() + 10000 });
    const consume = () =>
      new AuthStore().transaction(async (txn) => {
        const value = await txn.get("challenge:once");
        await txn.delete("challenge:once");
        return !!value;
      });
    assert.deepEqual((await Promise.all([consume(), consume()])).sort(), [
      false,
      true,
    ]);
    const expired = { expires: Date.now() - 1 };
    await auth.put("session:expired", expired);
    await auth.put("session:live", { expires: Date.now() + 10000 });
    assert.equal(await auth.get("session:expired"), undefined);
    const refs = await Promise.all([
      immutable({ frame: "exact" }),
      immutable({ frame: "exact" }),
    ]);
    assert.equal(refs[0], refs[1]);
    assert.deepEqual(await read(refs[0]), { frame: "exact" });
  });
});

test("private data stays private and malformed requests never commit", async () => {
  const store = new MemoryStorage();
  await storageContext.run(store, async () => {
    const send = (path, body) =>
      handler(
        new Request("https://neohack.dev" + path, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    assert.equal(
      (
        await send("/api/runs", {
          runs: [
            { id: "a", turn: 1, vaultId: "PRIVATE", accountId: "PRIVATE" },
          ],
        })
      ).status,
      200,
    );
    const stats = await handler(new Request("https://neohack.dev/api/stats"));
    assert.ok(!(await stats.text()).includes("PRIVATE"));
    const documentCount=store.docs.size, revision=store.revision;
    const response = await handler(
      new Request(`https://neohack.dev/api/vaults/${crypto.randomUUID()}`, {
        method: "PUT",
        body: '{"version":1}',
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(store.docs.size, documentCount);
    assert.equal(store.revision,revision,"malformed input writes no documents");
    const rewrite = await handler(
      new Request("https://neohack.dev/api/index?__path=stats"),
    );
    assert.equal((await rewrite.json()).totals.runs, 1);
    const noAccess = await handler(
      new Request("https://neohack.dev/api/index?__path=account/runs"),
    );
    assert.equal(noAccess.status, 401);
  });
});

test("corrupted content-addressed objects fail instead of becoming replay facts", async () => {
  const store = new MemoryStorage();
  await storageContext.run(store, async () => {
    const ref = await immutable({ turn: 1 }),
      doc = await store.read(ref);
    await store.write(ref, { turn: 2 }, doc.etag);
    await assert.rejects(read(ref), /hash differs/);
    await assert.rejects(immutable({ turn: 1 }), /hash differs/);
  });
});

test('storage health fails closed without attempting writes during a storage outage', async()=>{
  let writes=0;
  await storageContext.run({read:async()=>{throw Error('store suspended');},write:async()=>{writes++;}},async()=>{
    for(const path of ['health','stats']) {
      const response=await handler(new Request('https://neohack.dev/api/'+path));
      assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'Storage unavailable'});
    }
  });
  assert.equal(writes,0);
});

test('ledger persists across independent server instances and stale updates cannot erase completed runs', async t=>{
  const store=new MemoryStorage();
  const one=createTestHarness({store});const a=(await one.listen()).url;
  const submit=(url,runs)=>fetch(new URL('/api/runs',url),{method:'POST',body:JSON.stringify({runs})});
  assert.equal((await submit(a,[{id:'durable-run',name:'Hero',role:'wizard',turn:900,ended:true,maxLevel:8}])).status,200);
  await one.close();
  const two=createTestHarness({store});t.after(()=>two.close());const b=(await two.listen()).url;
  await submit(b,[]);await submit(b,[{id:'durable-run',turn:1,ended:false}]);
  const stats=await (await fetch(new URL('/api/stats',b))).json();
  assert.equal(stats.totals.runs,1);assert.equal(stats.best[0].turn,900);assert.equal(stats.best[0].ended,true);
});
