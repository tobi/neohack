import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

test("CLI reuses exact evidence, invalidates changed input, and never retries a failed provider", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "chronicle-cli-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "replies.jsonl"),
    out = join(dir, "out"),
    calls = join(dir, "calls"),
    fake = join(dir, "muse");
  // Provider double only; no model request or paid dependency belongs in CI.
  await writeFile(
    fake,
    `#!/usr/bin/env node
const fs=require('node:fs');fs.appendFileSync(process.env.CHRONICLE_TEST_CALLS,'call\\n');
if(process.env.CHRONICLE_TEST_FAIL){console.error('HTTP 503 overloaded');process.exit(1);}
process.stdout.write(JSON.stringify({title:'A Short Attempt',paragraphs:[{text:'The adventurer arrived.',sources:['e1']},{text:'The attempt ended in a quit.',sources:['e2']}]}));`,
  );
  await chmod(fake, 0o700);
  const rows = [0, 1].map((i) => ({
    version: 1,
    sessionId: "fresh-test",
    revision: i,
    observation: { turn: 1, heard: [], vitals: {}, world: [] },
    events: [],
    ended: !!i,
    end: i ? { kind: "quit", turn: 1 } : null,
  }));
  await writeFile(input, rows.map(JSON.stringify).join("\n"));
  const args = [
    resolve("examples/chronicle/cli.mjs"),
    "--input",
    input,
    "--out",
    out,
  ];
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    CHRONICLE_TEST_CALLS: calls,
  };
  await exec(process.execPath, args, { env });
  const a = JSON.parse(await readFile(join(out, "story.json")));
  assert.match(a.evidenceHash, /^[a-f0-9]{64}$/);
  const reuse = await exec(process.execPath, args, {
    env: { ...env, CHRONICLE_TEST_FAIL: "1" },
  });
  assert.match(reuse.stdout, /no model call/);
  assert.equal(await readFile(calls, "utf8"), "call\n");
  const failure = await exec(process.execPath, [...args, "--name", "Changed"], {
    env: { ...env, CHRONICLE_TEST_FAIL: "1" },
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(failure);
  assert.match(failure.stderr, /HTTP 503/);
  assert.equal(
    await readFile(calls, "utf8"),
    "call\ncall\n",
    "failed provider called once, not retried",
  );
  await assert.rejects(
    readFile(join(out, "index.html")),
    { code: "ENOENT" },
    "no stale story presented for new evidence",
  );
  assert.equal(
    JSON.parse(await readFile(join(out, "digest.json"))).hero.name,
    "Changed",
  );
  await exec(process.execPath, [...args, "--prepare-only"], {
    env: { ...env, CHRONICLE_TEST_FAIL: "1" },
  });
  assert.equal(
    await readFile(calls, "utf8"),
    "call\ncall\n",
    "prepare never calls the provider",
  );
});
