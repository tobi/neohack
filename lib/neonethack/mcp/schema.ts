export interface Schema {type?:string;properties?:Record<string,Schema|undefined>;required?:readonly string[];dependentRequired?:Record<string,readonly string[]|undefined>;additionalProperties?:boolean;oneOf?:readonly Schema[];enum?:readonly unknown[];const?:unknown;items?:Schema;minimum?:number;maximum?:number;minLength?:number;maxLength?:number;minItems?:number;maxItems?:number;uniqueItems?:boolean}
export function valid(value:unknown,s:Schema):boolean {
  if(s.oneOf&&s.oneOf.filter(c=>valid(value,c)).length!==1)return false;
  if('const' in s&&value!==s.const)return false;
  if(s.enum&&!s.enum.includes(value))return false;
  if(s.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    const v=value as Record<string,unknown>;
    return !(s.required??[]).some(k=>!(k in v))&&Object.entries(s.dependentRequired??{}).every(([k,needed])=>!(k in v)||!needed||needed.every(n=>n in v))&&Object.entries(v).every(([k,x])=>s.properties&&Object.hasOwn(s.properties,k)&&s.properties[k]?valid(x,s.properties[k]!):s.additionalProperties!==false);
  }
  if(s.type==='array')return Array.isArray(value)&&value.length>=(s.minItems??0)&&value.length<=(s.maxItems??Infinity)&&(!s.uniqueItems||new Set(value.map(v=>JSON.stringify(v))).size===value.length)&&value.every(v=>!s.items||valid(v,s.items));
  // oxlint-disable-next-line no-control-regex -- Reject controls at the public input boundary.
  if(s.type==='string')return typeof value==='string'&&value.length>=(s.minLength??0)&&value.length<=(s.maxLength??Infinity)&&!/[\u0000-\u001f\u007f]/.test(value);
  if(s.type==='integer')return Number.isSafeInteger(value)&&(value as number)>=(s.minimum??-Infinity)&&(value as number)<=(s.maximum??Infinity);
  if(s.type==='boolean')return typeof value==='boolean';
  return true;
}
