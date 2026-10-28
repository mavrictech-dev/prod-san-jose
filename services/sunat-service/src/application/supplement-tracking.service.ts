import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { fiscalSnapshotSha256 } from '@factuez/sunat-core/dist/fiscal-note';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { PrismaService } from '../infrastructure/prisma.service';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const PHASES = new Set(['AWAITING_AUTHORIZATION', 'PREPARING', 'PREPARED', 'RETRY_PREPARATION', 'SENDING', 'WAITING_TICKET', 'POLLING', 'DONE', 'UNKNOWN', 'BLOCKED', 'CDR_UNVERIFIED']);
const STATES = new Set(['QUEUED', 'BUILDING', 'SIGNED', 'SUBMITTED', 'PROCESSING', 'ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED', 'RETRYABLE_ERROR', 'PERMANENT_ERROR']);
type TrackingItem = { id: string; kind: '07' | '08' | 'RC' | 'RA'; reference: string; recordedStatus: string;
  phase: string | null; attempt: number | null; completedAt: string | null; requestedAction: 'NOTA' | 'ALTA' | 'MODIFICACION' | 'BAJA';
  snapshotSha256: string; fiscalEffectsAppliedByThisView: false };

/** Scoped READ MODEL, not an acceptance verifier or a financial projection.
 * Billing authorizes the original on each request; snapshots/totals never change.
 * No credential queries, artifacts, signing, network to SUNAT, writes or retries.
 */
