import {randomUUID} from 'node:crypto';
import {fiscalSnapshotSha256 as hash} from '@factuez/sunat-core/dist/fiscal-note';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type {PrismaService} from '../infrastructure/prisma.service';
import type {BatchMemberPrivateOwnerPort,BatchMemberOwnerVersionRecord,BatchEvidenceVersion} from './batch-member-evidence';
import {createBatchMemberEvidence} from './batch-member-evidence';
import {PrismaBetaDocumentAcceptanceRepository} from './beta-document-acceptance.repository';
import {PrismaBetaSummaryOwner} from './beta-owner-summary.repository';
import type {BetaAcceptedDocumentRecord,BetaAcceptanceDocument} from './beta-document-acceptance';
import type {BetaOwnedSummaryRecord} from './beta-owner-summary-acceptance';

export interface BatchEvidenceSqlConnection{
 query(sql:string,values?:unknown[]):Promise<{rows:any[];rowCount:number|null}>;
 release(destroy?:boolean):void;
}
export interface BatchEvidenceSqlPool{connect():Promise<BatchEvidenceSqlConnection>}
export class BatchEvidenceRepositoryError extends Error{
 constructor(readonly code:'BATCH_EVIDENCE_VERSION_MISSING'|'BATCH_EVIDENCE_CATALOGUE_HISTORY_MISSING'|
 'BATCH_EVIDENCE_OWNER_INVALID'|'BATCH_EVIDENCE_OWNER_CHANGED'|'BATCH_EVIDENCE_STORAGE_UNAVAILABLE'){
 super(code);this.name='BatchEvidenceRepositoryError';}
}
function deny(code:ConstructorParameters<typeof BatchEvidenceRepositoryError>[0]):never{throw new BatchEvidenceRepositoryError(code);}
const copy=<T>(v:T)=>boundedSupplementJson(v) as T;
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
const handle=(v:string)=>{if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(v))deny('BATCH_EVIDENCE_OWNER_INVALID');};
type OwnedPayload={source:'OWNED';record:BatchMemberOwnerVersionRecord;individual:BetaAcceptedDocumentRecord|null;summary:BetaOwnedSummaryRecord|null};
type Stored={owner_handle:string;document_id:string;version:number;snapshot_sha256:string;payload:OwnedPayload;payload_sha256:string};
function supported(record:BatchMemberOwnerVersionRecord){
 // No current-row query can prove complete financial history. Preserve this guard until a
 // real owner producer covers every accepted/reserved credit, revision and historical snapshot.
 if(!record||!['01','03'].includes(record.snapshot?.documentTypeCode)||record.noteContext!==null||record.ownerOriginalVersion!==null)
  deny('BATCH_EVIDENCE_CATALOGUE_HISTORY_MISSING');
}
function stored(row:Stored):OwnedPayload{
 const p=copy(row.payload);
 if(!p||Object.keys(p).sort().join(',')!=='individual,record,source,summary'||p.source!=='OWNED'||
  hash(p)!==row.payload_sha256||p.record?.member.documentId!==row.document_id||
  p.record.member.version!==row.version||p.record.member.snapshotSha256!==row.snapshot_sha256)deny('BATCH_EVIDENCE_OWNER_INVALID');
 supported(p.record);
 if(p.record.acceptance===null?(p.individual!==null||p.summary!==null):
   p.record.acceptance.kind==='INDIVIDUAL'?(!p.individual||p.summary!==null):(!p.summary||p.individual!==null))
  deny('BATCH_EVIDENCE_OWNER_INVALID');
 return p;
}

/** Exact immutable history only. This table is a NEW candidate, not a legacy Prisma model.
 * Empty/uninstalled storage cannot be promoted into current or complete owner evidence. */
