import {createHash, X509Certificate} from 'node:crypto';
import forge from 'node-forge';
import {unzipSync} from 'fflate';
import {boundedSupplementJson, validateFiscalSupplementCommand, type FiscalSupplementCommand,
  type FiscalSupplementEnvelope} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {buildFiscalBatchUbl} from '@factuez/sunat-core/dist/fiscal-batch';
import {fiscalSnapshotSha256, fiscalRuc, fiscalDate, fiscalTimestamp, fiscalLimaDate} from '@factuez/sunat-core/dist/fiscal-note';
import {prepareBetaFiscalPackage} from '../infrastructure/crypto/beta-fiscal-package-pipeline';
import {certificateRucCandidates} from '../infrastructure/crypto/certificate-identity';
import {parseSafeInvoice, verifyLocalSignedInvoice} from '../infrastructure/crypto/xml-signer.service';
import type {CdrSignatureTrustService} from '../infrastructure/crypto/cdr-signature-trust.service';
import {parseCdrZip} from '../infrastructure/sunat/cdr-parser';
import {children, CAC_NS, CBC_NS, type safeXml} from '../infrastructure/sunat/safe-xml';
import {betaCdrZipMetadata, betaCdrCrc32} from './beta-summary-acceptance';
import type {GuideDispatchDatabase, GuideDispatchSql} from './guide-dispatch-store';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FLAGS = {candidateOnly:true, localOnly:true, fiscalExecutionEnabled:false, transmissionAuthorized:false,
  officialCdrVerified:false, certificateTrusted:false, signatureVerifiedLocally:true} as const;
const CODES = ['INVALID_SCOPE','INVALID_ACCESS','POLICY_REQUIRED','RUC_NOT_ALLOWED','OWNER_INVALID','OWNER_CHANGED',
  'OWNER_UNAVAILABLE','NOT_PREPARED','INTEGRITY_FAILED','KEY_POLICY_REQUIRED','SIGNER_UNAVAILABLE',
  'CDR_NOT_FOUND','CDR_INVALID','CDR_UNTRUSTED','CDR_CONFLICT','STORE_UNAVAILABLE','IDENTITY_CONFLICT'] as const;
type ErrorCode = typeof CODES[number];
export class BatchLocalArtifactError extends Error {
  constructor(readonly code: ErrorCode) {super('BATCH_LOCAL_ARTIFACT_'+code); this.name='BatchLocalArtifactError';}
}
function fail(code:ErrorCode):never {throw new BatchLocalArtifactError(code);}
const exact = (value:object, keys:string[]) => Object.keys(value).sort().join(',')===keys.sort().join(',');
function safeError(error:unknown):never {
  if(error instanceof BatchLocalArtifactError && CODES.includes(error.code)) throw error;
  return fail('STORE_UNAVAILABLE');
}
export type BatchLocalArtifactScope = {environment:'BETA';issuerRuc:string;companyId:number;branchId:string;batchId:string};
export type BatchLocalArtifactAccess = {token:string;kind:'SERVICE'|'USER'};
export type BatchLocalArtifactAction = 'READ'|'WRITE';
export type BatchLocalArtifactOwned = {command:FiscalSupplementCommand;authorizationSha256:string};
/** Trusted PRIVATE owner capability, not a public DTO. Load the actual new-owner persisted command
 * by batchId; authorize every exact member, previous/original/credit-history dependency and tuple.
 * READ/WRITE are independent grants. Hash all member/catalogue/Identity/local-grant revisions in
 * authorizationSha256. No legacy fallback, accepted boolean, caller command or latest-version swap.
 * Repeated observations fence remote changes, NOT a distributed atomic revocation guarantee. */
export interface BatchLocalArtifactOwner {
  current(scope:BatchLocalArtifactScope, access:BatchLocalArtifactAccess, action:BatchLocalArtifactAction):Promise<BatchLocalArtifactOwned>;
}
/** Original response comes only from a trusted private journal, never public bytes/accepted flags.
 * May be absent. Capture cannot dispatch, manufacture CDRs, or advance any fiscal/member state. */
