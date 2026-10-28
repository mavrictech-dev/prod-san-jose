import {createHash,randomUUID} from 'node:crypto';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {validB2bGuideBinding,type B2bGuideBinding} from '@factuez/contracts/b2b-guide-security';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalRuc,fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import {validateGuideReferenceCatalogue,assertGuideReferenceCodes,type GuideReferenceCatalogue} from '@factuez/sunat-core/dist/fiscal-guide-catalogues';
import type {EstablishmentAdministrator,EstablishmentCompany} from './guide-establishments';
import type {GuideBody} from './guide-model';
import type {GuideGoodsAuthority,GuideGoodsContext,GuideGoodsEntry,GuideGoodsGuard,GuideGoodsProduct,GuideGoodsSnapshot,GuideGoodsStore,GuideGoodsTransaction} from './guide-goods-types';

const flags={candidateOnly:true as const,officialValidation:false as const,fiscalExecutionEnabled:false as const,transmissionAuthorized:false as const};
const integer=(v:unknown,min=1):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=2147483647;
const matches=(v:unknown,re:RegExp):v is string=>typeof v==='string'&&re.exec(v)?.[0]===v;
const hash=(v:unknown):v is string=>matches(v,/^[a-f0-9]{64}$/);
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&b2bUuid(v);
function fail(status:number,code:string):never{throw new B2bSecurityError(status,code);}
function safe(v:unknown):any{try{const copy=boundedSupplementJson(v);if(Buffer.byteLength(JSON.stringify(copy))>128*1024)throw new Error();return copy;}catch{return fail(400,'INVALID_GUIDE_GOODS_REQUEST');}}
function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))fail(400,'INVALID_GUIDE_GOODS_REQUEST');}
function text(v:unknown,max:number):v is string{return typeof v==='string'&&!!v&&v===v.trim()&&v.length<=max&&!/[\x00-\x1f\x7f-\x9f\ud800-\udfff\ufffe\uffff]/u.test(v);}
function timestamp(v:unknown):v is string{return typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;}
/** No price/tax data, guessed issuer ownership or classification from names. A
 * master edit, including category/SUNAT code, explicitly invalidates the policy. */
export function guideGoodsProductSha256(value:unknown):string{
  try{
    const p=safe(value);exact(p,['id','sku','description','category','unitCode','sunatProductCode','active','updatedAt']);
    if(!uuid(p.id)||!text(p.sku,40)||!text(p.description,250)||!text(p.category,80)||!matches(p.unitCode,/^[A-Z0-9]{2,3}$/)||
      p.sunatProductCode!==null&&!text(p.sunatProductCode,20)||typeof p.active!=='boolean'||!timestamp(p.updatedAt))throw new Error();
    return fiscalSnapshotSha256(p);
  }catch{return fail(409,'GUIDE_GOODS_PRODUCT_INCONSISTENT');}
}
function entries(v:unknown):GuideGoodsEntry[]{
  if(!Array.isArray(v)||v.length>200)fail(400,'INVALID_GUIDE_GOODS_REQUEST');
  const ids=new Set<string>();return v.map(e=>{
    exact(e,['productId','productSha256','classification','rationale']);
    if(!uuid(e.productId)||!hash(e.productSha256)||!['NON_REGULATED','REGULATED','UNKNOWN'].includes(e.classification)||!text(e.rationale,500)||ids.has(e.productId))fail(400,'INVALID_GUIDE_GOODS_REQUEST');
    ids.add(e.productId);return e as GuideGoodsEntry;
  }).sort((a,b)=>a.productId<b.productId?-1:a.productId>b.productId?1:0);
}
function snapshot(v:unknown,companyId:number):GuideGoodsSnapshot{
  try{
    const p=safe(v);exact(p,['schemaVersion','companyId','issuerRuc','issuerRevision','revision','catalogue','entries','actorId','authRevision','at','source','sha256']);
    if(p.schemaVersion!=='factuez.guide-goods-policy.v1'||p.companyId!==companyId||!integer(companyId)||!integer(p.issuerRevision)||!integer(p.revision)||!integer(p.authRevision,0)||
      !uuid(p.actorId)||!timestamp(p.at)||p.source!=='ADMIN_LOCAL_CONFIGURATION'||!hash(p.sha256))throw new Error();
    fiscalRuc(p.issuerRuc,'issuerRuc');validateGuideReferenceCatalogue(p.catalogue);
    if(fiscalSnapshotSha256(entries(p.entries))!==fiscalSnapshotSha256(p.entries))throw new Error();
    const {sha256,...unsigned}=p;if(fiscalSnapshotSha256(unsigned)!==sha256)throw new Error();return p;
  }catch{return fail(409,'GUIDE_GOODS_POLICY_INCONSISTENT');}
}

/** Privileged LOCAL configuration only. A classification is an attributable
 * declaration, not an IQBF licence or official legal classification. Neither
 * reference hashes nor this policy authorize signing, transfer or transmission. */
