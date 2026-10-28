import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PRODUCTION_NOTES_ISSUED, PRODUCTION_NOTES_STATUS, type ProductionNotesAnyIssued as ProductionNotesIssued, type ProductionNotesAnyStatus as ProductionNotesStatus } from '@factuez/contracts';
import { assertProductionNotesOwner, signProductionNotesOwner, fiscalSnapshotSha256 } from '@factuez/sunat-core';
import { assertProductionNotesContext, productionNotesUsesRc, productionNotesRcSnapshot } from './production-notes-rc';
import { PrismaService } from '../infrastructure/prisma.service';
import type { Prisma } from '../generated/prisma/client';
export type ProductionNotesFile = {
    storageKey: string;
    sha256: string;
    sizeBytes: number;
};
export type ProductionNotesManifest = {
    xml: ProductionNotesFile;
    zip: ProductionNotesFile;
    fileName: string;
    digest: string;
    fingerprint: string;
    revision: number;
    xsdEvidence: unknown;
    rc?: { identifier: string; xml: ProductionNotesFile; individualZip: ProductionNotesFile; digest: string; xsdEvidence: unknown };

};
export type ProductionNotesDispatch = {
    documentId: string;
    eventId: string;
    payload: ProductionNotesIssued;
    snapshotSha256: string;
    phase: string;
    lease: string | null;
    leaseUntil: Date | null;
    manifest: ProductionNotesManifest | null;
    rcIdentifier?: string | null;
};
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
@Injectable()
export class ProductionNotesDispatchRepository {
    constructor(private readonly prisma: PrismaService) { }
    async stage(event: ProductionNotesIssued) {
        if (!event || event.eventName !== PRODUCTION_NOTES_ISSUED || event.producer !== 'billing-service' || !/^[a-f0-9-]{36}$/.test(event.eventId))
            throw Error('Evento de notas inválido');
        const { ownerProof, ...unsigned } = event;
        assertProductionNotesOwner(unsigned, 'issued', ownerProof);
        const p = event.payload;
        assertProductionNotesContext(p.snapshot, p);
        if (p.admission.snapshotSha256 !== fiscalSnapshotSha256(p.snapshot) || p.admission.profile !== p.snapshot.profile || p.admission.authorized !== true || !/^[a-f0-9]{64}$/.test(p.ownerRevisionSha256))
            throw Error('Admisión de otro snapshot');
        await this.prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', 'production-notes:document:' + p.snapshot.documentId);
            const prior = await tx.$queryRawUnsafe<ProductionNotesDispatch[]>('SELECT * FROM "ProductionNotesDispatch" WHERE "documentId"=$1::uuid', p.snapshot.documentId);
            if (prior[0]) {
                if (fiscalSnapshotSha256(prior[0].payload) !== fiscalSnapshotSha256(event))
                    throw Error('No se reemplaza evento de nota');
                return;
            }
            await tx.fiscalDocument.create({ data: { documentId: p.snapshot.documentId, issuerRuc: p.snapshot.issuer.identityNumber, documentType: p.snapshot.documentTypeCode, series: p.snapshot.series, number: BigInt(p.snapshot.number), environment: 'PRODUCTION', status: 'QUEUED', billingEventId: event.eventId, immutablePayload: json(p.snapshot) } });
            await tx.sunatSubmission.create({ data: { documentId: p.snapshot.documentId, channel: productionNotesUsesRc(p.snapshot) ? 'SOAP_SEND_SUMMARY' : 'SOAP_SEND_BILL', attempt: 1, idempotencyKey: 'production-notes:' + p.snapshot.documentId + ':v1', errorCode: 'AWAITING_AUTHORIZATION', result: 'PENDING' } });
            await tx.$executeRawUnsafe('INSERT INTO "ProductionNotesDispatch" ("documentId","eventId","payload","snapshotSha256") VALUES ($1::uuid,$2::uuid,$3::jsonb,$4)', p.snapshot.documentId, event.eventId, JSON.stringify(event), fiscalSnapshotSha256(p.snapshot));
        });
    }
    async load(id: string) { return (await this.prisma.$queryRawUnsafe<ProductionNotesDispatch[]>('SELECT * FROM "ProductionNotesDispatch" WHERE "documentId"=$1::uuid', id))[0]; }
    async due() {
      const ready = await this.prisma.$queryRawUnsafe<{documentId:string}[]>("SELECT \"documentId\" FROM \"ProductionNotesDispatch\" WHERE \"phase\" IN ('AWAITING_AUTHORIZATION','PREPARED') AND (\"lease\" IS NULL OR \"leaseUntil\"<=now()) ORDER BY \"createdAt\" LIMIT 20");
      const polls = await this.prisma.$queryRawUnsafe<{documentId:string}[]>(`SELECT d."documentId" FROM "ProductionNotesDispatch" d JOIN "ProductionNotesRcTicket" t USING ("documentId") WHERE d."phase"='POLLING' AND t."nextPollAt"<=now() AND (d."leaseUntil" IS NULL OR d."leaseUntil"<=now()) ORDER BY t."nextPollAt" LIMIT 20`);
      return [...ready,...polls];
    }
    async claim(id: string) { const lease = randomUUID(); const rows = await this.prisma.$queryRawUnsafe<ProductionNotesDispatch[]>("UPDATE \"ProductionNotesDispatch\" SET \"phase\"='PREPARING',\"lease\"=$2::uuid,\"leaseUntil\"=now()+interval '90 seconds' WHERE \"documentId\"=$1::uuid AND \"phase\" IN ('AWAITING_AUTHORIZATION','PREPARED') AND (\"lease\" IS NULL OR \"leaseUntil\"<=now()) RETURNING *", id, lease); return rows[0]; }
    private async artifact(tx: Prisma.TransactionClient, id: string, kind: 'SIGNED_XML' | 'SUBMISSION_ZIP' | 'CDR_XML' | 'CDR_ZIP', file: ProductionNotesFile) {
        const mediaType = kind.endsWith('ZIP') ? 'application/zip' : 'application/xml', key = { documentId_kind: { documentId: id, kind } };
        const old = await tx.documentArtifact.findUnique({ where: key });
        if (old && (old.storageKey !== file.storageKey || old.sha256 !== file.sha256 || old.sizeBytes !== BigInt(file.sizeBytes) || old.mediaType !== mediaType))
            throw Error('Artefacto de nota no se reemplaza');
        await tx.documentArtifact.upsert({ where: key, update: {}, create: { documentId: id, kind, ...file, mediaType } });
    }
    async prepared(row: ProductionNotesDispatch, manifest: ProductionNotesManifest) {
        const note=row.payload.payload.snapshot, rc=manifest.rc;
        if(productionNotesUsesRc(note) !== Boolean(rc) || rc && (rc.identifier!==row.rcIdentifier || manifest.fileName!==note.issuer.identityNumber+'-'+rc.identifier+'.zip' || rc.xml.sha256===manifest.xml.sha256 || rc.individualZip.sha256===manifest.zip.sha256))throw Error('Manifiesto RC individual/resumen inconsistente');
        await this.prisma.$transaction(async (tx) => {
            const locked = await tx.$queryRawUnsafe<ProductionNotesDispatch[]>('SELECT * FROM "ProductionNotesDispatch" WHERE "documentId"=$1::uuid FOR UPDATE', row.documentId), old = locked[0];
            if (!old || old.phase !== 'PREPARING' || old.lease !== row.lease || !old.leaseUntil || old.leaseUntil <= new Date())
                throw Error('Lease de preparación perdido');
            if (old.manifest && fiscalSnapshotSha256(old.manifest) !== fiscalSnapshotSha256(manifest))
                throw Error('No se reemplaza paquete preparado');
            await this.artifact(tx, row.documentId, 'SIGNED_XML', manifest.xml);
            await this.artifact(tx, row.documentId, 'SUBMISSION_ZIP', manifest.zip);
            await tx.fiscalDocument.update({ where: { documentId: row.documentId }, data: { digestValue: manifest.digest, status: 'SIGNED' } });
            await tx.sunatSubmission.updateMany({ where: { idempotencyKey: 'production-notes:' + row.documentId + ':v1', result: 'PENDING' }, data: { requestArtifactKey: manifest.zip.storageKey, errorCode: 'PREPARED' } });
            await tx.$executeRawUnsafe("UPDATE \"ProductionNotesDispatch\" SET \"manifest\"=$2::jsonb,\"phase\"='PREPARED' WHERE \"documentId\"=$1::uuid", row.documentId, JSON.stringify(manifest));
        });
    }
    async sending(row: ProductionNotesDispatch) {
        await this.prisma.$transaction(async (tx) => {
            const count = await tx.$executeRawUnsafe(`UPDATE "ProductionNotesDispatch" SET "phase"='SENDING' WHERE "documentId"=$1::uuid AND "lease"=$2::uuid AND "phase"='PREPARED' AND "leaseUntil">now()`, row.documentId, row.lease);
            if (count !== 1)
                throw Error('Lease de envío perdido');
            await tx.sunatSubmission.updateMany({ where: { idempotencyKey: 'production-notes:' + row.documentId + ':v1', result: 'PENDING' }, data: { errorCode: 'SENDING' } });
            await tx.fiscalDocument.update({ where: { documentId: row.documentId }, data: { status: 'SUBMITTED' } });
        });
    }
    async finish(row: ProductionNotesDispatch, status: ProductionNotesStatus['payload']['status'], details: {
        code?: string;
        cdrXml?: ProductionNotesFile;
        cdrZip?: ProductionNotesFile;
        trusted?: boolean;
    } = {}) {
        const final = ['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(status);
        if (final && (!details.trusted || !details.cdrXml || !details.cdrZip))
            throw Error('CDR propio verificado requerido');
        await this.prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRawUnsafe<ProductionNotesDispatch[]>('SELECT * FROM "ProductionNotesDispatch" WHERE "documentId"=$1::uuid FOR UPDATE', row.documentId), current = rows[0];
            if (!current || current.lease !== row.lease || !['PREPARING', 'PREPARED', 'SENDING', 'POLLING'].includes(current.phase) || !current.leaseUntil || current.leaseUntil <= new Date())
                throw Error('Lease de resultado perdido');
            if (final && (!['SENDING','POLLING'].includes(current.phase) || !current.manifest))
                throw Error('Resultado sin paquete enviado');
            let rcTicket:string|undefined;
            if(final && current.manifest?.rc) {
              const tickets=await tx.$queryRawUnsafe<{ticket:string;requestSha256:string}[]>('SELECT "ticket","requestSha256" FROM "ProductionNotesRcTicket" WHERE "documentId"=$1::uuid',row.documentId);
              if(current.phase!=='POLLING'||tickets.length!==1||tickets[0]!.requestSha256!==current.manifest.zip.sha256)throw Error('CDR RC sin ticket durable');
              rcTicket=tickets[0]!.ticket;
            }
            const doc = await tx.fiscalDocument.findUniqueOrThrow({ where: { documentId: row.documentId } });
            if (doc.environment !== 'PRODUCTION' || fiscalSnapshotSha256(doc.immutablePayload) !== row.snapshotSha256)
                throw Error('Documento propio cambió');
            const submission = await tx.sunatSubmission.findUniqueOrThrow({ where: { idempotencyKey: 'production-notes:' + row.documentId + ':v1' } });
            if(rcTicket && (submission.ticket!==rcTicket||submission.channel!=='SOAP_SEND_SUMMARY'||!submission.batchId||submission.requestArtifactKey!==current.manifest!.zip.storageKey))throw Error('Envío RC no vinculado al ticket');
            if (details.cdrXml && details.cdrZip) {
                await this.artifact(tx, row.documentId, 'CDR_XML', details.cdrXml);
                await this.artifact(tx, row.documentId, 'CDR_ZIP', details.cdrZip);
            }
            const projected = status === 'UNKNOWN' ? 'RETRYABLE_ERROR' : status === 'BLOCKED' ? 'PERMANENT_ERROR' : status;
            await tx.fiscalDocument.update({ where: { documentId: row.documentId }, data: { status: projected, ...(final && status !== 'REJECTED' ? { acceptedAt: new Date() } : {}) } });
            await tx.sunatSubmission.update({ where: { id: submission.id }, data: { result: status === 'REJECTED' || status === 'BLOCKED' ? 'BUSINESS_ERROR' : final ? 'SUCCESS' : 'UNKNOWN', errorCode: final ? 'DONE' : status, completedAt: new Date(), responseArtifactKey: details.cdrZip?.storageKey } });
            await tx.$executeRawUnsafe('UPDATE "ProductionNotesDispatch" SET "phase"=$2,"lastCode"=$3,"leaseUntil"=NULL WHERE "documentId"=$1::uuid', row.documentId, final ? 'DONE' : status, details.code ?? null);
            const unsigned: Omit<ProductionNotesStatus, 'ownerProof'> = { eventId: randomUUID(), eventName: PRODUCTION_NOTES_STATUS, producer: 'sunat-service' as const, occurredAt: new Date().toISOString(), payload: { documentId: row.documentId, snapshotSha256: row.snapshotSha256, originalSnapshotSha256: row.payload.payload.snapshot.reference.snapshotSha256, issuerRuc: row.payload.payload.snapshot.issuer.identityNumber, status, submissionId: submission.id,
                    environment: 'PRODUCTION', profile: row.payload.payload.snapshot.profile, cdrSignatureVerified: final, ...(details.code ? { responseCode: details.code } : {}), ...(current.manifest ? { requestXmlSha256: current.manifest.xml.sha256, requestZipSha256: current.manifest.zip.sha256 } : {}), ...(details.cdrXml && details.cdrZip ? { cdrXmlSha256: details.cdrXml.sha256, cdrZipSha256: details.cdrZip.sha256 } : {}) } };
            const event: ProductionNotesStatus = { ...unsigned, ownerProof: signProductionNotesOwner(unsigned, 'status') };
            await tx.$executeRawUnsafe('INSERT INTO "ProductionNotesStatusOutbox" ("id","documentId","payload") VALUES ($1::uuid,$2::uuid,$3::jsonb)', event.eventId, row.documentId, JSON.stringify(event));
        });
    }
    /** Shares the issuer RC lock and FiscalBatch namespace with initial boletas. */
    async reserveRc(row: ProductionNotesDispatch) {
      return this.prisma.$transaction(async tx=>{
        const note=row.payload.payload.snapshot,ruc=note.issuer.identityNumber;
        if(!productionNotesUsesRc(note))throw Error('Reserva RC para otra ruta');
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',`${ruc}:PRODUCTION:supplement`);
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',`${ruc}:PRODUCTION:RC`);
        const current=(await tx.$queryRawUnsafe<ProductionNotesDispatch[]>('SELECT * FROM "ProductionNotesDispatch" WHERE "documentId"=$1::uuid FOR UPDATE',row.documentId))[0];
        if(!current||current.lease!==row.lease||current.phase!=='PREPARING'||!current.leaseUntil||current.leaseUntil<=new Date())throw Error('Lease de reserva RC perdido');
        const previous=await tx.fiscalBatch.findUnique({where:{summaryId:row.documentId}});
        if(current.rcIdentifier){
          if(!previous||previous.identifier!==current.rcIdentifier||previous.billingEventId!==row.eventId||previous.environment!=='PRODUCTION'||previous.issuerRuc!==ruc||fiscalSnapshotSha256(previous.immutablePayload)!==fiscalSnapshotSha256(productionNotesRcSnapshot(note,current.rcIdentifier)))throw Error('Reserva RC inmutable inconsistente');
          return current.rcIdentifier;
        }
        if(previous)throw Error('Reserva RC ajena');
        const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
        if(!/^\d{8}$/.test(day))throw Error('Fecha RC inválida');
        const maximum=await tx.$queryRawUnsafe<{maximum:number|null}[]>(`SELECT MAX(split_part("identifier",'-',3)::integer) AS maximum FROM "FiscalBatch" WHERE "issuerRuc"=$1 AND "environment"::text='PRODUCTION' AND "identifier" ~ $2`,ruc,`^RC-${day}-[1-9][0-9]{0,4}$`);
        const next=(maximum[0]?.maximum??0)+1;if(next>99999)throw Error('Correlativo RC agotado');
        const identifier=`RC-${day}-${next}`,snapshot=productionNotesRcSnapshot(note,identifier);
        const batch=await tx.fiscalBatch.create({data:{summaryId:row.documentId,issuerRuc:ruc,identifier,environment:'PRODUCTION',status:'QUEUED',billingEventId:row.eventId,immutablePayload:json(snapshot)}});
        await tx.sunatSubmission.update({where:{idempotencyKey:'production-notes:'+row.documentId+':v1'},data:{batchId:batch.id}});
        await tx.$executeRawUnsafe('UPDATE "ProductionNotesDispatch" SET "rcIdentifier"=$2 WHERE "documentId"=$1::uuid',row.documentId,identifier);
        return identifier;
      });
    }
    async ticket(row: ProductionNotesDispatch, ticket:string) {
      if(!/^[A-Za-z0-9_-]{1,120}$/.test(ticket))throw Error('Ticket RC inválido');
      await this.prisma.$transaction(async tx=>{
        const rows=await tx.$queryRawUnsafe<ProductionNotesDispatch[]>('SELECT * FROM "ProductionNotesDispatch" WHERE "documentId"=$1::uuid FOR UPDATE',row.documentId),current=rows[0];
        if(!current||current.phase!=='SENDING'||current.lease!==row.lease||!current.leaseUntil||current.leaseUntil<=new Date()||!current.manifest?.rc)throw Error('Lease de ticket RC perdido');
        await tx.$executeRawUnsafe('INSERT INTO "ProductionNotesRcTicket" ("documentId","ticket","requestSha256") VALUES ($1::uuid,$2,$3)',row.documentId,ticket,current.manifest.zip.sha256);
        await tx.$executeRawUnsafe(`UPDATE "ProductionNotesDispatch" SET "phase"='POLLING',"lease"=NULL,"leaseUntil"=NULL WHERE "documentId"=$1::uuid`,row.documentId);
        await tx.sunatSubmission.update({where:{idempotencyKey:'production-notes:'+row.documentId+':v1'},data:{ticket,errorCode:'POLLING'}});
      });
    }
    async claimPoll(id:string) {
      return (await this.prisma.$queryRawUnsafe<(ProductionNotesDispatch & {ticket:string;pollAttempts:number})[]>(`WITH claimed AS (UPDATE "ProductionNotesDispatch" d SET "lease"=$2::uuid,"leaseUntil"=now()+interval '90 seconds' FROM "ProductionNotesRcTicket" t WHERE d."documentId"=$1::uuid AND t."documentId"=d."documentId" AND d."phase"='POLLING' AND (d."leaseUntil" IS NULL OR d."leaseUntil"<=now()) AND t."nextPollAt"<=now() AND t."requestSha256"=d."manifest"->'zip'->>'sha256' RETURNING d.*) SELECT c.*,t."ticket",t."pollAttempts" FROM claimed c JOIN "ProductionNotesRcTicket" t USING ("documentId")`,id,randomUUID()))[0];
    }
    async deferPoll(row: ProductionNotesDispatch & {pollAttempts:number}, code:string) {
      await this.prisma.$transaction(async tx=>{
        const count=await tx.$executeRawUnsafe(`UPDATE "ProductionNotesDispatch" SET "lease"=NULL,"leaseUntil"=NULL,"lastCode"=$3 WHERE "documentId"=$1::uuid AND "lease"=$2::uuid AND "phase"='POLLING' AND "leaseUntil">now()`,row.documentId,row.lease,code);
        if(count!==1)throw Error('Lease de sondeo perdido');
        const delay=Math.min(3600,5*2**Math.min(row.pollAttempts,10));
        await tx.$executeRawUnsafe(`UPDATE "ProductionNotesRcTicket" SET "pollAttempts"="pollAttempts"+1,"nextPollAt"=now()+($2*interval '1 second'),"lastCode"=$3 WHERE "documentId"=$1::uuid`,row.documentId,delay,code);
      });
    }
    async recover() {
        // Before SENDING a dead lease may reuse only its frozen manifest. Once SENDING it never reposts.
        await this.prisma.$executeRawUnsafe("UPDATE \"ProductionNotesDispatch\" SET \"phase\"=CASE WHEN \"manifest\" IS NULL THEN 'AWAITING_AUTHORIZATION' ELSE 'PREPARED' END,\"lease\"=NULL,\"leaseUntil\"=NULL WHERE \"phase\" IN ('PREPARING','PREPARED') AND \"leaseUntil\"<=now()");
        const expired = await this.prisma.$queryRawUnsafe<ProductionNotesDispatch[]>("UPDATE \"ProductionNotesDispatch\" SET \"lease\"=gen_random_uuid(),\"leaseUntil\"=now()+interval '30 seconds' WHERE \"phase\"='SENDING' AND \"leaseUntil\"<=now() RETURNING *");
        for (const row of expired)
            await this.finish(row, 'UNKNOWN', { code: 'INTERRUPTED_SEND_RECONCILIATION_REQUIRED' });
    }
}
