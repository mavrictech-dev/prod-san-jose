import { createHash, X509Certificate } from 'node:crypto';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { buildNoteQaUbl } from '@factuez/sunat-core/dist/notes-ubl';
import { buildNoteQaSummary } from '@factuez/sunat-core/dist/notes-summary-ubl';
import { noteQaCanonical } from '@factuez/sunat-core/dist/notes-qa';
import { verifyLocalSignedInvoice } from '../infrastructure/crypto/xml-signer.service';
import { safeXml } from '../infrastructure/sunat/safe-xml';
import { singleNotesTransportXml } from '../infrastructure/sunat/notes-transport-qa-validator';
import type { NotesQaRow } from './notes-qa.repository';

export const notesTransportHash = (value: unknown) => createHash('sha256').update(noteQaCanonical(value)).digest('hex');
export const notesBytesHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Certificado archivado, fingerprint fijado en la reserva; nunca abre el PFX de la nota. */
export function verifyNotesTransportPackage(row: NotesQaRow, original: FiscalDocumentSnapshot, xml: Buffer, zip: Buffer, fileName: string, summaryIdentifier?: string) {
  if (!singleNotesTransportXml(zip, fileName).equals(xml)) throw new Error('ZIP no coincide con XML archivado');
  const root = safeXml(xml.toString('utf8')); const ds = 'http://www.w3.org/2000/09/xmldsig#';
  const certificates = root.getElementsByTagNameNS(ds, 'X509Certificate');
  if (certificates.length !== 1) throw new Error('Certificado único requerido');
  const certificate = new X509Certificate(Buffer.from(certificates[0].textContent ?? '', 'base64'));
  if (certificate.fingerprint256.replace(/:/g, '').toLowerCase() !== row.certificateFingerprint ||
    certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey) ||
    Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw new Error('Certificado archivado fuera del perfil QA');
  const kind = summaryIdentifier ? 'SummaryDocuments' : row.snapshot.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote';
  const unsigned = summaryIdentifier ? buildNoteQaSummary(row.snapshot, original, summaryIdentifier) : buildNoteQaUbl(row.snapshot, original);
  const digest = verifyLocalSignedInvoice(xml.toString('utf8'), certificate.toString(), unsigned, kind);
  if (!summaryIdentifier && digest !== row.digestValue) throw new Error('Digest de nota inconsistente');
}
