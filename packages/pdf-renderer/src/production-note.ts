import { PRODUCTION_NOTES_PROFILE, PRODUCTION_NOTES_EXTENDED_PROFILE, type ProductionNotesAnySnapshot } from '@factuez/contracts';
import type { ProductionPdfEvidence } from './production';
import { dateParts, type PrintFormat } from './types';

/** Drawing contract only: backend must independently verify original acceptance, note XML,
 * pinned public signer PKI/CRL, exact ZIP and final note CDR before supplying this evidence. */
export type ProductionNotePdfEvidence = ProductionPdfEvidence;
export async function renderProductionNotePdf(snapshot: ProductionNotesAnySnapshot, format: PrintFormat,
  evidence: ProductionNotePdfEvidence,
  draw: (snapshot: ProductionNotesAnySnapshot, format: PrintFormat, qa: undefined, evidence: ProductionPdfEvidence) => Promise<Buffer>,
): Promise<Buffer> {
  const type = snapshot?.documentTypeCode, extended=snapshot?.profile===PRODUCTION_NOTES_EXTENDED_PROFILE, rc=snapshot?.reference?.documentTypeCode==='03';
  const number=rc?/^B[A-Z0-9]{3}-[1-9]\d{0,7}$/:/^F[A-Z0-9]{3}-[1-9]\d{0,7}$/;
  const reasons=extended?(type==='07'?['01','02','03','04','05','06','07','08','09','10']:['01','02','03']):(type==='07'?['01']:['02']);
  const summary=evidence?.receiptSummary, hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  if(rc ? !extended||!summary||!/^RC-\d{8}-[1-9]\d{0,4}$/.test(summary.identifier)||![summary.individualXmlSha256,summary.individualZipSha256,summary.summaryXmlSha256,summary.summaryZipSha256].every(hash)||
     (evidence.status==='PENDING'?(summary.cdrXmlSha256!==undefined||summary.cdrZipSha256!==undefined):![summary.cdrXmlSha256,summary.cdrZipSha256].every(hash)) : evidence!=null && 'receiptSummary' in evidence) throw Error('Evidencia del RC de nota incompleta');
  if (!snapshot || snapshot.environment !== 'PRODUCTION' || snapshot.currencyCode !== 'PEN' || snapshot.operationTypeCode !== '0101' ||
      ![PRODUCTION_NOTES_PROFILE,PRODUCTION_NOTES_EXTENDED_PROFILE].includes(snapshot.profile) || !['07', '08'].includes(type) ||
      !reasons.includes(snapshot.reasonCode) || snapshot.adjustment?.documentTypeCode !== type ||
      snapshot.adjustment.reasonCode !== snapshot.reasonCode || snapshot.adjustment.reasonDescription !== snapshot.reasonDescription ||
      !snapshot.reference || !['01','03'].includes(snapshot.reference.documentTypeCode) || !number.test(snapshot.reference.fullNumber) ||
      !number.test(snapshot.fullNumber) || snapshot.fullNumber !== `${snapshot.series}-${snapshot.number}` ||
      snapshot.reference.documentId === snapshot.documentId || snapshot.originalAcceptance?.documentId !== snapshot.reference.documentId ||
      snapshot.originalAcceptance.snapshotSha256 !== snapshot.reference.snapshotSha256 ||
      snapshot.originalAcceptance.profile !== (rc?'PRODUCTION-03-RC-ARCHIVE-v1':'PRODUCTION-01-ARCHIVE-v1') ||
      evidence?.environment !== 'PRODUCTION' ||
      !['PENDING', 'ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(evidence.status) ||
      !/^[A-Za-z0-9+/]{43}=$/.test(evidence.digestValue) || Buffer.from(evidence.digestValue, 'base64').toString('base64') !== evidence.digestValue ||
      (evidence.status === 'PENDING' ? evidence.responseCode !== undefined : evidence.status === 'REJECTED' ?
        !/^[1-9]\d{0,7}$/.test(evidence.responseCode ?? '') : evidence.responseCode !== '0'))
    throw new Error('Representación productiva de nota incompleta o incompatible');
  const qr = [snapshot.issuer.identityNumber, type, snapshot.series, snapshot.number, snapshot.totals.igvAmount,
    snapshot.totals.payableAmount, dateParts(snapshot.issueDate).isoDay, snapshot.customer.identityType,
    snapshot.customer.identityNumber, evidence.digestValue].join('|') + '|';
  if (evidence.qrPayload !== qr) throw new Error('QR individual de nota no corresponde al XML/snapshot');
  return draw(snapshot, format, undefined, evidence);
}