export interface BatchLocalCdrSource {
  current(scope:BatchLocalArtifactScope, access:BatchLocalArtifactAccess):Promise<{
    source:'LOCAL_EMULATOR';zip:Buffer;receivedAt:string;
  }|null>;
}
export type BatchLocalArtifactMetadata = typeof FLAGS & {
  schemaVersion:'factuez.batch-artifacts-local.v1';scope:BatchLocalArtifactScope;operationId:string;eventId:string;
  kind:'RC'|'RA';identifier:string;commandSha256:string;envelopeSha256:string;batchSnapshotSha256:string;
  unsignedXmlSha256:string;xmlSha256:string;zipSha256:string;digestValue:string;certificateFingerprintSha256:string;fileName:string;
};
export type BatchLocalArtifactRecord = {metadata:BatchLocalArtifactMetadata;unsignedXml:string;signedXml:string;zip:Buffer;certificatePem:string};
export type BatchLocalCdrEvidence = {
  schemaVersion:'factuez.batch-cdr-local.v1';source:'LOCAL_EMULATOR';batchId:string;issuerRuc:string;kind:'RC'|'RA';identifier:string;
  requestXmlSha256:string;requestZipSha256:string;requestHashesBoundByCdr:false;cdrFileName:string;cdrXmlSha256:string;cdrZipSha256:string;
  receivedAt:string;responseCode:string;status:'ACCEPTED'|'ACCEPTED_WITH_OBSERVATIONS'|'REJECTED';description:string;notes:string[];
  signatureVerifiedLocally:true;officialCdrVerified:false;transmissionAuthorized:false;memberAcceptanceGranted:false;
};
export type BatchLocalCdrArchive = {batchId:string;packageSha256:string;evidence:BatchLocalCdrEvidence;zip:Buffer};
export interface BatchLocalArtifactTransaction {
  read():Promise<BatchLocalArtifactRecord|null>;insert(record:BatchLocalArtifactRecord):Promise<void>;
  readCdr():Promise<BatchLocalCdrArchive|null>;insertCdr(record:BatchLocalCdrArchive):Promise<void>;
}
export interface BatchLocalArtifactStore {
  transaction<T>(scope:BatchLocalArtifactScope,work:(tx:BatchLocalArtifactTransaction)=>Promise<T>):Promise<T>;
}
export interface BatchLocalSigner {
  readonly mode:'LOCAL_EPHEMERAL_ONLY';readonly keyPurpose:'LOCAL_SYNTHETIC_BATCH';
  prepare(envelope:Extract<FiscalSupplementEnvelope,{kind:'BATCH'}>):Promise<{
    xml:string;zip:Buffer;certificatePem:string;digestValue:string;certificateFingerprintSha256:string;
  }>;
}
/** Host-only key port. acquire returns an exclusively owned fresh P12 buffer, zeroed on release.
 * No request may contain a path, P12/password, PEM or key-purpose override. */
