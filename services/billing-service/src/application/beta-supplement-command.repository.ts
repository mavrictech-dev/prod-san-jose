import { allowsResource, type FiscalDocumentSnapshot } from '@factuez/contracts';
import {
  boundedSupplementJson, validateFiscalSupplementCommand, type FiscalSupplementCommand,
} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {
  fiscalSnapshotSha256, validateFiscalNoteSnapshot, type FiscalAcceptanceEvidence,
  type FiscalNoteContext, type FiscalNoteSnapshot,
} from '@factuez/sunat-core/dist/fiscal-note';
import { parseDecimal } from '@factuez/sunat-core/dist/tax';
import type { FiscalBatchSnapshot, FiscalRcEntry, FiscalRaEntry } from '@factuez/sunat-core/dist/fiscal-batch';
import type { Prisma, PrismaClient } from '../generated/prisma/client';

import {supplementActor,type SupplementActor} from './supplement-actor';
export type BetaSupplementActor = SupplementActor;
export type BetaSupplementReservation = {
  operationId: string; eventId: string; operationKind: 'NOTE' | 'RC' | 'RA'; deduplicated: boolean;
};
type Tx = Prisma.TransactionClient;
type Snapshot = FiscalDocumentSnapshot | FiscalNoteSnapshot;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TYPES = { '01': 'INVOICE', '03': 'SALES_RECEIPT', '07': 'CREDIT_NOTE', '08': 'DEBIT_NOTE' } as const;
const ACCEPTED = ['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'];
const documentSelect = {
  id: true, companyId: true, seriesCounterId: true, emissionPointId: true,
  type: true, status: true, sunatStatus: true, series: true, number: true, fullNumber: true,
  issueDate: true, currencyCode: true, operationTypeCode: true,
  customerIdentityType: true, customerIdentityNumber: true, customerLegalName: true,
  taxableAmount: true, unaffectedAmount: true, igvAmount: true, payableAmount: true, immutableSnapshot: true,
} satisfies Prisma.DocumentSelect;
type OwnDocument = Prisma.DocumentGetPayload<{ select: typeof documentSelect }>;
function deny(message: string): never { throw new Error(`Reserva BETA: ${message}`); }
function same(a: unknown, b: unknown, message: string): void {
  if (fiscalSnapshotSha256(a) !== fiscalSnapshotSha256(b)) deny(message);
}
function aliases(id: string): string[] { return [...new Set([id, id.toLowerCase(), id.toUpperCase()])]; }
function json(value: unknown): Prisma.InputJsonValue { return boundedSupplementJson(value) as Prisma.InputJsonValue; }

/**
 * INTERNAL repository; composition can use a factory provider with Prisma.
 * Caller gate stays hard-closed; no controller/bootstrap invokes reserve.
 * The caller must enforce that gate BEFORE reserve. Future activation requires authenticating
 * the actor and server acceptance/notDelivered evidence. This repository checks
 * own persistence and scope; it does NOT verify CDR PKI, SEE or authorize sending.
 * All participating writers must retain this company/RUC lock protocol. P2034 is
 * retried at most three attempts with the SAME command; other failures roll back.
 * No automatic release, number reuse/reset, original update or RC2 version ledger.
 * Compiled dist subpaths use the server-only contract without changing root/index.
 */
export class BetaSupplementCommandRepository {
  constructor(private readonly prisma: Pick<PrismaClient, '$transaction'>) {}

