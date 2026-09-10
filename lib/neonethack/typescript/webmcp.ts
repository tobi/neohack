import {McpService, tools} from '../mcp/service.js';
import type {Transport} from './client.js';

/** Structural types for document.modelContext and early navigator builds. */
export interface WebMcpContext {
  registerTool(tool: {
    name:string; description:string; inputSchema:object;
    annotations:{readOnlyHint:boolean};
    execute(input:Record<string,unknown>,options?:{signal?:AbortSignal}):Promise<unknown>;
  },options?:{signal:AbortSignal}):void|(()=>void)|Promise<void|(()=>void)>;
  unregisterTool?(name:string):void;
}
export interface WebMcpRegistration {supported:boolean;toolCount:number;dispose():void}

/** MCP exposes navigation and agent conveniences. The precise semantic catalog
 * remains available through the low library and NDJSON. An aborted invocation
 * cannot undo submitted input; retain its exact operation for recovery. */
export async function registerWebMcp(
  transport:Pick<Transport,'send'>,
  context:WebMcpContext|undefined = (globalThis.document as (Document & {modelContext?:WebMcpContext})|undefined)?.modelContext ??
    (globalThis.navigator as (Navigator & {modelContext?:WebMcpContext})|undefined)?.modelContext,
):Promise<WebMcpRegistration> {
  if(!context?.registerTool)return {supported:false,toolCount:0,dispose(){}};
  const agent=new McpService(transport),controller=new AbortController(),registered:string[]=[],cleanups:(()=>void)[]=[];
  const dispose=()=>{controller.abort();for(const cleanup of cleanups.splice(0))cleanup();for(const name of registered.splice(0))context.unregisterTool?.(name);};
  try {
    for(const tool of tools){
      const cleanup = await context.registerTool({
        name:tool.name,description:tool.description,inputSchema:tool.inputSchema,
        annotations:{readOnlyHint:tool.annotations.readOnlyHint},
        execute:async(input,options)=>{
          if(controller.signal.aborted||options?.signal?.aborted)return {
            isError:true,structuredContent:{version:1,error:{code:'cancelled',message:'Tool call cancelled before submission.'}},content:[],
          };
          const callController=new AbortController(),abort=()=>callController.abort();
          controller.signal.addEventListener('abort',abort,{once:true});
          options?.signal?.addEventListener('abort',abort,{once:true});
          try {
            return await agent.call(tool.name,input,{signal:callController.signal});
          } finally {
            controller.signal.removeEventListener('abort',abort);
            options?.signal?.removeEventListener('abort',abort);
          }
        },
      },{signal:controller.signal});
      if(typeof cleanup === "function")cleanups.push(cleanup);
      else registered.push(tool.name);
    }
  }catch(error){dispose();throw error;}
  return {supported:true,toolCount:tools.length,dispose};
}
export {CompactObservationReader} from '../mcp/compact.js';
