import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {startMcpHttp} from '../../../lib/neonethack/tests/mcp-fixture.mjs';

test('failed session resume preserves caller state and never creates a replacement adventure', {timeout:30000}, async t=>{
  const dir=await mkdtemp(tmpdir()+'/neohack-cli-resume-');
  const stateDir=dir+'/state',sessionsPath=dir+'/sessions';
  await mkdir(stateDir);await mkdir(sessionsPath);
  const saved=JSON.stringify({gameId:'abcdefghijklmnop',reqSeq:9}),conversation='[{"role":"user","content":"retain this run"}]';
  await writeFile(stateDir+'/game-state.json',saved);
  await writeFile(stateDir+'/conversation.json',conversation);
  const server=await startMcpHttp({sessionsPath});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  await assert.rejects(promisify(execFile)(process.execPath,[fileURLToPath(new URL('../agent.mjs',import.meta.url)),'--continue'],{
    timeout:15000,env:{...process.env,NEONETHACK_BOT_STATE:stateDir,NEONETHACK_SESSIONS:sessionsPath,
      NEONETHACK_MCP_HTTP_URL:server.url,OPENAI_API_BASE:'http://127.0.0.1:1/v1',OPENAI_BASE_URL:'http://127.0.0.1:1/v1',OPENAI_API_KEY:'fixture',OPENAI_MODEL:'fixture'},
  }),error=>{
    assert.match(error.stderr,/could not be resumed; preserve its state/);
    assert.doesNotMatch(error.stdout,/starting a new adventure|fresh conversation/);
    assert.equal(error.killed,false);
    return true;
  });
  assert.equal(await readFile(stateDir+'/game-state.json','utf8'),saved);
  assert.equal(await readFile(stateDir+'/conversation.json','utf8'),conversation);
  assert.deepEqual(await readdir(sessionsPath),[]);
  assert.ok(!(await readdir(stateDir)).includes('agent.lock'));
});
