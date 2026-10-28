/** Incoming originals have their own authority. No emission binding alone grants purchases. */
import {createHash} from 'node:crypto';
import {isProxy} from 'node:util/types';
import type {ReceivedDocumentProjectionV1,ReceivedDocumentRow} from '@factuez/contracts';
import {B2bSecurityError,type B2bPrincipal} from '@factuez/contracts/b2b-security';
import {b2bIssuerId,b2bUuid} from '@factuez/contracts/b2b-read-query';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from './b2b-correction-evidence-wire';
export type ReceivedScope={environment:'BETA';companyId:number;recipientRuc:string;branchId:string};
export type ReceivedSubject={kind:'SERVICE'|'USER';clientId:string;subjectId:string|null};
export type ReceivedAction='LIST'|'DETAIL'|'ARTIFACTS'|'CONTENT';
export type ReceivedSelection={scope:ReceivedScope;from:string;to:string;type?:string;after?:string;limit:number};
export type ReceivedArtifactView={id:string;kind:'XML'|'CDR'|'PROVIDER_PDF';fileName:string;mediaType:string;sha256:string;byteLength:number;
  representation:'PROVIDER_ORIGINAL';signatureTrust:'NOT_VERIFIED'};
export type ReceivedDetailView={schemaVersion:'factuez.b2b.received-detail.v1';scope:ReceivedScope;document:ReceivedDocumentRow;
  projection:ReceivedDocumentProjectionV1;artifacts:ReceivedArtifactView[];fiscalAcceptance:'NOT_VERIFIED';source:'RECEIVED_XML'};
export const receivedSubject=(p:B2bPrincipal):ReceivedSubject=>({kind:p.kind,clientId:p.clientId,subjectId:p.subjectId});
export function receivedFail(status=400,code='INVALID_RECEIVED_REQUEST'):never{throw new B2bSecurityError(status,code);}
const invalidOwner=():never=>receivedFail(503,'INVALID_RECEIVED_OWNER_RESPONSE');
const TYPES=['01','03','07','08','09','20','31','40'];
const SHA=/^[a-f0-9]{64}$/;
const CONTROL=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const UNPAIRED=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const DECIMAL=/^[+-]?\d{1,30}(?:\.\d{1,20})?$/;
const NUMBER=/^[A-Za-z0-9]{1,8}-\d{1,12}$/;
/** Inspect before reading: shared copier rejects traps, accessors, cycles,
 * custom prototypes, hidden/symbol keys, holes and excessive depth/nodes/bytes.
 * Private malformed replies never expose a foreign evidence error. */
