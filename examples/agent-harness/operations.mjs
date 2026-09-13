import Ajv2020 from 'ajv/dist/2020.js';
import {catalog} from '../../lib/neonethack/protocol/catalog.ts';
import {SUPPORTED_OPERATIONS} from './dispatcher.mjs';

/** Library reference policy: game/decision arguments use the low catalog.
 * Bounded legs use the shared Game navigator; this is not an MCP tool surface.
 */
export function createOperationValidators({sessionId,enabled=SUPPORTED_OPERATIONS}={}) {
  if(typeof sessionId!=='string'||!sessionId||!Array.isArray(enabled))throw new TypeError('Explicit session and enabled operations required.');
  const ajv=new Ajv2020({strict:false,allErrors:true});
  return new Map(enabled.map(name=>{
    const navigation=['go','explore','descend'].includes(name);
    const method=catalog.methods.find(t=>t.name===`${['answer','cancel'].includes(name)?'decision':'game'}.${name}`);
    if(!SUPPORTED_OPERATIONS.includes(name)||(!method&&!navigation))throw new TypeError('Unsupported operation: '+name);
    const schema=navigation?{
      type:'object',additionalProperties:false,properties:{
        sessionId:{type:'string'},maxActions:{type:'integer',minimum:1,maximum:200},
        ...(name==='go'?{to:{type:'object',additionalProperties:false,properties:{x:{type:'integer',minimum:1,maximum:79},y:{type:'integer',minimum:0,maximum:20}},required:['x','y']}}:{}),
      },required:['sessionId','maxActions',...(name==='go'?['to']:[])],
    }:structuredClone(method.schema);
    if(!navigation){
      delete schema.properties.requestId;delete schema.properties.expectedRevision;
      schema.required=schema.required.filter(key=>!['requestId','expectedRevision'].includes(key));
    }
    const validate=ajv.compile(schema);
    return [name,args=>Boolean(args && !Object.hasOwn(args,'sessionId') && validate({...args,sessionId}))];
  }));
}
