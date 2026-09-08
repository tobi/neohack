import Ajv2020 from 'ajv/dist/2020.js';
import {agentTools} from '../../lib/neonethack/protocol/agent.ts';
import {SUPPORTED_OPERATIONS} from './dispatcher.mjs';

/** Validate enabled high-MCP operations against the shared generated catalog.
 * Identity is bound by the client/dispatcher, not supplied inside action args.
 * No copied command schema, unknown-field tolerance, coercion or default input.
 */
export function createOperationValidators({sessionId,enabled=SUPPORTED_OPERATIONS}={}) {
  if(typeof sessionId!=='string'||!sessionId||!Array.isArray(enabled))throw new TypeError('Explicit session and enabled operations required.');
  const ajv=new Ajv2020({strict:false,allErrors:true});
  return new Map(enabled.map(name=>{
    const tool=agentTools.find(t=>t.name===name);
    if(!SUPPORTED_OPERATIONS.includes(name)||!tool)throw new TypeError('Unsupported operation: '+name);
    const validate=ajv.compile(tool.inputSchema);
    return [name,args=>Boolean(args && !Object.hasOwn(args,'sessionId') && validate({...args,sessionId}))];
  }));
}
