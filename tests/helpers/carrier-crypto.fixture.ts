import { vi } from 'vitest';
import { fiscalSnapshotSha256 as hash } from '../../packages/sunat-core/src/fiscal-note';
import { buildPublicGuide09Xml, projectPublicGuide09OwnerSnapshot, type PublicGuide09OwnerSnapshot } from '../../packages/sunat-core/src/public-guide-profile';
import { signLocalGuideXml } from '../../services/sunat-service/src/infrastructure/crypto/guide-artifact-crypto';
import { CarrierReferenceCryptoVerifier } from '../../services/sunat-service/src/application/carrier-reference-verifier';
import { createGuideSidecarPki, guideSidecarCdrXml } from './guide-sidecar-ephemeral-pki.fixture';
import { guideBinding, guideUuid } from './b2b-guide.fixture';

/** In-memory generated PKI only. The offline trust policy is explicitly a test
 * double; whole XMLDSig/RUC/pinned-certificate checks are real. No official CRL
 * or SUNAT certificate is represented as verified by this fixture. */
export function carrierCryptoFixture(senderPki: ReturnType<typeof createGuideSidecarPki>) {
  const sender = { ruc:'20000000001',legalName:'REMITENTE FICTICIO' }, carrier = {ruc:'20000000028',legalName:'TRANSPORTISTA FICTICIO'};
  const ownerSnapshot: PublicGuide09OwnerSnapshot = { schemaVersion:'factuez.public-guide09-issued-owner.v1',companyId:9,
    branchId:guideUuid(71),documentId:guideUuid(72),operationId:guideUuid(73),issuer:sender,series:'TQ31',number:'9',body:{
      issueDate:'2026-10-23T12:00:00.000Z',transferDate:'2026-10-24',sender,recipient:{ruc:'20000000036',legalName:'DESTINATARIO FICTICIO'},
      origin:{ubigeo:'150101',address:'ORIGEN FICTICIO'},destination:{ubigeo:'150102',address:'DESTINO FICTICIO'},carrier,
      grossWeight:'1.250',weightUnit:'KGM',transportMode:'01',regulatedGoods:false,reasonCode:'01',mtcRegistration:'MTC00031',
      items:[{code:'FICTICIO-1',description:'BIEN FICTICIO',quantity:'2.000001',unitCode:'NIU'}] } };
  const projection = projectPublicGuide09OwnerSnapshot(ownerSnapshot), unsigned = buildPublicGuide09Xml(ownerSnapshot);
  const signed = signLocalGuideXml({issuerRuc:sender.ruc,documentType:'09',fullNumber:'TQ31-9',unsignedXml:unsigned.xml},senderPki.issuer.pkcs12,senderPki.password);
  const expected = {issuerRuc:sender.ruc,documentType:'09' as const,fullNumber:'TQ31-9',requestXmlSha256:signed.xmlSha256,
    requestZipSha256:signed.zipSha256,issuedAt:ownerSnapshot.body.issueDate,receivedAt:'2026-10-23T16:00:00.000Z'};
  const cdrXml = Buffer.from(senderPki.signCdr(guideSidecarCdrXml(expected)));
  const input = {ownerSnapshot,ownerSnapshotSha256:hash(ownerSnapshot),projection,projectionSha256:hash(projection),
    signedXml:Buffer.from(signed.xml),signedXmlSha256:signed.xmlSha256,cdrXml,cdrSha256:hashBytes(cdrXml)};
  const pins = {current:vi.fn(async () => ({fingerprint:senderPki.issuer.fingerprint,revision:'a'.repeat(64)}))};
  const certificates = {load:vi.fn(async () => ({certificatePem:senderPki.issuer.certificatePem,chainPems:senderPki.issuer.chainPems}))};
  const trust = {evaluate:vi.fn(async (metadata: any,ruc: string,now: Date) => ({profile:'OFFLINE-PINNED-ROOTS-CRL-v1' as const,
    chainValid:true,identityMatched:ruc === sender.ruc,revocation:'VERIFIED_OFFLINE_CRL' as const,blockers:[],
    certificateFingerprint:metadata.fingerprint,trustStoreSha256:'b'.repeat(64),checkedAt:now.toISOString()}))};
  const verifier = new CarrierReferenceCryptoVerifier(pins,certificates,trust,senderPki.cdrVerifier,() => expected.receivedAt);
  const binding = {draft:guideBinding('31'),fiscalSeriesId:guideUuid(75)}; binding.draft.anchor.issuerRuc = carrier.ruc;
  return {sender,carrier,ownerSnapshot,projection,unsigned,signed,expected,input,pins,certificates,trust,verifier,binding};
}
import {createHash} from 'node:crypto';
export const hashBytes = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
