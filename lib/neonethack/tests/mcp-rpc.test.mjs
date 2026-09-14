import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RpcPeer} from '../dist/mcp/rpc.js';
import {tools} from '../dist/mcp/service.js';

for(const http of [false,true])test(`unknown tool logs a bounded diagnostic without arguments (${http?'http':'stdio'})`,async t=>{
  const logs=[];t.mock.method(console,'error',message=>logs.push(message));
  const peer=new RpcPeer({call:()=>assert.fail('unknown tools must never dispatch')},http);
  if(!http)await peer.request({method:'initialize',id:0,params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}});
  for(const name of ['zap','bad\n\u001b[31mtool','x'.repeat(10000)]){
    const id='request\n42';
    await assert.rejects(peer.request({method:'tools/call',id,params:{name,arguments:{sessionId:'private-session',text:'private-payload'}}}),error=>{
      assert.equal(error.code,-32602);assert.match(error.message,/Unknown tool/);
      assert.ok(error.message.includes(tools.map(t=>t.name).join(', ')));assert.match(error.message,/no operation was sent/);
      return true;
    });
    const line=logs.at(-1);
    assert.ok(line.length<1000);assert.ok(!line.includes('\n'));assert.ok(!line.includes('\u001b'));
    assert.ok(!line.includes('private-'));
    assert.deepEqual(JSON.parse(line.slice('[mcp] '.length)),{event:'unknownTool',transport:http?'http':'stdio',
      requestId:id,tool:name.slice(0,160),toolNameTruncated:name.length>160,availableTools:tools.map(t=>t.name)});
  }
  assert.equal(logs.length,3);
  for(const params of [{name:17},{name:'travel',arguments:[]}])
    await assert.rejects(peer.request({method:'tools/call',id:9,params}),error=>error.code===-32602&&!error.message.includes('Unknown tool'));
  assert.equal(logs.length,3,'malformed known calls are not mislabeled as unknown tools');
});
