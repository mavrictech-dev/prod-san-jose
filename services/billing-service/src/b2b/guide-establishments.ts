import {randomUUID,createHash} from 'node:crypto';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {validB2bGuideBinding,type B2bGuideBinding} from '@factuez/contracts/b2b-guide-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalRuc,fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import type {GuideBody} from './guide-model';

export type EstablishmentEntry={branchId:string;branchRevision:number;establishmentCode:string;ubigeo:string;address:string};
export type EstablishmentCompany={id:number;ruc:string;environment:'BETA';configVersion:number;active:boolean};
export type EstablishmentBranch={id:string;companyId:number;masterRevision:number;active:boolean};
export type EstablishmentSnapshot={schemaVersion:'factuez.guide-establishments.v1';companyId:number;issuerRuc:string;issuerRevision:number;
  revision:number;entries:EstablishmentEntry[];actorId:string;authRevision:number;at:string;source:'ADMIN_LOCAL_CONFIGURATION';sha256:string};
export type EstablishmentAudit={id:string;requestId:string;peerSha256:string;companyId:number;revision:number;actorId:string;action:'READ'|'REPLACE';at:string};
export interface EstablishmentTransaction{
  company(id:number):Promise<EstablishmentCompany|null>;
  branches(companyId:number,ids:string[]):Promise<EstablishmentBranch[]>;
  head(companyId:number):Promise<EstablishmentSnapshot|null>;
  save(snapshot:EstablishmentSnapshot,expectedRevision:number):Promise<void>;
  audit(value:EstablishmentAudit):Promise<void>;
}
export interface EstablishmentStore{
  transaction<T>(companyId:number,work:(tx:EstablishmentTransaction)=>Promise<T>):Promise<T>;
  rate(keySha256:string,window:number,limit:number):Promise<boolean>;
}
export type EstablishmentAdministrator={id:string;authRevision:number;stepUpVerified:true;scope:'GLOBAL';permissions:string[]};
/** Implemented by an authenticated owner-specific verifier, NEVER parsed from
 * the caller's JSON or inferred from a SERVICE token's requested scopes. */
export interface EstablishmentAdminAuthority{verify(token:string):Promise<EstablishmentAdministrator>}
export type EstablishmentContext={requestId:string;peer:string};
export interface GuideEstablishmentGuard{assertLocalMapping(binding:B2bGuideBinding,body:GuideBody):Promise<{fresh():Promise<void>}>}
const flags={candidateOnly:true as const,officialValidation:false as const,fiscalExecutionEnabled:false as const,transmissionAuthorized:false as const};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function fail(status:number,code:string):never{throw new B2bSecurityError(status,code);}
function safe(value:unknown):any{try{const copy=boundedSupplementJson(value);if(Buffer.byteLength(JSON.stringify(copy))>128*1024)throw new Error();return copy;}catch{return fail(400,'INVALID_ESTABLISHMENT_REQUEST');}}
function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))fail(400,'INVALID_ESTABLISHMENT_REQUEST');}
const integer=(v:unknown,min=1)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=2147483647;
function entries(value:unknown):EstablishmentEntry[]{
  if(!Array.isArray(value)||value.length>200)fail(400,'INVALID_ESTABLISHMENT_REQUEST');
  const branches=new Set<string>(),codes=new Set<string>();
  return value.map(v=>{
    exact(v,['branchId','branchRevision','establishmentCode','ubigeo','address']);
    if(!b2bUuid(v.branchId)||!integer(v.branchRevision)||typeof v.establishmentCode!=='string'||!/^\d{4}$/.test(v.establishmentCode)||
      typeof v.ubigeo!=='string'||!/^\d{6}$/.test(v.ubigeo)||typeof v.address!=='string'||!v.address||v.address!==v.address.trim()||v.address.length>300||/[\x00-\x1f\x7f-\x9f\ud800-\udfff\ufffe\uffff]/u.test(v.address)||branches.has(v.branchId)||codes.has(v.establishmentCode))fail(400,'INVALID_ESTABLISHMENT_REQUEST');
    branches.add(v.branchId);codes.add(v.establishmentCode);return v as EstablishmentEntry;
  }).sort((a,b)=>a.branchId<b.branchId?-1:a.branchId>b.branchId?1:0);
}
function snapshot(value:unknown,companyId:number):EstablishmentSnapshot{
  try{
    const p=safe(value);exact(p,['schemaVersion','companyId','issuerRuc','issuerRevision','revision','entries','actorId','authRevision','at','source','sha256']);
    if(p.schemaVersion!=='factuez.guide-establishments.v1'||p.source!=='ADMIN_LOCAL_CONFIGURATION'||p.companyId!==companyId||!integer(p.issuerRevision)||!integer(p.revision)||!integer(p.authRevision,0)||!b2bUuid(p.actorId)||typeof p.at!=='string'||!Number.isFinite(Date.parse(p.at))||new Date(p.at).toISOString()!==p.at||typeof p.sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.sha256))throw new Error();
    fiscalRuc(p.issuerRuc,'issuerRuc');const canonical=entries(p.entries);
    if(JSON.stringify(canonical)!==JSON.stringify(p.entries))throw new Error();
    const {sha256,...unsigned}=p;if(fiscalSnapshotSha256(unsigned)!==sha256)throw new Error();return p;
  }catch{return fail(409,'ESTABLISHMENT_REGISTRY_INCONSISTENT');}
}