function detached<T>(value:T,owner=false):T{
  try{return correctionEvidenceFreeze(value);}catch{if(owner)invalidOwner();receivedFail();}
}
function exact(value:any,keys:readonly string[],fail:()=>never){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))fail();
}
export function receivedExact(v:any,keys:string[]){exact(detached(v),keys,()=>receivedFail());}
function ownerExact(value:any,keys:readonly string[]){exact(value,keys,invalidOwner);}
function text(v:unknown,max=8192,nonempty=false):asserts v is string{
  if(typeof v!=='string'||v.length>max||CONTROL.test(v)||UNPAIRED.test(v)||nonempty&&!v.trim())invalidOwner();
}
function decimal(v:unknown){if(v!==null&&(typeof v!=='string'||!DECIMAL.test(v)))invalidOwner();}
function currency(v:unknown){if(v!==null&&(typeof v!=='string'||!/^[A-Z]{3}$/.test(v)))invalidOwner();}
function documentType(v:unknown){if(typeof v!=='string'||!TYPES.includes(v))invalidOwner();}
function fullNumber(v:unknown){if(typeof v!=='string'||!NUMBER.test(v)||/-0+$/.test(v))invalidOwner();}
function sameScope(value:unknown,scope:ReceivedScope){
  const parsed=(()=>{try{return receivedScope(value);}catch{return invalidOwner();}})();
  if(hash(parsed)!==hash(scope))invalidOwner();
}
export function receivedScope(value:unknown):ReceivedScope{
  const v:any=detached(value);exact(v,['environment','companyId','recipientRuc','branchId'],()=>receivedFail());
  if(v.environment!=='BETA'||!Number.isSafeInteger(v.companyId)||v.companyId<1||v.companyId>2147483647||
    typeof v.recipientRuc!=='string'||!/^\d{11}$/.test(v.recipientRuc)||!b2bUuid(v.branchId))receivedFail();return v;
}
export function receivedAnchor(p:B2bPrincipal,s:ReceivedScope){
  if(!p.bindings.some(b=>b.issuerId===s.companyId&&b.issuerRuc===s.recipientRuc&&b.branchId===s.branchId&&b.environment===s.environment))receivedFail(404,'RESOURCE_NOT_FOUND');
}
export function receivedDate(v:unknown):v is string{return typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;}
function time(v:unknown):boolean{
  return typeof v==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)?$/.test(v);
}
function instant(v:unknown){
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(v)||
    !receivedDate(v.slice(0,10))||!Number.isFinite(Date.parse(v))||/[+-]14:(?!00)/.test(v))invalidOwner();
}
export function receivedSelection(value:unknown):ReceivedSelection{
  const q:any=detached(value),keys=Object.keys(q??{});
  if(!q||typeof q!=='object'||Array.isArray(q)||keys.some(k=>!['scope','from','to','type','after','limit'].includes(k))||!['scope','from','to','limit'].every(k=>Object.hasOwn(q,k)))receivedFail();
  const scope=receivedScope(q.scope);
  if(!receivedDate(q.from)||!receivedDate(q.to)||q.from>q.to||Date.parse(q.to)-Date.parse(q.from)>366*86400000||
    !Number.isSafeInteger(q.limit)||q.limit<1||q.limit>100||Object.hasOwn(q,'after')&&!b2bUuid(q.after)||
    Object.hasOwn(q,'type')&&(typeof q.type!=='string'||!TYPES.includes(q.type)))receivedFail();
  return {...q,scope};
}
export function receivedScopeQuery(q:Record<string,string>):ReceivedScope{
  const v=detached(q);return receivedScope({environment:v?.environment,companyId:b2bIssuerId(v?.companyId),recipientRuc:v?.recipientRuc,branchId:v?.branchId});
}
function nullable(v:unknown,max=8192){if(v!==null)text(v,max);}
function array(v:any,max=1000):any[]{if(!Array.isArray(v)||v.length>max)invalidOwner();return v;}
function texts(v:unknown,max=1000){for(const s of array(v,max))text(s);}
function tax(t:any){
  ownerExact(t,['schemeId','name','amount','taxableAmount','percent','affectationCode']);
  for(const k of ['schemeId','name','affectationCode'])nullable(t[k]);
  for(const k of ['amount','taxableAmount','percent'])decimal(t[k]);
}
export function receivedProjection(value:unknown):ReceivedDocumentProjectionV1{
  const p:any=detached(value,true);
  ownerExact(p,['schemaVersion','documentType','fullNumber','series','number','issueDate','issueTime','dueDate','currencyCode','supplier','recipient','items','totals','taxes','paymentTerms','references','notes','warnings','xmlSha256','signature']);
  if(p.schemaVersion!=='factuez.received-document.v1'||!receivedDate(p.issueDate)||typeof p.xmlSha256!=='string'||!SHA.test(p.xmlSha256))invalidOwner();
  documentType(p.documentType);fullNumber(p.fullNumber);
  if(typeof p.series!=='string'||typeof p.number!=='string'||p.fullNumber!==`${p.series}-${p.number}`||
    p.issueTime!==null&&!time(p.issueTime)||p.dueDate!==null&&!receivedDate(p.dueDate))invalidOwner();
  currency(p.currencyCode);
  for(const who of ['supplier','recipient']){
    const party=p[who];ownerExact(party,['identityNumber','identityType','legalName','address']);
    for(const k of ['identityNumber','identityType','legalName'])nullable(party[k]);nullable(party.address,81958);
    if(party.identityType==='6'&&party.identityNumber!==null&&!/^\d{11}$/.test(party.identityNumber))invalidOwner();
  }
  for(const t of array(p.taxes))tax(t);
  const totals=['lineExtensionAmount','taxExclusiveAmount','taxInclusiveAmount','allowanceTotalAmount','chargeTotalAmount','prepaidAmount','payableAmount'];
  ownerExact(p.totals,totals);for(const k of totals)decimal(p.totals[k]);
  const lineIds=new Set<string>();
  for(const item of array(p.items)){
    ownerExact(item,['lineId','supplierCode','sunatCode','description','unitCode','quantity','unitValue','unitPrice','lineExtensionAmount','allowances','taxes']);
    text(item.lineId,4096,true);text(item.description,81939);
    if(lineIds.has(item.lineId))invalidOwner();lineIds.add(item.lineId);
    for(const key of ['supplierCode','sunatCode','unitCode'])nullable(item[key]);
    for(const key of ['quantity','unitValue','unitPrice','lineExtensionAmount'])decimal(item[key]);
    for(const a of array(item.allowances,100)){ownerExact(a,['charge','amount','reason']);if(typeof a.charge!=='boolean')invalidOwner();decimal(a.amount);nullable(a.reason);}
    for(const t of array(item.taxes))tax(t);
  }
  for(const t of array(p.paymentTerms,100)){
    ownerExact(t,['id','means','amount','dueDate']);nullable(t.id);nullable(t.means);decimal(t.amount);
    if(t.dueDate!==null&&!receivedDate(t.dueDate))invalidOwner();
  }
  for(const r of array(p.references)){
    ownerExact(r,['kind','number','documentType']);text(r.kind,8192,true);nullable(r.number);nullable(r.documentType);
  }
  texts(p.notes,100);texts(p.warnings,200);
  ownerExact(p.signature,['status','officialTrust']);if(!['MISSING','PRESENT_UNVERIFIED'].includes(p.signature.status)||p.signature.officialTrust!==false)invalidOwner();
  return p;
}
export function receivedRow(value:unknown,scope:ReceivedScope):ReceivedDocumentRow{
  const s=receivedScope(scope),r:any=detached(value,true);ownerExact(r,['id','companyId','recipientRuc','branchId','supplierRuc','supplierName','documentType','fullNumber','issueDate','currencyCode','payableAmount','receivedAt','itemCount','sunatStatus','lastVerifiedAt','registeredAt','erpReference','warnings']);
  if(!b2bUuid(r.id)||r.companyId!==s.companyId||r.recipientRuc!==s.recipientRuc||r.branchId!==s.branchId||!receivedDate(r.issueDate)||
    typeof r.supplierRuc!=='string'||!/^\d{11}$/.test(r.supplierRuc)||!Number.isSafeInteger(r.itemCount)||r.itemCount<0||r.itemCount>1000||r.sunatStatus!=='NOT_CHECKED'||r.lastVerifiedAt!==null)receivedFail(503,'INVALID_RECEIVED_OWNER_RESPONSE');
  documentType(r.documentType);fullNumber(r.fullNumber);currency(r.currencyCode);decimal(r.payableAmount);
  instant(r.receivedAt);if(r.registeredAt!==null)instant(r.registeredAt);
  nullable(r.supplierName);nullable(r.erpReference);texts(r.warnings,200);return r;
}
export function receivedArtifacts(value:unknown):ReceivedArtifactView[]{
  const rows:any=detached(value,true);if(!Array.isArray(rows)||rows.length>20)invalidOwner();
  for(const r of rows){ownerExact(r,['id','kind','fileName','mediaType','sha256','byteLength','representation','signatureTrust']);
    text(r.fileName,150,true);
    // Legitimate Unicode and punctuation are preserved; paths, HTTP controls,
    // lone surrogates and visually reordered extensions are never accepted.
    if(!b2bUuid(r.id)||!['XML','CDR','PROVIDER_PDF'].includes(r.kind)||/[\\/:\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(r.fileName)||
      !['application/xml','application/zip','application/pdf'].includes(r.mediaType)||
      r.mediaType!==(r.fileName.toLowerCase().endsWith('.pdf')?'application/pdf':r.fileName.toLowerCase().endsWith('.zip')?'application/zip':'application/xml')||
      r.kind==='XML'&&!/\.xml$/i.test(r.fileName)||r.kind==='CDR'&&!/\.(xml|zip)$/i.test(r.fileName)||r.kind==='PROVIDER_PDF'&&!/\.pdf$/i.test(r.fileName)||
      !Number.isSafeInteger(r.byteLength)||r.byteLength<1||r.byteLength>10*1024*1024||typeof r.sha256!=='string'||!/^[a-f0-9]{64}$/.test(r.sha256)||
      r.representation!=='PROVIDER_ORIGINAL'||r.signatureTrust!=='NOT_VERIFIED')receivedFail(503,'INVALID_RECEIVED_OWNER_RESPONSE');
  }if(new Set(rows.map((r:any)=>r.id)).size!==rows.length)receivedFail(503,'INVALID_RECEIVED_OWNER_RESPONSE');return rows;
}
export function receivedDetail(value:unknown,scope:ReceivedScope,id:string):ReceivedDetailView{
  const s=receivedScope(scope),v:any=detached(value,true);ownerExact(v,['schemaVersion','scope','document','projection','artifacts','fiscalAcceptance','source']);sameScope(v.scope,s);
  if(!b2bUuid(id)||v.schemaVersion!=='factuez.b2b.received-detail.v1'||v.fiscalAcceptance!=='NOT_VERIFIED'||v.source!=='RECEIVED_XML')invalidOwner();
  const r=receivedRow(v.document,s),p=receivedProjection(v.projection),artifacts=receivedArtifacts(v.artifacts);
  if(r.id!==id||p.recipient.identityNumber!==s.recipientRuc||p.recipient.identityType!=='6'||p.supplier.identityNumber!==r.supplierRuc||p.documentType!==r.documentType||
    p.supplier.legalName!==r.supplierName||hash(p.warnings)!==hash(r.warnings)||artifacts.filter(a=>a.kind==='XML').length!==1||
    p.fullNumber!==r.fullNumber||p.issueDate!==r.issueDate||p.items.length!==r.itemCount||p.currencyCode!==r.currencyCode||p.totals.payableAmount!==r.payableAmount||
    artifacts.filter(a=>a.kind==='XML'&&a.sha256===p.xmlSha256).length!==1)receivedFail(503,'INVALID_RECEIVED_OWNER_RESPONSE');return {...v,document:r,projection:p,artifacts};
}
export function receivedFile(file:{bytes:Buffer;sha256:string;fileName:string;mediaType:string},artifact:ReceivedArtifactView){
  // Binary envelopes cannot use a JSON copier. Inspect descriptors first and
  // copy with typed-array intrinsics, never getters or caller Buffer methods.
  const fail=():never=>receivedFail(409,'RECEIVED_INTEGRITY_FAILED');
  if(!file||typeof file!=='object'||isProxy(file)||Object.getPrototypeOf(file)!==Object.prototype&&Object.getPrototypeOf(file)!==null)fail();
  const keys=Reflect.ownKeys(file),fields=['bytes','sha256','fileName','mediaType'],d=Object.getOwnPropertyDescriptors(file);
  if(keys.length!==fields.length||fields.some(k=>!d[k]?.enumerable||!Object.hasOwn(d[k],'value')))fail();
  const b=d.bytes.value;if(!b||typeof b!=='object'||isProxy(b)||Object.getPrototypeOf(b)!==Buffer.prototype||!Buffer.isBuffer(b))fail();
  // A forged Buffer prototype has no typed-array internal slot; map it to the
  // same finite integrity failure instead of leaking a native TypeError.
  const byteLength=(()=>{try{return Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength')!.get!.call(b);}
    catch{return fail();}})();
  const a=receivedArtifacts([artifact])[0];
  if(byteLength!==a.byteLength||d.sha256.value!==a.sha256||d.fileName.value!==a.fileName||d.mediaType.value!==a.mediaType)fail();
  const bytes=Buffer.alloc(byteLength);Uint8Array.prototype.set.call(bytes,b as Uint8Array);
  if(createHash('sha256').update(bytes).digest('hex')!==a.sha256)fail();
  return {bytes,sha256:a.sha256,fileName:a.fileName,mediaType:a.mediaType};
}
export function receivedPage(value:unknown,query:ReceivedSelection){
  const q=receivedSelection(query),v:any=detached(value,true);ownerExact(v,['schemaVersion','scope','items','page','fiscalAcceptance','source']);sameScope(v.scope,q.scope);
  ownerExact(v.page,['limit','hasMore','nextAfter','consistency']);
  if(v.schemaVersion!=='factuez.b2b.received-page.v1'||!Array.isArray(v.items)||v.items.length>q.limit||
    v.page.limit!==q.limit||typeof v.page.hasMore!=='boolean'||v.page.consistency!=='LIVE_KEYSET_NOT_SNAPSHOT'||
    v.fiscalAcceptance!=='NOT_VERIFIED'||v.source!=='RECEIVED_XML')receivedFail(503,'INVALID_RECEIVED_OWNER_RESPONSE');
  const items=v.items.map((r:any)=>receivedRow(r,q.scope));
  if(items.some((r:ReceivedDocumentRow,i:number)=>r.issueDate<q.from||r.issueDate>q.to||q.type&&r.documentType!==q.type||q.after&&r.id<=q.after||i>0&&r.id<=items[i-1].id)||
    (v.page.hasMore?(items.length!==q.limit||!b2bUuid(v.page.nextAfter)||v.page.nextAfter!==items.at(-1)?.id):v.page.nextAfter!==null))receivedFail(503,'INVALID_RECEIVED_OWNER_RESPONSE');
  return {...v,items} as {schemaVersion:string;scope:ReceivedScope;items:ReceivedDocumentRow[];page:{limit:number;hasMore:boolean;nextAfter:string|null;consistency:string};fiscalAcceptance:string;source:string};
}
export function receivedManifest(value:unknown,scope:ReceivedScope,id:string){
  const s=receivedScope(scope),v:any=detached(value,true);ownerExact(v,['schemaVersion','scope','documentId','items','fiscalAcceptance']);sameScope(v.scope,s);
  if(!b2bUuid(id)||v.schemaVersion!=='factuez.b2b.received-artifacts.v1'||v.documentId!==id||v.fiscalAcceptance!=='NOT_VERIFIED')receivedFail(503,'INVALID_RECEIVED_OWNER_RESPONSE');
  return {...v,items:receivedArtifacts(v.items)} as {schemaVersion:string;scope:ReceivedScope;documentId:string;items:ReceivedArtifactView[];fiscalAcceptance:string};
}
