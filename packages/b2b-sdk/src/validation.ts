import { B2bSdkError, type B2bCapabilities, type ReceivedScope, type ReceivedSelection, type ReceivedArtifact,
  type ReceivedManifest, type ReceivedRow, type ReceivedProjection, type ReceivedDetail, type ReceivedPage } from './types';
type Obj = Record<string, any>;
export function fail(code: ConstructorParameters<typeof B2bSdkError>[0] = 'INVALID_RESPONSE'): never { throw new B2bSdkError(code); }
export function object(v: unknown): asserts v is Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail();
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v)))
    if (['__proto__','constructor','prototype'].includes(k) || !Object.hasOwn(d, 'value')) fail();
}
export function exact(v: unknown, keys: readonly string[]) { object(v); if (Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) fail(); }
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, max = 8192): v is string => typeof v === 'string' && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(v) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v);
function nullable(v: unknown,max=8192) { if (v !== null && !text(v,max)) fail(); }
function strings(v: unknown,max=1000) { const a=array(v);if(a.length>max)fail();for (const s of a) if (!text(s)) fail(); }
function decimal(v:unknown){if(v!==null&&(typeof v!=='string'||! /^[+-]?\d{1,30}(?:\.\d{1,20})?$/.test(v)))fail();}
function currency(v:unknown){if(v!==null&&(typeof v!=='string'||! /^[A-Z]{3}$/.test(v)))fail();}
function documentType(v:unknown){if(typeof v!=='string'||!['01','03','07','08','09','20','31','40'].includes(v))fail();}
function fullNumber(v:unknown){if(typeof v!=='string'||! /^[A-Za-z0-9]{1,8}-\d{1,12}$/.test(v)||/-0+$/.test(v))fail();}
function instant(v:unknown){if(typeof v!=='string'||! /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(v)||!date(v.slice(0,10))||!Number.isFinite(Date.parse(v))||/[+-]14:(?!00)/.test(v))fail();}
function array(v: unknown): any[] { if (!Array.isArray(v) || v.length > 1000) fail(); return v; }
function fields(v: unknown, keys: string[]) { exact(v, keys); for (const key of keys) nullable((v as Obj)[key]); }
export function date(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
}
export function scope(v: unknown): ReceivedScope {
  exact(v, ['environment','companyId','recipientRuc','branchId']); const s = v as ReceivedScope;
  if (s.environment !== 'BETA' || !Number.isSafeInteger(s.companyId) || s.companyId < 1 || s.companyId > 2147483647 ||
    !/^\d{11}$/.test(s.recipientRuc) || typeof s.recipientRuc !== 'string' || !uuid(s.branchId)) fail();
  return { environment:'BETA', companyId:s.companyId, recipientRuc:s.recipientRuc, branchId:s.branchId };
}
function sameScope(a: unknown, b: ReceivedScope) { const s=scope(a); if (Object.keys(s).some(k => s[k as keyof ReceivedScope] !== b[k as keyof ReceivedScope])) fail(); }
export function selection(v: unknown): Required<Pick<ReceivedSelection,'scope'|'from'|'to'|'limit'>> & ReceivedSelection {
  object(v); if (Object.keys(v).some(k => !['scope','from','to','limit','after','type'].includes(k))) fail();
  const s=scope(v.scope), limit=v.limit ?? 25;
  if (!date(v.from) || !date(v.to) || v.from > v.to || Date.parse(v.to)-Date.parse(v.from)>366*86400000 ||
    !Number.isSafeInteger(limit) || limit<1 || limit>100 || v.after!==undefined&&!uuid(v.after) ||
    v.type!==undefined&&!['01','03','07','08','09','20','31','40'].includes(v.type)) fail();
  return { scope:s, from:v.from, to:v.to, limit, ...(v.after===undefined?{}:{after:v.after}), ...(v.type===undefined?{}:{type:v.type}) };
}
export function artifacts(value: unknown): ReceivedArtifact[] {
  const rows=array(value); if (rows.length>20) fail();
  for (const r of rows) {
    exact(r,['id','kind','fileName','mediaType','sha256','byteLength','representation','signatureTrust']);
    if (!uuid(r.id) || !['XML','CDR','PROVIDER_PDF'].includes(r.kind) || !text(r.fileName,150) || !r.fileName ||
      /[\\/:\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(r.fileName) || !r.fileName.trim() ||
      !['application/xml','application/zip','application/pdf'].includes(r.mediaType) ||
      r.mediaType !== (r.fileName.toLowerCase().endsWith('.pdf')?'application/pdf':r.fileName.toLowerCase().endsWith('.zip')?'application/zip':'application/xml') ||
      r.kind==='XML'&&!/\.xml$/i.test(r.fileName) || r.kind==='CDR'&&!/\.(xml|zip)$/i.test(r.fileName) || r.kind==='PROVIDER_PDF'&&!/\.pdf$/i.test(r.fileName) ||
      !Number.isSafeInteger(r.byteLength) || r.byteLength<1 || r.byteLength>10*1024*1024 || !hash(r.sha256) ||
      r.representation!=='PROVIDER_ORIGINAL' || r.signatureTrust!=='NOT_VERIFIED') fail();
  }
  if (new Set(rows.map(r=>r.id)).size!==rows.length) fail(); return rows as ReceivedArtifact[];
}
export function manifest(v: unknown, s: ReceivedScope, id: string): ReceivedManifest {
  exact(v,['schemaVersion','scope','documentId','items','fiscalAcceptance']); const r=v as Obj; sameScope(r.scope,s);
  if(r.schemaVersion!=='factuez.b2b.received-artifacts.v1'||r.documentId!==id||r.fiscalAcceptance!=='NOT_VERIFIED')fail();
  artifacts(r.items); return r as ReceivedManifest;
}
function row(v: unknown,s:ReceivedScope):ReceivedRow {
  exact(v,['id','companyId','recipientRuc','branchId','supplierRuc','supplierName','documentType','fullNumber','issueDate','currencyCode','payableAmount','receivedAt','itemCount','sunatStatus','lastVerifiedAt','registeredAt','erpReference','warnings']);const r=v as Obj;
  if(!uuid(r.id)||r.companyId!==s.companyId||r.recipientRuc!==s.recipientRuc||r.branchId!==s.branchId||!date(r.issueDate)||
    typeof r.supplierRuc!=='string'||!/^\d{11}$/.test(r.supplierRuc)||!Number.isSafeInteger(r.itemCount)||r.itemCount<0||r.itemCount>1000||
    r.sunatStatus!=='NOT_CHECKED'||r.lastVerifiedAt!==null)fail();
  documentType(r.documentType);fullNumber(r.fullNumber);currency(r.currencyCode);decimal(r.payableAmount);instant(r.receivedAt);
  if(r.registeredAt!==null)instant(r.registeredAt);nullable(r.supplierName);nullable(r.erpReference);
  strings(r.warnings,200);return r as ReceivedRow;
}
export function projection(v: unknown):ReceivedProjection {
  exact(v,['schemaVersion','documentType','fullNumber','series','number','issueDate','issueTime','dueDate','currencyCode','supplier','recipient','items','totals','taxes','paymentTerms','references','notes','warnings','xmlSha256','signature']);const p=v as Obj;
  if(p.schemaVersion!=='factuez.received-document.v1'||!date(p.issueDate)||!hash(p.xmlSha256))fail();
  documentType(p.documentType);fullNumber(p.fullNumber);
  if(typeof p.series!=='string'||typeof p.number!=='string'||p.fullNumber!==`${p.series}-${p.number}`||
    p.issueTime!==null&&(typeof p.issueTime!=='string'||! /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)?$/.test(p.issueTime))||p.dueDate!==null&&!date(p.dueDate))fail();
  currency(p.currencyCode);
  for(const k of ['supplier','recipient']){const party=p[k];exact(party,['identityNumber','identityType','legalName','address']);
    for(const key of ['identityNumber','identityType','legalName'])nullable(party[key]);nullable(party.address,81958);
    if(party.identityType==='6'&&party.identityNumber!==null&&! /^\d{11}$/.test(party.identityNumber))fail();}
  const tax=(t:any)=>{exact(t,['schemeId','name','amount','taxableAmount','percent','affectationCode']);for(const k of ['schemeId','name','affectationCode'])nullable(t[k]);for(const k of ['amount','taxableAmount','percent'])decimal(t[k]);};
  array(p.taxes).forEach(tax);
  const totals=['lineExtensionAmount','taxExclusiveAmount','taxInclusiveAmount','allowanceTotalAmount','chargeTotalAmount','prepaidAmount','payableAmount'];exact(p.totals,totals);for(const k of totals)decimal(p.totals[k]);
  const lineIds=new Set<string>();
  for(const i of array(p.items)){
    exact(i,['lineId','supplierCode','sunatCode','description','unitCode','quantity','unitValue','unitPrice','lineExtensionAmount','allowances','taxes']);
    if(!text(i.lineId,4096)||!i.lineId.trim()||lineIds.has(i.lineId)||!text(i.description,81939))fail();lineIds.add(i.lineId);
    for(const k of ['supplierCode','sunatCode','unitCode'])nullable(i[k]);for(const k of ['quantity','unitValue','unitPrice','lineExtensionAmount'])decimal(i[k]);
    const allowances=array(i.allowances);if(allowances.length>100)fail();for(const a of allowances){exact(a,['charge','amount','reason']);if(typeof a.charge!=='boolean')fail();decimal(a.amount);nullable(a.reason);}
    array(i.taxes).forEach(tax);
  }
  const terms=array(p.paymentTerms);if(terms.length>100)fail();for(const t of terms){exact(t,['id','means','amount','dueDate']);nullable(t.id);nullable(t.means);decimal(t.amount);if(t.dueDate!==null&&!date(t.dueDate))fail();}
  for(const r of array(p.references)){fields(r,['kind','number','documentType']);if(!text(r.kind)||!r.kind.trim())fail();}
  strings(p.notes,100);strings(p.warnings,200);exact(p.signature,['status','officialTrust']);
  if(!['MISSING','PRESENT_UNVERIFIED'].includes(p.signature.status)||p.signature.officialTrust!==false)fail();return p as ReceivedProjection;
}
export function detail(v:unknown,s:ReceivedScope,id:string):ReceivedDetail {
  exact(v,['schemaVersion','scope','document','projection','artifacts','fiscalAcceptance','source']);const r=v as Obj;sameScope(r.scope,s);
  if(r.schemaVersion!=='factuez.b2b.received-detail.v1'||r.fiscalAcceptance!=='NOT_VERIFIED'||r.source!=='RECEIVED_XML')fail();
  const d=row(r.document,s),p=projection(r.projection),a=artifacts(r.artifacts);
  if(d.id!==id||p.recipient.identityNumber!==s.recipientRuc||p.recipient.identityType!=='6'||p.supplier.identityNumber!==d.supplierRuc||
    p.documentType!==d.documentType||p.fullNumber!==d.fullNumber||p.issueDate!==d.issueDate||p.items.length!==d.itemCount||
    p.currencyCode!==d.currencyCode||p.totals.payableAmount!==d.payableAmount||p.supplier.legalName!==d.supplierName||
    JSON.stringify(p.warnings)!==JSON.stringify(d.warnings)||a.filter(x=>x.kind==='XML').length!==1||a.filter(x=>x.kind==='XML'&&x.sha256===p.xmlSha256).length!==1)fail();return r as ReceivedDetail;
}
export function page(v:unknown,q:ReturnType<typeof selection>):ReceivedPage {
  exact(v,['schemaVersion','scope','items','page','fiscalAcceptance','source']);const r=v as Obj;sameScope(r.scope,q.scope);
  exact(r.page,['limit','hasMore','nextAfter','consistency']);
  if(r.schemaVersion!=='factuez.b2b.received-page.v1'||r.fiscalAcceptance!=='NOT_VERIFIED'||r.source!=='RECEIVED_XML'||
    r.page.limit!==q.limit||typeof r.page.hasMore!=='boolean'||r.page.consistency!=='LIVE_KEYSET_NOT_SNAPSHOT')fail();
  const items=array(r.items).map(i=>row(i,q.scope));
  if(items.length>q.limit||items.some((d,i)=>d.issueDate<q.from||d.issueDate>q.to||q.type&&d.documentType!==q.type||q.after&&d.id<=q.after||i>0&&d.id<=items[i-1].id)||
    (r.page.hasMore?(items.length!==q.limit||r.page.nextAfter!==items.at(-1)?.id):r.page.nextAfter!==null))fail();return r as ReceivedPage;
}
export function capabilities(v:unknown):B2bCapabilities {
  object(v);const keys=['schemaVersion','environment','fiscalActivation','executionReadiness','features','coverage','originalArtifacts','localRepresentations','limits','legacyExtraction'];
  exact(v,[...keys,...(Object.hasOwn(v,'receivedCoverage')?['receivedCoverage']:[])]);
  if(v.schemaVersion!=='factuez.b2b.v1'||v.environment!=='BETA'||v.fiscalActivation!==false||v.executionReadiness!=='NOT_PROBED')fail();
  const features=array(v.features);for(const f of features){exact(f,['id','state','reason']);if(!text(f.id,100)||!f.id||!text(f.reason)||!['ENABLED','DISABLED','NOT_IMPLEMENTED'].includes(f.state))fail();}
  if(new Set(features.map(f=>f.id)).size!==features.length)fail();
  for(const c of array(v.coverage)){exact(c,['type','state']);if(!text(c.type,10)||!['SUPPORTED','SOURCE_NOT_SUPPORTED'].includes(c.state))fail();}
  strings(v.originalArtifacts);strings(v.localRepresentations);exact(v.limits,['pageSize','cutRows','cutTtlSeconds','dateRangeDays']);
  for(const n of Object.values(v.limits))if(!Number.isSafeInteger(n)||Number(n)<1||Number(n)>1000000)fail();
  exact(v.legacyExtraction,['separateAudience','forwarded']);if(v.legacyExtraction.separateAudience!==true||v.legacyExtraction.forwarded!==false)fail();
  if(v.receivedCoverage!==undefined){exact(v.receivedCoverage,['source','unassigned','sireOnlyFindings','officialTrust']);const c=v.receivedCoverage;
    if(c.source!=='RECEIVED_XML_ONLY'||c.unassigned!==false||c.sireOnlyFindings!==false||c.officialTrust!==false)fail();}
  return v as B2bCapabilities;
}
