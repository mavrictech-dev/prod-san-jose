import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { allowsResource, PRODUCTION_NOTES_ISSUED, PRODUCTION_NOTES_PROFILE, PRODUCTION_NOTES_EXTENDED_PROFILE, type AccessScope, type FiscalDocumentSnapshot, type ProductionNotesExtendedAcceptance as ProductionNotesAcceptance, type ProductionNotesAnyAdmission as ProductionNotesAdmission, type ProductionNotesAnyIssued as ProductionNotesIssued, type ProductionNotesAnySnapshot as ProductionNotesSnapshot } from '@factuez/contracts';
import { assertProductionNotesExtendedOriginal as assertProductionNotesOriginal, assertProductionNotesAnySnapshot as assertProductionNotesSnapshot, buildProductionNotesSnapshot, buildProductionNotesExtendedSnapshot, fiscalSnapshotSha256, productionNotesExtendedAdjustment as productionNotesAdjustment, signProductionNotesOwner } from '@factuez/sunat-core';
import { PrismaService } from '../infrastructure/prisma.service';
import type { Prisma } from '../generated/prisma/client';
type Actor = {
    userId: string;
    scope: AccessScope;
    authorization: string;
};
type Reservation = {
    documentId: string;
    originalId: string;
    actorId: string;
    requestSha256: string;
    snapshotSha256: string;
    eventId: string;
    payload: ProductionNotesIssued;
    state: string;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
@Injectable()
export class ProductionNotesOwnerService {
    constructor(private readonly prisma: PrismaService) { }
    private async remote<T>(companyId: number, kind: string, body: unknown, authorization: string): Promise<T> {
        let r: Response;
        try {
            r = await fetch((process.env.SUNAT_INTERNAL_URL ?? 'http://sunat-service:3003') + '/api/v1/setup/sunat/' + companyId + '/PRODUCTION/notes/' + kind, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', ...(kind === 'admission' ? { 'X-Factuez-Notes-Owner': Buffer.from(JSON.stringify(signProductionNotesOwner(body, 'admission'))).toString('base64url') } : {}) }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
        }
        catch {
            throw new ServiceUnavailableException('SUNAT interno no disponible; no se reserva número');
        }
        if (!r.ok)
            throw new ConflictException('Admisión fiscal de notas pendiente; no se reserva número');
        return await r.json() as T;
    }
    private async own(tx: Prisma.TransactionClient, id: string, actor: Actor) {
        if (!uuid.test(id) || !uuid.test(actor.userId) || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(actor.authorization))
            throw new ForbiddenException('Actor/documento inválido');
        const own = await tx.document.findUnique({ where: { id }, include: { emissionPoint: { include: { branch: true, company: true } } } });
        const snapshot = own?.immutableSnapshot as unknown as FiscalDocumentSnapshot, p = own?.emissionPoint;
        if (!own || !p?.active || !p.branch?.active || !p.company.active || p.company.environment !== 'PRODUCTION' || !['INVOICE','SALES_RECEIPT'].includes(own.type) || own.status !== 'ISSUED' ||
            !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(own.sunatStatus) || !allowsResource(actor.scope, p.branch!.id, p.id, own.seriesCounterId))
            throw new ForbiddenException('Factura propia aceptada fuera del alcance');
        assertProductionNotesOriginal(snapshot);
        if (snapshot.documentId !== own.id || snapshot.companyId !== own.companyId || snapshot.branchId !== p.branchId || snapshot.issuer.identityNumber !== p.company.ruc || snapshot.fullNumber !== own.fullNumber || snapshot.series !== own.series || BigInt(snapshot.number) !== own.number || snapshot.customer.identityNumber !== own.customerIdentityNumber)
            throw new ConflictException('Snapshot propietario inconsistente');
        return { own, snapshot, point: p };
    }
    async ready(originalId: string, actor: Actor) {
        return this.prisma.$transaction(async (tx) => {
            const { own, snapshot, point } = await this.own(tx, originalId, actor);
            const series = await tx.seriesCounter.findMany({ where: { companyId: own.companyId, emissionPointId: own.emissionPointId, active: true, documentType: { in: ['CREDIT_NOTE', 'DEBIT_NOTE'] } }, orderBy: { series: 'asc' } });
            return { serverEnabled: process.env.BILLING_PRODUCTION_NOTES_ENABLED === 'true', original: { documentId: own.id, fullNumber: own.fullNumber, customer: snapshot.customer, lines: snapshot.lines, totals: snapshot.totals },
                series: series.filter(s => allowsResource(actor.scope, point.branch!.id, point.id, s.id)).map(s => ({ id: s.id, series: s.series, documentTypeCode: s.documentType === 'CREDIT_NOTE' ? '07' : '08', nextNumber: s.nextNumber.toString() })),
                profile: PRODUCTION_NOTES_PROFILE, availableProfiles:[PRODUCTION_NOTES_PROFILE,PRODUCTION_NOTES_EXTENDED_PROFILE], originalType:snapshot.documentTypeCode, extendedReasons:{'07':['01','02','03','04','05','06','07','08','09','10'],'08':['01','02','03']}, supportedReasons: { '07': ['01'], '08': ['02'] }, note: 'La admisión revalida certificado, autorización y CDR antes de reservar. No hay liberación automática de créditos rechazados o desconocidos.' };
        });
    }
    async issue(originalId: string, input: unknown, operationId: string, actor: Actor) {
        if (process.env.BILLING_PRODUCTION_NOTES_ENABLED !== 'true')
            throw new ServiceUnavailableException('Notas productivas deshabilitadas');
        if (!uuid.test(operationId) || !input || typeof input !== 'object' || Array.isArray(input))
            throw new BadRequestException('Operación inválida');
        const v = input as Record<string, unknown>;
        if (Object.keys(v).some(k=>!['adjustment','seriesCounterId','profile'].includes(k)) || !Object.hasOwn(v,'adjustment') || typeof v.seriesCounterId !== 'string' || !uuid.test(v.seriesCounterId))
            throw new BadRequestException('Envíe sólo serie y ajuste; el propietario obtiene el resto');
        const adjustment = productionNotesAdjustment(v.adjustment);
        if(v.profile!==undefined&&![PRODUCTION_NOTES_PROFILE,PRODUCTION_NOTES_EXTENDED_PROFILE].includes(v.profile as typeof PRODUCTION_NOTES_PROFILE))throw new BadRequestException('Perfil inválido');
        const requestHash = fiscalSnapshotSha256({ originalId, input });
        for (let attempt = 0;; attempt++) {
            try {
                return await this.prisma.$transaction(async (tx) => {
                    const { own, snapshot, point } = await this.own(tx, originalId, actor);
                    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', 'production-notes:ruc:' + snapshot.issuer.identityNumber);
                    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', 'production-notes:operation:' + operationId.toLowerCase());
                    await tx.$queryRawUnsafe('SELECT "id" FROM "CompanySettings" WHERE "id"=$1 FOR SHARE', own.companyId);
                    await tx.$queryRawUnsafe('SELECT "id" FROM "EmissionPoint" WHERE "id"=$1::uuid FOR SHARE', point.id);
                    await tx.$queryRawUnsafe('SELECT "id" FROM "Branch" WHERE "id"=$1::uuid FOR SHARE', point.branchId);
                    const prior = await tx.$queryRawUnsafe<Reservation[]>('SELECT * FROM "ProductionNotesReservation" WHERE "operationId"=$1::uuid', operationId);
                    if (prior[0]) {
                        if (prior[0].requestSha256 !== requestHash || prior[0].actorId !== actor.userId || prior[0].originalId !== originalId)
                            throw new ConflictException('Operación utilizada por otro actor/contenido');
                        return { documentId: prior[0].documentId, eventId: prior[0].eventId, deduplicated: true };
                    }
                    await tx.$queryRawUnsafe('SELECT "id" FROM "SeriesCounter" WHERE "id"=$1::uuid FOR UPDATE', v.seriesCounterId);
                    const counter = await tx.seriesCounter.findUnique({ where: { id: v.seriesCounterId as string } }), type = adjustment.documentTypeCode === '07' ? 'CREDIT_NOTE' : 'DEBIT_NOTE';
                    if (!counter?.active || counter.companyId !== own.companyId || counter.emissionPointId !== own.emissionPointId || counter.documentType !== type || !new RegExp('^'+(snapshot.documentTypeCode==='03'?'B':'F')+'[A-Z0-9]{3}$').test(counter.series) || !allowsResource(actor.scope, point.branch!.id, point.id, counter.id))
                        throw new ForbiddenException('Serie de nota fuera del punto y alcance');
                    if (counter.nextNumber < 1n || counter.nextNumber > 99999999n)
                        throw new ConflictException('Correlativo agotado');
                    const history = await tx.$queryRawUnsafe<Reservation[]>('SELECT * FROM "ProductionNotesReservation" WHERE "originalId"=$1::uuid ORDER BY "createdAt","documentId" LIMIT 101', originalId);
                    if (history.length > 100)
                        throw new ConflictException('Historial excede límite');
                    const references = await tx.documentReference.findMany({ where: { targetDocumentId: originalId }, select: { sourceDocumentId: true }, take: 102 });
                    if (references.length !== history.length || references.some(r => !history.some(h => h.documentId === r.sourceDocumentId)))
                        throw new ConflictException('Historial ajeno/no conciliado; no se aproxima capacidad');
                    if (history.some(h => h.payload.payload.snapshot.documentTypeCode !== adjustment.documentTypeCode))
                        throw new ConflictException('Mezcla de crédito y débito sobre original fuera de perfil');
                    const credits: ProductionNotesSnapshot[] = [];
                    for (const h of history) {
                        const n = h.payload.payload.snapshot;
                        const d = await tx.document.findUnique({ where: { id: h.documentId } });
                        if (!d || d.companyId !== own.companyId || fiscalSnapshotSha256(d.immutableSnapshot) !== h.snapshotSha256 || fiscalSnapshotSha256(n) !== h.snapshotSha256)
                            throw new ConflictException('Historial propietario inconsistente');
                        assertProductionNotesSnapshot(n, snapshot, h.payload.payload.creditHistory);
                        if (n.documentTypeCode === '07')
                            credits.push(n);
                    }
                    const acceptance = await this.remote<ProductionNotesAcceptance>(own.companyId, 'original-evidence', { original: snapshot }, actor.authorization);
                    const documentId = randomUUID(), eventId = randomUUID(), issueDate = new Date().toISOString();
                    const extended=v.profile===PRODUCTION_NOTES_EXTENDED_PROFILE||snapshot.documentTypeCode==='03'||(adjustment.documentTypeCode==='07'?adjustment.reasonCode!=='01':adjustment.reasonCode!=='02')||credits.some(n=>n.profile===PRODUCTION_NOTES_EXTENDED_PROFILE);
                    if(v.profile===PRODUCTION_NOTES_PROFILE&&extended)throw new BadRequestException('El motivo/original requiere perfil extendido');
                    const note:ProductionNotesSnapshot = extended
                      ? buildProductionNotesExtendedSnapshot(snapshot,acceptance,adjustment,{documentId,series:counter.series,number:counter.nextNumber.toString(),issueDate},credits)
                      : buildProductionNotesSnapshot(snapshot,acceptance as import('@factuez/contracts').ProductionNotesAcceptance,adjustment,{documentId,series:counter.series,number:counter.nextNumber.toString(),issueDate},credits as import('@factuez/contracts').ProductionNotesSnapshot[]);
                    if (note.lines.some(l => (l.productCode?.length ?? 0) > 40))
                        throw new ConflictException('Código de producto excede límite propietario; no se trunca');
                    const ownerRevisionSha256 = fiscalSnapshotSha256({ history: history.map(h => ({ documentId: h.documentId, snapshotSha256: h.snapshotSha256, state: h.state })), references, originalSha256: fiscalSnapshotSha256(snapshot), actorId: actor.userId });
                    const admission = await this.remote<ProductionNotesAdmission>(own.companyId, 'admission', { snapshot: note, original: snapshot, creditHistory: credits, ownerRevisionSha256 }, actor.authorization);
                    if (Object.keys(admission).sort().join(',') !== 'authorized,certificateFingerprint,credentialRevision,grantVersion,profile,snapshotSha256' || admission.authorized !== true || admission.profile !== note.profile || admission.snapshotSha256 !== fiscalSnapshotSha256(note) || !Number.isSafeInteger(admission.grantVersion) || admission.grantVersion < 1 || !Number.isSafeInteger(admission.credentialRevision) || admission.credentialRevision < 0 || !/^[a-f0-9]{64}$/.test(admission.certificateFingerprint))
                        throw new ConflictException('Admisión exacta inválida');
                    const unsigned: Omit<ProductionNotesIssued, 'ownerProof'> = { eventId, eventName: PRODUCTION_NOTES_ISSUED, producer: 'billing-service' as const, occurredAt: issueDate, correlationId: operationId, payload: { snapshot: note, original: snapshot, creditHistory: credits, ownerRevisionSha256, admission } };
                    const event: ProductionNotesIssued = { ...unsigned, ownerProof: signProductionNotesOwner(unsigned, 'issued') };
                    const changed = await tx.seriesCounter.updateMany({ where: { id: counter.id, companyId: own.companyId, emissionPointId: point.id, documentType: type, active: true, nextNumber: counter.nextNumber }, data: { nextNumber: { increment: 1n } } });
                    if (changed.count !== 1)
                        throw new ConflictException('Correlativo cambió');
                    await tx.document.create({ data: { id: documentId, companyId: own.companyId, seriesCounterId: counter.id, type, status: 'ISSUED', sunatStatus: 'QUEUED', series: note.series, number: BigInt(note.number), fullNumber: note.fullNumber, issueDate: new Date(note.issueDate), currencyCode: 'PEN', operationTypeCode: '0101', emissionPointId: point.id, createdByUserId: actor.userId,
                            customerIdentityType: note.customer.identityType, customerIdentityNumber: note.customer.identityNumber, customerLegalName: note.customer.legalName, customerAddress: note.customer.address, taxableAmount: note.totals.taxableAmount, unaffectedAmount:'unaffectedAmount' in note.totals?note.totals.unaffectedAmount:'0.00', igvAmount: note.totals.igvAmount, payableAmount: note.totals.payableAmount,
                            originSystem: 'PRODUCTION_NOTES', originId: operationId, immutableSnapshot: json(note), items: { create: note.lines.map(l => ({ lineNumber: l.lineNumber, internalCode: l.productCode, description: l.description, unitCode: l.unitCode, quantity: l.quantity, unitValue: l.unitValue, unitPriceWithTax: l.unitPriceWithTax, lineExtensionAmount: l.lineExtensionAmount, taxAffectationCode: l.taxAffectationCode, igvRate: l.igvRate, igvAmount: l.igvAmount, totalAmount: l.totalAmount })) },
                            taxes: { create: { taxSchemeId: note.lines.every(l=>l.taxAffectationCode==='30')?'9998':'1000', taxName: note.lines.every(l=>l.taxAffectationCode==='30')?'INA':'IGV', taxableAmount: note.lines.every(l=>l.taxAffectationCode==='30')&&'unaffectedAmount' in note.totals?note.totals.unaffectedAmount:note.totals.taxableAmount, taxAmount: note.totals.igvAmount } }, referencesFrom: { create: { targetDocumentId: originalId, targetTypeCode: snapshot.documentTypeCode, targetSeries: own.series, targetNumber: own.number, reasonCode: note.reasonCode, reason: note.reasonDescription } } } });
                    await tx.$executeRawUnsafe('INSERT INTO "ProductionNotesReservation" ("documentId","originalId","operationId","actorId","requestSha256","snapshotSha256","eventId","payload") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::uuid,$8::jsonb)', documentId, originalId, operationId, actor.userId, requestHash, fiscalSnapshotSha256(note), eventId, JSON.stringify(event));
                    await tx.$executeRawUnsafe('INSERT INTO "ProductionNotesOutbox" ("id","documentId","payload") VALUES ($1::uuid,$2::uuid,$3::jsonb)', eventId, documentId, JSON.stringify(event));
                    return { documentId, eventId, deduplicated: false };
                }, { isolationLevel: 'Serializable', timeout: 45000, maxWait: 5000 });
            }
            catch (e) {
                if (attempt >= 2 || !e || typeof e !== 'object' || !('code' in e) || e.code !== 'P2034')
                    throw e;
            }
        }
    }
}