export interface BatchLocalKeyProvider {
  acquire(ruc:string,purpose:'LOCAL_SYNTHETIC_BATCH'):Promise<{
    ruc:string;purpose:'LOCAL_SYNTHETIC_BATCH';p12:Buffer;password:string;certificatePem:string;dispose():Promise<void>;
  }>;
}
export function createBatchLocalSigner(keys:BatchLocalKeyProvider):BatchLocalSigner {
  return {mode:'LOCAL_EPHEMERAL_ONLY',keyPurpose:'LOCAL_SYNTHETIC_BATCH',async prepare(envelope) {
    let material:Awaited<ReturnType<BatchLocalKeyProvider['acquire']>>|undefined;
    try {
      material=await keys.acquire(envelope.batch.issuer.identityNumber,'LOCAL_SYNTHETIC_BATCH');
      if(material.purpose!=='LOCAL_SYNTHETIC_BATCH'||material.ruc!==envelope.batch.issuer.identityNumber||!Buffer.isBuffer(material.p12)||
        material.p12.length<1||material.p12.length>512*1024||typeof material.password!=='string'||material.password.length>4096||
        typeof material.dispose!=='function')fail('KEY_POLICY_REQUIRED');
      const result=prepareBetaFiscalPackage(envelope,material.p12,material.password);
      return {xml:result.xml,zip:Buffer.from(result.zip),certificatePem:material.certificatePem,
        digestValue:result.signed.digestValue,certificateFingerprintSha256:result.signed.certificateFingerprintSha256};
    } catch(error) {if(error instanceof BatchLocalArtifactError)throw error;return fail('SIGNER_UNAVAILABLE');}
    finally {if(material){if(Buffer.isBuffer(material.p12))material.p12.fill(0);try{await material.dispose();}catch{fail('SIGNER_UNAVAILABLE');}}}
  }};
}
export function validateBatchLocalArtifactScope(value:unknown):BatchLocalArtifactScope {
  try {
    const s=boundedSupplementJson(value) as BatchLocalArtifactScope;
    if(!s||!exact(s,['environment','issuerRuc','companyId','branchId','batchId'])||s.environment!=='BETA'||
      !Number.isSafeInteger(s.companyId)||s.companyId<1||!UUID.test(s.branchId)||!UUID.test(s.batchId))fail('INVALID_SCOPE');
    fiscalRuc(s.issuerRuc,'issuerRuc');return s;
  }catch{ return fail('INVALID_SCOPE'); }
}
function access(value:BatchLocalArtifactAccess):BatchLocalArtifactAccess {
  try {const a=boundedSupplementJson(value) as BatchLocalArtifactAccess;
    if(!a||!exact(a,['token','kind'])||!['USER','SERVICE'].includes(a.kind)||typeof a.token!=='string'||
      a.token.length<1||a.token.length>8192||/[\s\x00-\x1f\x7f]/.test(a.token))fail('INVALID_ACCESS');return a;
  }catch{return fail('INVALID_ACCESS');}
}
function owned(value:unknown,scope:BatchLocalArtifactScope):BatchLocalArtifactOwned {
  try {
    const o=boundedSupplementJson(value) as BatchLocalArtifactOwned;
    if(!o||!exact(o,['command','authorizationSha256'])||!HASH.test(o.authorizationSha256))fail('OWNER_INVALID');
    const c=validateFiscalSupplementCommand(o.command),p=c.payload,e=p.envelope;
    if(e.kind!=='BATCH'||p.operationId!==scope.batchId||p.issuerRuc!==scope.issuerRuc||p.companyId!==scope.companyId||
      p.branchId!==scope.branchId||p.environment!=='BETA'||e.batch.documentId!==scope.batchId||
      e.batch.companyId!==scope.companyId||e.batch.branchId!==scope.branchId)fail('OWNER_INVALID');
    return {command:c,authorizationSha256:o.authorizationSha256};
  }catch{return fail('OWNER_INVALID');}
}
function envelope(o:BatchLocalArtifactOwned) {
  const e=o.command.payload.envelope;if(e.kind!=='BATCH')return fail('OWNER_INVALID');return e;
}
function copy(record:BatchLocalArtifactRecord):BatchLocalArtifactRecord {
  return {metadata:boundedSupplementJson(record.metadata) as BatchLocalArtifactMetadata,unsignedXml:record.unsignedXml,
    signedXml:record.signedXml,zip:Buffer.from(record.zip),certificatePem:record.certificatePem};
}
export function validateBatchLocalArtifactRecord(value:BatchLocalArtifactRecord,owner:BatchLocalArtifactOwned,
  scope:BatchLocalArtifactScope):BatchLocalArtifactRecord {
  try {
    const o=owned(owner,scope),e=envelope(o),r=copy(value),m=r.metadata;
    const expectedUnsigned=buildFiscalBatchUbl(e.batch,e.asOf),fileName=`${scope.issuerRuc}-${e.batch.identifier}.zip`;
    if(!exact(value,['metadata','unsignedXml','signedXml','zip','certificatePem'])||
      !exact(m,['schemaVersion','scope','operationId','eventId','kind','identifier','commandSha256','envelopeSha256',
        'batchSnapshotSha256','unsignedXmlSha256','xmlSha256','zipSha256','digestValue','certificateFingerprintSha256','fileName',...Object.keys(FLAGS)])||
      m.schemaVersion!=='factuez.batch-artifacts-local.v1'||fiscalSnapshotSha256(m.scope)!==fiscalSnapshotSha256(scope)||
      m.operationId!==scope.batchId||m.eventId!==o.command.eventId||m.kind!==e.batch.kind||m.identifier!==e.batch.identifier||
      m.commandSha256!==fiscalSnapshotSha256(o.command)||m.envelopeSha256!==o.command.payload.envelopeSha256||
      m.batchSnapshotSha256!==fiscalSnapshotSha256(e.batch)||Object.entries(FLAGS).some(([k,v])=>m[k as keyof typeof FLAGS]!==v)||
      r.unsignedXml!==expectedUnsigned||m.unsignedXmlSha256!==sha(expectedUnsigned)||typeof r.signedXml!=='string'||
      Buffer.byteLength(r.signedXml)>2*1024*1024||m.xmlSha256!==sha(r.signedXml)||!Buffer.isBuffer(value.zip)||
      m.zipSha256!==sha(r.zip)||m.fileName!==fileName||!HASH.test(m.certificateFingerprintSha256)||
      typeof r.certificatePem!=='string'||r.certificatePem.length>65536||r.certificatePem.includes('PRIVATE KEY'))fail('INTEGRITY_FAILED');
    const cert=new X509Certificate(r.certificatePem),parsed=forge.pki.certificateFromPem(r.certificatePem);
    const rucs=certificateRucCandidates(parsed.subject.attributes);
    if(cert.ca||cert.publicKey.asymmetricKeyType!=='rsa'||(cert.publicKey.asymmetricKeyDetails?.modulusLength??0)<2048||
      (parsed.getExtension('keyUsage') as {digitalSignature?:boolean}|null)?.digitalSignature!==true||
      rucs.length!==1||rucs[0]!==scope.issuerRuc||cert.fingerprint256.replaceAll(':','').toLowerCase()!==m.certificateFingerprintSha256||
      verifyLocalSignedInvoice(r.signedXml,r.certificatePem,expectedUnsigned,e.batch.kind==='RC'?'SummaryDocuments':'VoidedDocuments')!==m.digestValue)
      fail('INTEGRITY_FAILED');
    const name=fileName.replace(/\.zip$/,'.xml'),z=betaCdrZipMetadata(r.zip,name),files=unzipSync(r.zip);
    if(Object.keys(files).length!==1||!files[name])fail('INTEGRITY_FAILED');
    const xml=Buffer.from(files[name]);if(!xml.equals(Buffer.from(r.signedXml))||xml.length!==z.size||betaCdrCrc32(xml)!==z.crc)fail('INTEGRITY_FAILED');
    return r;
  }catch{return fail('INTEGRITY_FAILED');}
}
type Element=ReturnType<typeof safeXml>;
function one(parent:Element,ns:string,name:string):Element {
  const matches=children(parent,ns,name);let count=0;
  for(let n=parent.firstChild;n;n=n.nextSibling)if(n.nodeType===1&&(n as Element).localName===name)count++;
  if(count!==1||matches.length!==1)fail('CDR_INVALID');return matches[0];
}
function text(parent:Element,ns:string,name:string,max:number):string {
  const n=one(parent,ns,name),v=n.textContent??'';if(!v||v!==v.trim()||v.length>max||n.getElementsByTagName('*').length)fail('CDR_INVALID');return v;
}
async function review(bytes:Buffer,receivedAt:string,record:BatchLocalArtifactRecord,o:BatchLocalArtifactOwned,
  verifier:Pick<CdrSignatureTrustService,'verify'>):Promise<BatchLocalCdrEvidence> {
  try {
    const m=record.metadata,e=envelope(o),name='R-'+m.fileName.replace(/\.zip$/,'.xml');
    fiscalTimestamp(receivedAt,'receivedAt');if(Date.parse(receivedAt)<Date.parse(o.command.occurredAt))fail('CDR_INVALID');
    const zip=Buffer.from(bytes),z=betaCdrZipMetadata(zip,name),cdr=parseCdrZip(zip,{fileName:name,issuerRuc:m.scope.issuerRuc,reference:m.identifier});
    if(cdr.xml.length!==z.size||betaCdrCrc32(cdr.xml)!==z.crc||!Buffer.from(cdr.xml.toString('utf8')).equals(cdr.xml))fail('CDR_INVALID');
    const {root,document,extension}=parseSafeInvoice(cdr.xml.toString('utf8'),'ApplicationResponse');
    const sender=one(one(root,CAC_NS,'SenderParty'),CAC_NS,'PartyIdentification'),receiver=one(one(root,CAC_NS,'ReceiverParty'),CAC_NS,'PartyIdentification');
    const response=one(root,CAC_NS,'DocumentResponse'),answer=one(response,CAC_NS,'Response'),ref=one(response,CAC_NS,'DocumentReference');
    if(text(sender,CBC_NS,'ID',11)!=='20131312955'||text(receiver,CBC_NS,'ID',11)!==m.scope.issuerRuc||
      text(ref,CBC_NS,'ID',40)!==m.identifier||text(answer,CBC_NS,'ReferenceID',40)!==m.identifier||
      text(answer,CBC_NS,'ResponseCode',8)!==cdr.code)fail('CDR_INVALID');
    // Optional type must match if present; historical CDRs need not carry it.
    if(children(ref,CBC_NS,'DocumentTypeCode').length&&text(ref,CBC_NS,'DocumentTypeCode',2)!==m.kind)fail('CDR_INVALID');
    const day=text(root,CBC_NS,'IssueDate',10);fiscalDate(day,'CDR.IssueDate');
    if(day<e.batch.issueDate||day>fiscalLimaDate(receivedAt))fail('CDR_INVALID');
    let lastDay=day,lastInstant:number|undefined;
    for(const [dateName,timeName] of [['IssueDate','IssueTime'],['ResponseDate','ResponseTime']]) {
      const present=(name:string)=>{let n=0;for(let c=root.firstChild;c;c=c.nextSibling)
        if(c.nodeType===1&&(c as Element).localName===name)n++;return n;};
      const hasDay=present(dateName),hasTime=present(timeName);
      if(!hasDay){if(hasTime)fail('CDR_INVALID');continue;}
      const d=text(root,CBC_NS,dateName,10);fiscalDate(d,'CDR.date');
      if(d<lastDay||d>fiscalLimaDate(receivedAt))fail('CDR_INVALID');lastDay=d;
      if(hasTime){const t=text(root,CBC_NS,timeName,24);
        if(!/^\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)?$/.test(t))fail('CDR_INVALID');
        const instant=d+'T'+t+(/(?:Z|[+-]\d\d:\d\d)$/.test(t)?'':'-05:00');fiscalTimestamp(instant,'CDR.time');
        const value=Date.parse(instant);
        if(value<Date.parse(o.command.occurredAt)||value>Date.parse(receivedAt)||lastInstant!==undefined&&value<lastInstant)fail('CDR_INVALID');
        lastInstant=value;}
    }
    const signatures=document.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#','Signature');
    if(signatures.length!==1||signatures[0].parentNode!==extension)fail('CDR_INVALID');
    const verification=Buffer.from(cdr.xml);
    try{if(await verifier.verify(verification)!==true||!verification.equals(cdr.xml))fail('CDR_UNTRUSTED');}catch{return fail('CDR_UNTRUSTED');}
    return {schemaVersion:'factuez.batch-cdr-local.v1',source:'LOCAL_EMULATOR',batchId:m.scope.batchId,issuerRuc:m.scope.issuerRuc,kind:m.kind,
      identifier:m.identifier,requestXmlSha256:m.xmlSha256,requestZipSha256:m.zipSha256,requestHashesBoundByCdr:false,
      cdrFileName:name,cdrXmlSha256:sha(cdr.xml),cdrZipSha256:sha(zip),receivedAt,responseCode:cdr.code,status:cdr.status,
      description:cdr.description,notes:[...cdr.notes],signatureVerifiedLocally:true,officialCdrVerified:false,
      transmissionAuthorized:false,memberAcceptanceGranted:false};
  }catch(error){if(error instanceof BatchLocalArtifactError)throw error;return fail('CDR_INVALID');}
}
/** Opt-in local pipeline. No decorators, defaults, queues, dispatch, migration or fiscal state writes.
 * RC condition 3 and RA CDRs are NOT document acceptance. A local CDR is never branded as an
 * official BetaOwnerSummaryAcceptance; that separate verifier must reload authoritative evidence. */
