import { Inject,Optional,Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { redisConnection,LivePublisher } from '@factuez/service-access';
import { PRODUCTION_NOTES_STATUS, PRODUCTION_NOTES_PROFILE, isProductionNotesProfile, PRODUCTION_NOTES_REQUEST_QUEUE, PRODUCTION_NOTES_STATUS_QUEUE, type ProductionNotesAnySnapshot as ProductionNotesSnapshot, type ProductionNotesAnyStatus as ProductionNotesStatus } from '@factuez/contracts';
import { assertProductionNotesOwner, fiscalSnapshotSha256 } from '@factuez/sunat-core';
import { PrismaService } from '../infrastructure/prisma.service';
export const PRODUCTION_NOTES_LIVE_FACTORY='PRODUCTION_NOTES_LIVE_FACTORY';
export type ProductionNotesLive={changed(documentId:string):Promise<void>;close():Promise<void>};
@Injectable()
export class ProductionNotesOwnerRuntime implements OnApplicationBootstrap, OnModuleDestroy {
    private queue?: Queue;
    private worker?: Worker;
    private timer?: NodeJS.Timeout;
    private active?: Promise<void>;
    private closing = false;
    private live?:ProductionNotesLive;
    constructor(private readonly prisma: PrismaService,@Optional() @Inject(PRODUCTION_NOTES_LIVE_FACTORY) private readonly liveFactory:()=>ProductionNotesLive=()=>new LivePublisher()) { }
    private async changed(id:string){try{await (this.live??=this.liveFactory()).changed(id);}catch{/* Commit/publication is durable; live delivery never rolls it back or reposts. */}} 
    async project(event: ProductionNotesStatus) {
        if (!event || event.eventName !== PRODUCTION_NOTES_STATUS || event.producer !== 'sunat-service')
            throw Error('Evento de notas inválido');
        const { ownerProof, ...unsigned } = event;
        assertProductionNotesOwner(unsigned, 'status', ownerProof);
        const p = event.payload, final = ['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(p.status), sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
        if (!isProductionNotesProfile(p.profile) || p.environment !== 'PRODUCTION' || !['SUBMITTED', 'ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED', 'UNKNOWN', 'BLOCKED'].includes(p.status) || !sha(p.snapshotSha256) || !sha(p.originalSnapshotSha256) ||
            final && (p.cdrSignatureVerified !== true || ![p.requestXmlSha256, p.requestZipSha256, p.cdrXmlSha256, p.cdrZipSha256].every(sha)))
            throw Error('Evidencia oficial de nota incompleta');
        const committed=await this.prisma.$transaction(async (tx) => {
            const duplicate = await tx.$queryRawUnsafe<{
                payloadSha256: string;
            }[]>('SELECT "payloadSha256" FROM "ProductionNotesInbox" WHERE "id"=$1::uuid', event.eventId);
            if (duplicate[0]) {
                if (duplicate[0].payloadSha256 !== fiscalSnapshotSha256(event))
                    throw Error('Evento duplicado alterado');
                return false;
            }
            const rows = await tx.$queryRawUnsafe<{
                snapshotSha256: string;
                state: string;
                outcome: ProductionNotesStatus | null;
            }[]>('SELECT * FROM "ProductionNotesReservation" WHERE "documentId"=$1::uuid FOR UPDATE', p.documentId), reservation = rows[0];
            const own = await tx.document.findUnique({ where: { id: p.documentId } }), snapshot = own?.immutableSnapshot as unknown as ProductionNotesSnapshot;
            if (!reservation || !own || own.originSystem !== 'PRODUCTION_NOTES' || snapshot.environment !== 'PRODUCTION' || snapshot.profile !== p.profile ||
                reservation.snapshotSha256 !== p.snapshotSha256 || fiscalSnapshotSha256(snapshot) !== p.snapshotSha256 || snapshot.reference.snapshotSha256 !== p.originalSnapshotSha256 || snapshot.issuer.identityNumber !== p.issuerRuc)
                throw Error('Proyección no corresponde al propietario');
            if (['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(reservation.state)) {
                if (!reservation.outcome || fiscalSnapshotSha256(reservation.outcome.payload) !== fiscalSnapshotSha256(p))
                    throw Error('Resultado final no se reemplaza');
            }
            else {
                const status = p.status === 'SUBMITTED' ? 'PROCESSING' : p.status === 'UNKNOWN' ? 'RETRYABLE_ERROR' : p.status === 'BLOCKED' ? 'PERMANENT_ERROR' : p.status;
                const updated = await tx.document.updateMany({ where: { id: p.documentId, sunatStatus: own.sunatStatus }, data: { sunatStatus: status, sunatResponseCode: final ? p.responseCode : undefined, sunatResponseDescription: p.status === 'UNKNOWN' ? 'Resultado desconocido; conciliar sin reenviar' : 'Resultado fiscal de nota productiva' } });
                if (updated.count !== 1)
                    throw Error('Estado propietario cambió');
                await tx.$executeRawUnsafe('UPDATE "ProductionNotesReservation" SET "state"=$2,"outcome"=$3::jsonb WHERE "documentId"=$1::uuid', p.documentId, p.status, JSON.stringify(event));
            }
            await tx.$executeRawUnsafe('INSERT INTO "ProductionNotesInbox" ("id","documentId","payloadSha256") VALUES ($1::uuid,$2::uuid,$3)', event.eventId, p.documentId, fiscalSnapshotSha256(event));
            return true;
        });
        if(committed)await this.changed(p.documentId);
    }
    async flush() {
        if (!this.queue || this.closing)
            return;
        const rows = await this.prisma.$queryRawUnsafe<{
            id: string;
            documentId:string;
            payload: unknown;
        }[]>('SELECT "id","documentId","payload" FROM "ProductionNotesOutbox" WHERE "publishedAt" IS NULL ORDER BY "createdAt" LIMIT 30');
        for (const row of rows) {
            if (this.closing)
                return;
            await this.queue.add('production-note', row.payload, { jobId: row.id, attempts: 8, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: { age: 86400 }, removeOnFail: { age: 604800 } });
            await this.prisma.$executeRawUnsafe('UPDATE "ProductionNotesOutbox" SET "publishedAt"=now() WHERE "id"=$1::uuid', row.id);
            await this.changed(row.documentId);
        }
    }
    onApplicationBootstrap() {
        if (process.env.BILLING_PRODUCTION_NOTES_ENABLED !== 'true')
            return;
        this.queue = new Queue(PRODUCTION_NOTES_REQUEST_QUEUE, { connection: redisConnection() });
        this.queue.on('error', () => { });
        this.worker = new Worker(PRODUCTION_NOTES_STATUS_QUEUE, job => this.project(job.data), { connection: redisConnection(), concurrency: 1 });
        this.worker.on('error', () => { });
        this.timer = setInterval(() => { if (this.active || this.closing)
            return; this.active = this.flush().catch(() => { }).finally(() => { this.active = undefined; }); }, 1000);
    }
    async onModuleDestroy() { this.closing = true; if (this.timer)
        clearInterval(this.timer); await this.active; await this.worker?.close(); await this.queue?.close(); await this.live?.close(); }
}
