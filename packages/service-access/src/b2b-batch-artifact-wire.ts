import {createHash} from 'node:crypto';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from './b2b-correction-evidence-wire';
export const BATCH_ARTIFACT_KINDS=['xml','zip','cdr-xml','cdr-zip'] as const;
export type BatchArtifactKind=typeof BATCH_ARTIFACT_KINDS[number];
export type BatchArtifactScope={environment:'BETA';issuerRuc:string;companyId:number;branchId:string;batchId:string};
const FLAGS={candidateOnly:true,localOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false,
  officialCdrVerified:false,certificateTrusted:false,signatureVerifiedLocally:true} as const;
export type BatchArtifactMetadata=typeof FLAGS & {schemaVersion:'factuez.batch-artifacts-local.v1';scope:BatchArtifactScope;
  operationId:string;eventId:string;kind:'RC'|'RA';identifier:string;commandSha256:string;envelopeSha256:string;batchSnapshotSha256:string;
  unsignedXmlSha256:string;xmlSha256:string;zipSha256:string;digestValue:string;certificateFingerprintSha256:string;fileName:string};
export type BatchArtifactView={schemaVersion:'factuez.b2b.batch-artifacts.v1';scope:BatchArtifactScope;metadata:BatchArtifactMetadata;replayed:boolean|null};
export type BatchArtifactFile={bytes:Buffer;sha256:string;fileName:string;mediaType:string};
function invalid():never{throw new B2bSecurityError(400,'INVALID_BATCH_ARTIFACT_REQUEST');}
function exact(v:any,keys:string[]){if(!v||Array.isArray(v)||typeof v!=='object'||Object.keys(v).sort().join(',')!==keys.sort().join(','))invalid();}
export function batchArtifactScope(value:unknown):BatchArtifactScope{
  const s:any=correctionEvidenceFreeze(value);exact(s,['environment','issuerRuc','companyId','branchId','batchId']);
  if(s.environment!=='BETA'||typeof s.issuerRuc!=='string'||!/^\d{11}$/.test(s.issuerRuc)||!Number.isSafeInteger(s.companyId)||
    s.companyId<1||s.companyId>2147483647||!b2bUuid(s.branchId)||!b2bUuid(s.batchId))invalid();return s;
}
export function batchArtifactView(value:unknown,scope:BatchArtifactScope,prepare:boolean):BatchArtifactView{
  try{
    const v:any=correctionEvidenceFreeze(value),m=v.metadata;
    if(Buffer.byteLength(JSON.stringify(v))>32768)throw new Error();
    exact(v,['schemaVersion','scope','metadata','replayed']);
    exact(m,['schemaVersion','scope','operationId','eventId','kind','identifier','commandSha256','envelopeSha256','batchSnapshotSha256',
      'unsignedXmlSha256','xmlSha256','zipSha256','digestValue','certificateFingerprintSha256','fileName',...Object.keys(FLAGS)]);
    if(v.schemaVersion!=='factuez.b2b.batch-artifacts.v1'||hash(batchArtifactScope(v.scope))!==hash(scope)||
      hash(batchArtifactScope(m.scope))!==hash(scope)||m.schemaVersion!=='factuez.batch-artifacts-local.v1'||m.operationId!==scope.batchId||!b2bUuid(m.eventId)||
      !['RC','RA'].includes(m.kind)||typeof m.identifier!=='string'||!new RegExp('^'+m.kind+'-[0-9]{8}-[1-9][0-9]{0,14}$').test(m.identifier)||
      m.fileName!==`${scope.issuerRuc}-${m.identifier}.zip`||Object.entries(FLAGS).some(([k,x])=>m[k]!==x)||
      (prepare?typeof v.replayed!=='boolean':v.replayed!==null))throw new Error();
    for(const k of ['commandSha256','envelopeSha256','batchSnapshotSha256','unsignedXmlSha256','xmlSha256','zipSha256','certificateFingerprintSha256'])
      if(typeof m[k]!=='string'||!/^[a-f0-9]{64}$/.test(m[k]))throw new Error();
    if(typeof m.digestValue!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(m.digestValue)||![20,32].includes(Buffer.from(m.digestValue,'base64').length)||
      Buffer.from(m.digestValue,'base64').toString('base64')!==m.digestValue)throw new Error();
    return v;
  }catch{throw new B2bSecurityError(503,'INVALID_BATCH_ARTIFACT_OWNER_RESPONSE');}
}
export function batchArtifactFile(value:BatchArtifactFile,view:BatchArtifactView,kind:BatchArtifactKind):BatchArtifactFile{
  if(!BATCH_ARTIFACT_KINDS.includes(kind))invalid();
  const cdr=kind.startsWith('cdr'),xml=kind.endsWith('xml'),name=(cdr?'R-':'')+view.metadata.fileName.replace(/\.zip$/,xml?'.xml':'.zip');
  if(!value||!Buffer.isBuffer(value.bytes)||!value.bytes.length||value.bytes.length>4*1024*1024||value.fileName!==name||
    value.mediaType!==(xml?'application/xml':'application/zip')||createHash('sha256').update(value.bytes).digest('hex')!==value.sha256||
    !/^[a-f0-9]{64}$/.test(value.sha256)||!cdr&&value.sha256!==(xml?view.metadata.xmlSha256:view.metadata.zipSha256))
    throw new B2bSecurityError(409,'BATCH_ARTIFACT_INTEGRITY_FAILED');
  return {...value,bytes:Buffer.from(value.bytes)};
}
