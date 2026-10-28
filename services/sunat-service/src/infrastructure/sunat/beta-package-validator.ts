import { createHash, X509Certificate } from 'node:crypto';
import { XMLSerializer } from '@xmldom/xmldom';
import forge from 'node-forge';
import { isFiscalCalendarDate, isRucStructurallyValid } from '@factuez/sunat-core';
import type { SignedPackage } from '../../domain/ports/sunat-adapter.port';
import { parseSafeInvoice, verifyLocalSignedInvoice, type XmlRootKind } from '../crypto/xml-signer.service';
import { certificateRucCandidates } from '../crypto/certificate-identity';
import { singleNotesTransportXml, SAC_NS } from './notes-transport-qa-validator';
import { child, children, leaf, CBC_NS, CAC_NS } from './safe-xml';

const DS = 'http://www.w3.org/2000/09/xmldsig#';
/** Validación previa al POST. La firma matemática NO sustituye cadena, CRL ni autorización. */
export function validateBetaPackage(pkg: SignedPackage, ruc: string, method: 'sendBill' | 'sendSummary') {
  if (!isRucStructurallyValid(ruc) || !pkg.fileName.startsWith(`${ruc}-`) ||
      createHash('sha256').update(pkg.zip).digest('hex') !== pkg.sha256) throw new Error('Paquete Beta inconsistente');
  const bill = pkg.fileName.match(/^\d{11}-(01|07|08)-(F[A-Z0-9]{3}-[1-9]\d{0,7})\.zip$/);
  const batch = pkg.fileName.match(/^\d{11}-(RC|RA)-(\d{8})-([1-9]\d{0,4})\.zip$/);
  if (method === 'sendBill' ? !bill : !batch) throw new Error('Ruta fiscal Beta incorrecta');
  const rootName: XmlRootKind = bill ? bill[1] === '01' ? 'Invoice' : bill[1] === '07' ? 'CreditNote' : 'DebitNote'
    : batch![1] === 'RC' ? 'SummaryDocuments' : 'VoidedDocuments';
  const reference = bill ? bill[2] : `${batch![1]}-${batch![2]}-${batch![3]}`;
  if (batch && !isFiscalCalendarDate(`${batch[2].slice(0, 4)}-${batch[2].slice(4, 6)}-${batch[2].slice(6, 8)}`))
    throw new Error('Calendario RC/RA inválido');
  const xml = singleNotesTransportXml(pkg.zip, pkg.fileName).toString('utf8');
  const parsed = parseSafeInvoice(xml, rootName), root = parsed.root;
  if (leaf(root, CBC_NS, 'ID', 40) !== reference || !isFiscalCalendarDate(leaf(root, CBC_NS, 'IssueDate', 10)))
    throw new Error('Identidad/calendario XML no corresponden al ZIP');
  const supplier = child(root, CAC_NS, 'AccountingSupplierParty');
  const parties = children(supplier, CAC_NS, 'Party');
  const supplierRuc = batch ? leaf(supplier, CBC_NS, 'CustomerAssignedAccountID', 11)
    : leaf(child(child(supplier, CAC_NS, 'Party'), CAC_NS, 'PartyIdentification'), CBC_NS, 'ID', 11);
  if (batch && leaf(supplier, CBC_NS, 'AdditionalAccountID', 1) !== '6') throw new Error('Tipo de emisor RC/RA inconsistente');
  if (supplierRuc !== ruc || parties.length > 1) throw new Error('XML de otro RUC');
  if (bill && bill[1] === '01' && leaf(root, CBC_NS, 'InvoiceTypeCode', 2) !== '01') throw new Error('Tipo Invoice inconsistente');
  if (bill && bill[1] !== '01') {
    const document = child(child(root, CAC_NS, 'BillingReference'), CAC_NS, 'InvoiceDocumentReference');
    const originalId = leaf(document, CBC_NS, 'ID', 40), discrepancy = child(root, CAC_NS, 'DiscrepancyResponse');
    if (leaf(document, CBC_NS, 'DocumentTypeCode', 2) !== '01' || !/^F[A-Z0-9]{3}-[1-9]\d{0,7}$/.test(originalId) ||
        leaf(discrepancy, CBC_NS, 'ReferenceID', 40) !== originalId) throw new Error('sendBill de nota exige referencia a factura');
  }
  if (batch) {
    const date = leaf(root, CBC_NS, 'IssueDate', 10);
    if (date.replaceAll('-', '') !== batch[2] || !isFiscalCalendarDate(leaf(root, CBC_NS, 'ReferenceDate', 10)) ||
        leaf(root, CBC_NS, 'ReferenceDate', 10) > date) throw new Error('Fechas de lote inconsistentes');
    const lines = children(root, SAC_NS, rootName === 'SummaryDocuments' ? 'SummaryDocumentsLine' : 'VoidedDocumentsLine');
    if (!lines.length || lines.length > 500) throw new Error('Lote requiere de 1 a 500 documentos');
    const seen = new Set<string>();
    for (const [index, line] of lines.entries()) {
      const type = leaf(line, CBC_NS, 'DocumentTypeCode', 2);
      if (leaf(line, CBC_NS, 'LineID', 4) !== String(index + 1)) throw new Error('Líneas de lote no consecutivas');
      let id: string;
      if (rootName === 'SummaryDocuments') {
        id = leaf(line, CBC_NS, 'ID', 40);
        if (!['03', '07', '08'].includes(type) || !/^B[A-Z0-9]{3}-[1-9]\d{0,7}$/.test(id) ||
            !['1', '2', '3'].includes(leaf(child(line, CAC_NS, 'Status'), CBC_NS, 'ConditionCode', 1))) throw new Error('RC fuera del perfil de boletas/notas');
        if (type !== '03') {
          const original = child(child(line, CAC_NS, 'BillingReference'), CAC_NS, 'InvoiceDocumentReference');
          if (leaf(original, CBC_NS, 'DocumentTypeCode', 2) !== '03' || !/^B[A-Z0-9]{3}-[1-9]\d{0,7}$/.test(leaf(original, CBC_NS, 'ID', 40)))
            throw new Error('RC de nota sin boleta original');
        }
      } else {
        id = `${leaf(line, SAC_NS, 'DocumentSerialID', 4)}-${leaf(line, SAC_NS, 'DocumentNumberID', 8)}`;
        if (!['01', '07', '08'].includes(type) || !/^F[A-Z0-9]{3}-[1-9]\d{0,7}$/.test(id)) throw new Error('RA fuera del perfil de facturas/notas F');
        leaf(line, SAC_NS, 'VoidReasonDescription', 250);
      }
      if (seen.has(`${type}:${id}`)) throw new Error('Documento duplicado en lote'); seen.add(`${type}:${id}`);
    }
  }
  const signatures = parsed.document.getElementsByTagNameNS(DS, 'Signature');
  const certificates = parsed.document.getElementsByTagNameNS(DS, 'X509Certificate');
  if (signatures.length !== 1 || certificates.length !== 1 || signatures[0].parentNode !== parsed.extension)
    throw new Error('Firma única requerida para el envío Beta');
  const certificate = new X509Certificate(Buffer.from((certificates[0].textContent ?? '').replace(/\s/g, ''), 'base64'));
  const publicCertificate = forge.pki.certificateFromPem(certificate.toString());
  const candidates = certificateRucCandidates(publicCertificate.subject.attributes);
  const usage = publicCertificate.getExtension('keyUsage') as { digitalSignature?: boolean } | null;
  if (certificate.ca || (certificate.subject === certificate.issuer && certificate.verify(certificate.publicKey)) ||
      certificate.publicKey.asymmetricKeyType !== 'rsa' || (certificate.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      usage?.digitalSignature !== true || candidates.length !== 1 || candidates[0] !== ruc || Date.now() < Date.parse(certificate.validFrom) ||
      Date.now() >= Date.parse(certificate.validTo)) throw new Error('Firmante no vinculado/vigente');
  signatures[0].parentNode!.removeChild(signatures[0]);
  const digest = verifyLocalSignedInvoice(xml, certificate.toString(), new XMLSerializer().serializeToString(parsed.document), rootName);
  return { xml, rootName, reference, digest, certificateFingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase() };
}
