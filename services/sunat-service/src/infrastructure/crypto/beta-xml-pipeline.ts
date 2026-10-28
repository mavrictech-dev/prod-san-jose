import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { assertFiscalSnapshot, buildInvoiceUbl, buildReceiptSummary } from '@factuez/sunat-core';
import { zipSync } from 'fflate';
import { inspectCertificate } from './certificate-inspector';
import { XmlSignerService } from './xml-signer.service';

/** Preparación criptográfica Beta; el llamador debe acreditar autorización/cadena/CRL antes de iniciar el worker. */
export function prepareBetaXml(snapshot: FiscalDocumentSnapshot, bytes: Buffer, password: string, identifier?: string) {
  if (snapshot.environment !== 'BETA' && !(snapshot.environment === 'PRODUCTION' && ['01', '03'].includes(snapshot.documentTypeCode) && snapshot.currencyCode === 'PEN' && snapshot.operationTypeCode === '0101')) throw new Error('Documento fuera del perfil de firma');
  assertFiscalSnapshot(snapshot, { mode: 'REAL_PREPARATION' });
  const metadata = inspectCertificate(bytes, password);
  if (metadata.selfSigned || !metadata.digitalSignature || metadata.subjectRucCandidates.length !== 1 ||
    metadata.subjectRucCandidates[0] !== snapshot.issuer.identityNumber) throw new Error('Certificado no vinculado al RUC Beta');
  const signer = new XmlSignerService();
  const document = signer.sign(buildInvoiceUbl(snapshot, { mode: 'REAL_PREPARATION' }), bytes, password);
  const documentFileName = `${snapshot.issuer.identityNumber}-${snapshot.documentTypeCode}-${snapshot.fullNumber}`;
  const request = snapshot.documentTypeCode === '03'
    ? signer.sign(buildReceiptSummary(snapshot, identifier!, 'REAL_PREPARATION'), bytes, password, 'SummaryDocuments') : document;
  const fileName = snapshot.documentTypeCode === '03' ? `${snapshot.issuer.identityNumber}-${identifier}` : documentFileName;
  const zip = Buffer.from(zipSync({ [`${fileName}.xml`]: Buffer.from(request.xml) }, { level: 6, mtime: new Date('2020-01-01T00:00:00Z') }));
  // The 03 submission ZIP contains RC XML; preserve a distinct local package for
  // the signed individual document. It is never represented as the submitted ZIP.
  const individualZip = snapshot.documentTypeCode === '03'
    ? Buffer.from(zipSync({ [`${documentFileName}.xml`]: Buffer.from(document.xml) }, { level: 6, mtime: new Date('2020-01-01T00:00:00Z') }))
    : undefined;
  return { document, request, fileName, documentFileName, zip, individualZip };
}