export class GuideGoods implements GuideGoodsGuard{
  constructor(private readonly store:GuideGoodsStore,private readonly authority:GuideGoodsAuthority,private readonly now=()=>new Date().toISOString()){}
  private async admin(token:string){
    if(!matches(token,/^[A-Za-z0-9._~-]{1,8192}$/))fail(401,'INVALID_TOKEN');
    let a:EstablishmentAdministrator;
    try{a=safe(await this.authority.verify(token));}catch(e){if(e instanceof B2bSecurityError)throw e;return fail(503,'ADMIN_AUTHORITY_UNAVAILABLE');}
    exact(a,['id','authRevision','stepUpVerified','scope','permissions']);
    if(!uuid(a.id)||!integer(a.authRevision,0)||a.stepUpVerified!==true||a.scope!=='GLOBAL'||!Array.isArray(a.permissions)||a.permissions.length>100||
      new Set(a.permissions).size!==a.permissions.length||a.permissions.some(p=>!text(p,80))||!['setup.manage','series.manage'].every(p=>a.permissions.includes(p)))fail(403,'GUIDE_GOODS_ADMIN_REQUIRED');return a;
  }
  private async boundary(token:string){const a=await this.admin(token);return{actor:a,fresh:async()=>{if(fiscalSnapshotSha256(await this.admin(token))!==fiscalSnapshotSha256(a))fail(409,'GUIDE_GOODS_AUTHORITY_CHANGED');}};}
  private async quota(ctx:GuideGoodsContext,action:'READ'|'REPLACE'){
    if(!ctx||!uuid(ctx.requestId)||!text(ctx.peer,256))fail(400,'INVALID_GUIDE_GOODS_REQUEST');
    const at=this.now();if(!timestamp(at))fail(503,'GUIDE_GOODS_CLOCK_INVALID');
    const key=createHash('sha256').update('guide-goods:'+action+':'+ctx.peer).digest('hex');
    if(!await this.store.rate(key,Math.floor(Date.parse(at)/60000),action==='READ'?300:30))fail(429,'RATE_LIMITED');
  }
  private async company(tx:GuideGoodsTransaction,id:number):Promise<EstablishmentCompany>{
    const c=await tx.company(id);if(!c||c.id!==id||c.active!==true||c.environment!=='BETA'||!integer(c.configVersion))fail(404,'GUIDE_GOODS_ISSUER_NOT_FOUND');
    try{fiscalRuc(c.ruc,'issuerRuc');}catch{fail(409,'GUIDE_GOODS_ISSUER_INCONSISTENT');}return c;
  }
  private async products(tx:GuideGoodsTransaction,list:GuideGoodsEntry[],requireCurrent:boolean){
    const rows:GuideGoodsProduct[]=safe(await tx.products(list.map(e=>e.productId)));
    if(!Array.isArray(rows)||rows.length>200||rows.some(r=>!r||typeof r!=='object'||Array.isArray(r))||new Set(rows.map(r=>r.id)).size!==rows.length||rows.some(r=>!list.some(e=>e.productId===r.id)))fail(409,'GUIDE_GOODS_PRODUCT_INCONSISTENT');
    rows.forEach(guideGoodsProductSha256);rows.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    const stale=rows.length!==list.length||list.some(e=>{const p=rows.find(r=>r.id===e.productId);return !p||guideGoodsProductSha256(p)!==e.productSha256||!p.active;});
    if(requireCurrent&&stale)fail(409,'GUIDE_GOODS_PRODUCT_CHANGED');return{rows,stale};
  }
  async read(token:string,companyId:number,ctx:GuideGoodsContext){
    if(!integer(companyId))fail(400,'INVALID_GUIDE_GOODS_REQUEST');await this.quota(ctx,'READ');const a=await this.boundary(token);
    return this.store.transaction(companyId,async tx=>{
      await a.fresh();const c=await this.company(tx,companyId),raw=await tx.head(companyId),p=raw===null?null:snapshot(raw,companyId);
      const stale=!!p&&(p.issuerRuc!==c.ruc||p.issuerRevision!==c.configVersion||(await this.products(tx,p.entries,false)).stale);
      await tx.audit({id:randomUUID(),requestId:ctx.requestId,peerSha256:createHash('sha256').update(ctx.peer).digest('hex'),companyId,revision:p?.revision??0,actorId:a.actor.id,action:'READ',at:this.now()});
      await a.fresh();return{schemaVersion:'factuez.guide-goods-registry.v1',companyId,issuerRuc:c.ruc,issuerRevision:c.configVersion,revision:p?.revision??0,snapshot:p,stale,...flags};
    });
  }
  async replace(token:string,companyId:number,input:unknown,ctx:GuideGoodsContext){
    if(!integer(companyId))fail(400,'INVALID_GUIDE_GOODS_REQUEST');await this.quota(ctx,'REPLACE');const a=await this.boundary(token),v=safe(input);
    exact(v,['expectedRevision','expectedIssuerRevision','catalogue','entries']);
    if(!integer(v.expectedRevision,0)||v.expectedRevision===2147483647||!integer(v.expectedIssuerRevision))fail(400,'INVALID_GUIDE_GOODS_REQUEST');
    let catalogue:GuideReferenceCatalogue;try{catalogue=validateGuideReferenceCatalogue(v.catalogue);}catch{fail(400,'INVALID_GUIDE_REFERENCE_CATALOGUE');}
    const list=entries(v.entries);
    return this.store.transaction(companyId,async tx=>{
      await a.fresh();const c=await this.company(tx,companyId);
      if(c.configVersion!==v.expectedIssuerRevision)fail(409,'GUIDE_GOODS_ISSUER_REVISION_CONFLICT');
      const raw=await tx.head(companyId),p=raw===null?null:snapshot(raw,companyId);
      if((p?.revision??0)!==v.expectedRevision)fail(409,'GUIDE_GOODS_REVISION_CONFLICT');
      if(p&&p.catalogue.version===catalogue.version&&p.catalogue.sha256!==catalogue.sha256)fail(409,'GUIDE_GOODS_CATALOGUE_VERSION_CONFLICT');
      const {rows}=await this.products(tx,list,true);
      if(rows.some(r=>!catalogue.units.includes(r.unitCode)))fail(409,'GUIDE_REFERENCE_CODE_NOT_ENABLED');
      const unsigned={schemaVersion:'factuez.guide-goods-policy.v1' as const,companyId,issuerRuc:c.ruc,issuerRevision:c.configVersion,revision:v.expectedRevision+1,catalogue,
        entries:list,actorId:a.actor.id,authRevision:a.actor.authRevision,at:this.now(),source:'ADMIN_LOCAL_CONFIGURATION' as const};
      const next=snapshot({...unsigned,sha256:fiscalSnapshotSha256(unsigned)},companyId);
      await tx.save(next,v.expectedRevision);await tx.audit({id:randomUUID(),requestId:ctx.requestId,peerSha256:createHash('sha256').update(ctx.peer).digest('hex'),companyId,revision:next.revision,actorId:a.actor.id,action:'REPLACE',at:next.at});
      await a.fresh();return{schemaVersion:'factuez.guide-goods-registry.v1',companyId,issuerRuc:c.ruc,issuerRevision:c.configVersion,revision:next.revision,snapshot:next,...flags};
    });
  }
  private async match(binding:B2bGuideBinding,body:GuideBody){
    return this.store.transaction(binding.anchor.issuerId,async tx=>{
      const c=await this.company(tx,binding.anchor.issuerId);
      if(c.ruc!==binding.anchor.issuerRuc||body.sender?.ruc!==c.ruc||body.recipient?.ruc!==c.ruc)fail(409,'GUIDE_GOODS_ISSUER_MISMATCH');
      if(body.reasonCode!=='04'||body.transport?.mode!=='02'||body.regulatedGoods!==false||!Array.isArray(body.references)||body.references.length)fail(409,'GUIDE_GOODS_PROFILE_NOT_ENABLED');
      const raw=await tx.head(c.id);if(raw===null)fail(409,'GUIDE_GOODS_POLICY_REQUIRED');const p=snapshot(raw,c.id);
      if(p.issuerRuc!==c.ruc||p.issuerRevision!==c.configVersion)fail(409,'GUIDE_GOODS_POLICY_STALE');
      try{assertGuideReferenceCodes(p.catalogue,body);}catch{fail(409,'GUIDE_REFERENCE_CODE_NOT_ENABLED');}
      const {rows}=await this.products(tx,p.entries,true),seen=new Set<string>();
      for(const item of body.items){
        if(!text(item.code,40)||seen.has(item.code))fail(409,'GUIDE_GOODS_ITEM_MISMATCH');seen.add(item.code);
        const candidates=rows.filter(r=>r.sku===item.code),product=candidates[0];
        if(candidates.length!==1||product.description!==item.description||product.unitCode!==item.unitCode)fail(409,'GUIDE_GOODS_ITEM_MISMATCH');
        if(p.entries.find(e=>e.productId===product.id)?.classification!=='NON_REGULATED')fail(409,'GUIDE_GOODS_CLASSIFICATION_NOT_ENABLED');
      }
      return fiscalSnapshotSha256({company:c,policy:p,products:rows});
    });
  }
  /** Billing must authorize the draft first. This internal closure is not a
   * serializable approval/proof accepted from a caller or future fiscal producer. */
  async assertLocalGoods(bindingInput:B2bGuideBinding,bodyInput:GuideBody){
    const binding=safe(bindingInput),body=safe(bodyInput);
    if(!validB2bGuideBinding(binding)||binding.guideType!=='09'||![binding.guideSeriesId,binding.anchor.branchId,binding.anchor.pointId,binding.anchor.seriesId].every(uuid)||!body||typeof body!=='object'||Array.isArray(body))fail(400,'INVALID_GUIDE_GOODS_REQUEST');
    const stamp=await this.match(binding,body);return{fresh:async()=>{if(await this.match(binding,body)!==stamp)fail(409,'GUIDE_GOODS_POLICY_CHANGED');}};
  }
}
