import {AgentClient,tools,instructions} from './agent.js';
import type {Transport} from '../typescript/client.js';
import {SceneProjector} from './scene.js';
export {tools,instructions};
export {readOnlyTools} from './agent-data.js';
/** The ONLY MCP tool execution boundary, shared by document registration,
 * stdio and HTTP. Transports never map gameplay operations or shape snapshots. */
export class McpService {
  private agent:AgentClient;
  private projector=new SceneProjector();
  constructor(transport:Pick<Transport,'send'>){this.agent=new AgentClient(transport);}
  async call(name:string,input:Record<string,unknown>={},options:{signal?:AbortSignal}={}) {
    const frame=await this.agent.call(name,input,options);
    const response=this.projector.project(frame,typeof input.sinceViewId==='string'?input.sinceViewId:undefined);
    const content = [{type:'text' as const,text:JSON.stringify(response)}];
    const map = response.scene?.map;
    if (map && typeof map === 'object' && 'text' in map && typeof map.text === 'string') {
      // Tildes cannot form a fence inside a row: each row has a coordinate prefix.
      content.push({type:'text',text:`Perceived map (exact feature coordinates: scene.map.positions):\n~~~~text\n${map.text}\n~~~~`});
    }
    // Death is a failed gameplay result, not a failed/uncertain submission.
    // Keep its accepted outcome and exact receipt intact; postmortem reads
    // remain successful and must not be mistaken for another fatal action.
    const died=frame.control.gate==='ended'&&frame.scene?.end?.kind==='death'&&
      (frame.outcome?.actionsTaken??0)>0;
    return {isError:!!response.error||died,structuredContent:response,content};
  }
}