export class BatchLocalArtifactPipeline {
  private readonly allowedRucs:readonly string[];
  constructor(private readonly owner:BatchLocalArtifactOwner,private readonly store:BatchLocalArtifactStore,
    private readonly signer:BatchLocalSigner,allowedRucs:readonly string[],
    private readonly cdrSource?:BatchLocalCdrSource,private readonly cdrVerifier?:Pick<CdrSignatureTrustService,'verify'>) {
    if(signer.mode!=='LOCAL_EPHEMERAL_ONLY'||signer.keyPurpose!=='LOCAL_SYNTHETIC_BATCH'||!allowedRucs.length||allowedRucs.length>100||
      new Set(allowedRucs).size!==allowedRucs.length)fail('POLICY_REQUIRED');
    try{for(const ruc of allowedRucs)fiscalRuc(ruc,'allowedRuc');}catch{fail('POLICY_REQUIRED');}
    this.allowedRucs=Object.freeze([...allowedRucs]);
  }
  private async current(scope:BatchLocalArtifactScope,a:BatchLocalArtifactAccess,action:BatchLocalArtifactAction) {
    if(!this.allowedRucs.includes(scope.issuerRuc))fail('RUC_NOT_ALLOWED');
    try{return owned(await this.owner.current(structuredClone(scope),{...a},action),scope);}
    catch(error){if(error instanceof BatchLocalArtifactError)throw error;return fail('OWNER_UNAVAILABLE');}
  }
  private async fresh(s:BatchLocalArtifactScope,a:BatchLocalArtifactAccess,action:BatchLocalArtifactAction,o:BatchLocalArtifactOwned) {
    if(fiscalSnapshotSha256(await this.current(s,a,action))!==fiscalSnapshotSha256(o))fail('OWNER_CHANGED');
  }
  prepare(input:unknown,a:BatchLocalArtifactAccess){return this.run(input,a,'WRITE');}
  read(input:unknown,a:BatchLocalArtifactAccess){return this.run(input,a,'READ');}
  private async run(input:unknown,credentials:BatchLocalArtifactAccess,action:BatchLocalArtifactAction) {
    try {
      const s=validateBatchLocalArtifactScope(input),a=access(credentials),o=await this.current(s,a,action);
      const result=await this.store.transaction(s,async tx=>{
        await this.fresh(s,a,action,o);const prior=await tx.read();
        if(prior){const record=validateBatchLocalArtifactRecord(prior,o,s);await this.fresh(s,a,action,o);return {record,replayed:true};}
        if(action==='READ')fail('NOT_PREPARED');
        const e=envelope(o),unsigned=buildFiscalBatchUbl(e.batch,e.asOf),signed=await this.signer.prepare(structuredClone(e));
        const metadata:BatchLocalArtifactMetadata={schemaVersion:'factuez.batch-artifacts-local.v1',scope:s,operationId:s.batchId,eventId:o.command.eventId,
          kind:e.batch.kind,identifier:e.batch.identifier,commandSha256:fiscalSnapshotSha256(o.command),envelopeSha256:o.command.payload.envelopeSha256,
          batchSnapshotSha256:fiscalSnapshotSha256(e.batch),unsignedXmlSha256:sha(unsigned),xmlSha256:sha(signed.xml),zipSha256:sha(signed.zip),
          digestValue:signed.digestValue,certificateFingerprintSha256:signed.certificateFingerprintSha256,fileName:`${s.issuerRuc}-${e.batch.identifier}.zip`,...FLAGS};
        const record=validateBatchLocalArtifactRecord({metadata,unsignedXml:unsigned,signedXml:signed.xml,zip:signed.zip,certificatePem:signed.certificatePem},o,s);
        await this.fresh(s,a,action,o);await tx.insert(copy(record));await this.fresh(s,a,action,o);return {record,replayed:false};
      });
      await this.fresh(s,a,action,o);return {record:copy(result.record),replayed:result.replayed};
    }catch(error){return safeError(error);}
  }
  captureCdr(input:unknown,a:BatchLocalArtifactAccess){return this.cdr(input,a,'WRITE');}
  readCdr(input:unknown,a:BatchLocalArtifactAccess){return this.cdr(input,a,'READ');}
  private async cdr(input:unknown,credentials:BatchLocalArtifactAccess,action:BatchLocalArtifactAction):Promise<BatchLocalCdrArchive> {
    try {
      const s=validateBatchLocalArtifactScope(input),a=access(credentials),o=await this.current(s,a,action);
      if(!this.cdrVerifier)fail('CDR_UNTRUSTED');
      const result=await this.store.transaction(s,async tx=>{
        await this.fresh(s,a,action,o);const raw=await tx.read();if(!raw)fail('NOT_PREPARED');
        const record=validateBatchLocalArtifactRecord(raw,o,s),prior=await tx.readCdr();
        let receivedAt=prior?.evidence.receivedAt,bytes=prior?Buffer.from(prior.zip):undefined;
        let source:Awaited<ReturnType<BatchLocalCdrSource['current']>>=null;
        let sourceReceivedAt:string|undefined;
        if(action==='WRITE'){
          if(!this.cdrSource)fail('CDR_NOT_FOUND');source=await this.cdrSource.current(structuredClone(s),{...a});
          if(!source)fail('CDR_NOT_FOUND');
          if(source.source!=='LOCAL_EMULATOR'||!Buffer.isBuffer(source.zip)||source.zip.length<22||source.zip.length>4*1024*1024)fail('CDR_INVALID');
          if(prior&&!prior.zip.equals(source.zip))fail('CDR_CONFLICT');bytes=Buffer.from(source.zip);
          sourceReceivedAt=source.receivedAt;receivedAt??=sourceReceivedAt;
        }
        if(!bytes||!receivedAt)fail('CDR_NOT_FOUND');
        const evidence=await review(bytes,receivedAt,record,o,this.cdrVerifier!);
        const archive={batchId:s.batchId,packageSha256:fiscalSnapshotSha256(record.metadata),evidence,zip:bytes};
        if(prior&&(prior.batchId!==s.batchId||prior.packageSha256!==archive.packageSha256||
          fiscalSnapshotSha256(prior.evidence)!==fiscalSnapshotSha256(evidence)))fail('INTEGRITY_FAILED');
        await this.fresh(s,a,action,o);
        if(source){const again=await this.cdrSource!.current(structuredClone(s),{...a});
          if(!again||again.source!=='LOCAL_EMULATOR'||again.receivedAt!==sourceReceivedAt||source.receivedAt!==sourceReceivedAt||!Buffer.isBuffer(again.zip)||
            !again.zip.equals(bytes)||!source.zip.equals(bytes))fail('OWNER_CHANGED');}
        if(!prior)await tx.insertCdr({...archive,zip:Buffer.from(bytes)});
        await this.fresh(s,a,action,o);return archive;
      });
      await this.fresh(s,a,action,o);return {...result,evidence:structuredClone(result.evidence),zip:Buffer.from(result.zip)};
    }catch(error){return safeError(error);}
  }
}

