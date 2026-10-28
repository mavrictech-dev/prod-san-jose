import { createHash } from 'node:crypto';
import { fiscalDate, fiscalLimaDate, fiscalRuc, fiscalTimestamp } from '@factuez/sunat-core/dist/fiscal-note';
import type { CdrSignatureTrustService } from '../infrastructure/crypto/cdr-signature-trust.service';
import { parseSafeInvoice } from '../infrastructure/crypto/xml-signer.service';
import { parseCdrZip } from '../infrastructure/sunat/cdr-parser';
import { CAC_NS, CBC_NS, children, type safeXml } from '../infrastructure/sunat/safe-xml';
import { betaCdrCrc32, betaCdrZipMetadata } from './beta-summary-acceptance';

export type GuideCdrExpected = {
  issuerRuc: string; documentType: '09' | '31'; fullNumber: string;
  requestXmlSha256: string; requestZipSha256: string; issuedAt: string; receivedAt: string;
  /** Caller-owned provenance, never inferred from ResponseCode, KeyInfo or a verifier flag. Defaults to LOCAL_EMULATOR. */
  source?: 'LOCAL_EMULATOR' | 'EXTERNAL_CDR';
};
export type GuideCdrEvidenceErrorCode = 'GUIDE_CDR_INPUT_INVALID' | 'GUIDE_CDR_ARCHIVE_INVALID' | 'GUIDE_CDR_XML_INVALID'
  | 'GUIDE_CDR_BINDING_MISMATCH' | 'GUIDE_CDR_DATE_INVALID' | 'GUIDE_CDR_SIGNATURE_UNTRUSTED' | 'GUIDE_CDR_INPUT_CHANGED';
export class GuideCdrEvidenceError extends Error {
  constructor(readonly code: GuideCdrEvidenceErrorCode) { super(code); this.name = 'GuideCdrEvidenceError'; }
}
export type GuideCdrEvidence = Readonly<{
  profile: 'LOCAL_GUIDE_CDR_REVIEW_V1'; source: 'LOCAL_EMULATOR' | 'EXTERNAL_CDR';
  issuerRuc: string; documentType: '09' | '31'; fullNumber: string; issuedAt: string; receivedAt: string;
  requestXmlSha256: string; requestZipSha256: string; requestHashesBoundByCdr: false;
  cdrFileName: string; cdrZipSha256: string; cdrXmlSha256: string;
  responseCode: string; status: 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS' | 'REJECTED'; description: string; notes: readonly string[];
  signatureTrusted: true; cryptographicReceiptVerified: true; bindingComplete: true;
  officialCdrVerified: false; transmissionAuthorized: false; authorizedForTransfer: false;
}>;
function deny(code: GuideCdrEvidenceErrorCode): never { throw new GuideCdrEvidenceError(code); }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const DS = 'http://www.w3.org/2000/09/xmldsig#';
type Element = ReturnType<typeof safeXml>;
function one(parent: Element, ns: string, name: string): Element {
  const matches = children(parent, ns, name); let count = 0;
  for (let n = parent.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n as Element).localName === name) count++;
  if (matches.length !== 1 || count !== 1) deny('GUIDE_CDR_XML_INVALID');
  return matches[0];
}
function text(parent: Element, ns: string, name: string, max: number): string {
  const node = one(parent, ns, name), value = node.textContent ?? '';
  if (!value || value !== value.trim() || value.length > max || node.getElementsByTagName('*').length) deny('GUIDE_CDR_XML_INVALID');
  return value;
}
function optionalText(root: Element, name: string, max: number): string | undefined {
  for (let n = root.firstChild; n; n = n.nextSibling)
    if (n.nodeType === 1 && (n as Element).localName === name) return text(root, CBC_NS, name, max);
  return undefined;
}
function dates(root: Element, expected: GuideCdrExpected): void {
  try {
    const issueDay = text(root, CBC_NS, 'IssueDate', 10), responseDay = optionalText(root, 'ResponseDate', 10);
    const issueTime = optionalText(root, 'IssueTime', 24), responseTime = optionalText(root, 'ResponseTime', 24);
    const start = Date.parse(expected.issuedAt), finish = Date.parse(expected.receivedAt);
    const validate = (day: string, time: string | undefined) => {
      fiscalDate(day, 'CDR.date');
      if (day < fiscalLimaDate(expected.issuedAt) || day > fiscalLimaDate(expected.receivedAt)) deny('GUIDE_CDR_DATE_INVALID');
      if (time === undefined) return undefined;
      if (!/^\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)?$/.test(time)) deny('GUIDE_CDR_DATE_INVALID');
      const timestamp = `${day}T${time}${/(?:Z|[+-]\d\d:\d\d)$/.test(time) ? '' : '-05:00'}`;
      fiscalTimestamp(timestamp, 'CDR.time');
      const instant = Date.parse(timestamp);
      if (instant < start || instant > finish) deny('GUIDE_CDR_DATE_INVALID');
      return instant;
    };
    const issue = validate(issueDay, issueTime);
    if (responseTime !== undefined && responseDay === undefined) deny('GUIDE_CDR_DATE_INVALID');
    if (responseDay !== undefined) {
      const response = validate(responseDay, responseTime);
      if (responseDay < issueDay || (issue !== undefined && response !== undefined && response < issue)) deny('GUIDE_CDR_DATE_INVALID');
    }
  } catch { deny('GUIDE_CDR_DATE_INVALID'); }
}