export class PostgresBatchMemberEvidenceRepository{
 constructor(private readonly pool:BatchEvidenceSqlPool){}
 async assertInfrastructure():Promise<void>{
  let db:BatchEvidenceSqlConnection|undefined;
  try{db=await this.pool.connect();const result=await db.query('SELECT owner_handle,document_id,version,snapshot_sha256,payload,payload_sha256 FROM b2b_sunat_batch_member_evidence_version WHERE false');
   if(!Array.isArray(result.rows)||result.rows.length)deny('BATCH_EVIDENCE_STORAGE_UNAVAILABLE');
  }catch{deny('BATCH_EVIDENCE_STORAGE_UNAVAILABLE');}finally{db?.release();}
 }
 /** Resolve only the requested immutable original; this does not verify acceptance or signatures. */
 async resolveHandle(reference:BatchEvidenceVersion):Promise<string>{
  if(!reference||typeof reference!=='object'||Array.isArray(reference)||
   Object.keys(reference).sort().join(',')!=='documentId,snapshotSha256,version'||
   typeof reference.documentId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(reference.documentId)||
   !Number.isSafeInteger(reference.version)||reference.version<1||reference.version>2147483647||
   typeof reference.snapshotSha256!=='string'||!/^[a-f0-9]{64}$/.test(reference.snapshotSha256))deny('BATCH_EVIDENCE_OWNER_INVALID');
  const requested={documentId:reference.documentId,version:reference.version,snapshotSha256:reference.snapshotSha256};
  let db:BatchEvidenceSqlConnection|undefined;
  try{
   db=await this.pool.connect();
   const rows=(await db.query('SELECT owner_handle,document_id,version,snapshot_sha256,payload,payload_sha256 FROM b2b_sunat_batch_member_evidence_version WHERE document_id=$1 AND version=$2 AND snapshot_sha256=$3',
    [requested.documentId,requested.version,requested.snapshotSha256])).rows;
   if(!rows.length)deny('BATCH_EVIDENCE_VERSION_MISSING');
   if(rows.length!==1)deny('BATCH_EVIDENCE_OWNER_INVALID');
   const row=rows[0];handle(row.owner_handle);
   if(row.document_id!==requested.documentId||row.version!==requested.version||row.snapshot_sha256!==requested.snapshotSha256)
    deny('BATCH_EVIDENCE_OWNER_INVALID');
   const payload=stored(row);
   if(payload.record.snapshot.documentId!==requested.documentId||hash(payload.record.snapshot)!==requested.snapshotSha256)
    deny('BATCH_EVIDENCE_OWNER_INVALID');
   return row.owner_handle;
  }catch(e){
   if(e instanceof BatchEvidenceRepositoryError)throw e;
   if((e as {code?:string})?.code==='42P01')deny('BATCH_EVIDENCE_VERSION_MISSING');
   return deny('BATCH_EVIDENCE_STORAGE_UNAVAILABLE');
  }finally{db?.release();}
 }
 async load(ownerHandle:string):Promise<OwnedPayload>{
  handle(ownerHandle);let db:BatchEvidenceSqlConnection|undefined;
  try{
   db=await this.pool.connect();
   const rows=(await db.query('SELECT owner_handle,document_id,version,snapshot_sha256,payload,payload_sha256 FROM b2b_sunat_batch_member_evidence_version WHERE owner_handle=$1',[ownerHandle])).rows;
   if(!rows.length)deny('BATCH_EVIDENCE_VERSION_MISSING');
   if(rows.length!==1||rows[0].owner_handle!==ownerHandle)deny('BATCH_EVIDENCE_OWNER_INVALID');
   return stored(rows[0]);
  }catch(e){
   if(e instanceof BatchEvidenceRepositoryError)throw e;
   if((e as {code?:string})?.code==='42P01')deny('BATCH_EVIDENCE_VERSION_MISSING');
   return deny('BATCH_EVIDENCE_STORAGE_UNAVAILABLE');
  }finally{db?.release();}
 }
 /** Handle-scoped ports avoid shared mutable request state and cross-version CDR lookup. */
 forHandle(ownerHandle:string){
  handle(ownerHandle);
  return {
   owner:{load:async(h:string)=>{if(h!==ownerHandle)deny('BATCH_EVIDENCE_OWNER_INVALID');return (await this.load(ownerHandle)).record;}},
   individual:{load:async(ruc:string,environment:'BETA',documentId:string)=>{
    const p=await this.load(ownerHandle),r=p.individual;
    if(environment!=='BETA'||!r||r.document.documentId!==documentId||r.document.issuer.identityNumber!==ruc)deny('BATCH_EVIDENCE_VERSION_MISSING');
    return r;}},
   summary:{current:async(document:BetaAcceptanceDocument)=>{
    const p=await this.load(ownerHandle);if(!p.summary||!same(document,p.record.snapshot))deny('BATCH_EVIDENCE_VERSION_MISSING');
    return p.summary;}},
  };
 }
}

export type BatchEvidenceCrypto=Pick<Parameters<typeof createBatchMemberEvidence>[0],'artifacts'|'certificates'|'trust'|'cdr'>;

/** Sole insertion capability, private producer only: capture accepts a handle, never a record.
 * The explicitly supplied OWNED source must already own the exact binding/version and signed
 * package. Legacy FiscalDocument alone cannot implement that source. No public import route.
 * This original-only candidate does not assert a complete note credit catalogue. */