  async reserve(value: unknown, actorInput: BetaSupplementActor): Promise<BetaSupplementReservation> {
    const command = validateFiscalSupplementCommand(value);
    const actor = supplementActor(actorInput);
    if (!allowsResource(actor.scope, command.payload.branchId)) deny('sede fuera de scope');
    if(actor.userId===null&&command.payload.envelope.kind==='BATCH')deny('SERVICE batch sin procedencia persistente soportada');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(tx => this.reserveInTransaction(tx, command, actor),
          { isolationLevel: 'Serializable' });
      } catch (error) {
        if (attempt >= 2 || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2034') throw error;
      }
    }
  }

  /** Owner-local composition ONLY: caller owns commit/rollback and activation gate.
   * Revalidates the input; never opens or commits a nested transaction. */
  async reserveWithinTransaction(tx:Tx,value:unknown,actorInput:BetaSupplementActor):Promise<BetaSupplementReservation>{
    const command=validateFiscalSupplementCommand(value),actor=supplementActor(actorInput);
    if(!allowsResource(actor.scope,command.payload.branchId))deny('sede fuera de scope');
    if(actor.userId===null&&command.payload.envelope.kind==='BATCH')deny('SERVICE batch sin procedencia persistente soportada');
    return this.reserveInTransaction(tx,command,actor);
  }

  private async reserveInTransaction(tx: Tx, command: FiscalSupplementCommand, actor: BetaSupplementActor) {
    const p = command.payload, operationId = p.operationId.toLowerCase();
    // Parameterized, transaction-scoped, stable locks. Operation IDs are global
    // across issuers and NOTE/RC/RA; the company lock also protects credit phantoms.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factuez:beta-supplement:company:${p.companyId}:ruc:${p.issuerRuc}`}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factuez:beta-supplement:operation:${operationId}`}, 0))`;
    if (process.env.STATION_MASTER_CRUD_ENABLED === 'true') {
      await tx.$executeRaw`SELECT "id" FROM "CompanySettings" WHERE "id" = ${p.companyId} FOR SHARE`;
      await tx.$executeRaw`SELECT "id" FROM "Branch" WHERE "id" = ${p.branchId.toLowerCase()}::uuid FOR SHARE`;
    }
    const company = await tx.companySettings.findUnique({ where: { id: p.companyId },
      select: { id: true, ruc: true, environment: true, active: true } });
    const branch = await tx.branch.findUnique({ where: { id: p.branchId.toLowerCase() },
      select: { id: true, companyId: true, active: true } });
    if (!company || company.active === false || company.id !== p.companyId || company.ruc !== p.issuerRuc || company.environment !== 'BETA')
      deny('empresa/RUC/environment propio no coincide o producción bloqueada');
    if (!branch?.active || branch.companyId !== company.id || branch.id.toLowerCase() !== p.branchId.toLowerCase())
      deny('sede propia inválida');

    const events = await tx.outboxEvent.findMany({ where: { OR: [
      { id: command.eventId.toLowerCase() }, { eventType: command.eventName, aggregateId: { in: aliases(p.operationId) } },
    ] }, select: { id: true, eventType: true, aggregateId: true, payload: true }, take: 3 });
    const prior = events[0];
    if (events.length > 1) deny('IDs/aliases de Outbox ambiguos');
    if (prior) {
      if (prior.eventType !== command.eventName || prior.aggregateId.toLowerCase() !== operationId ||
          prior.id.toLowerCase() !== command.eventId.toLowerCase()) deny('evento u operación ya reservada con otro comando');
      same(validateFiscalSupplementCommand(prior.payload), command, 'operación ya reservada con otro comando exacto');
    }
    const envelope = p.envelope;
    if (envelope.kind === 'NOTE') {
      const ownOriginal = await this.ownDocument(tx, command, actor, envelope.context.original);
      this.ownAcceptance(ownOriginal, envelope.context.acceptance);
      const counter = await tx.seriesCounter.findUnique({ where: { companyId_documentType_series: {
        companyId: p.companyId, documentType: TYPES[envelope.note.documentTypeCode], series: envelope.note.series,
      } }, select: { id: true, companyId: true, emissionPointId: true, documentType: true, series: true, active: true, nextNumber: true } });
      if (!counter?.active || counter.companyId !== p.companyId || counter.emissionPointId !== ownOriginal.emissionPointId ||
          counter.documentType !== TYPES[envelope.note.documentTypeCode] || counter.series !== envelope.note.series ||
          !allowsResource(actor.scope, p.branchId, counter.emissionPointId, counter.id)) deny('serie de nota fuera de punto original/scope');
      await this.operationAliases(tx, command, !!prior, ownOriginal.emissionPointId);
      if (prior) {
        const reserved = await this.ownDocument(tx, command, actor, envelope.note);
        if (reserved.emissionPointId !== ownOriginal.emissionPointId || reserved.seriesCounterId !== counter.id)
          deny('nota reservada fuera del punto original/serie propia');
      } else {
        if (envelope.note.lines.some(line => line.productCode !== undefined && line.productCode.length > 40))
          deny('productCode excede internalCode de DocumentItem (40); no se trunca');
        await this.ownNoteContext(tx, command, actor, envelope.note, envelope.context);
        if (counter.nextNumber !== BigInt(envelope.note.number)) deny('nextNumber no coincide; nunca se reutiliza ni reinicia');
        const changed = await tx.seriesCounter.updateMany({ where: { id: counter.id, companyId: p.companyId,
          emissionPointId: ownOriginal.emissionPointId, documentType: counter.documentType, series: counter.series,
          active: true, nextNumber: BigInt(envelope.note.number) }, data: { nextNumber: { increment: 1n } } });
        if (changed.count !== 1) deny('CAS de correlativo falló');
        await this.insertNote(tx, command, actor, counter.id, ownOriginal);
      }
    } else {
      const pointId = await this.ownBatch(tx, command, actor, envelope.batch, !!prior);
      await this.operationAliases(tx, command, !!prior, pointId);
      if (!prior) {
        // DailySummary is the existing GENERIC batch record. Its identifier's
        // RC-/RA- prefix is the label; RA items use condition 3 (void). sequence
        // is the identifier suffix, NOT a fiscal SeriesCounter/nextNumber.
        // Existing (company,referenceDate,sequence) uniqueness also spans RC/RA.
        await tx.dailySummary.create({ data: { id: operationId, companyId: p.companyId,
          emissionPointId: pointId, createdByUserId: actor.userId!.toLowerCase(),
          referenceDate: new Date(`${envelope.batch.referenceDate}T00:00:00Z`),
          sequence: Number(envelope.batch.identifier.split('-')[2]), identifier: envelope.batch.identifier, status: 'QUEUED',
          items: { create: envelope.batch.input.entries.map((entry, index) => ({
            documentId: entry.document.snapshot.documentId.toLowerCase(), lineNumber: index + 1,
            conditionCode: 'conditionCode' in entry ? entry.conditionCode : '3',
          })) },
        } });
      }
    }
    if (!prior) await tx.outboxEvent.create({ data: { id: command.eventId.toLowerCase(), eventType: command.eventName,
      aggregateId: operationId, occurredAt: new Date(command.occurredAt), payload: json(command) } });
    return { operationId: p.operationId, eventId: command.eventId, operationKind: p.operationKind, deduplicated: !!prior };
  }

  private async ownDocument(tx: Tx, command: FiscalSupplementCommand, actor: BetaSupplementActor, snapshot: Snapshot): Promise<OwnDocument> {
    const p = command.payload;
    if (snapshot.companyId !== p.companyId || snapshot.branchId !== p.branchId || snapshot.environment !== 'BETA' ||
        snapshot.issuer.identityNumber !== p.issuerRuc) deny('snapshot ajeno a empresa/sede/RUC BETA');
    const own = await tx.document.findUnique({ where: { id: snapshot.documentId.toLowerCase() }, select: documentSelect });
    if (!own || own.companyId !== p.companyId || own.id.toLowerCase() !== snapshot.documentId.toLowerCase() ||
        own.type !== TYPES[snapshot.documentTypeCode as keyof typeof TYPES] || own.status !== 'ISSUED' ||
        own.series !== snapshot.series || own.number !== BigInt(snapshot.number) || own.fullNumber !== snapshot.fullNumber ||
        own.issueDate.getTime() !== Date.parse(snapshot.issueDate) || own.currencyCode !== snapshot.currencyCode ||
        own.operationTypeCode !== snapshot.operationTypeCode || own.customerIdentityType !== snapshot.customer.identityType ||
        own.customerIdentityNumber !== snapshot.customer.identityNumber || own.customerLegalName !== snapshot.customer.legalName)
      deny('documento propio no coincide con identidad/snapshot');
    same(boundedSupplementJson(own.immutableSnapshot), snapshot, 'SHA del snapshot propio no coincide');
    for (const field of ['taxableAmount', 'igvAmount', 'payableAmount', 'unaffectedAmount'] as const) {
      const expected = field === 'unaffectedAmount' && !('unaffectedAmount' in snapshot.totals) ? '0.00' : String(snapshot.totals[field as keyof typeof snapshot.totals]);
      if (parseDecimal(String(own[field]), 2) !== parseDecimal(expected, 2)) deny('importes propios no coinciden');
    }
    const point = await tx.emissionPoint.findUnique({ where: { id: own.emissionPointId },
      select: { id: true, companyId: true, branchId: true, code: true, active: true } });
    const counter = await tx.seriesCounter.findUnique({ where: { id: own.seriesCounterId },
      select: { id: true, companyId: true, emissionPointId: true, documentType: true, series: true, active: true } });
    if (!point?.active || point.companyId !== p.companyId || point.branchId?.toLowerCase() !== p.branchId.toLowerCase() ||
        point.code !== snapshot.issuer.establishmentCode || !counter?.active || counter.companyId !== p.companyId ||
        counter.emissionPointId !== point.id || counter.documentType !== own.type || counter.series !== own.series ||
        !allowsResource(actor.scope, p.branchId, point.id, counter.id)) deny('punto/establecimiento/serie propia fuera de scope');
    return own;
  }

  private ownAcceptance(own: OwnDocument, evidence: FiscalAcceptanceEvidence): void {
    // Billing projection only. The external closed gate must authenticate CDRs.
    if (!ACCEPTED.includes(own.sunatStatus) || own.sunatStatus !== evidence.status ||
        own.id.toLowerCase() !== evidence.documentId.toLowerCase() ||
        fiscalSnapshotSha256(own.immutableSnapshot) !== evidence.snapshotSha256) deny('aceptación previa propia requerida');
  }

  private async ownNoteContext(tx: Tx, command: FiscalSupplementCommand, actor: BetaSupplementActor,
    note: FiscalNoteSnapshot, context: FiscalNoteContext, member?: OwnDocument): Promise<void> {
    const original = await this.ownDocument(tx, command, actor, context.original);
    this.ownAcceptance(original, context.acceptance);
    if (member && member.emissionPointId !== original.emissionPointId) deny('nota y original requieren mismo punto');
    same(context.original, original.immutableSnapshot, 'original del contexto no es el propio');
    if (note.reference.snapshotSha256 !== fiscalSnapshotSha256(original.immutableSnapshot)) deny('referencia SHA original ajena');
    const credits = await tx.document.findMany({ where: { companyId: command.payload.companyId, type: 'CREDIT_NOTE',
      sunatStatus: { not: 'REJECTED' }, ...(member ? { id: { not: member.id } } : {}),
      OR: [
        ...aliases(context.original.documentId).map(id => ({ immutableSnapshot: { path: ['reference', 'documentId'], equals: id } })),
        { referencesFrom: { some: { targetDocumentId: original.id } } },
      ],
    }, select: documentSelect, orderBy: [{ issueDate: 'asc' }, { id: 'asc' }], take: 101 });
    if (credits.length > 100 || credits.length !== context.creditHistory.entries.length) deny('historial propio incompleto o mayor a 100');
    const byId = new Map(credits.map(credit => [credit.id.toLowerCase(), credit]));
    for (const entry of context.creditHistory.entries) {
      const credit = byId.get(entry.note.documentId.toLowerCase());
      if (!credit) deny('historial incluye crédito ajeno/duplicado');
      byId.delete(credit.id.toLowerCase());
      const verified = await this.ownDocument(tx, command, actor, entry.note);
      if (verified.emissionPointId !== original.emissionPointId ||
          entry.state !== (ACCEPTED.includes(credit.sunatStatus) ? 'ACCEPTED' : 'RESERVED')) deny('estado/punto de crédito propio no coincide');
      // UNKNOWN, PENDING, errors, VOIDED etc. still consume capacity. Only an
      // explicit Document.sunatStatus=REJECTED is excluded by the query above.
    }
    validateFiscalNoteSnapshot(note, { ...context, original: boundedSupplementJson(original.immutableSnapshot) as FiscalDocumentSnapshot });
  }

  private async operationAliases(tx: Tx, command: FiscalSupplementCommand, prior: boolean, pointId: string): Promise<void> {
    const p = command.payload, e = p.envelope;
    const documents = await tx.document.findMany({ where: { OR: [ { id: p.operationId.toLowerCase() },
      { companyId: p.companyId, originSystem: 'BETA_SUPPLEMENT', originId: { in: aliases(p.operationId) } },
      ...(e.kind === 'NOTE' ? [{ companyId: p.companyId, type: TYPES[e.note.documentTypeCode], series: e.note.series, number: BigInt(e.note.number) }] : []),
    ] }, select: documentSelect, take: 3 });
    const batch = e.kind === 'BATCH' ? e.batch : undefined;
    const summaries = await tx.dailySummary.findMany({ where: { OR: [ { id: p.operationId.toLowerCase() },
      ...(batch ? [ { companyId: p.companyId, identifier: batch.identifier },
        { companyId: p.companyId, referenceDate: new Date(`${batch.referenceDate}T00:00:00Z`), sequence: Number(batch.identifier.split('-')[2]) } ] : []),
    ] }, select: { id: true, companyId: true, emissionPointId: true, identifier: true, referenceDate: true, sequence: true,
      items: { select: { documentId: true, lineNumber: true, conditionCode: true } } }, take: 3 });
    if (!prior) {
      if (documents.length || summaries.length) deny('ID/alias/número ya existe sin Outbox exacto');
    } else if (e.kind === 'NOTE') {
      if (documents.length !== 1 || summaries.length || documents[0].id.toLowerCase() !== p.operationId.toLowerCase() ||
          documents[0].companyId !== p.companyId || documents[0].emissionPointId !== pointId) deny('reserva NOTE propia inconsistente');
      same(documents[0].immutableSnapshot, e.note, 'copia NOTE reservada distinta');
    } else {
      const own = summaries[0];
      if (documents.length || summaries.length !== 1 || own.id.toLowerCase() !== p.operationId.toLowerCase() ||
          own.companyId !== p.companyId || own.emissionPointId !== pointId || own.identifier !== e.batch.identifier ||
          own.referenceDate.toISOString().slice(0, 10) !== e.batch.referenceDate || own.sequence !== Number(e.batch.identifier.split('-')[2]))
        deny('reserva batch propia inconsistente');
      same([...own.items].sort((a, b) => a.lineNumber - b.lineNumber), e.batch.input.entries.map((entry, i) => ({
        documentId: entry.document.snapshot.documentId.toLowerCase(), lineNumber: i + 1,
        conditionCode: 'conditionCode' in entry ? entry.conditionCode : '3',
      })), 'copias de miembros reservadas distintas');
    }
  }

  private async ownBatch(tx: Tx, command: FiscalSupplementCommand, actor: BetaSupplementActor,
    batch: FiscalBatchSnapshot, prior: boolean): Promise<string> {
    if (batch.input.kind === 'RC' && batch.input.entries.some(entry => entry.conditionCode === '2'))
      deny('RC2 bloqueado hasta persistencia materializada de versiones Billing; ledger independiente no la acredita');
    let pointId: string | undefined;
    const baseline = new Set<string>();
    for (const raw of batch.input.entries) {
      const own = await this.ownDocument(tx, command, actor, raw.document.snapshot);
      if (pointId && pointId !== own.emissionPointId) deny('miembros del lote requieren mismo punto');
      pointId = own.emissionPointId;
      if (raw.document.noteContext) await this.ownNoteContext(tx, command, actor,
        raw.document.snapshot as FiscalNoteSnapshot, raw.document.noteContext, own);
      if (batch.kind === 'RC') {
        const entry = raw as FiscalRcEntry;
        if (entry.conditionCode === '1') {
          if (!prior && !['PENDING', 'QUEUED', 'SUMMARY_PENDING'].includes(own.sunatStatus)) deny('RC alta requiere miembro propio aún no informado');
        } else {
          // Contract validation binds NOT_DELIVERED and previous acceptance to
          // exact bytes. Own persistence must additionally match those bytes.
          same(entry.previous.document.snapshot, own.immutableSnapshot, 'RC3 previo no es snapshot propio');
          this.ownAcceptance(own, entry.previous.acceptance);
          const source = entry.previous.acceptance.source;
          if (source.kind !== 'CDR_SUMMARY') deny('RC3 requiere base RC propia');
          const base = await tx.dailySummary.findUnique({ where: { companyId_identifier: {
            companyId: command.payload.companyId, identifier: source.identifier,
          } }, select: { id: true, companyId: true, emissionPointId: true, status: true, referenceDate: true,
            items: { select: { documentId: true, lineNumber: true, conditionCode: true } } } });
          if (!base || base.companyId !== command.payload.companyId || base.emissionPointId !== pointId || base.status !== 'ACCEPTED' ||
              base.referenceDate.toISOString().slice(0, 10) !== source.referenceDate || !base.items.some(item =>
                item.documentId === own.id && item.lineNumber === source.lineNumber && item.conditionCode === source.conditionCode))
            deny('RC3 sin pertenencia previa propia aceptada');
          baseline.add(`${base.id}/${own.id}/${source.lineNumber}/${source.conditionCode}`);
        }
      } else this.ownAcceptance(own, (raw as FiscalRaEntry).acceptance);
    }
    if (!prior) {
      const overlaps = await tx.dailySummaryItem.findMany({ where: {
        documentId: { in: batch.input.entries.map(entry => entry.document.snapshot.documentId.toLowerCase()) },
        summary: { status: { not: 'REJECTED' } },
      }, select: { documentId: true, lineNumber: true, conditionCode: true,
        summary: { select: { id: true, companyId: true, emissionPointId: true, status: true } } }, take: 201 });
      if (overlaps.length > 200 || overlaps.some(item => item.summary.status !== 'ACCEPTED' ||
          item.summary.companyId !== command.payload.companyId || item.summary.emissionPointId !== pointId ||
          !baseline.has(`${item.summary.id}/${item.documentId}/${item.lineNumber}/${item.conditionCode}`)))
        deny('miembro con batch pendiente/aceptado/ambiguo; sin liberación automática');
    }
    return pointId!;
  }

  private async insertNote(tx: Tx, command: FiscalSupplementCommand, actor: BetaSupplementActor,
    counterId: string, original: OwnDocument): Promise<void> {
    const e = command.payload.envelope;
    if (e.kind !== 'NOTE') deny('NOTE requerido');
    const note = e.note;
    await tx.document.create({ data: {
      id: command.payload.operationId.toLowerCase(), companyId: command.payload.companyId, seriesCounterId: counterId,
      type: TYPES[note.documentTypeCode], status: 'ISSUED', sunatStatus: 'QUEUED', series: note.series, number: BigInt(note.number),
      fullNumber: note.fullNumber, issueDate: new Date(note.issueDate), currencyCode: note.currencyCode,
      operationTypeCode: note.operationTypeCode, emissionPointId: original.emissionPointId, createdByUserId: actor.userId?.toLowerCase()??null,
      ...(actor.b2b?{createdByActor:json(actor.b2b)}:{}),
      customerIdentityType: note.customer.identityType, customerIdentityNumber: note.customer.identityNumber,
      customerLegalName: note.customer.legalName, customerAddress: note.customer.address,
      taxableAmount: note.totals.taxableAmount, unaffectedAmount: note.totals.unaffectedAmount,
      igvAmount: note.totals.igvAmount, payableAmount: note.totals.payableAmount,
      originSystem: 'BETA_SUPPLEMENT', originId: command.payload.operationId.toLowerCase(), immutableSnapshot: json(note),
      items: { create: note.lines.map(line => ({ lineNumber: line.lineNumber,
        internalCode: line.productCode,
        description: line.description, unitCode: line.unitCode, quantity: line.quantity, unitValue: line.unitValue,
        unitPriceWithTax: line.unitPriceWithTax, lineExtensionAmount: line.lineExtensionAmount,
        taxAffectationCode: line.taxAffectationCode, igvRate: line.igvRate, igvAmount: line.igvAmount, totalAmount: line.totalAmount,
      })) },
      taxes: { create: note.reasonCode === '01' && note.documentTypeCode === '08'
        ? [{ taxSchemeId: '9998', taxName: 'INA', taxableAmount: note.totals.unaffectedAmount, taxAmount: note.totals.igvAmount }]
        : [{ taxSchemeId: '1000', taxName: 'IGV', taxableAmount: note.totals.taxableAmount, taxAmount: note.totals.igvAmount }] },
      referencesFrom: { create: { targetDocumentId: original.id, targetTypeCode: note.reference.documentTypeCode,
        targetSeries: original.series, targetNumber: original.number, reasonCode: note.reasonCode, reason: note.reasonDescription } },
    } });
  }
}
