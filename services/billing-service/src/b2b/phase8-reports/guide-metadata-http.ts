import { B2bSecurityError,b2bBindingsContain,type B2bPrincipal } from '@factuez/contracts/b2b-security';
import { B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
import { B2bOwnerReadFrame,type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { guideArtifactWireScope,guideArtifactWireView,type GuideArtifactWireScope } from '@factuez/service-access/dist/b2b-guide-artifact-wire';
import { snapshotHash } from '@factuez/service-access/dist/integration';
import type { ReportsAuth } from './types';
import { fail,sha } from './validation';
export interface ReportGuideMetadata {
  source:'SUNAT_PRIVATE_GUIDE_METADATA';scope:GuideArtifactWireScope;
  documentId:string;fullNumber:string;snapshotSha256:string;ownerRevision:number;metadataSha256:string;
}
export type ReportGuideExpected=Pick<ReportGuideMetadata,'documentId'|'fullNumber'|'snapshotSha256'>;
export interface ReportsGuideMetadataReadPort {
  read(auth:ReportsAuth,p:B2bPrincipal,scope:GuideArtifactWireScope,expected:ReportGuideExpected):Promise<ReportGuideMetadata>;
  recheck(auth:ReportsAuth,p:B2bPrincipal,saved:ReportGuideMetadata):Promise<void>;
}
/** Existing private metadata RPC only. No PREPARE/CONTENT, new routes, DB,
 * enumeration, issued date, item quantities, financial amount or acceptance.
 * A metadata-only owner cannot be promoted to a complete report source. */
export class HttpReportsGuideMetadata implements ReportsGuideMetadataReadPort {
  private readonly http:B2bPrivateHttp;
  readonly capabilities=Object.freeze({transport:'HTTP_MTLS',existingRoute:'/internal/b2b/guide-artifacts',
    action:'READ',metadataOnly:true,enumeration:false,reportRows:false,financialAmounts:false,finalFiscalParity:false} as const);
  constructor(origin:string,tls:{ca:Buffer;cert:Buffer;key:Buffer},private readonly identity:B2bIdentityPort){
    if(!tls||![tls.ca,tls.cert,tls.key].every(b=>Buffer.isBuffer(b)&&b.length>0))fail(503,'REPORT_EXPLICIT_MTLS_REQUIRED');
    this.http=new B2bPrivateHttp(origin,{ca:Buffer.from(tls.ca),cert:Buffer.from(tls.cert),key:Buffer.from(tls.key)});
  }
  async read(auth:ReportsAuth,p:B2bPrincipal,input:GuideArtifactWireScope,expected:ReportGuideExpected):Promise<ReportGuideMetadata>{
    const scope=guideArtifactWireScope(input),frame=new B2bOwnerReadFrame(this.identity,auth.kind);
    const required=['b2b:reports:read','b2b:documents:read','b2b:guides:read','b2b:guide-operations:read'] as const;
    const current=async()=>{
      const fresh=await frame.principal(auth.token,[...required]);
      if(snapshotHash(fresh)!==snapshotHash(p))fail(401,'ACCESS_CHANGED');
      if(!b2bBindingsContain(fresh.bindings,scope.binding.draft.anchor))fail(404,'RESOURCE_NOT_FOUND');
    };
    if(!expected||!sha(expected.snapshotSha256))fail(400,'INVALID_REPORT_GUIDE_METADATA_SCOPE');
    await current();
    let response:unknown;
    try{response=await this.http.post('/internal/b2b/guide-artifacts',{kind:auth.kind,scope,action:'READ'},auth.token);}
    catch(e){if(e instanceof B2bSecurityError)throw e;fail(503,'REPORT_GUIDE_METADATA_UNAVAILABLE');}
    const view=guideArtifactWireView(response,scope,false),m=view.metadata;
    // Existing wire validation enforces all closed candidate/trust flags and
    // exact metadata keys. Owner money/acceptance additions fail closed.
    if(m.documentId!==expected.documentId||m.fullNumber!==expected.fullNumber||m.snapshotSha256!==expected.snapshotSha256)
      fail(409,'REPORT_GUIDE_METADATA_SOURCE_MISMATCH');
    await current();
    return {source:'SUNAT_PRIVATE_GUIDE_METADATA',scope:structuredClone(scope),documentId:m.documentId,fullNumber:m.fullNumber,
      snapshotSha256:m.snapshotSha256,ownerRevision:m.ownerRevision,metadataSha256:snapshotHash(m)};
  }
  async recheck(auth:ReportsAuth,p:B2bPrincipal,saved:ReportGuideMetadata){
    const current=await this.read(auth,p,saved.scope,saved);
    if(current.ownerRevision!==saved.ownerRevision||current.metadataSha256!==saved.metadataSha256)fail(409,'REPORT_GUIDE_METADATA_CHANGED');
  }
}