/** Strict identity/date/archive binding plus mandatory trusted XMLDSig port, with no I/O or automatic activation.
 * The port must be owner-injected CdrSignatureTrustService (or an equally strict verifier), never a request flag.
 * Request hashes are local correlation only: this CDR profile has no signed field authenticating those hashes.
 * Status describes the authenticated response code, including rejection; it grants no official capability.
 */
export async function verifyGuideCdrEvidence(expected: GuideCdrExpected, cdrZip: Buffer,
  verifier: Pick<CdrSignatureTrustService, 'verify'>): Promise<GuideCdrEvidence> {
  let snapshot: GuideCdrExpected, original: string, zip: Buffer;
  try {
    if (!expected || Object.keys(expected).some(key => !['issuerRuc', 'documentType', 'fullNumber', 'requestXmlSha256', 'requestZipSha256', 'issuedAt', 'receivedAt', 'source'].includes(key))) deny('GUIDE_CDR_INPUT_INVALID');
    snapshot = structuredClone(expected); original = JSON.stringify(expected);
    fiscalRuc(snapshot.issuerRuc, 'issuerRuc'); fiscalTimestamp(snapshot.issuedAt, 'issuedAt'); fiscalTimestamp(snapshot.receivedAt, 'receivedAt');
    if (!['09', '31'].includes(snapshot.documentType) || typeof snapshot.fullNumber !== 'string' ||
      !(snapshot.documentType === '09' ? /^T[A-Z0-9]{3}-[1-9][0-9]{0,7}$/ : /^V[A-Z0-9]{3}-[1-9][0-9]{0,7}$/).test(snapshot.fullNumber) ||
      !HASH.test(snapshot.requestXmlSha256) || !HASH.test(snapshot.requestZipSha256) || Date.parse(snapshot.receivedAt) < Date.parse(snapshot.issuedAt) ||
      (snapshot.source !== undefined && !['LOCAL_EMULATOR', 'EXTERNAL_CDR'].includes(snapshot.source)) ||
      !verifier || typeof verifier.verify !== 'function') deny('GUIDE_CDR_INPUT_INVALID');
    if (!Buffer.isBuffer(cdrZip) || cdrZip.length < 22 || cdrZip.length > 4 * 1024 * 1024) deny('GUIDE_CDR_ARCHIVE_INVALID');
    zip = Buffer.from(cdrZip);
  } catch (error) { if (error instanceof GuideCdrEvidenceError) throw error; deny('GUIDE_CDR_INPUT_INVALID'); }
  const fileName = `R-${snapshot.issuerRuc}-${snapshot.documentType}-${snapshot.fullNumber}.xml`;
  let metadata: ReturnType<typeof betaCdrZipMetadata>;
  try { metadata = betaCdrZipMetadata(zip, fileName); } catch { deny('GUIDE_CDR_ARCHIVE_INVALID'); }
  let parsed: ReturnType<typeof parseCdrZip>;
  try {
    parsed = parseCdrZip(zip, { fileName, issuerRuc: snapshot.issuerRuc, reference: snapshot.fullNumber });
    if (parsed.xml.length !== metadata.size || betaCdrCrc32(parsed.xml) !== metadata.crc ||
      !Buffer.from(parsed.xml.toString('utf8')).equals(parsed.xml)) deny('GUIDE_CDR_XML_INVALID');
    const { root, extension, document } = parseSafeInvoice(parsed.xml.toString('utf8'), 'ApplicationResponse');
    const sender = one(one(root, CAC_NS, 'SenderParty'), CAC_NS, 'PartyIdentification');
    const receiver = one(one(root, CAC_NS, 'ReceiverParty'), CAC_NS, 'PartyIdentification');
    const response = one(root, CAC_NS, 'DocumentResponse'), reference = one(response, CAC_NS, 'DocumentReference'), answer = one(response, CAC_NS, 'Response');
    if (text(sender, CBC_NS, 'ID', 11) !== '20131312955' || text(receiver, CBC_NS, 'ID', 11) !== snapshot.issuerRuc ||
      text(reference, CBC_NS, 'ID', 40) !== snapshot.fullNumber || text(reference, CBC_NS, 'DocumentTypeCode', 2) !== snapshot.documentType ||
      text(answer, CBC_NS, 'ReferenceID', 40) !== snapshot.fullNumber || text(answer, CBC_NS, 'ResponseCode', 8) !== parsed.code) deny('GUIDE_CDR_BINDING_MISMATCH');
    dates(root, snapshot);
    const signatures = document.getElementsByTagNameNS(DS, 'Signature');
    if (signatures.length !== 1 || signatures[0].parentNode !== extension) deny('GUIDE_CDR_SIGNATURE_UNTRUSTED');
  } catch (error) { if (error instanceof GuideCdrEvidenceError) throw error; deny('GUIDE_CDR_XML_INVALID'); }
  const verificationBytes = Buffer.from(parsed.xml);
  try { if (await verifier.verify(verificationBytes) !== true) deny('GUIDE_CDR_SIGNATURE_UNTRUSTED'); }
  catch { deny('GUIDE_CDR_SIGNATURE_UNTRUSTED'); }
  try {
    if (JSON.stringify(expected) !== original || !cdrZip.equals(zip) || !verificationBytes.equals(parsed.xml)) deny('GUIDE_CDR_INPUT_CHANGED');
  } catch { deny('GUIDE_CDR_INPUT_CHANGED'); }
  return Object.freeze({ profile: 'LOCAL_GUIDE_CDR_REVIEW_V1', source: snapshot.source ?? 'LOCAL_EMULATOR',
    issuerRuc: snapshot.issuerRuc, documentType: snapshot.documentType, fullNumber: snapshot.fullNumber,
    issuedAt: snapshot.issuedAt, receivedAt: snapshot.receivedAt, requestXmlSha256: snapshot.requestXmlSha256, requestZipSha256: snapshot.requestZipSha256,
    requestHashesBoundByCdr: false, cdrFileName: fileName, cdrZipSha256: hash(zip), cdrXmlSha256: hash(parsed.xml),
    responseCode: parsed.code, status: parsed.status, description: parsed.description, notes: Object.freeze([...parsed.notes]),
    signatureTrusted: true, cryptographicReceiptVerified: true, bindingComplete: true,
    officialCdrVerified: false, transmissionAuthorized: false, authorizedForTransfer: false });
}