class PgTransaction implements BatchLocalArtifactTransaction {
  private open=true;private failure:unknown;private pending=new Set<Promise<unknown>>();
  constructor(private db:GuideDispatchSql,private scope:BatchLocalArtifactScope){}
  private run<T>(work:()=>Promise<T>):Promise<T>{
    const p=(async()=>{if(!this.open||this.failure)fail('STORE_UNAVAILABLE');try{return await work();}catch(e){this.failure??=e;throw e;}})();
    this.pending.add(p);void p.then(()=>this.pending.delete(p),()=>this.pending.delete(p));return p;
  }
  async finish(){this.open=false;await Promise.allSettled([...this.pending]);if(this.failure)throw this.failure;}
  read():Promise<BatchLocalArtifactRecord|null>{return this.run(async()=>{
    const rows=await this.db.$queryRawUnsafe<any[]>(`SELECT "batchId","eventId","commandSha256","issuerRuc","identifier","metadata","metadataSha256",
      "unsignedXml","signedXml","zip","certificatePem" FROM "BatchLocalArtifact" WHERE "batchId"=$1::uuid FOR UPDATE`,this.scope.batchId);
    if(!rows.length)return null;if(rows.length!==1)fail('STORE_UNAVAILABLE');
    const r=rows[0],m=boundedSupplementJson(r.metadata) as BatchLocalArtifactMetadata;
    if(r.batchId!==this.scope.batchId||r.eventId!==m.eventId||r.commandSha256!==m.commandSha256||r.issuerRuc!==this.scope.issuerRuc||r.identifier!==m.identifier||
      fiscalSnapshotSha256(m.scope)!==fiscalSnapshotSha256(this.scope)||fiscalSnapshotSha256(m)!==r.metadataSha256||
      !(r.unsignedXml instanceof Uint8Array)||!(r.signedXml instanceof Uint8Array)||!(r.zip instanceof Uint8Array))fail('INTEGRITY_FAILED');
    const unsigned=Buffer.from(r.unsignedXml),signed=Buffer.from(r.signedXml);
    if(!Buffer.from(unsigned.toString('utf8')).equals(unsigned)||!Buffer.from(signed.toString('utf8')).equals(signed))fail('INTEGRITY_FAILED');
    return {metadata:m,unsignedXml:unsigned.toString('utf8'),signedXml:signed.toString('utf8'),zip:Buffer.from(r.zip),certificatePem:r.certificatePem};
  });}
  insert(r:BatchLocalArtifactRecord):Promise<void>{return this.run(async()=>{
    const m=boundedSupplementJson(r.metadata) as BatchLocalArtifactMetadata;
    if(fiscalSnapshotSha256(m.scope)!==fiscalSnapshotSha256(this.scope))fail('INTEGRITY_FAILED');
    const n=await this.db.$executeRawUnsafe(`INSERT INTO "BatchLocalArtifact" ("batchId","eventId","commandSha256","issuerRuc","identifier","metadata","metadataSha256",
      "unsignedXml","signedXml","zip","certificatePem") VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
      this.scope.batchId,m.eventId,m.commandSha256,this.scope.issuerRuc,m.identifier,JSON.stringify(m),fiscalSnapshotSha256(m),
      Buffer.from(r.unsignedXml),Buffer.from(r.signedXml),Buffer.from(r.zip),r.certificatePem);
    if(n!==1)fail('STORE_UNAVAILABLE');
  });}
  readCdr():Promise<BatchLocalCdrArchive|null>{return this.run(async()=>{
    const rows=await this.db.$queryRawUnsafe<any[]>('SELECT "batchId","packageSha256","evidence","zip" FROM "BatchLocalCdr" WHERE "batchId"=$1::uuid',this.scope.batchId);
    if(!rows.length)return null;if(rows.length!==1||rows[0].batchId!==this.scope.batchId||!(rows[0].zip instanceof Uint8Array))fail('INTEGRITY_FAILED');
    return {batchId:rows[0].batchId,packageSha256:rows[0].packageSha256,evidence:boundedSupplementJson(rows[0].evidence) as BatchLocalCdrEvidence,zip:Buffer.from(rows[0].zip)};
  });}
  insertCdr(r:BatchLocalCdrArchive):Promise<void>{return this.run(async()=>{
    if(r.batchId!==this.scope.batchId)fail('INTEGRITY_FAILED');
    const n=await this.db.$executeRawUnsafe('INSERT INTO "BatchLocalCdr" ("batchId","packageSha256","evidence","zip") VALUES ($1::uuid,$2,$3::jsonb,$4)',
      r.batchId,r.packageSha256,JSON.stringify(r.evidence),Buffer.from(r.zip));if(n!==1)fail('STORE_UNAVAILABLE');
  });}
}
function sqlCode(error:any,code:string):boolean {
  return error?.code===code||error?.code==='P2010'&&[error.meta?.code,error.meta?.driverAdapterError?.cause?.originalCode].includes(code);
}
/** SUNAT-owned append-only bytea originals. SQL candidate must be explicitly installed in a NEW
 * isolated database. No schema install here, no filesystem paths or cross-service DB access. */
export class PostgresBatchLocalArtifactStore implements BatchLocalArtifactStore {
  constructor(private readonly db:GuideDispatchDatabase){}
  async transaction<T>(input:BatchLocalArtifactScope,work:(tx:BatchLocalArtifactTransaction)=>Promise<T>):Promise<T>{
    const s=validateBatchLocalArtifactScope(input);
    for(let attempt=0;attempt<3;attempt++){
      try{return await this.db.$transaction(async db=>{
        await db.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))','factuez:batch-local-artifact:'+s.batchId);
        const tx=new PgTransaction(db,s);
        try{const result=await work(tx);await tx.finish();return result;}catch(e){await tx.finish();throw e;}
      },{isolationLevel:'Serializable',timeout:30000,maxWait:3000});}
      catch(e){if(attempt<2&&['40001','P2034','23505','P2002'].some(c=>sqlCode(e,c)))continue;
        if(['23505','P2002'].some(c=>sqlCode(e,c)))fail('IDENTITY_CONFLICT');return safeError(e);}
    }
    return fail('STORE_UNAVAILABLE');
  }
}
