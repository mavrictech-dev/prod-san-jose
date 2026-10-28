import { B2bSecurityError,b2bBindingsContain,b2bCorrectionBindingKey,validB2bCorrectionBinding,validB2bPrincipal,type B2bCorrectionBinding } from '@factuez/contracts/b2b-security';
import type { B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
import { supplementActor } from '../application/supplement-actor';
import type { ContextIdentity } from './context';
/** Fresh private authority port, not a fiscal command endpoint. No cached permission receipts. */
export class BillingB2bCorrectionAuthorization {
  constructor(private readonly identity:ContextIdentity,private readonly authority:Pick<B2bPrivateHttp,'post'>) {}
  async current(token:string,kind:'SERVICE'|'USER',binding:B2bCorrectionBinding) {
    if (!validB2bCorrectionBinding(binding)||!['SERVICE','USER'].includes(kind)) throw new B2bSecurityError(400,'INVALID_CORRECTION_BINDINGS');
    binding=structuredClone(binding);
    const required=['b2b:documents:read','b2b:documents:issue','b2b:corrections:write'] as const;
    const principal=await this.identity.authenticate(token,[...required],kind);
    if (!validB2bPrincipal(principal)||principal.kind!==kind||required.some(s=>!principal.scopes.includes(s))||!b2bBindingsContain(principal.bindings,binding.reference)) throw new B2bSecurityError(401,'INVALID_PRINCIPAL');
    const response:any=await this.authority.post('/internal/b2b/authorize-correction',{binding:structuredClone(binding),kind},token);
    try {
      if (!response||typeof response!=='object'||Array.isArray(response)||
        Object.keys(response).sort().join(',')!=='actor,binding,candidateOnly,clientRevision,fiscalExecutionEnabled,grantRevision,schemaVersion,transmissionAuthorized'||
        response.schemaVersion!=='factuez.b2b.correction-authorization.v1'||response.candidateOnly!==true||response.fiscalExecutionEnabled!==false||response.transmissionAuthorized!==false||
        response.clientRevision!==principal.revision||!Number.isSafeInteger(response.grantRevision)||response.grantRevision<1||
        !validB2bCorrectionBinding(response.binding)||b2bCorrectionBindingKey(response.binding)!==b2bCorrectionBindingKey(binding)) throw new Error();
      const actor=supplementActor(response.actor),p=actor.b2b,s=actor.scope;
      if (!p||p.kind!==kind||p.clientId!==principal.clientId||p.revision!==principal.revision||p.subjectId!==principal.subjectId||p.userAuthRevision!==principal.userAuthRevision||
        s.kind!=='ASSIGNED'||s.branchIds.length!==1||s.branchIds[0]!==binding.reference.branchId||s.emissionPointIds.length!==1||s.emissionPointIds[0]!==binding.reference.pointId||
        s.series.length!==2||new Set(s.series).size!==2||![binding.reference.seriesId,binding.noteSeriesId].every(id=>s.series.includes(id))) throw new Error();
      return {actor,grantRevision:response.grantRevision as number,clientRevision:principal.revision,candidateOnly:true as const,fiscalExecutionEnabled:false as const};
    } catch { throw new B2bSecurityError(503,'INVALID_CORRECTION_AUTHORITY_RESPONSE'); }
  }
}
