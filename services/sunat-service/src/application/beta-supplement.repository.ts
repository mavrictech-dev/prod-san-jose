import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { fiscalSnapshotSha256, type FiscalNoteContext, type FiscalNoteSnapshot } from '@factuez/sunat-core/dist/fiscal-note';
import { validateFiscalBatchSnapshot, type FiscalBatchDocument, type FiscalBatchSnapshot } from '@factuez/sunat-core/dist/fiscal-batch';
import { PrismaService } from '../infrastructure/prisma.service';
import { betaFiscalIdentity, type BetaFiscalEnvelope, type BetaSupplementContext } from '../infrastructure/crypto/beta-fiscal-package-pipeline';
import type { BetaDispatchRow, BetaPhase, BetaCdr } from './beta-dispatch-pipeline';
import type { BetaStored } from './beta-issuance.repository';
import type { BetaSummaryAcceptanceMetadata } from './beta-summary-acceptance';
import type { Prisma, SunatSubmission } from '../generated/prisma/client';
export type BetaSupplementManifest = { fileName: string; reference: string; revision: number; fingerprint: string;
  digest: string; xml: BetaStored; zip: BetaStored; xsdEvidence: unknown };
type Metadata = { version: 1; kind: 'BETA_SUPPLEMENT'; envelope: BetaFiscalEnvelope; envelopeSha256: string;
  eventId: string; correlationId: string; summaryProofs?: BetaSummaryAcceptanceMetadata[]; prepared?: BetaSupplementManifest; cdr?: BetaCdr };
