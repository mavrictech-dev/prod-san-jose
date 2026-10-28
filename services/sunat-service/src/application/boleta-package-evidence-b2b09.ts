import {createHash} from 'node:crypto';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import {buildFiscalBatchUbl, type FiscalBatchSnapshot} from '@factuez/sunat-core/dist/fiscal-batch';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type {BetaAcceptanceArtifact, BetaAcceptanceDocument} from './beta-document-acceptance';
import type {BetaOwnerXmlTrust} from '../infrastructure/crypto/beta-owner-xml-trust';
import {singleNotesTransportXml} from '../infrastructure/sunat/notes-transport-qa-validator';
import {betaCdrZipMetadata, betaCdrCrc32} from './beta-summary-acceptance';

/** Candidate only: owner must resolve the exact immutable version, not latest or public input. */
export type BoletaPackageRecord = {
  document: BetaAcceptanceDocument; memberXml: BetaAcceptanceArtifact; memberFingerprint: string; memberDigest: string;
  transport: {kind:'INDIVIDUAL'; zip:BetaAcceptanceArtifact} | {kind:'RC'; zip:BetaAcceptanceArtifact;
    batch:FiscalBatchSnapshot; signedXml:BetaAcceptanceArtifact; fingerprint:string; digest:string};
};
type Ports = {load:()=>Promise<BoletaPackageRecord|null>; read:(documentId:string, artifact:BetaAcceptanceArtifact)=>Promise<Buffer>;
  signatures:Pick<BetaOwnerXmlTrust,'verifyPreparedDocument'|'verifyBatch'>};
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const digest=/^[A-Za-z0-9+/]{43}=$/, sha=/^[a-f0-9]{64}$/;
const fail=():never=>{throw new Error('BOLETA_PACKAGE_INVALID');};

/** Verifies packaging, issuer signatures and (for RC) exact membership. Never verifies acceptance. */
export async function verifyBoletaPackage(ports:Ports, asOf:string) {
  try {
    const load=async()=>{const value=await ports.load(); if(!value)return fail(); return boundedSupplementJson(value) as BoletaPackageRecord;};
    const record=await load(), stamp=fiscalSnapshotSha256(record), d=record.document, t=record.transport;
    if(d.environment!=='BETA'||d.documentTypeCode!=='03'||!/^B[A-Z0-9]{3}$/.test(d.series)||
      !/^\d{11}$/.test(d.issuer.identityNumber)||!sha.test(record.memberFingerprint)||!digest.test(record.memberDigest)||
      !t||!['INDIVIDUAL','RC'].includes(t.kind))return fail();
    const checked:{id:string; artifact:BetaAcceptanceArtifact; bytes:Buffer}[]=[];
    const read=async(id:string,a:BetaAcceptanceArtifact,max:number)=>{
      if(!a||typeof a.id!=='string'||typeof a.storageKey!=='string'||!a.id||!a.storageKey||
        !sha.test(a.sha256)||!Number.isSafeInteger(a.sizeBytes)||a.sizeBytes<1||a.sizeBytes>max)return fail();
      const b=await ports.read(id,structuredClone(a));
      if(!Buffer.isBuffer(b)||b.length!==a.sizeBytes||hash(b)!==a.sha256)return fail();
      const bytes=Buffer.from(b);checked.push({id,artifact:structuredClone(a),bytes});return bytes;
    };
    const xml=await read(d.documentId,record.memberXml,2*1024*1024);
    const member=await ports.signatures.verifyPreparedDocument(structuredClone(d),record.memberFingerprint,Buffer.from(xml),asOf);
    if(member.certificateFingerprint!==record.memberFingerprint||member.digestValue!==record.memberDigest||member.checkedAt!==asOf||!sha.test(member.trustStoreSha256))return fail();
    let expected:Buffer, filename:string, ownerId:string, lineNumber:number|null=null;
    if(t.kind==='INDIVIDUAL'){
      expected=xml;ownerId=d.documentId;filename=`${d.issuer.identityNumber}-03-${d.fullNumber}.zip`;
    }else if(t.kind==='RC'){
      const b=t.batch;
      if(!b||b.kind!=='RC'||b.environment!=='BETA'||b.issuer.identityNumber!==d.issuer.identityNumber||
        !sha.test(t.fingerprint)||!digest.test(t.digest)||!Array.isArray(b.input.entries))return fail();
      const matches=b.input.entries.map((e,i)=>({e,i})).filter(({e})=>e.document.snapshot.documentId===d.documentId||
        (e.document.snapshot.documentTypeCode===d.documentTypeCode&&e.document.snapshot.fullNumber===d.fullNumber));
      if(matches.length!==1||fiscalSnapshotSha256(matches[0].e.document.snapshot)!==fiscalSnapshotSha256(d))return fail();
      lineNumber=matches[0].i+1;ownerId=b.documentId;filename=`${d.issuer.identityNumber}-${b.identifier}.zip`;
      expected=await read(ownerId,t.signedXml,2*1024*1024);
      const proof=await ports.signatures.verifyBatch(structuredClone(b),t.fingerprint,Buffer.from(expected),buildFiscalBatchUbl(b,asOf),asOf);
      if(proof.certificateFingerprint!==t.fingerprint||proof.digestValue!==t.digest||proof.checkedAt!==asOf||!sha.test(proof.trustStoreSha256))return fail();
    }else return fail();
    const zip=await read(ownerId,t.zip,4*1024*1024), archived=singleNotesTransportXml(zip,filename);
    const metadata=betaCdrZipMetadata(zip,filename.replace(/\.zip$/,'.xml'));
    if(!archived.equals(expected)||metadata.size!==expected.length||metadata.crc!==betaCdrCrc32(expected))return fail();
    if(fiscalSnapshotSha256(await load())!==stamp)return fail();
    for(const item of checked){const next=await ports.read(item.id,structuredClone(item.artifact));if(!Buffer.isBuffer(next)||!next.equals(item.bytes))return fail();}
    if(fiscalSnapshotSha256(await load())!==stamp)return fail();
    return Object.freeze({kind:t.kind,memberXmlSha256:hash(xml),requestZipSha256:hash(zip),
      rcXmlSha256:t.kind==='RC'?hash(expected):null,rcIdentifier:t.kind==='RC'?t.batch.identifier:null,lineNumber});
  }catch{return fail();}
}