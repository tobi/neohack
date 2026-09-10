import {McpService,tools,instructions} from './service.js';
export const versions=['2026-07-28','2025-11-25','2025-06-18','2025-03-26'] as const;
const serverInfo={name:'neohack',version:'1.0.0-alpha.1'};
export class RpcError extends Error{constructor(readonly code:number,message:string,readonly status=400){super(message);}}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Reject duplicate object keys rather than allow a parser-dependent operation.
 * JSON.parse does syntax validation; this lexical pass only checks object keys. */
export function parseFrame(bytes:Uint8Array){
  let source:string,value:unknown;
  try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);value=JSON.parse(source);}catch{throw new RpcError(-32700,'Invalid UTF-8 JSON');}
  const stack:Array<{keys:Set<string>;key:boolean}|null>=[];
  const tokens=source.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]|[^\s{}[\]:,]+/g)??[];
  for(const token of tokens){
    if(token==='{')stack.push({keys:new Set(),key:true});else if(token==='[')stack.push(null);
    else if(token==='}'||token===']')stack.pop();
    else {const top=stack.at(-1);if(top){if(token===',')top.key=true;else if(token===':')top.key=false;else if(top.key&&token.startsWith('"')){const key=JSON.parse(token);if(top.keys.has(key))throw new RpcError(-32600,'Duplicate JSON key');top.keys.add(key);top.key=false;}}}
  }
  if(!object(value)||value.jsonrpc!=='2.0'||typeof value.method!=='string'||('id'in value&&!(typeof value.id==='string'||Number.isSafeInteger(value.id)))||('params'in value&&!object(value.params)))throw new RpcError(-32600,'Invalid JSON-RPC request');
  return value;
}
export function errorFrame(id:unknown,error:unknown){const e=error instanceof RpcError?error:new RpcError(-32603,'MCP transport failed; execution may be uncertain.',500);return {status:e.status,body:{jsonrpc:'2.0',id:id??null,error:{code:e.code,message:e.message}}};}
export class RpcPeer{
  private initialized=false;
  private active=new Map<string,AbortController>();
  constructor(readonly service:McpService,readonly http=false){}
  async request(frame:Record<string,any>,modern=false):Promise<Record<string,unknown>|null>{
    const {method,id}=frame,params=frame.params??{};
    if(id===undefined){
      if(method==='notifications/cancelled'){const key=JSON.stringify(params.requestId);this.active.get(key)?.abort();}
      else if(method!=='notifications/initialized'&&!method.startsWith('notifications/')){if(this.http)throw new RpcError(-32600,'Tools require a request ID');}
      return null;
    }
    let result:Record<string,unknown>;
    if(method==='initialize'){
      if(modern)throw new RpcError(-32601,'Use server/discover for this protocol version',404);
      if(!object(params.capabilities)||!object(params.clientInfo)||typeof params.protocolVersion!=='string')throw new RpcError(-32602,'Invalid initialization');
      this.initialized=true;
      result={protocolVersion:versions.includes(params.protocolVersion)?params.protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo,instructions};
    }else if(method==='server/discover')result={serverInfo,supportedVersions:[versions[0]],capabilities:{tools:{}},instructions};
    else{
      if(!this.http&&!this.initialized)throw new RpcError(-32000,'Initialize first');
      if(method==='ping')result={};
      else if(method==='tools/list')result={tools};
      else if(method==='tools/call'){
        if(typeof params.name!=='string'||!tools.some(t=>t.name===params.name)||('arguments'in params&&!object(params.arguments)))throw new RpcError(-32602,'Unknown tool or invalid arguments; call help for schemas');
        const key=JSON.stringify(id);if(this.active.has(key))throw new RpcError(-32600,'Request ID already in flight');
        const controller=new AbortController();this.active.set(key,controller);
        try{result=await this.service.call(params.name,params.arguments??{},{signal:controller.signal});}finally{this.active.delete(key);}
      }else throw new RpcError(-32601,'Unknown method',404);
    }
    // Only transport metadata differs. Tool content is identical to WebMCP.
    return {jsonrpc:'2.0',id,result:modern?{...result,resultType:'complete',_meta:{'io.modelcontextprotocol/serverInfo':serverInfo}}:result};
  }
}
