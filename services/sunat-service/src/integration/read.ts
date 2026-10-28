import { createHash, randomUUID } from 'node:crypto';
import { IntegrationContractVersion, IntegrationLimits, integrationArtifactAllowed, type IntegrationArtifactV1,
  type IntegrationBatchV1, type IntegrationDocumentDetailV1 } from '@factuez/contracts/integration';
import { deny, plain, uuid, requireIssuer, requireScopes, snapshotHash, type ReadIdentity, type ReadPrincipal,
  type BillingReadEnvelope, PrivateReadHttp } from '@factuez/service-access/dist/integration';
export interface StoredArtifact { id:string; kind:string; storageKey:string; mediaType:string; sizeBytes:bigint|number; sha256:string; createdAt:Date }
export interface FiscalReadDocument { documentId:string; issuerRuc:string; environment:string; documentType:string; series:string; number:bigint; immutablePayload:unknown; artifacts:StoredArtifact[] }
export interface FiscalReadBatch {id:string;summaryId:string;issuerRuc:string;environment:string;identifier:string;immutablePayload:unknown;artifacts:StoredArtifact[]}
export interface SunatReadRepository {
  document(ruc:string,id:string):Promise<FiscalReadDocument|null>;
  batch(ruc:string,id:string):Promise<FiscalReadBatch|null>;
  artifact(ruc:string,id:string):Promise<{artifact:StoredArtifact;owner:{kind:'DOCUMENT'|'BATCH';id:string}}|null>;
  sharedCdr(ruc:string,artifact:StoredArtifact,documentId:string):Promise<{artifact:StoredArtifact;batchId:string}[]>;
  audit(event:{id:string;clientId:string;revision:number;issuerRuc:string;artifactId:string;sha256:string;byteLength:number}):Promise<void>;
}
export interface BillingOwner {
  document(token:string,ruc:string,id:string):Promise<BillingReadEnvelope>;
  batch(token:string,ruc:string,id:string):Promise<{identifier:string;items:{documentId:string;conditionCode:string}[]}>;
}
export class RemoteBillingOwner implements BillingOwner {
  constructor(private readonly http:PrivateReadHttp) {}
  document(token:string,ruc:string,id:string) {return this.http.json<BillingReadEnvelope>(`/internal/integration/documents/${id}?issuerRuc=${ruc}`,token);}
  batch(token:string,ruc:string,id:string) {return this.http.json<{identifier:string;items:{documentId:string;conditionCode:string}[]}>(`/internal/integration/batches/${id}?issuerRuc=${ruc}`,token);}
}
const allowedKinds = ['UNSIGNED_XML','SIGNED_XML','SUBMISSION_ZIP','CDR_XML','CDR_ZIP'] as const;
const suffix=(kind:string)=>kind.endsWith('XML')?'xml':'zip';
export class SunatRead {
  constructor(private readonly repository:SunatReadRepository,private readonly identity:ReadIdentity,
    private readonly billing:BillingOwner,private readonly store:{read(id:string,a:StoredArtifact):Promise<Buffer>}) {}
  private async principal(token:string,issuerRuc:string,artifacts=false) {
    const p=await this.identity.authenticate(token,artifacts?['integration:documents:read','integration:artifacts:read']:['integration:documents:read']);
    requireScopes(p,artifacts?['integration:documents:read','integration:artifacts:read']:['integration:documents:read']);
    requireIssuer(p,issuerRuc);return p;
  }
  private async ownDocument(token:string,issuerRuc:string,id:string) {
    if (!uuid(id)) return deny(400,'INVALID_QUERY');
    id=id.toLowerCase();
    const {document}=await this.billing.document(token,issuerRuc,id);
    const row=await this.repository.document(issuerRuc,id);
    if (!row) return deny(409,'ARTIFACT_UNAVAILABLE');
    if (row.documentId!==id || row.issuerRuc!==issuerRuc || row.environment!=='BETA' || row.documentType!==document.type ||
      row.series!==document.series || row.number!==BigInt(document.number) || snapshotHash(row.immutablePayload)!==document.snapshotSha256)
      return deny(409,'EVIDENCE_INCONSISTENT');
    return {row,document};
  }
  private async ownBatch(token:string,issuerRuc:string,id:string) {
    if (!uuid(id)) return deny(400,'INVALID_QUERY');
    id=id.toLowerCase();
    const row=await this.repository.batch(issuerRuc,id);
    if (!row) return deny(404,'RESOURCE_NOT_FOUND');
    const s=row.immutablePayload;
    if (row.id!==id || row.issuerRuc!==issuerRuc || row.environment!=='BETA' || !plain(s) || s.environment!=='BETA' ||
      s.issuer?.identityNumber!==issuerRuc || !/^(RC|RA)-\d{8}-[1-9]\d{0,9}$/.test(row.identifier)) return deny(409,'INCOMPLETE_BINDING');
    const kind=row.identifier.slice(0,2) as 'RC'|'RA';
    // Legacy RC singletons are immutable sale snapshots, not the newer batch envelope.
    const legacy=!s.input;
    if (legacy && (kind!=='RC' || s.documentTypeCode!=='03')) return deny(409,'INCOMPLETE_BINDING');
    if (!legacy && (s.identifier!==row.identifier || s.kind!==kind || s.input?.kind!==kind)) return deny(409,'INCOMPLETE_BINDING');
    const entries=legacy?[{document:{snapshot:s},conditionCode:'1'}]:s.input.entries;
    if (!Array.isArray(entries) || !entries.length || entries.length>IntegrationLimits.maxBatchMembers) return deny(409,'INCOMPLETE_BINDING');
    const binding=await this.billing.batch(token,issuerRuc,row.summaryId);
    if (binding.identifier!==row.identifier || binding.items.length!==entries.length) return deny(409,'INCOMPLETE_BINDING');
    const deadline=Date.now()+20000;
    const resources:IntegrationDocumentDetailV1[]=[], members:IntegrationBatchV1['members']=[];
    for (const entry of entries) {
      if (Date.now()>deadline) return deny(503,'CONSISTENT_READ_UNAVAILABLE');
      const snapshot=entry?.document?.snapshot;
      if (!plain(snapshot) || !uuid(snapshot.documentId) || snapshot.environment!=='BETA' || snapshot.issuer?.identityNumber!==issuerRuc)
        return deny(409,'INCOMPLETE_BINDING');
      const condition=kind==='RC'?entry.conditionCode:null;
      const b=binding.items.find(i=>i.documentId===snapshot.documentId);
      if (!b || (kind==='RC' && (!['1','2','3'].includes(condition) || b.conditionCode!==condition))) return deny(409,'INCOMPLETE_BINDING');
      const {document}=await this.billing.document(token,issuerRuc,snapshot.documentId);
      if (document.snapshotSha256!==snapshotHash(snapshot) || snapshot.documentTypeCode!==document.type || snapshot.fullNumber!==document.fullNumber)
        return deny(409,'EVIDENCE_INCONSISTENT');
      const baseType=['07','08'].includes(document.type) && document.detail.kind==='SALE'?document.detail.references[0]?.type:document.type;
      if (baseType!==(kind==='RC'?'03':'01')) return deny(409,'INCOMPLETE_BINDING');
      resources.push(document);members.push({documentId:document.id,type:document.type,fullNumber:document.fullNumber,
        conditionCode:condition,documentVersion:document.resourceVersion});
    }
    if (new Set(members.map(m=>m.documentId)).size!==members.length || new Set(binding.items.map(m=>m.documentId)).size!==members.length)
      return deny(409,'INCOMPLETE_BINDING');
    const batch:IntegrationBatchV1={schemaVersion:IntegrationContractVersion,id,issuerRuc,environment:'BETA',kind,identifier:row.identifier,
      state:{local:null,fiscal:'NOT_CHECKED',transport:null,provenance:'LOCAL',verifiedAt:null,responseCode:null},membersComplete:true,members};
    return {row,batch,resources};
  }
  async batch(token:string,issuerRuc:string,id:string) {await this.principal(token,issuerRuc);return (await this.ownBatch(token,issuerRuc,id)).batch;}
  private metadata(a:StoredArtifact,owner:{kind:'DOCUMENT'|'BATCH';id:string},name:string):IntegrationArtifactV1 {
    if (!uuid(a.id) || !allowedKinds.includes(a.kind as any)) return deny(422,'SOURCE_NOT_SUPPORTED');
    const ext=suffix(a.kind), mediaType=ext==='xml'?'application/xml':'application/zip';
    const length=Number(a.sizeBytes);
    if (a.mediaType!==mediaType || !Number.isSafeInteger(length) || length<1 || length>10*1024*1024 || !/^[a-f0-9]{64}$/.test(a.sha256))
      return deny(409,'EVIDENCE_INCONSISTENT');
    return {id:a.id,kind:a.kind as IntegrationArtifactV1['kind'],owner,fileName:name+'.'+ext,mediaType,byteLength:length,sha256:a.sha256,
      availability:'AVAILABLE',representation:'ORIGINAL',provenance:'LOCAL',
      verification:{integrity:'UNVERIFIED',signature:'UNVERIFIED',trust:'UNVERIFIED',identity:'UNVERIFIED',checkedAt:null},
      rendererVersion:null,profileRevision:null,generatedAt:a.createdAt.toISOString()};
  }
  private async resolve(token:string,issuerRuc:string,a:StoredArtifact,owner:{kind:'DOCUMENT'|'BATCH';id:string},p:ReadPrincipal):Promise<{artifact:StoredArtifact;metadata:IntegrationArtifactV1;storageOwner:string}> {
    if (!allowedKinds.includes(a.kind as any)) return deny(422,'SOURCE_NOT_SUPPORTED');
    if (owner.kind==='DOCUMENT') {
      const {document,row}=await this.ownDocument(token,issuerRuc,owner.id);
      if (!row.artifacts.some(i=>i.id===a.id && i.sha256===a.sha256 && i.storageKey===a.storageKey)) return deny(409,'INCOMPLETE_BINDING');
      if (a.kind.startsWith('CDR_')) {
        const shared=await this.repository.sharedCdr(issuerRuc,a,owner.id);
        if (shared.length>1) return deny(409,'INCOMPLETE_BINDING');
        if (shared.length===1) return this.resolve(token,issuerRuc,shared[0].artifact,{kind:'BATCH',id:shared[0].batchId},p);
        if (document.type==='03' || (['07','08'].includes(document.type) && document.detail.kind==='SALE' && document.detail.references.some(r=>r.type==='03')))
          return deny(409,'INCOMPLETE_BINDING');
      }
      if (!integrationArtifactAllowed(p.scopes,p.grants,{issuerRuc,environment:'BETA',dataset:'ISSUED_BUSINESS',kind:a.kind as any,
        owner:{kind:'DOCUMENT',resource:document}})) return deny(404,'RESOURCE_NOT_FOUND');
      return {artifact:a,metadata:this.metadata(a,owner,`${issuerRuc}-${document.type}-${document.series}-${document.number}-${a.kind}`),storageOwner:owner.id};
    }
    const {batch,row,resources}=await this.ownBatch(token,issuerRuc,owner.id);
    if (!row.artifacts.some(i=>i.id===a.id && i.sha256===a.sha256 && i.storageKey===a.storageKey)) return deny(409,'INCOMPLETE_BINDING');
    if (!integrationArtifactAllowed(p.scopes,p.grants,{issuerRuc,environment:'BETA',dataset:'ISSUED_BUSINESS',kind:a.kind as any,
      owner:{kind:'BATCH',membersComplete:true,expectedMembers:resources.length,members:resources.map(d=>({...d,documentId:d.id}))}}))
      return deny(404,'RESOURCE_NOT_FOUND');
    return {artifact:a,metadata:this.metadata(a,owner,`${issuerRuc}-${batch.identifier}-${a.kind}`),storageOwner:owner.id};
  }
  async artifacts(token:string,issuerRuc:string,id:string,kind:'DOCUMENT'|'BATCH') {
    const p=await this.principal(token,issuerRuc,true);
    const row=kind==='DOCUMENT'?(await this.ownDocument(token,issuerRuc,id)).row:(await this.ownBatch(token,issuerRuc,id)).row;
    if (row.artifacts.length>32) return deny(409,'INCOMPLETE_BINDING');
    const items:IntegrationArtifactV1[]=[];
    for (const a of row.artifacts.filter(a=>allowedKinds.includes(a.kind as any))) {
      const result=await this.resolve(token,issuerRuc,a,{kind,id},p); if (!items.some(i=>i.id===result.metadata.id)) items.push(result.metadata);
    }
    return {schemaVersion:IntegrationContractVersion,items,warnings:['PDF_ARTIFACTS_NOT_EXPOSED_IN_PHASE4','NO_PDF_SUBSTITUTION','SIGNATURE_TRUST_AND_FISCAL_ACCEPTANCE_UNVERIFIED']};
  }
  async content(token:string,issuerRuc:string,id:string) {
    if (!uuid(id)) return deny(400,'INVALID_QUERY');
    id=id.toLowerCase();
    const p=await this.principal(token,issuerRuc,true), found=await this.repository.artifact(issuerRuc,id);
    if (!found) return deny(404,'RESOURCE_NOT_FOUND');
    const resolved=await this.resolve(token,issuerRuc,found.artifact,found.owner,p);
    let bytes:Buffer;
    try {bytes=await this.store.read(resolved.storageOwner,resolved.artifact);} catch(error) {
      if (error && typeof error==='object' && 'code' in error && error.code==='ENOENT') return deny(404,'ARTIFACT_UNAVAILABLE');
      return deny(409,'INTEGRITY_FAILED');
    }
    if (bytes.length!==resolved.metadata.byteLength || createHash('sha256').update(bytes).digest('hex')!==resolved.artifact.sha256)
      return deny(409,'INTEGRITY_FAILED');
    // Cached/loaded bytes never bypass revocation. Revalidate all members and current revision immediately before response.
    const fresh=await this.principal(token,issuerRuc,true);
    if (fresh.revision!==p.revision || fresh.clientId!==p.clientId) return deny(401,'UNAUTHENTICATED');
    const final=await this.resolve(token,issuerRuc,found.artifact,found.owner,fresh);
    if (final.metadata.id!==resolved.metadata.id || final.metadata.sha256!==resolved.metadata.sha256) return deny(409,'EVIDENCE_INCONSISTENT');
    try {await this.repository.audit({id:randomUUID(),clientId:fresh.clientId,revision:fresh.revision,issuerRuc,
      artifactId:resolved.metadata.id,sha256:resolved.artifact.sha256,byteLength:bytes.length});} catch {return deny(503,'UPSTREAM_UNAVAILABLE');}
    return {bytes,sha256:resolved.artifact.sha256,fileName:resolved.metadata.fileName,mediaType:resolved.metadata.mediaType};
  }
}
