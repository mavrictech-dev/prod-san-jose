import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { fiscalSnapshotSha256 as hash, fiscalTimestamp } from '@factuez/sunat-core/dist/fiscal-note';
import { buildPublicGuide09Xml, projectPublicGuide09OwnerSnapshot, type PublicGuide09OwnerSnapshot } from '@factuez/sunat-core/dist/public-guide-profile';
import type { CarrierReference09Snapshot, CarrierReference09Evidence } from '@factuez/sunat-core/dist/carrier-guide-profile';
import { verifyGuideIssuerXmlTrust } from '../infrastructure/crypto/guide-artifact-crypto';
import type { BetaIssuerPublicCertificates } from '../infrastructure/crypto/beta-owner-xml-trust';
import type { CertificateTrustService } from '../infrastructure/crypto/certificate-trust.service';
import type { CdrSignatureTrustService } from '../infrastructure/crypto/cdr-signature-trust.service';
import { verifyGuideCdrEvidence } from './guide-cdr-evidence';
import { safeXml, children, CBC_NS } from '../infrastructure/sunat/safe-xml';

export type CarrierReferenceVerifyInput = { ownerSnapshot: PublicGuide09OwnerSnapshot; ownerSnapshotSha256: string;
  projection: CarrierReference09Snapshot; projectionSha256: string; signedXml: Uint8Array; signedXmlSha256: string;
  cdrXml: Uint8Array; cdrSha256: string };
/** The fingerprint is an owner-selected PUBLIC pin, not a value trusted from
 * the incoming KeyInfo or uploaded certificate. Revoked/unknown slots deny. */
export interface CarrierReferenceSignerPins {
  current(issuerRuc: string, documentId: string, ownerSnapshotSha256: string): Promise<{ fingerprint: string; revision: string }>;
}
const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
function deny(): never { throw new Error('CARRIER_REFERENCE_CRYPTO_UNVERIFIED'); }
function timeOfCdr(xml: string) {
  const root = safeXml(xml);
  const leaf = (name: string, required = true) => {
    const all = children(root,CBC_NS,name); let aliases = 0;
    for (let n = root.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n as typeof root).localName === name) aliases++;
    if (!required && !all.length && aliases === 0) return null;
    if (all.length !== 1 || aliases !== 1 || all[0].getElementsByTagName('*').length) deny();
    return all[0].textContent;
  };
  const responseDay = leaf('ResponseDate',false), responseTime = leaf('ResponseTime',false);
  // No invented midnight/current-time acceptance: a precise CDR instant is required.
  const day = responseDay ?? leaf('IssueDate'), time = responseDay ? responseTime : leaf('IssueTime');
  if (!day || !time || !/^\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)?$/.test(time)) deny();
  const value = `${day}T${time}${/(?:Z|[+-]\d\d:\d\d)$/.test(time) ? '' : '-05:00'}`;
  fiscalTimestamp(value,'CDR.acceptedAt'); return new Date(value).toISOString();
}
/** Structural implementation of Billing's private reference verifier. No
 * Billing imports/DB access: all full-document crypto stays with SUNAT owner. */
export class CarrierReferenceCryptoVerifier {
  constructor(private readonly pins: CarrierReferenceSignerPins, private readonly certificates: BetaIssuerPublicCertificates,
    private readonly trust: Pick<CertificateTrustService,'evaluate'>, private readonly cdr: Pick<CdrSignatureTrustService,'verify'>,
    private readonly now = () => new Date().toISOString()) {}
  async verify(input: Readonly<CarrierReferenceVerifyInput>): Promise<CarrierReference09Evidence['acceptance']> {
    try {
      const s = boundedSupplementJson(input.ownerSnapshot) as PublicGuide09OwnerSnapshot;
      const projection = projectPublicGuide09OwnerSnapshot(s), xml = Buffer.from(input.signedXml), cdrXml = Buffer.from(input.cdrXml);
      if (!xml.length || xml.length > 384*1024 || !cdrXml.length || cdrXml.length > 384*1024 ||
        hash(s) !== input.ownerSnapshotSha256 || hash(projection) !== input.projectionSha256 ||
        hash(projection) !== hash(input.projection) || sha(xml) !== input.signedXmlSha256 || sha(cdrXml) !== input.cdrSha256 ||
        !Buffer.from(xml.toString('utf8')).equals(xml) || !Buffer.from(cdrXml.toString('utf8')).equals(cdrXml)) deny();
      const expected = buildPublicGuide09Xml(s), asOf = this.now(); fiscalTimestamp(asOf,'asOf');
      const pin = boundedSupplementJson(await this.pins.current(s.issuer.ruc,s.documentId,input.ownerSnapshotSha256)) as {fingerprint:string;revision:string};
      if (!pin || Object.keys(pin).sort().join(',') !== 'fingerprint,revision' || !/^[a-f0-9]{64}$/.test(pin.fingerprint) || !/^[a-f0-9]{64}$/.test(pin.revision)) deny();
      const fullNumber = `${s.series}-${s.number}`;
      await verifyGuideIssuerXmlTrust({ issuerRuc:s.issuer.ruc, documentType:'09', fullNumber, unsignedXml:expected.xml,
        xml:xml.toString('utf8'), certificateFingerprintSha256:pin.fingerprint, asOf },this.certificates,this.trust);
      // This temporary envelope is only a strict in-memory XML/signature review.
      // Its ZIP hash is not represented as an original CDR archive.
      const temporaryZip = Buffer.from(zipSync({ [`R-${s.issuer.ruc}-09-${fullNumber}.xml`]:cdrXml }, {level:0,mtime:new Date(2000,0,1)}));
      const evidence = await verifyGuideCdrEvidence({ issuerRuc:s.issuer.ruc,documentType:'09',fullNumber,
        requestXmlSha256:sha(xml),requestZipSha256:sha('LOCAL_REVIEW_ENVELOPE_NOT_ORIGINAL_REQUEST'),
        issuedAt:s.body.issueDate,receivedAt:asOf,source:'EXTERNAL_CDR' },temporaryZip,this.cdr);
      if (evidence.responseCode !== '0' || !['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(evidence.status) || evidence.cdrXmlSha256 !== sha(cdrXml)) deny();
      const acceptedAt = timeOfCdr(cdrXml.toString('utf8'));
      if (acceptedAt < s.body.issueDate || acceptedAt > asOf ||
        hash(await this.pins.current(s.issuer.ruc,s.documentId,input.ownerSnapshotSha256)) !== hash(pin) ||
        sha(input.signedXml) !== sha(xml) || sha(input.cdrXml) !== sha(cdrXml) || hash(input.ownerSnapshot) !== hash(s)) deny();
      return Object.freeze({ environment:'BETA',documentId:s.documentId,issuerRuc:s.issuer.ruc,fullNumber,
        snapshotSha256:hash(projection),cdrSha256:sha(cdrXml),responseCode:'0',status:evidence.status as 'ACCEPTED'|'ACCEPTED_WITH_OBSERVATIONS',acceptedAt });
    } catch { return deny(); }
  }
}
