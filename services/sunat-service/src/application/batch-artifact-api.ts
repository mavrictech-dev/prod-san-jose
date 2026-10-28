import {createHash} from 'node:crypto';
import {B2bSecurityError,b2bBindingsContain} from '@factuez/contracts/b2b-security';
import {B2bOwnerReadFrame} from '@factuez/service-access/dist/b2b-read-adapter';
import type {B2bIdentityHttp,B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {batchArtifactScope,batchArtifactView,batchArtifactFile,BATCH_ARTIFACT_KINDS,
  type BatchArtifactScope,type BatchArtifactKind} from '@factuez/service-access/dist/b2b-batch-artifact-wire';
import {boundedSupplementJson,validateFiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256 as hash} from '@factuez/sunat-core/dist/fiscal-note';
import {parseCdrZip} from '../infrastructure/sunat/cdr-parser';
import {BatchLocalArtifactPipeline,type BatchLocalArtifactOwner,type BatchLocalArtifactAccess,type BatchLocalArtifactAction} from './batch-local-artifacts';

/** Fixed private RPC; loads the actual immutable command by ID from Billing.
 * Full-member authorization remains Billing-owned; no public snapshot or state
 * flag is admitted here. Two fresh remote observations are not a distributed lock. */
export class PrivateBatchArtifactOwner implements BatchLocalArtifactOwner{
  constructor(private readonly identity:Pick<B2bIdentityHttp,'authenticate'>,private readonly billing:Pick<B2bPrivateHttp,'post'>){}
  async current(input:BatchArtifactScope,access:BatchLocalArtifactAccess,permission:BatchLocalArtifactAction){
    const scope=batchArtifactScope(input),frame=new B2bOwnerReadFrame(this.identity,access.kind);
    const required=permission==='WRITE'?['b2b:batches:write'] as const:['b2b:batches:read','b2b:artifacts:read'] as const;
    const before=await frame.principal(access.token,[...required]);
    if(!before.bindings.some(b=>b.issuerId===scope.companyId&&b.issuerRuc===scope.issuerRuc&&b.environment===scope.environment&&b.branchId===scope.branchId))
      throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    const v:any=boundedSupplementJson(await this.billing.post('/internal/b2b/batch-operations',{action:'ARTIFACT_OWNER',kind:access.kind,scope,permission},access.token));
    const command=validateFiscalSupplementCommand(v?.command),p=command.payload,e=p.envelope;
    if(!v||Object.keys(v).sort().join(',')!==['schemaVersion','permission','subject','command','requestSha256','authorizationSha256','checkedAt',
      'operationId','identifier','kind','scope','state','memberCount','commandSha256','candidateOnly','localOnly','fiscalExecutionEnabled','transmissionAuthorized','officialAcceptance'].sort().join(',')||
      v.schemaVersion!=='factuez.b2b.batch-artifact-owner.v1'||v.permission!==permission||e.kind!=='BATCH'||
      v.operationId!==scope.batchId||p.operationId!==scope.batchId||p.companyId!==scope.companyId||p.issuerRuc!==scope.issuerRuc||p.branchId!==scope.branchId||p.environment!=='BETA'||
      hash(v.scope)!==hash({environment:scope.environment,issuerRuc:scope.issuerRuc,companyId:scope.companyId,branchId:scope.branchId})||
      hash(v.subject)!==hash({kind:before.kind,clientId:before.clientId,subjectId:before.subjectId})||v.commandSha256!==hash(command)||
      typeof v.authorizationSha256!=='string'||!/^[a-f0-9]{64}$/.test(v.authorizationSha256)||v.candidateOnly!==true||v.localOnly!==true||v.transmissionAuthorized!==false||
      v.fiscalExecutionEnabled!==false||v.officialAcceptance!==false)throw new B2bSecurityError(503,'INVALID_BATCH_OWNER_RESPONSE');
    const after=await frame.principal(access.token,[...required]);
    if(!after.bindings.some(b=>b2bBindingsContain(before.bindings,b))||!after.bindings.some(b=>b.issuerId===scope.companyId&&b.issuerRuc===scope.issuerRuc&&b.environment===scope.environment&&b.branchId===scope.branchId))
      throw new B2bSecurityError(409,'BATCH_AUTHORITY_CHANGED');
    return {command,authorizationSha256:v.authorizationSha256 as string};
  }
}
export class BatchArtifactApi{
  constructor(private readonly pipeline:BatchLocalArtifactPipeline){}
  async view(scope:BatchArtifactScope,access:BatchLocalArtifactAccess,prepare=false){
    const result=await (prepare?this.pipeline.prepare(scope,access):this.pipeline.read(scope,access));
    return batchArtifactView({schemaVersion:'factuez.b2b.batch-artifacts.v1',scope,metadata:result.record.metadata,replayed:prepare?result.replayed:null},scope,prepare);
  }
  async content(scope:BatchArtifactScope,access:BatchLocalArtifactAccess,kind:BatchArtifactKind){
    if(!BATCH_ARTIFACT_KINDS.includes(kind))throw new B2bSecurityError(400,'INVALID_BATCH_ARTIFACT_REQUEST');
    const result=await this.pipeline.read(scope,access),view=batchArtifactView({schemaVersion:'factuez.b2b.batch-artifacts.v1',scope,metadata:result.record.metadata,replayed:null},scope,false);
    let bytes:Buffer;
    if(kind==='xml')bytes=Buffer.from(result.record.signedXml);else if(kind==='zip')bytes=Buffer.from(result.record.zip);
    else{const cdr=await this.pipeline.readCdr(scope,access);bytes=kind==='cdr-zip'?Buffer.from(cdr.zip):parseCdrZip(cdr.zip,
      {fileName:'R-'+view.metadata.fileName.replace(/\.zip$/,'.xml'),issuerRuc:scope.issuerRuc,reference:view.metadata.identifier}).xml;}
    const fileName=(kind.startsWith('cdr')?'R-':'')+view.metadata.fileName.replace(/\.zip$/,kind.endsWith('xml')?'.xml':'.zip');
    return batchArtifactFile({bytes,sha256:createHash('sha256').update(bytes).digest('hex'),fileName,
      mediaType:kind.endsWith('xml')?'application/xml':'application/zip'},view,kind);
  }
}