/** Local configuration registry, NOT proof of SUNAT registration, accounting
 * approval, guide emission, a cutover or authority to change a fiscal counter. */
export class GuideEstablishments implements GuideEstablishmentGuard{
  constructor(private readonly store:EstablishmentStore,private readonly admin:EstablishmentAdminAuthority,private readonly now=()=>new Date().toISOString()){}
  private async administrator(token:string){
    if(typeof token!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(token))fail(401,'INVALID_TOKEN');
    let a:EstablishmentAdministrator;try{a=safe(await this.admin.verify(token));}catch(e){if(e instanceof B2bSecurityError)throw e;return fail(503,'ADMIN_AUTHORITY_UNAVAILABLE');}
    if(!a||Object.keys(a).sort().join(',')!=='authRevision,id,permissions,scope,stepUpVerified'||!b2bUuid(a.id)||!integer(a.authRevision,0)||a.stepUpVerified!==true||a.scope!=='GLOBAL'||!Array.isArray(a.permissions)||a.permissions.length>100||new Set(a.permissions).size!==a.permissions.length||a.permissions.some(p=>typeof p!=='string'||p.length>80)||!['setup.manage','series.manage'].every(p=>a.permissions.includes(p)))fail(403,'ESTABLISHMENT_ADMIN_REQUIRED');return a;
  }
  private async boundary(token:string){const a=await this.administrator(token);return{actor:a,fresh:async()=>{if(fiscalSnapshotSha256(await this.administrator(token))!==fiscalSnapshotSha256(a))fail(409,'ESTABLISHMENT_AUTHORITY_CHANGED');}};}
  private async quota(ctx:EstablishmentContext,action:'READ'|'REPLACE'){
    if(!ctx||!b2bUuid(ctx.requestId)||typeof ctx.peer!=='string'||!ctx.peer||ctx.peer.length>256)fail(400,'INVALID_ESTABLISHMENT_REQUEST');
    if(!await this.store.rate(sha('guide-establishments:'+action+':'+ctx.peer),Math.floor(Date.parse(this.now())/60000),action==='READ'?300:30))fail(429,'RATE_LIMITED');
  }
  private async company(tx:EstablishmentTransaction,id:number){
    const c=await tx.company(id);if(!c||c.id!==id||c.environment!=='BETA'||c.active!==true||!integer(c.configVersion))fail(404,'ESTABLISHMENT_ISSUER_NOT_FOUND');
    try{fiscalRuc(c.ruc,'issuerRuc');}catch{fail(409,'ESTABLISHMENT_ISSUER_INCONSISTENT');}return c;
  }
  private async validateBranches(tx:EstablishmentTransaction,c:EstablishmentCompany,list:EstablishmentEntry[]){
    const rows=await tx.branches(c.id,list.map(e=>e.branchId));
    if(rows.length!==list.length||new Set(rows.map(r=>r.id)).size!==rows.length||list.some(e=>!rows.some(r=>r.id===e.branchId&&r.companyId===c.id&&r.active===true&&r.masterRevision===e.branchRevision)))fail(409,'ESTABLISHMENT_BRANCH_REVISION_CONFLICT');
  }
  private async current(tx:EstablishmentTransaction,c:EstablishmentCompany){
    const raw=await tx.head(c.id);if(raw===null)return null;const p=snapshot(raw,c.id);
    if(p.issuerRuc!==c.ruc||p.issuerRevision!==c.configVersion)fail(409,'ESTABLISHMENT_REGISTRY_STALE');return p;
  }
  async read(token:string,companyId:number,ctx:EstablishmentContext){
    if(!integer(companyId))fail(400,'INVALID_ESTABLISHMENT_REQUEST');await this.quota(ctx,'READ');const a=await this.boundary(token);
    return this.store.transaction(companyId,async tx=>{await a.fresh();const c=await this.company(tx,companyId),raw=await tx.head(companyId),p=raw===null?null:snapshot(raw,companyId);
      const rows=p?await tx.branches(companyId,p.entries.map(e=>e.branchId)):[];
      const stale=!!p&&(p.issuerRuc!==c.ruc||p.issuerRevision!==c.configVersion||rows.length!==p.entries.length||p.entries.some(e=>!rows.some(r=>r.id===e.branchId&&r.companyId===companyId&&r.active&&r.masterRevision===e.branchRevision)));
      await tx.audit({id:randomUUID(),requestId:ctx.requestId,peerSha256:sha(ctx.peer),companyId,revision:p?.revision??0,actorId:a.actor.id,action:'READ',at:this.now()});await a.fresh();
      return{schemaVersion:'factuez.guide-establishment-registry.v1',companyId,issuerRuc:c.ruc,issuerRevision:c.configVersion,revision:p?.revision??0,snapshot:p,stale,...flags};});
  }
  async replace(token:string,companyId:number,input:unknown,ctx:EstablishmentContext){
    if(!integer(companyId))fail(400,'INVALID_ESTABLISHMENT_REQUEST');await this.quota(ctx,'REPLACE');const a=await this.boundary(token),v=safe(input);
    exact(v,['expectedRevision','expectedIssuerRevision','entries']);
    if(!integer(v.expectedRevision,0)||v.expectedRevision>=2147483647||!integer(v.expectedIssuerRevision))fail(400,'INVALID_ESTABLISHMENT_REQUEST');const list=entries(v.entries);
    return this.store.transaction(companyId,async tx=>{await a.fresh();const c=await this.company(tx,companyId);
      if(c.configVersion!==v.expectedIssuerRevision)fail(409,'ESTABLISHMENT_ISSUER_REVISION_CONFLICT');
      // A stale map can be deliberately replaced only with the exact current head
      // revision and explicit new issuer/branch revisions. Never repair silently.
      const raw=await tx.head(companyId),prior=raw===null?null:snapshot(raw,companyId);
      if((prior?.revision??0)!==v.expectedRevision)fail(409,'ESTABLISHMENT_REVISION_CONFLICT');await this.validateBranches(tx,c,list);
      const unsigned={schemaVersion:'factuez.guide-establishments.v1' as const,companyId,issuerRuc:c.ruc,issuerRevision:c.configVersion,revision:v.expectedRevision+1,
        entries:list,actorId:a.actor.id,authRevision:a.actor.authRevision,at:this.now(),source:'ADMIN_LOCAL_CONFIGURATION' as const};
      const p=snapshot({...unsigned,sha256:fiscalSnapshotSha256(unsigned)},companyId);
      await tx.save(p,v.expectedRevision);await tx.audit({id:randomUUID(),requestId:ctx.requestId,peerSha256:sha(ctx.peer),companyId,revision:p.revision,actorId:a.actor.id,action:'REPLACE',at:p.at});
      await a.fresh();return{schemaVersion:'factuez.guide-establishment-registry.v1',companyId,issuerRuc:c.ruc,issuerRevision:c.configVersion,revision:p.revision,snapshot:p,...flags};});
  }
  private async match(binding:B2bGuideBinding,body:GuideBody){
    return this.store.transaction(binding.anchor.issuerId,async tx=>{
      const c=await this.company(tx,binding.anchor.issuerId);if(c.ruc!==binding.anchor.issuerRuc)fail(404,'ESTABLISHMENT_ISSUER_NOT_FOUND');
      if(body.sender?.ruc!==c.ruc||body.recipient?.ruc!==c.ruc)fail(409,'ESTABLISHMENT_MAPPING_MISMATCH');
      const p=await this.current(tx,c);if(!p)fail(409,'ESTABLISHMENT_REGISTRY_REQUIRED');await this.validateBranches(tx,c,p.entries);
      const matches=(a:GuideBody['origin'])=>p.entries.filter(e=>e.establishmentCode===a.establishmentCode&&e.ubigeo===a.ubigeo&&e.address===a.address);
      const o=matches(body.origin),d=matches(body.destination);
      if(o.length!==1||d.length!==1||o[0].branchId!==binding.anchor.branchId||o[0].branchId===d[0].branchId)fail(409,'ESTABLISHMENT_MAPPING_MISMATCH');
      return fiscalSnapshotSha256({company:c,registry:p,origin:o[0],destination:d[0]});});
  }
  /** Internal guard only; no public route accepts a claimed match/proof. Billing
   * MUST authenticate/read the guide before calling this port. Returns no map. */
  async assertLocalMapping(bindingInput:B2bGuideBinding,bodyInput:GuideBody){
    const binding=safe(bindingInput),body=safe(bodyInput);
    if(!validB2bGuideBinding(binding)||binding.guideType!=='09'||!body?.origin||!body?.destination)fail(400,'INVALID_ESTABLISHMENT_REQUEST');
    const stamp=await this.match(binding,body);return{fresh:async()=>{if(await this.match(binding,body)!==stamp)fail(409,'ESTABLISHMENT_MAPPING_CHANGED');}};
  }
}
