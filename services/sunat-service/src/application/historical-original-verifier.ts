import {createHash} from 'node:crypto';
import {checkHistoricalOriginal,type HistoricalOriginalStore} from './historical-original-contract';
import type {BatchMemberArtifactPort} from './batch-member-evidence';
import type {BetaOwnerXmlTrust} from '../infrastructure/crypto/beta-owner-xml-trust';
import {singleNotesTransportXml} from '../infrastructure/sunat/notes-transport-qa-validator';
import {betaCdrZipMetadata,betaCdrCrc32} from './beta-summary-acceptance';

/** Internal read-only verifier. A durable owner and a trusted certificate policy
 * must be supplied by the caller. No acceptance or delivery is inferred. */
export async function verifyHistoricalOriginal(handle:string,asOf:string,ports:{
 store:Pick<HistoricalOriginalStore,'loadExact'>; artifacts:BatchMemberArtifactPort;
 signatures:Pick<BetaOwnerXmlTrust,'verifyPreparedDocument'>;
}){
 try{
  const load=async()=>{const value=await ports.store.loadExact(handle);if(!value)throw Error();return checkHistoricalOriginal(value,handle);};
  const first=await load(),doc=first.snapshot,read=async(a:typeof first.signedXml)=>{
   const bytes=await ports.artifacts.read(doc.documentId,structuredClone(a));
   if(!Buffer.isBuffer(bytes)||bytes.length!==a.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw Error();
   return Buffer.from(bytes);
  };
  const xml=await read(first.signedXml),zip=await read(first.documentZip);
  const filename=`${first.binding.issuerRuc}-${first.binding.documentType}-${doc.fullNumber}.zip`;
  const entry=singleNotesTransportXml(zip,filename),meta=betaCdrZipMetadata(zip,filename.replace(/\.zip$/,'.xml'));
  if(!entry.equals(xml)||meta.size!==xml.length||meta.crc!==betaCdrCrc32(xml))throw Error();
  const proof=await ports.signatures.verifyPreparedDocument(structuredClone(doc),first.signerFingerprint,Buffer.from(xml),asOf);
  if(proof.certificateFingerprint!==first.signerFingerprint||proof.digestValue!==first.digestValue||proof.checkedAt!==asOf||
   !/^[a-f0-9]{64}$/.test(proof.trustStoreSha256))throw Error();
  const second=await load();if(second.recordSha256!==first.recordSha256||!(await read(first.signedXml)).equals(xml)||!(await read(first.documentZip)).equals(zip))throw Error();
  const last=await load();if(last.recordSha256!==first.recordSha256)throw Error();
  return Object.freeze({schemaVersion:'factuez.historical-original-verified.v1' as const,member:structuredClone(first.member),
   binding:structuredClone(first.binding),recordSha256:first.recordSha256,signedXmlSha256:first.signedXml.sha256,
   documentZipSha256:first.documentZip.sha256,verifiedAt:asOf,acceptance:'NOT_VERIFIED' as const});
 }catch{throw new Error('HISTORICAL_ORIGINAL_VERIFICATION_FAILED');}
}