export function createBatchMemberEvidenceProducer(options:BatchEvidenceCrypto&{
 pool:BatchEvidenceSqlPool;db:PrismaService;owner:BatchMemberPrivateOwnerPort;
}){
 const individual=new PrismaBetaDocumentAcceptanceRepository(options.db),summary=new PrismaBetaSummaryOwner(options.db);
 return Object.freeze({async capture(sourceHandle:string,asOf:string):Promise<{ownerHandle:string;member:BatchMemberOwnerVersionRecord['member']}>{
  handle(sourceHandle);
  const raw=await options.owner.load(sourceHandle);if(!raw)deny('BATCH_EVIDENCE_VERSION_MISSING');
  const record=copy(raw);supported(record);
  const stamp=hash(record),checkOwner=async()=>{
   const value=await options.owner.load(sourceHandle);
   if(!value||hash(copy(value))!==stamp)deny('BATCH_EVIDENCE_OWNER_CHANGED');
   return copy(value);
  };
  let accepted:BetaAcceptedDocumentRecord|null=null,rc:BetaOwnedSummaryRecord|null=null;
  if(record.acceptance){
   if(record.acceptance.kind==='INDIVIDUAL')accepted=await individual.load(record.binding.issuerRuc,'BETA',record.member.documentId);
   else rc=await summary.current(record.snapshot);
   if(!accepted&&!rc)deny('BATCH_EVIDENCE_VERSION_MISSING');
  }
  const p:OwnedPayload={source:'OWNED',record,individual:accepted,summary:rc};
  // Execute actual XML signature/CDR/PKI verifiers, with real current owner repositories
  // on every acceptance read. Their own read-before/after checks remain in force.
  const core=createBatchMemberEvidence({...options,owner:{load:async(h:string)=>{
   if(h!==sourceHandle)deny('BATCH_EVIDENCE_OWNER_INVALID');return checkOwner();}},individual,summary});
  await core.verifySignedVersion(sourceHandle,asOf);
  // A matching live SUNAT row is mandatory even for an unreported signed original.
  const current=async()=>{
   const row=await options.db.fiscalDocument.findFirst({where:{documentId:record.member.documentId,issuerRuc:record.binding.issuerRuc,environment:'BETA'},
    select:{immutablePayload:true,documentId:true,documentType:true,series:true,number:true,digestValue:true,
     artifacts:{where:{kind:{in:['SIGNED_XML','SUBMISSION_ZIP']}},select:{id:true,kind:true,storageKey:true,sha256:true,sizeBytes:true}}}});
   if(!row||!same(row.immutablePayload,record.snapshot)||row.documentId!==record.member.documentId||row.documentType!==record.binding.documentType||
    row.series!==record.binding.series||String(row.number)!==record.snapshot.number||row.digestValue!==record.digestValue||row.artifacts.length!==2)
    deny('BATCH_EVIDENCE_VERSION_MISSING');
   for(const [kind,a] of [['SIGNED_XML',record.signedXml],['SUBMISSION_ZIP',record.requestZip]] as const){
    const found=row.artifacts.find(x=>x.kind===kind);
    if(!found||found.id!==a.id||found.storageKey!==a.storageKey||found.sha256!==a.sha256||String(found.sizeBytes)!==String(a.sizeBytes))
     deny('BATCH_EVIDENCE_VERSION_MISSING');
   }
   return hash({...row,number:String(row.number),artifacts:row.artifacts.map(a=>({...a,sizeBytes:String(a.sizeBytes)})).sort((a,b)=>a.kind.localeCompare(b.kind))});
  };
  const currentStamp=await current();
  if(accepted&&!same(accepted,await individual.load(record.binding.issuerRuc,'BETA',record.member.documentId))||
   rc&&!same(rc,await summary.current(record.snapshot)))deny('BATCH_EVIDENCE_OWNER_CHANGED');
  await checkOwner();
  let db:BatchEvidenceSqlConnection|undefined,begun=false,destroy=false;
  try{
   db=await options.pool.connect();await db.query('BEGIN');begun=true;
   const ownerHandle=randomUUID(),payload=copy(p),digest=hash(payload);
   const rows=(await db.query(
    'INSERT INTO b2b_sunat_batch_member_evidence_version(owner_handle,document_id,version,snapshot_sha256,payload,payload_sha256) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(document_id,version) DO NOTHING RETURNING owner_handle',
    [ownerHandle,record.member.documentId,record.member.version,record.member.snapshotSha256,JSON.stringify(payload),digest])).rows;
   let selected=ownerHandle;
   if(!rows.length){
    const old=(await db.query('SELECT owner_handle,document_id,version,snapshot_sha256,payload,payload_sha256 FROM b2b_sunat_batch_member_evidence_version WHERE document_id=$1 AND version=$2',
     [record.member.documentId,record.member.version])).rows;
    if(old.length!==1||!same(stored(old[0]),payload))deny('BATCH_EVIDENCE_OWNER_CHANGED');
    selected=old[0].owner_handle;
   }else if(rows.length!==1||rows[0].owner_handle!==ownerHandle)deny('BATCH_EVIDENCE_OWNER_INVALID');
   await checkOwner();if(currentStamp!==await current())deny('BATCH_EVIDENCE_OWNER_CHANGED');
   if(accepted&&!same(accepted,await individual.load(record.binding.issuerRuc,'BETA',record.member.documentId))||
    rc&&!same(rc,await summary.current(record.snapshot)))deny('BATCH_EVIDENCE_OWNER_CHANGED');
   await db.query('COMMIT');begun=false;return {ownerHandle:selected,member:copy(record.member)};
  }catch(e){
   if(begun)try{await db!.query('ROLLBACK');}catch{destroy=true;}
   if(e instanceof BatchEvidenceRepositoryError)throw e;
   deny('BATCH_EVIDENCE_STORAGE_UNAVAILABLE');
  }finally{db?.release(destroy);}
 }});
}

