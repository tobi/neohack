import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const Ajv=createRequire(new URL('../../../lib/neonethack/package.json',import.meta.url))('ajv/dist/2020.js').default;
import {recommend} from '../advisor.mjs';
import {agentTools} from '../../../lib/neonethack/protocol/agent.ts';
const base={version:2,basis:{sessionId:'abcdefghijklmnop',viewId:'view-1'},control:{gate:'ready'},scene:{kind:'snapshot',self:{position:{x:5,y:5},vitals:{hunger:'not_hungry'}},entities:[],features:[]}};
const ajv=new Ajv({strict:false});
const schemas=new Map(agentTools.map(t=>[t.name,ajv.compile(t.inputSchema)]));
test('reference advisor uses current navigation MCP schemas and leaves choices explicit',()=>{
  const frames=[base,{...base,scene:{...base.scene,self:{...base.scene.self,vitals:{hunger:'hungry'}}}},{...base,scene:{...base.scene,entities:[{ref:'seen-1',position:{x:6,y:5},kind:'creature'}]}},{...base,scene:{...base.scene,features:[{terrain:{type:'stairsDown'}}]}}];
  for(const frame of frames){const r=recommend(frame),validate=schemas.get(r.tool);assert.ok(validate,r.tool);assert.ok(validate(r.args),JSON.stringify(validate.errors));}
  assert.equal(recommend({...base,decision:{kind:'confirmation'}}).tool,null);
  for(const gate of ['ended','ownershipLost','recoveryRequired'])assert.equal(recommend({...base,control:{gate}}).tool,null);
  assert.equal(recommend(base).tool,'explore');
  assert.equal(recommend(frames[1]).args.itemId,undefined);
  assert.equal(recommend(base).args.viewId,'view-1');
  assert.equal(recommend({...base,scene:null}).tool,'syncState');
  assert.throws(()=>recommend({version:1,observation:{}}),/v2/);
});
