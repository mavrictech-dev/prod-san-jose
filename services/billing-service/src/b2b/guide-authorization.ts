import {B2bSecurityError,b2bBindingsContain,validB2bPrincipal,type B2bIdentityScope} from '@factuez/contracts/b2b-security';
import {validB2bGuideBinding,b2bGuideBindingKey,type B2bGuideBinding} from '@factuez/contracts/b2b-guide-security';
import type {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {supplementActor,type SupplementActor} from '../application/supplement-actor';
import type {ContextIdentity} from './context';
export type GuideAccess='READ'|'WRITE'|'OPERATION';
export interface GuideAuthorization{current(token:string,kind:'SERVICE'|'USER',binding:B2bGuideBinding,action:GuideAccess):Promise<{actor:SupplementActor;grantRevision:number;clientRevision:number}>}
/** Paired explicit grant; guide access never follows from an invoice grant alone. */
export class BillingB2bGuideAuthorization implements GuideAuthorization{
  constructor(private readonly identity:ContextIdentity,private readonly owner:Pick<B2bPrivateHttp,'post'>){}
  async current(token:string,kind:'SERVICE'|'USER',binding:B2bGuideBinding,action:GuideAccess){
    if(!validB2bGuideBinding(binding)||!['READ','WRITE','OPERATION'].includes(action)||!['SERVICE','USER'].includes(kind))throw new B2bSecurityError(400,'INVALID_GUIDE_BINDING');
    binding=boundedSupplementJson(binding) as B2bGuideBinding;
    const required:B2bIdentityScope[]=['b2b:documents:read',action==='WRITE'?'b2b:guides:write':'b2b:guides:read',...(action==='OPERATION'?['b2b:guide-operations:read' as const]:[])];
    const principal=await this.identity.authenticate(token,required,kind);
    if(!validB2bPrincipal(principal)||principal.kind!==kind||required.some(s=>!principal.scopes.includes(s))||!b2bBindingsContain(principal.bindings,binding.anchor))throw new B2bSecurityError(401,'INVALID_PRINCIPAL');
    try{
      const r=boundedSupplementJson(await this.owner.post('/internal/b2b/authorize-guide',{binding,kind,action},token)) as any;
      if(!r||Object.keys(r).sort().join(',')!=='action,actor,binding,candidateOnly,clientRevision,fiscalExecutionEnabled,grantRevision,schemaVersion,transmissionAuthorized'||r.schemaVersion!=='factuez.b2b.guide-authorization.v1'||r.action!==action||r.candidateOnly!==true||r.fiscalExecutionEnabled!==false||r.transmissionAuthorized!==false||r.clientRevision!==principal.revision||!Number.isSafeInteger(r.grantRevision)||r.grantRevision<1||!validB2bGuideBinding(r.binding)||b2bGuideBindingKey(r.binding)!==b2bGuideBindingKey(binding))throw new Error();
      const actor=supplementActor(r.actor),p=actor.b2b,s=actor.scope;
      if(!p||p.kind!==kind||p.clientId!==principal.clientId||p.revision!==principal.revision||p.subjectId!==principal.subjectId||p.userAuthRevision!==principal.userAuthRevision||s.kind!=='ASSIGNED'||s.branchIds.length!==1||s.branchIds[0]!==binding.anchor.branchId||s.emissionPointIds.length!==1||s.emissionPointIds[0]!==binding.anchor.pointId||s.series.length!==2||new Set(s.series).size!==2||![binding.anchor.seriesId,binding.guideSeriesId].every(id=>s.series.includes(id)))throw new Error();
      return{actor,grantRevision:r.grantRevision as number,clientRevision:principal.revision};
    }catch{throw new B2bSecurityError(503,'INVALID_GUIDE_AUTHORITY_RESPONSE');}
  }
}
