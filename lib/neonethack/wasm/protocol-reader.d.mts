export function validateManifest(value:unknown):void;
export function replayDocument(response:Response):Promise<any>;
export function inputManifest(url:URL|string,signal?:AbortSignal):Promise<any>;
export function inputRecords(manifest:any,url:URL|string,options?:{signal?:AbortSignal;from?:number;prefetch?:number}):AsyncGenerator<any>;
export function checkpointBytes(entry:any,url:URL|string,signal?:AbortSignal):Promise<{bytes:Uint8Array;sha256:string;index:number}>;
