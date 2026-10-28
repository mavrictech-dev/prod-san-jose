import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { allowsResource, type AccessScope, type FiscalDocumentSnapshot } from '@factuez/contracts';
import type { ProductionBatchesCommand, ProductionBatchesEntry, ProductionBatchesDeclaration, ProductionBatchesIssued, ProductionBatchesAcceptance } from '@factuez/contracts/production-batches';
import { buildProductionBatchesSnapshot } from '@factuez/sunat-core/dist/production-batches';
import { ProductionBatchesAuthenticator } from '@factuez/sunat-core/dist/production-batches-proof';
import { fiscalObject, fiscalArray, fiscalUuid, fiscalText, fiscalSnapshotSha256, fiscalLimaDate } from '@factuez/sunat-core';
import { PrismaService } from '../infrastructure/prisma.service';
import type { Prisma } from '../generated/prisma/client';
export const PRODUCTION_BATCHES_OWNER_AUTH = Symbol('production-batches-owner-auth');
export type ProductionBatchesActor = { userId: string; scope: AccessScope; authorization: string; administrator: boolean };
/** Private owner-to-owner port; concrete SUNAT implementation must check its archive and routing ledger.
 * Main binds an authenticated internal transport, never an HTTP DTO or an evidence-producing factory. */
export abstract class ProductionBatchesEvidencePort {
  abstract reserveIdentifier(snapshot: FiscalDocumentSnapshot,kind:'RC'|'RA',batchId:string,issueDate:string,authorization:string):Promise<string>;
  abstract accepted(snapshot: FiscalDocumentSnapshot, authorization: string): Promise<ProductionBatchesAcceptance>;
  abstract reservePending(snapshot: FiscalDocumentSnapshot, token: string, authorization: string): Promise<void>;
  abstract assertCorrectionAvailable(snapshot: FiscalDocumentSnapshot, authorization: string): Promise<void>;
}
@Injectable()
export class ProductionBatchesOwnerService {
  constructor(private readonly prisma: PrismaService, private readonly evidence: ProductionBatchesEvidencePort,
    @Inject(PRODUCTION_BATCHES_OWNER_AUTH) private readonly auth: ProductionBatchesAuthenticator) {}
  private async own(tx: Prisma.TransactionClient, id: string, actor: ProductionBatchesActor) {
    fiscalUuid(id,'documentId'); fiscalUuid(actor.userId,'actor');
    if (!/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(actor.authorization)) throw Error('Actor autenticado requerido');
    const d = await tx.document.findUnique({where:{id},include:{emissionPoint:{include:{branch:true,company:true}}}});
    const p=d?.emissionPoint, s=d?.immutableSnapshot as unknown as FiscalDocumentSnapshot;
    if (!d || !p?.active || !p.branch?.active || !p.company.active || p.company.environment!=='PRODUCTION' || d.status!=='ISSUED' ||
        !allowsResource(actor.scope,p.branch.id,p.id,d.seriesCounterId) || s.environment!=='PRODUCTION' ||
        s.documentId!==id || s.companyId!==d.companyId || s.issuer.identityNumber!==p.company.ruc || s.fullNumber!==d.fullNumber ||
        s.series!==d.series || BigInt(s.number)!==d.number || s.branchId!==p.branchId) throw Error('Documento propietario fuera del alcance');
    return {d,s};
  }
  /** Called atomically from native issuance BEFORE publishing document.issued.
   * Missing row means INDIVIDUAL. Existing rows cannot change route or clear transmissionStarted. */
  async selectPending(tx: Prisma.TransactionClient, snapshot: FiscalDocumentSnapshot) {
    if (process.env.BILLING_PRODUCTION_BATCHES_ENABLED!=='true' || snapshot.environment!=='PRODUCTION' || snapshot.documentTypeCode!=='03') throw Error('Selección de lotes deshabilitada');
    const token=randomUUID();
    await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesRoute" ("documentId","issuerRuc","mode","token") VALUES ($1::uuid,$2,\'BATCH_PENDING\',$3::uuid)',snapshot.documentId,snapshot.issuer.identityNumber,token);
    return token;
  }
  async declareNotDelivered(id: string, reason: string, actor: ProductionBatchesActor) {
    if (!actor.administrator) throw Error('Declaración requiere administrador autenticado');
    fiscalText(reason,100,'reason');
    return this.prisma.$transaction(async tx=>{
      const {s}=await this.own(tx,id,actor);
      const declaration:ProductionBatchesDeclaration={id:randomUUID(),documentId:id,issuerRuc:s.issuer.identityNumber,snapshotSha256:fiscalSnapshotSha256(s),actorId:actor.userId,assertedAt:new Date().toISOString(),reason,status:'NOT_DELIVERED'};
      await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesDeclaration" ("id","documentId","issuerRuc","snapshotSha256","actorId","assertedAt","reason","status","payload") VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::timestamptz,$7,\'NOT_DELIVERED\',$8::jsonb)',declaration.id,id,declaration.issuerRuc,declaration.snapshotSha256,actor.userId,declaration.assertedAt,reason,JSON.stringify(declaration));
      return declaration;
    });
  }
  async issue(input: ProductionBatchesCommand, operationId:string, actor:ProductionBatchesActor) {
    if(process.env.BILLING_PRODUCTION_BATCHES_ENABLED!=='true')throw Error('Lotes productivos deshabilitados');
    fiscalUuid(operationId,'operationId'); fiscalObject(input,['kind','entries'],'command'); fiscalArray(input.entries,100,'entries');
    if(!input.entries.length||!['RC','RA'].includes(input.kind))throw Error('Lote inválido');
    for(const e of input.entries){fiscalObject(e,['documentId','conditionCode','declarationId'],'entry');fiscalUuid(e.documentId,'documentId');if(e.declarationId)fiscalUuid(e.declarationId,'declarationId');}
    const requestHash=fiscalSnapshotSha256(input);
    return this.prisma.$transaction(async tx=>{
      const owned=await Promise.all(input.entries.map(e=>this.own(tx,e.documentId,actor))), ruc=owned[0].s.issuer.identityNumber;
      if(owned.some(o=>o.s.issuer.identityNumber!==ruc))throw Error('Un RUC por lote');
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-batches:ruc:'+ruc);
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-batches:operation:'+operationId);
      const prior=await tx.$queryRawUnsafe<{payload:ProductionBatchesIssued;requestSha256:string;actorId:string}[]>('SELECT * FROM "ProductionBatchesReservation" WHERE "operationId"=$1::uuid',operationId);
      if(prior[0]){
        if(prior[0].actorId!==actor.userId||prior[0].requestSha256!==requestHash)throw Error('Idempotencia incompatible');
        return prior[0].payload;
      }
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-notes:ruc:'+ruc);
      const entries:ProductionBatchesEntry[]=[];
      for(const [i,o] of owned.entries()){
        const requested=input.entries[i], s=o.s;
        await tx.$queryRawUnsafe('SELECT "id" FROM "Document" WHERE "id"=$1::uuid FOR UPDATE',s.documentId);
        // Reread after the row lock; no client snapshot or stale owner read can enter the batch.
        const fresh=await this.own(tx,s.documentId,actor);
        if(fiscalSnapshotSha256(fresh.s)!==fiscalSnapshotSha256(s))throw Error('Original cambió');
        const locks=await tx.$queryRawUnsafe<unknown[]>('SELECT 1 FROM "ProductionBatchesMember" WHERE "documentId"=$1::uuid AND "active"',s.documentId);
        if(locks.length)throw Error('Documento ya reservado');
        const notes=await tx.documentReference.count({where:{targetDocumentId:s.documentId}});
        if(notes)throw Error('Original con notas/reservas de corrección; conciliar antes de baja');
        await this.evidence.assertCorrectionAvailable(s,actor.authorization);
        const e:ProductionBatchesEntry={snapshot:s};
        if(input.kind==='RC'){
          e.conditionCode=requested.conditionCode;
          if(e.conditionCode==='1'){
            const routes=await tx.$queryRawUnsafe<{token:string;mode:string;transmissionStarted:boolean}[]>('SELECT * FROM "ProductionBatchesRoute" WHERE "documentId"=$1::uuid FOR UPDATE',s.documentId);
            const route=routes[0];
            if(!route||route.mode!=='BATCH_PENDING'||route.transmissionStarted)throw Error('Boleta no seleccionada antes de transmisión');
            // Durable remote claim is idempotent by document+token. Failure leaves it pending, never falls back to individual.
            await this.evidence.reservePending(s,route.token,actor.authorization);
            e.pendingRoute={documentId:s.documentId,token:route.token,transmissionStarted:false};
          }else{
            const proof=await this.evidence.accepted(s,actor.authorization);
            e.previous={snapshot:structuredClone(s),acceptance:proof};
          }
        }else{if(requested.conditionCode)throw Error('RA no admite condición');e.acceptance=await this.evidence.accepted(s,actor.authorization);}
        if(input.kind==='RA'||e.conditionCode==='3'){
          const rows=await tx.$queryRawUnsafe<{payload:ProductionBatchesDeclaration}[]>('SELECT "payload" FROM "ProductionBatchesDeclaration" WHERE "id"=$1::uuid AND "documentId"=$2::uuid',requested.declarationId??null,s.documentId);
          if(!rows[0])throw Error('Declaración auditada requerida');e.declaration=rows[0].payload;
        }else if(requested.declarationId)throw Error('Declaración no aplicable');
        entries.push(e);
      }
      const now=new Date().toISOString(),issueDate=fiscalLimaDate(now),batchId=operationId;
      const identifier=await this.evidence.reserveIdentifier(entries[0].snapshot,input.kind,batchId,issueDate,actor.authorization);
      const snapshot=buildProductionBatchesSnapshot(entries,input.kind,{documentId:batchId,identifier,issueDate,referenceDate:fiscalLimaDate(entries[0].snapshot.issueDate)},owned[0].d.companyId,now);
      const body:Omit<ProductionBatchesIssued,'ownerProof'>={eventId:randomUUID(),eventName:'billing.production.batches.issued.v1',occurredAt:now,actorId:actor.userId,operationId,snapshot};
      const event:ProductionBatchesIssued={...body,ownerProof:this.auth.sign(body)};
      await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesReservation" ("batchId","operationId","actorId","issuerRuc","requestSha256","snapshotSha256","payload") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb)',batchId,operationId,actor.userId,ruc,requestHash,fiscalSnapshotSha256(snapshot),JSON.stringify(event));
      for(const e of entries)await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesMember" ("batchId","documentId","snapshotSha256") VALUES ($1::uuid,$2::uuid,$3)',batchId,e.snapshot.documentId,fiscalSnapshotSha256(e.snapshot));
      await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesOutbox" ("id","payload") VALUES ($1::uuid,$2::jsonb)',event.eventId,JSON.stringify(event));
      return event;
    },{isolationLevel:'Serializable',timeout:45000,maxWait:5000});
  }
}
