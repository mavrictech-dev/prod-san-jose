/** Explicit owner-side compatibility adapter. Not a token exchange or legacy guard bypass. */
import { B2bSecurityError,validB2bPrincipal,type B2bPrincipal,type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import type { IntegrationScope } from '@factuez/contracts/integration';
import type { ReadIdentity,ReadPrincipal } from './integration';
import { snapshotHash } from './integration';
export interface B2bIdentityPort { authenticate(token:string,scopes:B2bIdentityScope[],kind:'SERVICE'|'USER'):Promise<B2bPrincipal> }
const scopeMap:Partial<Record<IntegrationScope,B2bIdentityScope>>={
  'integration:catalog:read':'b2b:catalog:read','integration:documents:read':'b2b:documents:read','integration:artifacts:read':'b2b:artifacts:read',
  'integration:exports:create':'b2b:exports:create','integration:exports:read':'b2b:exports:read','integration:changes:read':'b2b:changes:read',
};
/** New instance per request: identity stamp cannot bleed between concurrent callers. */
export class B2bOwnerReadFrame implements ReadIdentity {
  private stamp:string|null=null;
  constructor(private readonly identity:B2bIdentityPort,readonly kind:'SERVICE'|'USER'){}
  async principal(token:string,required:B2bIdentityScope[]):Promise<B2bPrincipal>{
    const p=await this.identity.authenticate(token,required,this.kind);
    if(!validB2bPrincipal(p)||p.kind!==this.kind||required.some(scope=>!p.scopes.includes(scope)))throw new B2bSecurityError(401,'INVALID_PRINCIPAL');
    const stamp=snapshotHash(p);if(this.stamp!==null&&stamp!==this.stamp)throw new B2bSecurityError(401,'ACCESS_CHANGED');
    this.stamp=stamp;return p;
  }
  async authenticate(token:string,required:IntegrationScope[]):Promise<ReadPrincipal>{
    const mapped=required.map(scope=>{const translated=scopeMap[scope];if(!translated)throw new B2bSecurityError(403,'READ_ADAPTER_SCOPE_NOT_SUPPORTED');return translated;});
    const p=await this.principal(token,[...new Set(mapped)]);
    const selected=(Object.entries(scopeMap) as [IntegrationScope,B2bIdentityScope][]).filter(([,scope])=>p.scopes.includes(scope)).map(([scope])=>scope);
    if(p.bindings.length>100)throw new B2bSecurityError(422,'NARROW_CLIENT_BINDINGS');
    // Persistent engine records belong to a B2B actor+auth revision, never another
    // person sharing its OIDC client or an unrelated legacy extraction account.
    const hex=snapshotHash({audience:'factuez-b2b-v1',clientId:p.clientId,revision:p.revision,kind:p.kind,subjectId:p.subjectId,userAuthRevision:p.userAuthRevision}).slice(0,32).split('');
    hex[12]='5';hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);const h=hex.join('');
    const clientId=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    return {clientId,revision:p.revision,environment:'BETA',scopes:selected,
      grants:p.bindings.map(binding=>({issuerRuc:binding.issuerRuc,environment:'BETA',documentTypes:[binding.documentType],
        branches:{kind:'IDS',ids:[binding.branchId]},points:{kind:'IDS',ids:[binding.pointId]},series:{kind:'IDS',ids:[binding.seriesId]}}))};
  }
}
