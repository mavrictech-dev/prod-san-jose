import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {validB2bGuideBinding,b2bGuideBindingKey,type B2bGuideBinding} from '@factuez/contracts/b2b-guide-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import {prepareGuide09,GuidePreparationError} from '@factuez/sunat-core/dist/fiscal-guide-preparation';
import type {PrismaService} from '../infrastructure/prisma.service';
import type {B2bGuides} from './guide-drafts';
import type {GuideEstablishmentGuard} from './guide-establishments';
import type {GuideGoodsGuard} from './guide-goods-types';
import {GUIDE_PREPARATION_GATES} from '@factuez/service-access/dist/b2b-guide-preparation-wire';

export {GUIDE_PREPARATION_GATES};
type Issuer={ruc:string;legalName:string;metadataSha256:string};
export interface GuidePreparationIssuer{current(binding:B2bGuideBinding):Promise<Issuer|null>}
/** Read only, no credentials, no cross-owner DB and no implicit establishment map.
 * The current Branch schema has no fiscal ubigeo/establishment binding: this
 * preparer deliberately cannot claim that declared addresses are verified. */
export class PrismaGuidePreparationIssuer implements GuidePreparationIssuer{
  constructor(private readonly db:PrismaService){}
  async current(binding:B2bGuideBinding){
    if(!validB2bGuideBinding(binding))return null;
    const c=await this.db.companySettings.findFirst({where:{id:binding.anchor.issuerId,ruc:binding.anchor.issuerRuc,environment:'BETA',active:true},
      select:{id:true,ruc:true,legalName:true,environment:true,configVersion:true}});
    if(!c)return null;return{ruc:c.ruc,legalName:c.legalName,metadataSha256:fiscalSnapshotSha256(c)};
  }
}
/** Preflight only. It does not consume numbers, write fiscal snapshots, generate
 * an Outbox, sign XML or call SUNAT. A READY draft remains READY after this call. */
export class BillingGuidePreparation{
  constructor(private readonly guides:Pick<B2bGuides,'read'>,private readonly issuer:GuidePreparationIssuer,private readonly establishments?:GuideEstablishmentGuard,private readonly goods?:GuideGoodsGuard){}
  async prepare(token:string,kind:'SERVICE'|'USER',bindingInput:unknown,id:string,ifMatch:string){
    let binding:B2bGuideBinding;
    try{binding=boundedSupplementJson(bindingInput) as B2bGuideBinding;}catch{throw new B2bSecurityError(400,'INVALID_GUIDE_BINDING');}
    if(!validB2bGuideBinding(binding)||!b2bUuid(id)||!['SERVICE','USER'].includes(kind))throw new B2bSecurityError(400,'INVALID_GUIDE_PREPARATION');
    if(typeof ifMatch!=='string'||!/^"v[1-9][0-9]{0,8}"$/.test(ifMatch))throw new B2bSecurityError(428,'PRECONDITION_REQUIRED');
    const source=await this.guides.read(token,kind,binding,id);
    if(source.id!==id||!validB2bGuideBinding(source.binding)||b2bGuideBindingKey(source.binding)!==b2bGuideBindingKey(binding)||
      source.schemaVersion!=='factuez.b2b.guide-draft.v1'||source.candidateOnly!==true||source.fiscalExecutionEnabled!==false||source.transmissionAuthorized!==false||source.authorizedForTransfer!==false||source.referenceVerification!=='NOT_VERIFIED')throw new B2bSecurityError(503,'INVALID_GUIDE_SOURCE');
    if(source.revision!==ifMatch)throw new B2bSecurityError(412,'REVISION_CONFLICT');
    if(source.state!=='READY')throw new B2bSecurityError(409,'READY_GUIDE_REQUIRED');
    // Reauthorize and establish ownership before revealing profile availability.
    if(binding.guideType!=='09')throw new B2bSecurityError(409,'GUIDE_PREPARATION_PROFILE_NOT_ENABLED');
    const issuer=await this.issuer.current(binding);
    if(!issuer||issuer.ruc!==binding.anchor.issuerRuc||!/^[a-f0-9]{64}$/.test(issuer.metadataSha256))throw new B2bSecurityError(404,'GUIDE_ISSUER_NOT_FOUND');
    let plan;
    try{plan=prepareGuide09({schemaVersion:'factuez.guide09-preparation-input.v1',draftId:id,draftRevision:source.revision,
      draftBodySha256:source.bodySha256,issuer:{ruc:issuer.ruc,legalName:issuer.legalName},body:source.body});}
    catch(e){throw new B2bSecurityError(409,e instanceof GuidePreparationError?e.code:'INVALID_GUIDE_PREPARATION');}
    // Optional STRICT local guard. No registry is invented or auto-populated.
    // This does not remove an official gate or promote the plan to fiscal proof.
    const local=await this.establishments?.assertLocalMapping(binding,source.body);
    if(this.establishments&&(!local||typeof local.fresh!=='function'))throw new B2bSecurityError(503,'INVALID_ESTABLISHMENT_GUARD');
    const goods=await this.goods?.assertLocalGoods(binding,source.body);
    if(this.goods&&(!goods||typeof goods.fresh!=='function'))throw new B2bSecurityError(503,'INVALID_GUIDE_GOODS_GUARD');
    const checkedIssuer=await this.issuer.current(binding),checkedSource=await this.guides.read(token,kind,binding,id);
    if(!checkedIssuer||fiscalSnapshotSha256(checkedIssuer)!==fiscalSnapshotSha256(issuer)||fiscalSnapshotSha256(checkedSource)!==fiscalSnapshotSha256(source))throw new B2bSecurityError(409,'GUIDE_PREPARATION_SOURCE_CHANGED');
    await local?.fresh();
    await goods?.fresh();
    return{schemaVersion:'factuez.b2b.guide-preparation.v1',binding,plan,gates:[...GUIDE_PREPARATION_GATES],
      candidateOnly:true as const,fiscalExecutionEnabled:false as const,transmissionAuthorized:false as const,authorizedForTransfer:false as const};
  }
}