export type BetaSupplementRow = BetaDispatchRow<BetaSupplementContext>;
type Tx = Prisma.TransactionClient;
type Snapshot = FiscalBatchDocument['snapshot'];
const phases: BetaPhase[] = ['AWAITING_AUTHORIZATION', 'PREPARING', 'PREPARED', 'RETRY_PREPARATION', 'SENDING', 'WAITING_TICKET', 'POLLING', 'DONE', 'UNKNOWN', 'BLOCKED', 'CDR_UNVERIFIED'];
const accepted = ['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'] as const;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const LEASE_MS = 60000, MAX_PREPARATIONS = 3, MAX_POLLS = 20, MAX_BATCHES = 1000;
const transitions: Partial<Record<BetaPhase, BetaPhase[]>> = {
  PREPARING: ['RETRY_PREPARATION', 'BLOCKED'], PREPARED: ['SENDING', 'RETRY_PREPARATION', 'BLOCKED'],
  SENDING: ['WAITING_TICKET', 'DONE', 'UNKNOWN', 'BLOCKED', 'CDR_UNVERIFIED'],
  POLLING: ['WAITING_TICKET', 'DONE', 'UNKNOWN', 'BLOCKED', 'CDR_UNVERIFIED'],
};
function aliases(snapshot: Snapshot) {
  if (!snapshot || !UUID.test(snapshot.documentId) || !/^(01|03|07|08)$/.test(snapshot.documentTypeCode) ||
      !/^[FB][A-Z0-9]{3}$/.test(snapshot.series) || !/^[1-9]\d{0,7}$/.test(snapshot.number) ||
      !/^\d{11}$/.test(snapshot.issuer?.identityNumber)) throw new Error('Identidad de miembro persistido inválida');
  return [snapshot.documentId.toLowerCase(), `${snapshot.issuer.identityNumber}/${snapshot.documentTypeCode}/${snapshot.series}/${BigInt(snapshot.number)}`];
}
function overlaps(a: Snapshot, b: Snapshot) { const left = aliases(a), right = aliases(b); return left.some((v, i) => v === right[i]); }
function frozenHeader(snapshot: Snapshot) {
  const fields = ['documentId', 'documentTypeCode', 'series', 'number', 'fullNumber', 'issueDate', 'environment', 'currencyCode',
    'operationTypeCode', 'companyId', 'branchId', 'issuer', 'customer', 'reference'] as const;
  return Object.fromEntries(fields.map(field => [field, field === 'reference' ? (snapshot as FiscalNoteSnapshot).reference : snapshot[field]]));
}
function members(payload: unknown): Snapshot[] {
  const data = payload as FiscalBatchSnapshot;
  // El RC inicial de BetaIssuance conserva un snapshot de documento, no de lote.
  const result = data?.input ? data.input.entries?.map(e => e.document.snapshot) : [payload as Snapshot];
  if (!result?.length || result.length > 100) throw new Error('Lote persistido sin miembros acotados');
  const ids = new Set<string>(), numbers = new Set<string>();
  for (const member of result) {
    const [id, number] = aliases(member);
    if (ids.has(id) || numbers.has(number)) throw new Error('Alias de miembro duplicado');
    ids.add(id); numbers.add(number);
  }
  return result;
}
function noteContexts(envelope: BetaFiscalEnvelope): FiscalNoteContext[] {
  return envelope.kind === 'NOTE' ? [envelope.context] : envelope.batch.input.entries.flatMap(e =>
    [e.document.noteContext, ...('previous' in e && e.previous ? [e.previous.document.noteContext] : [])].filter((c): c is FiscalNoteContext => Boolean(c)));
}
function acceptances(envelope: BetaFiscalEnvelope) {
  const result = noteContexts(envelope).map(c => ({ snapshot: c.original as Snapshot, acceptance: c.acceptance, asOf: c.asOf }));
  if (envelope.kind === 'BATCH') for (const entry of envelope.batch.input.entries) {
    if ('acceptance' in entry) result.push({ snapshot: entry.document.snapshot, acceptance: entry.acceptance, asOf: envelope.asOf });
    else if (entry.previous) result.push({ snapshot: entry.previous.document.snapshot, acceptance: entry.previous.acceptance, asOf: envelope.asOf });
  }
  return result;
}
/** Tablas propias existentes; ni migraciones ni reservas de correlativos de Billing. */
@Injectable()
export class BetaSupplementRepository {
  constructor(private readonly prisma: PrismaService) {}
  private metadata(row: SunatSubmission): Metadata {
    const value = JSON.parse(row.errorMessage ?? 'null') as Metadata | null;
    if (!value || value.version !== 1 || value.kind !== 'BETA_SUPPLEMENT' || !UUID.test(value.eventId) || !UUID.test(value.correlationId) ||
        fiscalSnapshotSha256(value.envelope) !== value.envelopeSha256) throw new Error('Sobre fiscal archivado inconsistente');
    const identity = betaFiscalIdentity(value.envelope);
    if (row.idempotencyKey.toLowerCase() !== `beta-supplement:${identity.documentId.toLowerCase()}:v1` ||
        row.channel !== (identity.method === 'sendBill' ? 'SOAP_SEND_BILL' : 'SOAP_SEND_SUMMARY') ||
        (value.envelope.kind === 'NOTE' ? row.documentId?.toLowerCase() !== identity.documentId.toLowerCase() || row.batchId !== null : !row.batchId || row.documentId !== null))
      throw new Error('Envío fuera del sobre fiscal');
    return value;
  }
  private async lock(tx: Tx, ruc: string) {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', `${ruc}:BETA:supplement`);
  }
  private async ownDocument(tx: Tx, snapshot: Snapshot, identityOnly = false) {
    const document = await tx.fiscalDocument.findFirst({ where: { documentId: snapshot.documentId, issuerRuc: snapshot.issuer.identityNumber, environment: 'BETA' } });
    const base = document?.immutablePayload as unknown as Snapshot;
    if (!document || (identityOnly ? fiscalSnapshotSha256(frozenHeader(base)) !== fiscalSnapshotSha256(frozenHeader(snapshot)) : fiscalSnapshotSha256(base) !== fiscalSnapshotSha256(snapshot)))
      throw new Error('Snapshot propio cambió durante reserva');
    return document;
  }
  private async latestAcceptance(tx: Tx, batchId: string) {
    return tx.sunatSubmission.findFirst({ where: { batchId, channel: 'SOAP_SEND_SUMMARY', errorCode: 'DONE', result: 'SUCCESS', completedAt: { not: null } },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }] });
  }
  /** Pruebas del verificador interno: cerca versiones; estas banderas no verifican firmas. */
  private async reserveEvidence(tx: Tx, envelope: BetaFiscalEnvelope, proofs: BetaSummaryAcceptanceMetadata[], batches: Awaited<ReturnType<Tx['fiscalBatch']['findMany']>>) {
    const contexts = noteContexts(envelope), evidence = acceptances(envelope);
    const used = new Set<BetaSummaryAcceptanceMetadata>();
    for (const { snapshot, acceptance: proofSource, asOf } of evidence) {
      const source = proofSource.source;
      const ownDocument = await this.ownDocument(tx, snapshot, source.kind === 'CDR_SUMMARY');
      let sourceBatchId: string | undefined;
      if (source.kind === 'CDR_DOCUMENT') {
        const cdr = await tx.documentArtifact.findUnique({ where: { documentId_kind: { documentId: snapshot.documentId, kind: 'CDR_ZIP' } } });
        if (!accepted.includes(ownDocument.status as typeof accepted[number]) || ownDocument.status !== proofSource.status ||
            ownDocument.acceptedAt?.toISOString() !== proofSource.acceptedAt || cdr?.sha256 !== proofSource.cdrSha256) throw new Error('Aceptación de original cambió durante reserva');
      } else {
        const matching = proofs.filter(p => p.environment === 'BETA' && p.issuerRuc === proofSource.issuerRuc && p.documentId === snapshot.documentId &&
          p.snapshotSha256 === proofSource.snapshotSha256 && p.identifier === source.identifier && p.lineNumber === source.lineNumber && p.conditionCode === source.conditionCode &&
          p.documentTypeCode === snapshot.documentTypeCode && p.fullNumber === snapshot.fullNumber && p.referenceDate === source.referenceDate &&
          p.acceptedAt === proofSource.acceptedAt && p.status === proofSource.status && p.responseCode === '0' && p.cdrZipSha256 === proofSource.cdrSha256 &&
          p.cdrFileName === `R-${proofSource.issuerRuc}-${source.identifier}.xml`);
        if (!matching.length || matching.some(p => fiscalSnapshotSha256(p) !== fiscalSnapshotSha256(matching[0]))) throw new Error('Prueba RC verificada requerida para cada aceptación');
        matching.forEach(p => used.add(p)); const proof = matching[0];
        if (![proof.batchSnapshotSha256, proof.cdrXmlSha256, proof.requestXmlSha256].every(v => typeof v === 'string' && HASH.test(v))) throw new Error('Prueba RC sin hashes de versión completos');
        const batch = await tx.fiscalBatch.findUnique({ where: { issuerRuc_environment_identifier: { issuerRuc: proofSource.issuerRuc, environment: 'BETA', identifier: source.identifier } } });
        if (!batch || batch.status !== proof.status || !accepted.includes(batch.status as typeof accepted[number])) throw new Error('Lote RC ya no aceptado');
        const own = batch.immutablePayload as unknown as FiscalBatchSnapshot;
        validateFiscalBatchSnapshot(own, asOf); members(own);
        const entry = own.input.entries[source.lineNumber - 1];
        // BetaIssuance 03 usa summaryId del miembro para su lookup singleton;
        // la identidad fiscal del lote sigue siendo own.documentId/proof.batchDocumentId.
        const singleton = own.input.entries.length === 1 && batch.summaryId.toLowerCase() === own.input.entries[0].document.snapshot.documentId.toLowerCase();
        if (own.kind !== 'RC' || own.environment !== 'BETA' || own.issuer.identityNumber !== proof.issuerRuc || own.identifier !== proof.identifier ||
            own.documentId !== proof.batchDocumentId || (!singleton && batch.summaryId.toLowerCase() !== own.documentId.toLowerCase()) || own.referenceDate !== proof.referenceDate ||
            fiscalSnapshotSha256(own) !== proof.batchSnapshotSha256 || !entry || !('conditionCode' in entry) || entry.conditionCode !== proof.conditionCode ||
            fiscalSnapshotSha256(entry.document.snapshot) !== proof.snapshotSha256) throw new Error('Versión/miembro de lote RC cambió durante reserva');
        const submission = await this.latestAcceptance(tx, batch.id);
        const cdr = await tx.batchArtifact.findUnique({ where: { batchId_kind: { batchId: batch.id, kind: 'CDR_ZIP' } } });
        const xml = await tx.batchArtifact.findUnique({ where: { batchId_kind: { batchId: batch.id, kind: 'SIGNED_XML' } } });
        if (submission?.completedAt?.toISOString() !== proof.acceptedAt || cdr?.sha256 !== proof.cdrZipSha256 || xml?.sha256 !== proof.requestXmlSha256)
          throw new Error('Aceptación/artefactos de lote RC cambiaron durante reserva');
        sourceBatchId = batch.id;
      }
      for (const candidate of batches) {
        if (candidate.id === sourceBatchId || !members(candidate.immutablePayload).some(m => overlaps(m, snapshot))) continue;
        if (!accepted.includes(candidate.status as typeof accepted[number])) {
          if (candidate.status !== 'REJECTED') throw new Error('Original tiene lote reservado; conciliar antes de ajustar');
          continue;
        }
        const latest = await this.latestAcceptance(tx, candidate.id);
        if (!latest?.completedAt || latest.completedAt.getTime() >= Date.parse(proofSource.acceptedAt)) throw new Error('Original tiene versión RC/baja posterior o ambigua');
      }
    }
    if (used.size !== proofs.length) throw new Error('Prueba RC ajena al sobre fiscal');
    const proposedNotes = envelope.kind === 'NOTE' ? [envelope.note] : envelope.batch.input.entries.filter(e => !('conditionCode' in e) || e.conditionCode !== '3')
      .map(e => e.document.snapshot).filter((s): s is FiscalNoteSnapshot => s.documentTypeCode === '07' || s.documentTypeCode === '08');
    for (const context of contexts) {
      const prior = await tx.fiscalDocument.findMany({ where: { issuerRuc: context.original.issuer.identityNumber, environment: 'BETA', documentType: '07',
        status: { not: 'REJECTED' }, immutablePayload: { path: ['reference', 'documentId'], equals: context.original.documentId } }, take: 101 });
      const existing = prior.filter(p => !proposedNotes.some(n => n.documentId.toLowerCase() === p.documentId.toLowerCase()));
      const supplied = context.creditHistory.entries;
      if (prior.length > 100 || existing.length !== supplied.length || existing.some(p => !supplied.some(s => s.note.documentId.toLowerCase() === p.documentId.toLowerCase() &&
          fiscalSnapshotSha256(s.note) === fiscalSnapshotSha256(p.immutablePayload) &&
          (s.state === 'ACCEPTED' ? accepted.includes(p.status as typeof accepted[number]) : !accepted.includes(p.status as typeof accepted[number])))))
        throw new Error('Historial de créditos cambió durante reserva');
    }
  }
  async stage(envelope: BetaFiscalEnvelope, eventId: string, correlationId: string, summaryProofs: BetaSummaryAcceptanceMetadata[] = []) {
    const identity = betaFiscalIdentity(envelope);
    if (![eventId, correlationId].every(v => UUID.test(v))) throw new Error('Identidad de evento inválida');
    if (!Array.isArray(summaryProofs) || summaryProofs.length > 400 || summaryProofs.some(p => !p || typeof p !== 'object')) throw new Error('Pruebas RC inválidas');
    // No conservar referencias del caller a través de un await/lock.
    envelope = JSON.parse(JSON.stringify(envelope)) as BetaFiscalEnvelope;
    const proofs = structuredClone(summaryProofs);
    if (!proofs.length && acceptances(envelope).some(e => e.acceptance.source.kind === 'CDR_SUMMARY')) throw new Error('Prueba RC verificada requerida para cada aceptación');
    const metadata: Metadata = { version: 1, kind: 'BETA_SUPPLEMENT', envelope, envelopeSha256: fiscalSnapshotSha256(envelope), eventId, correlationId, summaryProofs: proofs };
    return this.prisma.$transaction(async tx => {
      await this.lock(tx, identity.ruc);
      const idempotencyKey = `beta-supplement:${identity.documentId.toLowerCase()}:v1`;
      const previous = await tx.sunatSubmission.findFirst({ where: { idempotencyKey: { equals: idempotencyKey, mode: 'insensitive' } } });
      if (previous) {
        if (this.metadata(previous).envelopeSha256 !== metadata.envelopeSha256) throw new Error('No se modifica un envío reservado');
        if (fiscalSnapshotSha256(this.metadata(previous).summaryProofs ?? []) !== fiscalSnapshotSha256(proofs)) throw new Error('Pruebas RC distintas del envío reservado');
        return previous.id;
      }
      const batches = await tx.fiscalBatch.findMany({ where: { issuerRuc: identity.ruc, environment: 'BETA' }, take: MAX_BATCHES + 1 });
      if (batches.length > MAX_BATCHES) throw new Error('Historial de lotes excede reserva acotada; conciliar');
      await this.reserveEvidence(tx, envelope, proofs, batches);
      let documentId: string | undefined, batchId: string | undefined;
      if (envelope.kind === 'NOTE') {
        const note = envelope.note;
        documentId = identity.documentId;
        await tx.fiscalDocument.create({ data: { documentId, issuerRuc: identity.ruc, environment: 'BETA', documentType: note.documentTypeCode,
          series: note.series, number: BigInt(note.number), billingEventId: eventId, immutablePayload: JSON.parse(JSON.stringify(note)) } });
      } else {
        batchId = randomUUID();
        members(envelope.batch);
        const incoming = envelope.batch.input.entries.map(e => e.document.snapshot);
        for (const entry of envelope.batch.input.entries) await this.ownDocument(tx, entry.document.snapshot, 'conditionCode' in entry && ['2', '3'].includes(entry.conditionCode));
        for (const candidate of batches) {
          const same = members(candidate.immutablePayload).filter(m => incoming.some(s => overlaps(s, m)));
          if (!same.length || candidate.status === 'REJECTED') continue;
          if (!accepted.includes(candidate.status as typeof accepted[number]) || (envelope.batch.input.kind === 'RC' && envelope.batch.input.entries.some(e => e.conditionCode === '1' && same.some(m => overlaps(m, e.document.snapshot)))))
            throw new Error('Documento pertenece a lote reservado/aceptado; conciliar antes de crear otro');
        }
        await tx.fiscalBatch.create({ data: { id: batchId, summaryId: identity.documentId, issuerRuc: identity.ruc,
          identifier: identity.reference, environment: 'BETA', billingEventId: eventId, immutablePayload: JSON.parse(JSON.stringify(envelope.batch)) } });
      }
      const row = await tx.sunatSubmission.create({ data: { documentId, batchId, channel: identity.method === 'sendBill' ? 'SOAP_SEND_BILL' : 'SOAP_SEND_SUMMARY',
        attempt: 1, idempotencyKey, errorCode: 'AWAITING_AUTHORIZATION', errorMessage: JSON.stringify(metadata), nextRetryAt: new Date() } });
      return row.id;
    }, { isolationLevel: 'Serializable' });
  }
  async load(id: string): Promise<BetaSupplementRow | null> {
    const stored = await this.prisma.sunatSubmission.findUnique({ where: { id } });
    if (!stored?.idempotencyKey.toLowerCase().startsWith('beta-supplement:') || !phases.includes(stored.errorCode as BetaPhase)) return null;
    const meta = this.metadata(stored), identity = betaFiscalIdentity(meta.envelope);
    return { id, documentId: identity.documentId, phase: stored.errorCode as BetaPhase, owner: stored.startedAt,
      attempt: stored.attempt, ticket: stored.ticket, snapshot: { environment: 'BETA', issuer: { identityNumber: identity.ruc },
        documentTypeCode: meta.envelope.kind === 'NOTE' ? meta.envelope.note.documentTypeCode : meta.envelope.batch.kind, envelope: meta.envelope } };
  }
  private where(row: BetaSupplementRow, phase: BetaPhase) {
    const identity = betaFiscalIdentity(row.snapshot.envelope);
    if (row.snapshot.environment !== 'BETA' || row.documentId !== identity.documentId || row.snapshot.issuer.identityNumber !== identity.ruc ||
        row.snapshot.documentTypeCode !== (row.snapshot.envelope.kind === 'NOTE' ? row.snapshot.envelope.note.documentTypeCode : row.snapshot.envelope.batch.kind)) throw new Error('Claim fuera de BETA/sobre');
    return { id: row.id, idempotencyKey: { equals: `beta-supplement:${identity.documentId.toLowerCase()}:v1`, mode: 'insensitive' as const },
      ...(row.snapshot.envelope.kind === 'NOTE' ? { documentId: row.documentId, document: { is: { issuerRuc: identity.ruc, environment: 'BETA' as const } } }
        : { batch: { is: { summaryId: row.documentId, issuerRuc: identity.ruc, environment: 'BETA' as const } } }),
      errorCode: phase, result: 'PENDING' as const, attempt: row.attempt, startedAt: row.owner, completedAt: null };
  }
  private matches(stored: SunatSubmission, row: BetaSupplementRow) {
    return this.metadata(stored).envelopeSha256 === fiscalSnapshotSha256(row.snapshot.envelope);
  }
  async claim(row: BetaSupplementRow, phase: 'PREPARING' | 'POLLING') {
    if (phase === 'PREPARING' ? !['AWAITING_AUTHORIZATION', 'RETRY_PREPARATION', 'PREPARED'].includes(row.phase) ||
        (row.phase === 'RETRY_PREPARATION' && row.attempt >= MAX_PREPARATIONS) : row.phase !== 'WAITING_TICKET' || !row.ticket || row.attempt >= MAX_POLLS) return null;
    const now = new Date(), owner = new Date(Math.max(now.getTime(), row.owner.getTime() + 1));
    const increment = row.phase === 'RETRY_PREPARATION' || phase === 'POLLING';
    return this.prisma.$transaction(async tx => {
      const stored = await tx.sunatSubmission.findUniqueOrThrow({ where: { id: row.id } });
      if (!this.matches(stored, row)) return null;
      const result = await tx.sunatSubmission.updateMany({ where: { ...this.where(row, row.phase), ticket: row.ticket, nextRetryAt: { lte: now } },
        data: { errorCode: phase, startedAt: owner, nextRetryAt: new Date(owner.getTime() + LEASE_MS), ...(increment ? { attempt: { increment: 1 } } : {}) } });
      return result.count === 1 ? { ...row, owner, phase, attempt: row.attempt + Number(increment) } : null;
    });
  }
  async owns(row: BetaSupplementRow, phase: BetaPhase) {
    const stored = await this.prisma.sunatSubmission.findFirst({ where: { ...this.where(row, phase), nextRetryAt: { gt: new Date() } } });
    return Boolean(stored && this.matches(stored, row));
  }
  async manifest(row: BetaSupplementRow) {
    const stored = await this.prisma.sunatSubmission.findUniqueOrThrow({ where: { id: row.id } });
    const manifest = this.metadata(stored).prepared;
    if (!this.matches(stored, row) || !manifest) throw new Error('Paquete no archivado para este sobre'); return manifest;
  }
  async savePrepared(row: BetaSupplementRow, manifest: BetaSupplementManifest) {
    manifest = structuredClone(manifest);
    const identity = betaFiscalIdentity(row.snapshot.envelope);
    if (manifest.fileName !== identity.fileName || manifest.reference !== identity.reference || !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 || !HASH.test(manifest.fingerprint) ||
        !manifest.digest || manifest.digest.length > 128 || [manifest.xml, manifest.zip].some(f => !f || !HASH.test(f.sha256) || !f.storageKey || f.storageKey.length > 500 || !Number.isSafeInteger(f.sizeBytes) || f.sizeBytes <= 0) ||
        (manifest.xsdEvidence as { xmlSha256?: string } | null)?.xmlSha256 !== manifest.xml.sha256) throw new Error('Manifiesto de paquete inconsistente');
    return this.prisma.$transaction(async tx => {
      const stored = await tx.sunatSubmission.findUniqueOrThrow({ where: { id: row.id } });
      const meta = this.metadata(stored);
      if (!this.matches(stored, row)) return false;
      if (meta.prepared && fiscalSnapshotSha256(meta.prepared) !== fiscalSnapshotSha256(manifest)) throw new Error('No se reemplaza paquete fiscal preparado');
      const credentials = await tx.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: row.snapshot.issuer.identityNumber, environment: 'BETA' } }, select: { revision: true, certificateFingerprint: true } });
      if (credentials?.revision !== manifest.revision || credentials.certificateFingerprint !== manifest.fingerprint) throw new Error('Certificado cambió');
      const changed = await tx.sunatSubmission.updateMany({ where: { ...this.where(row, 'PREPARING'), nextRetryAt: { gt: new Date() } },
        data: { errorCode: 'PREPARED', requestArtifactKey: manifest.zip.storageKey, errorMessage: JSON.stringify({ ...meta, prepared: manifest }) } });
      if (changed.count !== 1) return false;
      for (const [kind, file, mediaType] of [['SIGNED_XML', manifest.xml, 'application/xml'], ['SUBMISSION_ZIP', manifest.zip, 'application/zip']] as const) {
        if (stored.documentId) {
          const key = { documentId_kind: { documentId: stored.documentId, kind } };
          const previous = await tx.documentArtifact.findUnique({ where: key });
          if (previous && (previous.sha256 !== file.sha256 || previous.storageKey !== file.storageKey || Number(previous.sizeBytes) !== file.sizeBytes || previous.mediaType !== mediaType)) throw new Error('No se reemplaza artefacto fiscal preparado');
          await tx.documentArtifact.upsert({ where: key, update: {}, create: { documentId: stored.documentId, kind, ...file, mediaType } });
        } else {
          const key = { batchId_kind: { batchId: stored.batchId!, kind } };
          const previous = await tx.batchArtifact.findUnique({ where: key });
          if (previous && (previous.sha256 !== file.sha256 || previous.storageKey !== file.storageKey || Number(previous.sizeBytes) !== file.sizeBytes || previous.mediaType !== mediaType)) throw new Error('No se reemplaza artefacto de lote preparado');
          await tx.batchArtifact.upsert({ where: key, update: {}, create: { batchId: stored.batchId!, kind, ...file, mediaType } });
        }
      }
      if (stored.documentId) await tx.fiscalDocument.update({ where: { documentId: stored.documentId }, data: { digestValue: manifest.digest } });
      return true;
    });
  }
  async transition(row: BetaSupplementRow, from: BetaPhase, to: BetaPhase, details: { ticket?: string; code?: string; delayMs?: number; cdr?: BetaCdr } = {}) {
    if (!transitions[from]?.includes(to)) return false;
    if (to === 'RETRY_PREPARATION' && row.attempt >= MAX_PREPARATIONS) return false;
    if (details.delayMs !== undefined && (!Number.isSafeInteger(details.delayMs) || details.delayMs < 0 || details.delayMs > LEASE_MS)) throw new Error('Espera fuera del límite');
    details = structuredClone(details);
    if (to === 'DONE' && (details.cdr?.trusted !== true || !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(details.cdr.status) ||
        (details.cdr.status === 'REJECTED' ? details.cdr.code === '0' : details.cdr.code !== '0'))) throw new Error('CDR confiable requerido');
    if (to === 'SENDING') await this.manifest(row);
    const ticket = details.ticket ?? row.ticket;
    if (to === 'WAITING_TICKET' && (!ticket || ticket.length > 120 || ticket !== ticket.trim() || /[\x00-\x1f\x7f]/.test(ticket) ||
        (row.ticket && row.ticket !== ticket) || betaFiscalIdentity(row.snapshot.envelope).method !== 'sendSummary' || row.attempt >= MAX_POLLS)) throw new Error('Ticket/consulta fuera del límite');
    return this.prisma.$transaction(async tx => {
      await this.lock(tx, row.snapshot.issuer.identityNumber);
      const stored = await tx.sunatSubmission.findUniqueOrThrow({ where: { id: row.id } });
      if (!this.matches(stored, row)) return false;
      const terminal = ['DONE', 'UNKNOWN', 'BLOCKED', 'CDR_UNVERIFIED'].includes(to);
      const now = new Date();
      const result = await tx.sunatSubmission.updateMany({ where: { ...this.where(row, from), nextRetryAt: { gt: new Date() } }, data: {
        errorCode: to, ...(to === 'WAITING_TICKET' ? { ticket } : {}), completedAt: terminal ? now : null,
        nextRetryAt: terminal ? null : new Date(now.getTime() + (details.delayMs ?? LEASE_MS)),
        result: to === 'DONE' ? details.cdr!.status === 'REJECTED' ? 'BUSINESS_ERROR' : 'SUCCESS' : to === 'BLOCKED' ? 'BUSINESS_ERROR' : terminal ? 'UNKNOWN' : 'PENDING',
        errorMessage: JSON.stringify({ ...this.metadata(stored), ...(details.cdr ? { cdr: details.cdr } : {}) }) } });
      if (result.count !== 1) return false;
      const status = to === 'DONE' ? details.cdr!.status : to === 'BLOCKED' ? 'PERMANENT_ERROR' : terminal ? 'RETRYABLE_ERROR' : 'SUBMITTED';
      if (['SENDING', 'DONE', 'UNKNOWN', 'BLOCKED', 'CDR_UNVERIFIED'].includes(to)) {
        if (stored.documentId) await tx.fiscalDocument.update({ where: { documentId: stored.documentId }, data: { status, ...(to === 'DONE' && status !== 'REJECTED' ? { acceptedAt: now } : {}) } });
        else await tx.fiscalBatch.update({ where: { id: stored.batchId! }, data: { status } });
        // Lotes no hacen pasar todos los miembros por aceptados/BAJA sólo por CDR global.
        // La proyección miembro/versión exige reconciliación dedicada; este evento es de evidencia.
        const eventId = randomUUID();
        await tx.outboxEvent.create({ data: { id: eventId, eventType: 'sunat.beta.supplement.evidence.v1', aggregateId: row.documentId,
          payload: { eventId, producer: 'sunat-service', environment: 'BETA', issuerRuc: row.snapshot.issuer.identityNumber,
            submissionId: row.id, status, phase: to, cdrSignatureVerified: to === 'DONE', responseCode: details.code ?? null } } });
      }
      return true;
    });
  }
  async recoverInterrupted() {
    const now = new Date();
    const expired = { idempotencyKey: { startsWith: 'beta-supplement:', mode: 'insensitive' as const }, result: 'PENDING' as const, completedAt: null, nextRetryAt: { lte: now } };
    await this.prisma.sunatSubmission.updateMany({ where: { ...expired, errorCode: 'SENDING' }, data: { errorCode: 'UNKNOWN', result: 'UNKNOWN', completedAt: now, nextRetryAt: null } });
    await this.prisma.sunatSubmission.updateMany({ where: { ...expired, errorCode: 'POLLING', attempt: { lt: MAX_POLLS }, ticket: { not: null } }, data: { errorCode: 'WAITING_TICKET', nextRetryAt: now } });
    await this.prisma.sunatSubmission.updateMany({ where: { ...expired, errorCode: 'POLLING', OR: [{ attempt: { gte: MAX_POLLS } }, { ticket: null }] }, data: { errorCode: 'UNKNOWN', result: 'UNKNOWN', completedAt: now, nextRetryAt: null } });
    await this.prisma.sunatSubmission.updateMany({ where: { ...expired, errorCode: 'PREPARING', attempt: { lt: MAX_PREPARATIONS } }, data: { errorCode: 'RETRY_PREPARATION', nextRetryAt: new Date(now.getTime() + 2000) } });
    await this.prisma.sunatSubmission.updateMany({ where: { ...expired, errorCode: 'PREPARING', attempt: { gte: MAX_PREPARATIONS } }, data: { errorCode: 'BLOCKED', result: 'BUSINESS_ERROR', completedAt: now, nextRetryAt: null } });
  }
  async due() { return this.prisma.sunatSubmission.findMany({ where: { idempotencyKey: { startsWith: 'beta-supplement:', mode: 'insensitive' }, result: 'PENDING', completedAt: null,
    OR: [{ errorCode: { in: ['AWAITING_AUTHORIZATION', 'PREPARED'] } }, { errorCode: 'RETRY_PREPARATION', attempt: { lt: MAX_PREPARATIONS } },
      { errorCode: 'WAITING_TICKET', attempt: { lt: MAX_POLLS }, ticket: { not: null } }], nextRetryAt: { lte: new Date() } }, select: { id: true }, orderBy: [{ nextRetryAt: 'asc' }, { id: 'asc' }], take: 20 }); }
}