@Injectable()
export class SupplementTrackingService {
  constructor(private readonly prisma: PrismaService) {}
  private async permitted(id: string, authorization?: string): Promise<FiscalDocumentSnapshot> {
    if (!UUID.test(id)) throw new BadRequestException('Documento inválido');
    if (!authorization || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(authorization)) throw new UnauthorizedException('Inicie sesión nuevamente');
    let response: Response;
    try {
      response = await fetch(`${process.env.BILLING_INTERNAL_URL ?? 'http://billing-service:3002'}/api/v1/documents/${id}`, {
        headers: { Authorization: authorization, Accept: 'application/json', 'Cache-Control': 'no-store' },
        redirect: 'error', signal: AbortSignal.timeout(5000),
      });
    } catch { throw new ServiceUnavailableException('No se pudo verificar el acceso'); }
    if (response.status === 401) throw new UnauthorizedException('Inicie sesión nuevamente');
    if ([403, 404].includes(response.status)) throw new NotFoundException('Documento no disponible en su alcance');
    if (!response.ok) throw new ServiceUnavailableException('No se pudo verificar el acceso');
    let permitted: { id: string; immutableSnapshot: FiscalDocumentSnapshot };
    try {
      const reader = response.body?.getReader(); if (!reader) throw new Error();
      const parts: Buffer[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; if (size > 512 * 1024) throw new Error(); parts.push(Buffer.from(part.value)); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      permitted = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const snapshot = permitted.immutableSnapshot;
      if (permitted.id !== id || snapshot?.documentId !== id || snapshot.environment !== 'BETA' ||
          !/^\d{11}$/.test(snapshot.issuer?.identityNumber ?? '') || !['01', '03', '07', '08'].includes(snapshot.documentTypeCode) ||
          !/^[FB][A-Z0-9]{3}$/.test(snapshot.series) || !/^[1-9]\d{0,7}$/.test(snapshot.number) ||
          snapshot.fullNumber !== `${snapshot.series}-${snapshot.number}`) throw new Error();
    } catch { throw new ConflictException('Documento fuera del seguimiento BETA o contexto inconsistente'); }
    return permitted.immutableSnapshot;
  }
  private sameHeader(a: FiscalDocumentSnapshot, b: FiscalDocumentSnapshot) {
    return ['documentId', 'documentTypeCode', 'series', 'number', 'fullNumber', 'companyId', 'branchId', 'environment',
      'issueDate', 'issuer', 'customer', 'currencyCode', 'operationTypeCode'].every(field =>
      isDeepStrictEqual(a[field as keyof FiscalDocumentSnapshot], b[field as keyof FiscalDocumentSnapshot]));
  }
  private async submission(ruc: string, relation: { documentId: string } | { batchId: string }) {
    const row = await this.prisma.sunatSubmission.findFirst({ where: { ...relation,
      ...('documentId' in relation ? { document: { is: { issuerRuc: ruc, environment: 'BETA' } } } : { batch: { is: { issuerRuc: ruc, environment: 'BETA' } } }) },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], select: { errorCode: true, attempt: true, completedAt: true } });
    return { phase: row && PHASES.has(row.errorCode ?? '') ? row.errorCode : null,
      attempt: row && Number.isSafeInteger(row.attempt) && row.attempt > 0 && row.attempt <= 20 ? row.attempt : null,
      completedAt: row?.completedAt?.toISOString() ?? null };
  }
  async list(id: string, authorization?: string) {
    const snapshot = await this.permitted(id, authorization), ruc = snapshot.issuer.identityNumber;
    const own = await this.prisma.fiscalDocument.findFirst({ where: { documentId: id, issuerRuc: ruc, environment: 'BETA' },
      select: { immutablePayload: true } });
    if (!own) throw new ConflictException('Documento todavía en preparación local');
    if (!isDeepStrictEqual(own.immutablePayload, JSON.parse(JSON.stringify(snapshot)))) throw new ConflictException('Snapshot propio inconsistente');
    const notes = await this.prisma.fiscalDocument.findMany({ where: { issuerRuc: ruc, environment: 'BETA', documentType: { in: ['07', '08'] },
      immutablePayload: { path: ['reference', 'documentId'], equals: id } }, take: 101,
      orderBy: [{ createdAt: 'desc' }, { documentId: 'desc' }],
      select: { documentId: true, documentType: true, series: true, number: true, status: true, immutablePayload: true } });
    const batches = await this.prisma.fiscalBatch.findMany({ where: { issuerRuc: ruc, environment: 'BETA',
      immutablePayload: { path: ['input', 'entries'], array_contains: [{ document: { snapshot: { documentId: id } } }] } }, take: 201,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], select: { id: true, identifier: true, status: true, immutablePayload: true } });
    if (notes.length > 100 || batches.length > 200) throw new ConflictException('Historial supera la consulta acotada; requiere conciliación');
    const items: TrackingItem[] = [];
    for (const note of notes) {
      const payload = note.immutablePayload as unknown as FiscalDocumentSnapshot & { reference?: { documentId?: string } };
      if (!UUID.test(note.documentId) || payload.environment !== 'BETA' || payload.issuer?.identityNumber !== ruc ||
          payload.reference?.documentId !== id || payload.companyId !== snapshot.companyId || payload.branchId !== snapshot.branchId ||
          payload.documentId !== note.documentId || payload.documentTypeCode !== note.documentType ||
          payload.series !== note.series || payload.number !== note.number.toString() ||
          !/^[FB][A-Z0-9]{3}$/.test(note.series) || note.number < 1n || note.number > 99999999n ||
          payload.fullNumber !== `${note.series}-${note.number}` || !STATES.has(note.status)) throw new ConflictException('Nota persistida inconsistente');
      items.push({ id: note.documentId, kind: note.documentType as '07' | '08', reference: payload.fullNumber,
        recordedStatus: note.status, requestedAction: 'NOTA', snapshotSha256: fiscalSnapshotSha256(payload),
        ...await this.submission(ruc, { documentId: note.documentId }), fiscalEffectsAppliedByThisView: false });
    }
    for (const batch of batches) {
      const payload = batch.immutablePayload as unknown as { environment?: string; issuer?: { identityNumber?: string };
        identifier?: string; kind?: string; input?: { entries?: { conditionCode?: string; document?: { snapshot?: FiscalDocumentSnapshot } }[] } };
      const entries = payload.input?.entries;
      // Legacy singleton snapshots are visible only through their original document;
      // this view does not fabricate a version or rewrite their metadata.
      if (!entries) continue;
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 100) throw new ConflictException('Lote persistido inconsistente');
      const matching = entries.filter(e => e.document?.snapshot?.documentId === id);
      if (!matching.length) continue;
      if (matching.length !== 1 || !UUID.test(batch.id) || payload.environment !== 'BETA' || payload.issuer?.identityNumber !== ruc ||
          !['RC', 'RA'].includes(payload.kind ?? '') || payload.identifier !== batch.identifier ||
          !/^(RC|RA)-\d{8}-[1-9]\d{0,4}$/.test(batch.identifier) || !STATES.has(batch.status) ||
          !this.sameHeader(snapshot, matching[0].document!.snapshot!)) throw new ConflictException('Miembro del lote inconsistente');
      const entry = matching[0], action = payload.kind === 'RA' ? 'BAJA' :
        ({ '1': 'ALTA', '2': 'MODIFICACION', '3': 'BAJA' } as const)[entry.conditionCode as '1' | '2' | '3'];
      if (!action) throw new ConflictException('Condición RC inválida');
      items.push({ id: batch.id, kind: payload.kind as 'RC' | 'RA', reference: batch.identifier, requestedAction: action,
        recordedStatus: batch.status, snapshotSha256: fiscalSnapshotSha256(entry.document!.snapshot!),
        ...await this.submission(ruc, { batchId: batch.id }), fiscalEffectsAppliedByThisView: false });
    }
    return { documentId: id, environment: 'BETA' as const, items, readOnly: true as const,
      financialProjectionApplied: false as const, certificateAccess: false as const, transmissionAuthorized: false as const,
      notice: 'Seguimiento de registros. Esta consulta no acredita firma del CDR, aceptación fiscal ni anulación; conserva los importes y snapshots originales.' };
  }
}
