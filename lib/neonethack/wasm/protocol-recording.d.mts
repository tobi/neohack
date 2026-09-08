export const recordingFormat:'neonethack.inputs';
export function randomRunId():string;
export function digest(value:string|Uint8Array):Promise<string>;
export function compress(value:Uint8Array):Promise<Uint8Array>;
export function decompress(value:Uint8Array,limit?:number):Promise<Uint8Array>;
export function validateRecord(value:any,index:number):any;
export function validateIntegrity(value:unknown):void;
