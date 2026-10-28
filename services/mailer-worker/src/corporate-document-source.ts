import { Injectable } from '@nestjs/common';
import { AccessError, UUID, identity, privateJson } from '@factuez/service-access';
import { unzipSync } from 'fflate';
import { PRODUCTION_NOTES_PROFILE, PRODUCTION_NOTES_EXTENDED_PROFILE, type FiscalDocumentSnapshot, type ProductionNotesAnySnapshot as ProductionNotesSnapshot } from '@factuez/contracts';
import type { SmtpIssuer } from './smtp-configuration.store';
import { bytesDigest, canonical, documentGate } from './corporate-document-policy';
export type DocumentAttachment = { kind: 'PDF' | 'XML' | 'SUBMISSION_ZIP' | 'CDR_XML' | 'CDR_ZIP'; filename: string; contentType: string; content: Buffer; sha256: string };
export type DocumentProof = { documentId: string; companyId: number; ruc: string; fullNumber: string; documentType: '01' | '03' | '07' | '08'; referenceType?: '01' | '03'; snapshotSha256: string; fiscalStatus: string; actorId: string };
export type PreparedDocument = { proof: DocumentProof; documentProof: string; attachments: DocumentAttachment[] };
export interface DocumentSourceIo {
  identity: typeof identity;
  json: <T>(base: string, path: string, authorization: string) => Promise<T>;
  fetch: typeof fetch;
}
const actualIo: DocumentSourceIo = { identity, json: privateJson, fetch: (...args) => fetch(...args) };
const invalid = () => new AccessError(409, 'Comprobante u originales fiscales no disponibles, alterados o de otro emisor');
@Injectable()
export class CorporateDocumentSource {
  constructor(private readonly io: DocumentSourceIo = actualIo) {}
  async authorize(issuer: SmtpIssuer, documentId: string, authorization: string, requireEnabled = true): Promise<DocumentProof> {
    if (requireEnabled) documentGate();
    if (!UUID.test(documentId)) throw new AccessError(400, 'Comprobante inválido');
    const user = await this.io.identity(authorization, 'document.email');
    if (!user.roles.includes('ADMIN') || user.scope.kind !== 'GLOBAL') throw new AccessError(403, 'Correo documental requiere ADMIN GLOBAL');
    const doc = await this.io.json<{ id: string; companyId: number; fullNumber: string; sunatStatus: string; immutableSnapshot: FiscalDocumentSnapshot | ProductionNotesSnapshot }>(
      process.env.BILLING_INTERNAL_URL ?? 'http://billing-service:3002', '/api/v1/documents/' + documentId, authorization);
    const s = doc?.immutableSnapshot;
    if (doc?.id !== documentId || doc.companyId !== issuer.companyId || s?.documentId !== documentId ||
      s.environment !== 'PRODUCTION' || !['01', '03', '07', '08'].includes(s.documentTypeCode) || s.issuer?.identityNumber !== issuer.ruc ||
      s.companyId !== undefined && s.companyId !== issuer.companyId || doc.fullNumber !== s.fullNumber ||
      s.fullNumber !== s.series + '-' + s.number || !((s.documentTypeCode === '03' || ((s.documentTypeCode === '07' || s.documentTypeCode === '08') && (s as ProductionNotesSnapshot).reference?.documentTypeCode === '03')) ? /^B[A-Z0-9]{3}-[1-9]\d{0,7}$/ : /^F[A-Z0-9]{3}-[1-9]\d{0,7}$/).test(s.fullNumber) ||
      !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(doc.sunatStatus)) throw invalid();
    if (s.documentTypeCode === '07' || s.documentTypeCode === '08') {
      const note = s as ProductionNotesSnapshot;
      const legacy = note.profile === PRODUCTION_NOTES_PROFILE;
      const reasons = legacy ? (note.documentTypeCode === '07' ? ['01'] : ['02']) :
        note.documentTypeCode === '07' ? ['01','02','03','04','05','06','07','08','09','10'] : ['01','02','03'];
      // The artifact owner independently proves the original, adjustment, signature, manifest and CDR.
      if (note.companyId !== issuer.companyId || (!legacy && note.profile !== PRODUCTION_NOTES_EXTENDED_PROFILE) || !reasons.includes(note.reasonCode) ||
        note.adjustment?.documentTypeCode !== note.documentTypeCode || note.adjustment.reasonCode !== note.reasonCode ||
        !(legacy ? note.reference?.documentTypeCode === '01' : ['01','03'].includes(note.reference?.documentTypeCode))) throw invalid();
    }
    if (requireEnabled) documentGate();
    return { documentId, ...issuer, fullNumber: s.fullNumber, documentType: s.documentTypeCode as DocumentProof['documentType'],
      ...((s.documentTypeCode === '07' || s.documentTypeCode === '08') && (s as ProductionNotesSnapshot).reference.documentTypeCode === '03' ? {referenceType: '03' as const} : {}),
      snapshotSha256: bytesDigest(canonical(s)), fiscalStatus: doc.sunatStatus, actorId: user.sub };
  }
  private async file(path: string, type: string, kind: DocumentAttachment['kind'], authorization: string, signal: AbortSignal): Promise<DocumentAttachment> {
    let response: Response;
    try { response = await this.io.fetch((process.env.SUNAT_INTERNAL_URL ?? 'http://sunat-service:3003') + path, {
      method: 'GET', headers: { Authorization: authorization, Accept: type, 'Cache-Control': 'no-store' }, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    }); } catch { throw new AccessError(503, 'Servicio de originales fiscales no disponible'); }
    if (!response.ok) { await response.body?.cancel(); throw new AccessError([401, 403, 404, 409].includes(response.status) ? response.status : 503, 'Archivo fiscal no autorizado o no disponible'); }
    const length = response.headers.get('content-length'), limit = kind === 'PDF' ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /^attachment; filename="([A-Za-z0-9_-]+\.(?:pdf|xml|zip))"$/.exec(disposition);
    if (!match || match[1].length > 180 || response.headers.get('content-type')?.split(';')[0].trim() !== type ||
      length !== null && (!/^\d{1,9}$/.test(length) || Number(length) < 1 || Number(length) > limit)) {
      await response.body?.cancel(); throw invalid();
    }
    const reader = response.body?.getReader(); if (!reader) throw invalid();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (signal.aborted || size > limit) throw invalid(); chunks.push(value); }
      if (!size || length !== null && Number(length) !== size) throw invalid();
    } catch { await reader.cancel().catch(() => {}); throw invalid(); }
    const content = Buffer.concat(chunks);
    if (kind === 'PDF' && content.subarray(0, 5).toString() !== '%PDF-' || type === 'application/zip' && !content.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw invalid();
    return { kind, filename: match[1], contentType: type, content, sha256: bytesDigest(content) };
  }
  private xml(bytes: Buffer) {
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid(); }
    if (!text.trimStart().startsWith('<') || /<!DOCTYPE|<!ENTITY|\x00/i.test(text)) throw invalid();
  }
  private zipXml(archive: DocumentAttachment, filename: string) {
    let count = 0;
    try {
      const entries = unzipSync(archive.content, { filter: file => {
        if (++count !== 1 || file.name !== filename || !Number.isSafeInteger(file.originalSize) || file.originalSize < 1 || file.originalSize > 5 * 1024 * 1024 ||
          file.originalSize > Math.max(1024, archive.content.length * 200)) throw invalid();
        return true;
      } });
      if (count !== 1 || Object.keys(entries).length !== 1 || !entries[filename]) throw invalid();
      const xml = Buffer.from(entries[filename]); this.xml(xml); return xml;
    } catch { throw invalid(); }
  }
  async prepare(issuer: SmtpIssuer, id: string, format: 'a4' | 'ticket', authorization: string): Promise<PreparedDocument> {
    if (!['a4', 'ticket'].includes(format)) throw new AccessError(400, 'Formato inválido');
    const proof = await this.authorize(issuer, id, authorization);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 35000);
    try {
      const root = '/api/v1/fiscal-artifacts/' + id;
      // Owner endpoints validate signatures, exact snapshot/company, note manifest and archived hashes (RC only for 03).
      // No P12, signing, SUNAT transmission, filesystem access or generated replacement originals here.
      const attachments = await Promise.all([
        this.file(root + '/' + format, 'application/pdf', 'PDF', authorization, controller.signal),
        this.file(root + '/original/xml', 'application/xml', 'XML', authorization, controller.signal),
        this.file(root + '/original/submission-zip', 'application/zip', 'SUBMISSION_ZIP', authorization, controller.signal),
        this.file(root + '/original/cdr-xml', 'application/xml', 'CDR_XML', authorization, controller.signal),
        this.file(root + '/original/cdr-zip', 'application/zip', 'CDR_ZIP', authorization, controller.signal),
      ]);
      if (attachments.reduce((sum, a) => sum + a.content.length, 0) > 25 * 1024 * 1024) throw invalid();
      const [pdf, xml, submission, cdrXml, cdrZip] = attachments;
      const base = issuer.ruc + '-' + proof.documentType + '-' + proof.fullNumber;
      const usesSummary = proof.documentType === '03' || proof.referenceType === '03';
      const rc = new RegExp('^' + issuer.ruc + '-RC-[0-9]{8}-[1-9][0-9]{0,4}\\.zip$');
      if (pdf.filename !== base + '-' + format + '-PRODUCCION.pdf' || xml.filename !== base + '.xml' ||
        (usesSummary ? !rc.test(submission.filename) : submission.filename !== base + '.zip') ||
        cdrZip.filename !== 'R-' + submission.filename || cdrXml.filename !== cdrZip.filename.replace(/\.zip$/, '.xml')) throw invalid();
      this.xml(xml.content); this.xml(cdrXml.content);
      const submittedXml = this.zipXml(submission, submission.filename.replace(/\.zip$/, '.xml'));
      if (!usesSummary && !submittedXml.equals(xml.content)) throw invalid();
      if (!this.zipXml(cdrZip, cdrXml.filename).equals(cdrXml.content)) throw invalid();
      const latest = await this.authorize(issuer, id, authorization);
      if (canonical(latest) !== canonical(proof)) throw new AccessError(409, 'El comprobante o la autorización cambió durante la preparación');
      const documentProof = bytesDigest(canonical({ proof, originals: attachments.filter(a => a.kind !== 'PDF').map(a => ({ kind: a.kind, filename: a.filename, sha256: a.sha256, size: a.content.length })) }));
      return { proof, documentProof, attachments };
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
