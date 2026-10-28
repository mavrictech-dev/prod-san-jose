import { B2bSecurityError } from './b2b-security';
export interface B2bDocumentFilters {issuerId:number;environment:'BETA';from:string;to:string;types:('01'|'03')[];branchId?:string;pointId?:string;seriesId?:string}
export const b2bUuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function b2bQuery(value:unknown,keys:readonly string[],required:readonly string[]=[]):Record<string,string>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||Object.values(value).some(v=>typeof v!=='string'||!v||v.length>4096)||required.some(key=>!(key in value)))throw new B2bSecurityError(400,'INVALID_QUERY');
  const q=value as Record<string,string>;
  if(q.environment!==undefined&&q.environment!=='BETA')throw new B2bSecurityError(400,'ENVIRONMENT_NOT_ALLOWED');
  return q;
}
export function b2bIssuerId(value:unknown):number {
  if(typeof value!=='string'||!/^[1-9][0-9]{0,9}$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>2147483647)throw new B2bSecurityError(400,'INVALID_ISSUER');return Number(value);
}
export function b2bDocumentFilters(value:unknown):B2bDocumentFilters {
  const q=b2bQuery(value,['issuerId','environment','from','to','types','branchId','pointId','seriesId'],['issuerId','environment','from','to']);
  const validDate=(date:string)=>/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(date)&&!Number.isNaN(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date;
  if(!validDate(q.from)||!validDate(q.to)||q.to<q.from||Date.parse(q.to)-Date.parse(q.from)>366*86400000)throw new B2bSecurityError(400,'INVALID_DATE_RANGE');
  const types=q.types===undefined?['01','03']:q.types.split(',');
  if(types.some(type=>!['01','03','07','08','09','31'].includes(type))||new Set(types).size!==types.length)throw new B2bSecurityError(400,'INVALID_DOCUMENT_TYPES');
  if(types.some(type=>!['01','03'].includes(type)))throw new B2bSecurityError(422,'SOURCE_NOT_SUPPORTED');
  for(const key of ['branchId','pointId','seriesId'])if(q[key]!==undefined&&!b2bUuid(q[key]))throw new B2bSecurityError(400,'INVALID_QUERY');
  return {issuerId:b2bIssuerId(q.issuerId),environment:'BETA',from:q.from,to:q.to,types:types.sort() as ('01'|'03')[],
    ...(q.branchId?{branchId:q.branchId}:{}),...(q.pointId?{pointId:q.pointId}:{}),...(q.seriesId?{seriesId:q.seriesId}:{})};
}
