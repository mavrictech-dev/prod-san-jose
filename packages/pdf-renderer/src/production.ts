import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { dateParts, type PrintFormat } from './types';

export type ProductionPdfStatus = 'PENDING' | 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS' | 'REJECTED';
/** Supplied only after backend verification of original XML, issuer PKI/CRL and final CDR.
 * The renderer grants no acceptance or transmission capability. */
export interface ProductionPdfEvidence {
  environment: 'PRODUCTION';
  status: ProductionPdfStatus;
  digestValue: string;
  /** Fields extracted from the authenticated original XML, including its XMLDSig digest. */
  qrPayload: string;
  responseCode?: string;
  cdrDescription?: string;
  cdrNotes?: string[];
  /** Verified single-member initial RC. The QR always uses the individual boleta digest. */
  receiptSummary?: { identifier: string; summaryXmlSha256: string; summaryZipSha256: string;
    individualXmlSha256: string; individualZipSha256: string; cdrXmlSha256?: string; cdrZipSha256?: string };
}

async function renderProductionSalePdf(snapshot: FiscalDocumentSnapshot, format: PrintFormat,
  evidence: ProductionPdfEvidence,
  type: '01' | '03',
  draw: (snapshot: FiscalDocumentSnapshot, format: PrintFormat, qa: undefined, production: ProductionPdfEvidence) => Promise<Buffer>,
): Promise<Buffer> {
  if (snapshot?.environment !== 'PRODUCTION' || snapshot.documentTypeCode !== type || snapshot.currencyCode !== 'PEN' ||
      !(type === '01' ? /^F[A-Z0-9]{3}-[1-9]\d{0,7}$/ : /^B[A-Z0-9]{3}-[1-9]\d{0,7}$/).test(snapshot.fullNumber) || evidence?.environment !== 'PRODUCTION' ||
      !['PENDING', 'ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(evidence.status) ||
      !/^[A-Za-z0-9+/]{43}=$/.test(evidence.digestValue) ||
      (evidence.status === 'PENDING' ? evidence.responseCode !== undefined :
        evidence.status === 'REJECTED' ? !/^[1-9]\d{0,7}$/.test(evidence.responseCode ?? '') : evidence.responseCode !== '0'))
    throw new Error('Evidencia productiva 01/03 PEN incompleta o incompatible');
  if (type === '03') {
    const rc = evidence.receiptSummary, validHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (!rc || !/^RC-\d{8}-[1-9]\d{0,4}$/.test(rc.identifier) ||
        ![rc.summaryXmlSha256, rc.summaryZipSha256, rc.individualXmlSha256, rc.individualZipSha256].every(validHash) ||
        (evidence.status === 'PENDING' ? rc.cdrXmlSha256 !== undefined || rc.cdrZipSha256 !== undefined :
          !validHash(rc.cdrXmlSha256) || !validHash(rc.cdrZipSha256))) throw new Error('Boleta productiva requiere vínculo RC verificado');
  } else if (evidence.receiptSummary !== undefined) throw new Error('Factura 01 no admite evidencia RC de boleta');
  const expected = [snapshot.issuer.identityNumber, type, snapshot.series, snapshot.number,
    snapshot.totals.igvAmount, snapshot.totals.payableAmount, dateParts(snapshot.issueDate).isoDay,
    snapshot.customer.identityType, snapshot.customer.identityNumber, evidence.digestValue].join('|') + '|';
  if (evidence.qrPayload !== expected) throw new Error('QR original incompatible con el snapshot');
  return draw(snapshot, format, undefined, evidence);
}

type ProductionDraw = (snapshot: FiscalDocumentSnapshot, format: PrintFormat, qa: undefined, production: ProductionPdfEvidence) => Promise<Buffer>;
export async function renderProductionInvoicePdf(snapshot: FiscalDocumentSnapshot, format: PrintFormat, evidence: ProductionPdfEvidence, draw: ProductionDraw) {
  return renderProductionSalePdf(snapshot, format, evidence, '01', draw);
}
export async function renderProductionReceiptPdf(snapshot: FiscalDocumentSnapshot, format: PrintFormat, evidence: ProductionPdfEvidence, draw: ProductionDraw) {
  return renderProductionSalePdf(snapshot, format, evidence, '03', draw);
}
