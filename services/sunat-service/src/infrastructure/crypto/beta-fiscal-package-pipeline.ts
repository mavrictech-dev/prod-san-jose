import { zipSync } from 'fflate';
import { buildFiscalNoteUbl, validateFiscalNoteSnapshot, type FiscalNoteSnapshot, type FiscalNoteContext } from '@factuez/sunat-core/dist/fiscal-note';
import { buildFiscalBatchUbl, validateFiscalBatchSnapshot, type FiscalBatchSnapshot } from '@factuez/sunat-core/dist/fiscal-batch';
import { inspectCertificate } from './certificate-inspector';
import { XmlSignerService, type XmlRootKind } from './xml-signer.service';
import { validateBetaPackage } from '../sunat/beta-package-validator';
import type { BetaDispatchContext } from '../../application/beta-dispatch-pipeline';
import type { FiscalSupplementEnvelope } from '@factuez/sunat-core/dist/fiscal-supplement-command';

export type BetaFiscalEnvelope = FiscalSupplementEnvelope;
export type BetaSupplementContext = BetaDispatchContext & { envelope: BetaFiscalEnvelope };
/** No transporte ni lectura de secretos; rechaza ambiente/ruta antes de usar la clave. */
export function betaFiscalIdentity(envelope: BetaFiscalEnvelope) {
  let documentId: string, reference: string, ruc: string, rootName: XmlRootKind, method: 'sendBill' | 'sendSummary';
  if (envelope.kind === 'NOTE') {
    if (envelope.note.environment !== 'BETA') throw new Error('Producción bloqueada');
    validateFiscalNoteSnapshot(envelope.note, envelope.context);
    if (!envelope.note.series.startsWith('F')) throw new Error('Notas B requieren lote RC explícito');
    documentId = envelope.note.documentId; reference = envelope.note.fullNumber; ruc = envelope.note.issuer.identityNumber;
    rootName = envelope.note.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote'; method = 'sendBill';
  } else if (envelope.kind === 'BATCH') {
    if (envelope.batch.environment !== 'BETA') throw new Error('Producción bloqueada');
    validateFiscalBatchSnapshot(envelope.batch, envelope.asOf);
    documentId = envelope.batch.documentId; reference = envelope.batch.identifier; ruc = envelope.batch.issuer.identityNumber;
    rootName = envelope.batch.kind === 'RC' ? 'SummaryDocuments' : 'VoidedDocuments'; method = 'sendSummary';
  } else throw new Error('Sobre fiscal desconocido');
  const fileName = `${ruc}-${envelope.kind === 'NOTE' ? `${envelope.note.documentTypeCode}-` : ''}${reference}.zip`;
  return { documentId, reference, ruc, rootName, method, fileName };
}

/** Caller acredita autorización/cadena/CRL; el worker sólo firma, verifica y empaqueta el snapshot congelado. */
export function prepareBetaFiscalPackage(envelope: BetaFiscalEnvelope, bytes: Buffer, password: string) {
  const identity = betaFiscalIdentity(envelope), metadata = inspectCertificate(bytes, password);
  if (metadata.selfSigned || !metadata.digitalSignature || metadata.subjectRucCandidates.length !== 1 ||
      metadata.subjectRucCandidates[0] !== identity.ruc) throw new Error('Certificado no vinculado al RUC Beta');
  const unsigned = envelope.kind === 'NOTE' ? buildFiscalNoteUbl(envelope.note, envelope.context) : buildFiscalBatchUbl(envelope.batch, envelope.asOf);
  const signed = new XmlSignerService().sign(unsigned, bytes, password, identity.rootName);
  const zip = Buffer.from(zipSync({ [identity.fileName.replace(/\.zip$/, '.xml')]: Buffer.from(signed.xml) },
    { level: 6, mtime: new Date('2020-01-01T00:00:00Z') }));
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  validateBetaPackage({ ...identity, zip, sha256: createHash('sha256').update(zip).digest('hex') }, identity.ruc, identity.method);
  return { ...identity, xml: signed.xml, zip, signed };
}
