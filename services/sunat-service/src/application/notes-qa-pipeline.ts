import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { buildNoteQaUbl } from '@factuez/sunat-core/dist/notes-ubl';
import { buildNoteQaSummary } from '@factuez/sunat-core/dist/notes-summary-ubl';
import { NOTES_QA_PROFILE, type NoteQaSnapshot } from '@factuez/sunat-core/dist/notes-qa';
import { zipSync, unzipSync } from 'fflate';
import { XmlSignerService } from '../infrastructure/crypto/xml-signer.service';
import { inspectCertificate } from '../infrastructure/crypto/certificate-inspector';

/** Sólo uso en el worker acotado. Nunca recibe SOL, JWT ni destinos de red. */
export function prepareNotesQaXml(note: NoteQaSnapshot, original: FiscalDocumentSnapshot, bytes: Buffer, password: string, summaryIdentifier?: string) {
  const metadata = inspectCertificate(bytes, password);
  if (!metadata.selfSigned) throw new Error('Notas QA requieren certificado ficticio autofirmado');
  const rootKind = summaryIdentifier ? 'SummaryDocuments' : note.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote';
  const unsigned = summaryIdentifier ? buildNoteQaSummary(note, original, summaryIdentifier) : buildNoteQaUbl(note, original);
  const signed = new XmlSignerService().sign(unsigned, bytes, password, rootKind);
  const fileName = `${note.issuer.identityNumber}-${summaryIdentifier ?? `${note.documentTypeCode}-${note.fullNumber}`}`;
  const xmlBytes = Buffer.from(signed.xml);
  const zip = Buffer.from(zipSync({ [`${fileName}.xml`]: xmlBytes }, { level: 6, mtime: new Date('2020-01-01T00:00:00Z') }));
  const files = unzipSync(zip);
  if (Object.keys(files).length !== 1 || !Buffer.from(files[`${fileName}.xml`]).equals(xmlBytes)) throw new Error('ZIP de nota inválido');
  return { ...signed, fileName, zip, profile: NOTES_QA_PROFILE };
}
