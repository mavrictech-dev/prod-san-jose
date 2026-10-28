import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bUuid } from '@factuez/contracts/b2b-read-query';
import { calculateDocumentTotals } from '../application/totals';
import type { DraftBody } from './draft-model';
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const fields=(v:any,allowed:string[],required=allowed)=>plain(v)&&Object.keys(v).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(v,k));
const safe=(v:unknown,max:number)=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
export const patchFields=['customer','lines','issueDate'] as const;
export function draftBody(value:unknown):DraftBody{
  const keys=['issuerId','branchId','pointId','seriesId','environment','documentType','currency','paymentTerms','externalReference',...patchFields];
  if(!fields(value,keys))throw new B2bSecurityError(400,'INVALID_DRAFT');const b=value as DraftBody;
  if(!Number.isSafeInteger(b.issuerId)||b.issuerId<1||b.issuerId>2147483647||![b.branchId,b.pointId,b.seriesId].every(b2bUuid)||b.environment!=='BETA'||!['01','03'].includes(b.documentType)||!['PEN','USD'].includes(b.currency)||b.paymentTerms!=='CONTADO')throw new B2bSecurityError(400,'INVALID_DRAFT_CONTEXT');
  if(!/^20\d{2}-\d{2}-\d{2}$/.test(b.issueDate)||!Number.isFinite(Date.parse(b.issueDate))||new Date(b.issueDate).toISOString().slice(0,10)!==b.issueDate)throw new B2bSecurityError(400,'INVALID_ISSUE_DATE');
  if(!fields(b.externalReference,['namespace','value'])||!safe(b.externalReference.value,120)||!/^[a-z][a-z0-9_-]{0,39}$/.test(b.externalReference.namespace))throw new B2bSecurityError(400,'INVALID_EXTERNAL_REFERENCE');
  const c=b.customer;
  if(!fields(c,['identityType','identityNumber','legalName','address','email'],['identityType','identityNumber','legalName'])||!['0','1','6'].includes(c.identityType)||!safe(c.legalName,200)||typeof c.identityNumber!=='string'||!/^\d{1,15}$/.test(c.identityNumber)||
    (c.identityType==='1'&&!/^\d{8}$/.test(c.identityNumber))||(c.identityType==='6'&&!/^\d{11}$/.test(c.identityNumber))||(b.documentType==='01'&&c.identityType!=='6')||
    (c.address!==undefined&&!safe(c.address,300))||(c.email!==undefined&&(!safe(c.email,254)||!/^\S+@\S+\.\S+$/.test(c.email))))throw new B2bSecurityError(400,'INVALID_CUSTOMER');
  if(!Array.isArray(b.lines)||!b.lines.length||b.lines.length>100)throw new B2bSecurityError(400,'INVALID_LINES');
  for(const l of b.lines)if(!fields(l,['productId','productCode','description','unitCode','quantity','unitPriceWithTax','taxAffectationCode','igvRate'],['description','unitCode','quantity','unitPriceWithTax','taxAffectationCode','igvRate'])||!safe(l.description,250)||!/^[A-Z0-9]{2,3}$/.test(l.unitCode)||
    ![l.quantity,l.unitPriceWithTax].every(n=>typeof n==='string'&&/^\d{1,12}(\.\d{1,6})?$/.test(n)&&Number(n)>0)||l.taxAffectationCode!=='10'||l.igvRate!=='18'||(l.productId!==undefined&&!b2bUuid(l.productId))||(l.productCode!==undefined&&!safe(l.productCode,40)))throw new B2bSecurityError(400,'PROFILE_NOT_ENABLED');
  calculateDocumentTotals(b.lines);return structuredClone(b);
}
export function draftPatch(original:DraftBody,value:unknown){
  if(!fields(value,[...patchFields],[])||!Object.keys(value as any).length)throw new B2bSecurityError(400,'INVALID_DRAFT_PATCH');
  return draftBody({...original,...value as any});
}
