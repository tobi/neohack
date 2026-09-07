import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const Ajv=createRequire(new URL('../../../lib/neonethack/package.json',import.meta.url))('ajv/dist/2020.js').default;
import {recommend} from '../advisor.mjs';
import {methods} from '../../../lib/neonethack/dist/mcp/agent-data.js';
const base={sessionId:'abcdefghijklmnop',observation:{you:{x:5,y:5},vitals:{hunger:'not_hungry'},world:[]}};
const ajv=new Ajv({strict:false});
const schemas=new Map(methods.map(t=>[t.name,ajv.compile(t.schema)]));
test('reference advisor uses current navigation MCP schemas and leaves choices explicit',()=>{
  const frames=[base,{...base,observation:{...base.observation,vitals:{hunger:'hungry'}}},{...base,observation:{...base.observation,world:[{x:6,y:5,visible:true,occupant:{kind:'creature'}}]}},{...base,observation:{...base.observation,world:[{terrain:{type:'stairsDown'}}]}}];
  for(const frame of frames){const r=recommend(frame),validate=schemas.get(r.tool);assert.ok(validate,r.tool);assert.ok(validate(r.args),JSON.stringify(validate.errors));}
  assert.equal(recommend({...base,decision:{kind:'confirmation'}}).tool,null);
  assert.equal(recommend({...base,ended:true}).tool,null);
  assert.equal(recommend(base).tool,'explore');
  assert.equal(recommend({...base,observation:{...base.observation,vitals:{hunger:'hungry'},inventory:[{id:'opaque',label:'a cockatrice corpse'}]}}).args.item,undefined);
});
