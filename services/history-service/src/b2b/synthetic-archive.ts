import { randomBytes,timingSafeEqual,createHash } from 'node:crypto';
import { b2bBindingKey,b2bBindingsContain,validB2bBinding,type B2bPrincipal,type B2bBinding } from '@factuez/contracts/b2b-security';
import { historicalSha256,HISTORY_ARTIFACT_KINDS } from '@factuez/history-core';
import { HistoricalArchiveService } from '../service';
import { HistoryArchiveRepository } from '../repository';
import { HistoryArtifactStore } from '../artifact-store';
import { historyActor } from '../access';
import { denyHistory } from './reader';
import type { B2bHistoryAction,B2bHistoryArchivePermissionPort,B2bHistoryArchivePort,B2bHistoryInputMap } from './types';
const policy={schemaVersion:'factuez.b2b.history.v1',environment:'BETA',datasetClass:'SYNTHETIC',candidateOnly:true,readOnly:true,
  fiscalAuthority:false,cdrAuthenticityVerified:false} as const;
/** Real HistoricalArchiveService composition under the original repository/storage guards. */
export class SyntheticB2bHistoryArchive implements B2bHistoryArchivePort {
  constructor(private readonly repository:HistoryArchiveRepository,private readonly artifacts:HistoryArtifactStore,
    private readonly permissions:B2bHistoryArchivePermissionPort|null) {
    if(!(repository instanceof HistoryArchiveRepository)||!(artifacts instanceof HistoryArtifactStore)) denyHistory(503,'HISTORY_REAL_ARCHIVE_REQUIRED');
  }
  async execute<A extends B2bHistoryAction>(action:A,input:B2bHistoryInputMap[A],livePrincipal:()=>Promise<B2bPrincipal>):Promise<unknown> {
    const raw=structuredClone(input),binding=raw.binding;
    if(!validB2bBinding(binding)||!/^00000000[0-9]{3}$/.test(binding.issuerRuc)) denyHistory(422,'HISTORY_SYNTHETIC_PROFILE_REQUIRED');
    if(!this.permissions) denyHistory(503,'HISTORY_ARCHIVE_PERMISSION_PORT_REQUIRED');
    const capability=randomBytes(32).toString('hex');let enrollmentStamp:string|null=null,principalStamp:string|null=null;
    const authorize=async()=>{
      const p=await livePrincipal(),ps=historicalSha256(p);
      if(principalStamp!==null&&ps!==principalStamp) denyHistory(401,'ACCESS_CHANGED');principalStamp=ps;
      if(!b2bBindingsContain(p.bindings,binding)||!p.scopes.includes('b2b:history:read')||action==='CONTENT'&&!p.scopes.includes('b2b:artifacts:read')) denyHistory(403,'HISTORY_ARCHIVE_PERMISSION_DENIED');
      const decision=await this.permissions!.authorizeCurrent({principal:structuredClone(p),binding:structuredClone(binding)});
      if(!decision||decision.environment!=='BETA'||decision.datasetClass!=='SYNTHETIC'||decision.permission!=='history.view'||
        !validB2bBinding(decision.binding)||b2bBindingKey(decision.binding)!==b2bBindingKey(binding)||
        typeof decision.enrollmentId!=='string'||!decision.enrollmentId||decision.enrollmentId.length>200||
        typeof decision.revision!=='string'||!decision.revision||decision.revision.length>200) denyHistory(403,'HISTORY_ARCHIVE_NOT_ENROLLED');
      const actor=historyActor(decision.actor,'history.view'),s=actor.scope;
      if(actor.permissions.length!==1||actor.permissions[0]!=='history.view'||s.kind!=='ASSIGNED'||
        s.branchIds.length!==1||s.branchIds[0]!==binding.branchId||s.emissionPointIds.length!==1||s.emissionPointIds[0]!==binding.pointId||
        s.seriesCounterIds.length!==1||s.seriesCounterIds[0]!==binding.seriesId||p.kind==='USER'&&actor.userId!==p.subjectId) denyHistory(403,'HISTORY_ARCHIVE_SCOPE_DENIED');
      const stamp=historicalSha256(decision);if(enrollmentStamp!==null&&stamp!==enrollmentStamp) denyHistory(401,'HISTORY_ARCHIVE_ACCESS_CHANGED');enrollmentStamp=stamp;
      return actor;
    };
    const service=new HistoricalArchiveService({authorize:async(credential,permission)=>{
      if(permission!=='history.view'||typeof credential!=='string'||credential.length!==capability.length||
        !timingSafeEqual(Buffer.from(credential),Buffer.from(capability))) denyHistory(401,'HISTORY_ARCHIVE_CAPABILITY_INVALID');
      return authorize();
    }},this.repository,this.artifacts);
    const checked=async(recordId:string)=>{
      const detail=await service.detail(recordId,capability),m=detail.snapshot.ownership;
      const found:B2bBinding={issuerId:m.companyId,issuerRuc:m.issuerRuc,environment:'BETA',branchId:m.branchId,pointId:m.emissionPointId,
        seriesId:m.seriesCounterId,documentType:m.documentTypeCode as '01'|'03'};
      if(b2bBindingKey(found)!==b2bBindingKey(binding)) denyHistory(404,'RESOURCE_NOT_FOUND');
      return detail;
    };
    await authorize();
    if(action==='LIST') {
      const q=raw as B2bHistoryInputMap['LIST'],take=q.take??25;
      const items=await service.list({issuerRuc:binding.issuerRuc,branchId:binding.branchId,documentTypeCode:binding.documentType,series:null,
        take,afterRecordId:q.afterRecordId??null},capability);
      if(items.length>take) denyHistory(409,'HISTORY_ARCHIVE_INTEGRITY');
      for(const item of items) await checked(item.recordId);
      await authorize();return {...policy,data:{items,nextCursor:items.length===take?items.at(-1)?.recordId??null:null}};
    }
    const q=raw as B2bHistoryInputMap['DETAIL'|'CONTENT'],detail=await checked(q.recordId);
    if(action==='DETAIL') {
      const {artifactKeys:_privateKeys,...data}=detail;await authorize();return {...policy,data};
    }
    const kind=(raw as B2bHistoryInputMap['CONTENT']).artifactKind;
    if(!HISTORY_ARTIFACT_KINDS.includes(kind)) denyHistory(400,'INVALID_QUERY');
    const file=await service.artifact(q.recordId,kind,capability);await checked(q.recordId);await authorize();
    if(file.bytes.length!==file.sizeBytes||createHash('sha256').update(file.bytes).digest('hex')!==file.sha256) denyHistory(409,'HISTORY_ARCHIVE_INTEGRITY');
    return {bytes:Buffer.from(file.bytes),sha256:file.sha256,sizeBytes:file.sizeBytes,
      mediaType:kind.endsWith('_XML')?'application/xml':kind.startsWith('PDF_')?'application/pdf':'application/zip',fileName:file.originalName};
  }
}