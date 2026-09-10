import {AgentClient,tools,instructions} from './agent.js';
import type {Transport} from '../typescript/client.js';
export {tools,instructions};
/** The ONLY MCP tool execution boundary, shared by document registration,
 * stdio and HTTP. Transports never map gameplay operations or shape snapshots. */
export class McpService {
  private agent:AgentClient;
  constructor(transport:Pick<Transport,'send'>){this.agent=new AgentClient(transport);}
  async call(name:string,input:Record<string,unknown>={},options:{signal?:AbortSignal}={}) {
    if(options.signal?.aborted)return {isError:true,structuredContent:{version:1,error:{code:'cancelled',message:'Tool call cancelled before submission.'}},content:[]};
    const response=await this.agent.call(name,input,options);
    return {isError:!!response.error,structuredContent:response,content:[{type:'text' as const,text:JSON.stringify(response)}]};
  }
}
