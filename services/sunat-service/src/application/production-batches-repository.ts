import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ProductionBatchesIssued, ProductionBatchesStatus, ProductionBatchesState } from '@factuez/contracts/production-batches';
import { assertProductionBatchesSnapshot } from '@factuez/sunat-core/dist/production-batches';
import { ProductionBatchesAuthenticator } from '@factuez/sunat-core/dist/production-batches-proof';
import { fiscalSnapshotSha256 } from '@factuez/sunat-core';
import { PrismaService } from '../infrastructure/prisma.service';
export const PRODUCTION_BATCHES_OWNER_VERIFIER=Symbol('production-batches-owner-verifier');
export const PRODUCTION_BATCHES_STATUS_AUTH=Symbol('production-batches-status-auth');
export type ProductionBatchesArtifact={storageKey:string;sha256:string;sizeBytes:number};
export type ProductionBatchesManifest={xml:ProductionBatchesArtifact;zip:ProductionBatchesArtifact;fileName:string;originals?:Record<string,{xml:ProductionBatchesArtifact;zip:ProductionBatchesArtifact;digest:string}>};
export type ProductionBatchesRow={batchId:string;payload:ProductionBatchesIssued;state:ProductionBatchesState;ticket:string|null;manifest:ProductionBatchesManifest|null;cdrManifest:{zip:ProductionBatchesArtifact;members:Record<string,ProductionBatchesArtifact>}|null;grant:ProductionBatchesGrant|null;responseCode:string|null};
export type ProductionBatchesGrant={issuerRuc:string;enabled:boolean;version:number;profile:string;credentialRevision:number;fingerprint:string};
@Injectable()
export class ProductionBatchesRepository {
  constructor(private readonly prisma:PrismaService,
    @Inject(PRODUCTION_BATCHES_OWNER_VERIFIER) private readonly owner:ProductionBatchesAuthenticator,
    @Inject(PRODUCTION_BATCHES_STATUS_AUTH) private readonly status:ProductionBatchesAuthenticator){}
  async stage(event:ProductionBatchesIssued){
    const {ownerProof,...body}=event;this.owner.verify(body,ownerProof);
    if(event.eventName!=='billing.production.batches.issued.v1')throw Error('Contrato de lote ajeno');
    // Validate using the trusted owner's creation time; send path separately checks current deadlines.
    assertProductionBatchesSnapshot(event.snapshot,event.occurredAt);
    return this.prisma.$transaction(async tx=>{
      const b=event.snapshot,hash=fiscalSnapshotSha256(b);
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-batches:ruc:'+b.issuerRuc);
      const numbers=await tx.$queryRawUnsafe<{identifier:string;issuerRuc:string}[]>('SELECT * FROM "ProductionBatchesNumber" WHERE "ownerId"=$1::uuid',b.batchId);
      if(numbers[0]?.identifier!==b.identifier||numbers[0].issuerRuc!==b.issuerRuc)throw Error('Número de lote no reservado por SUNAT');
      const prior=await tx.$queryRawUnsafe<{payload:ProductionBatchesIssued}[]>('SELECT "payload" FROM "ProductionBatchesDispatch" WHERE "batchId"=$1::uuid',b.batchId);
      if(prior[0]){if(fiscalSnapshotSha256(prior[0].payload)!==fiscalSnapshotSha256(event))throw Error('Replay incompatible');return;}
      for(const e of b.entries){
        const doc=await tx.fiscalDocument.findUnique({where:{documentId:e.snapshot.documentId}});
        if(!doc||doc.environment!=='PRODUCTION'||fiscalSnapshotSha256(doc.immutablePayload)!==fiscalSnapshotSha256(e.snapshot))throw Error('Original inmutable ajeno');
        if(e.pendingRoute){
          const routes=await tx.$queryRawUnsafe<{token:string;mode:string;transmissionStarted:boolean}[]>('SELECT * FROM "ProductionBatchesRoute" WHERE "documentId"=$1::uuid FOR UPDATE',doc.documentId);
          if(routes[0]?.mode!=='BATCH_PENDING'||routes[0].token!==e.pendingRoute.token||routes[0].transmissionStarted)throw Error('Reserva de ruta ausente');
        }
      }
      await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesDispatch" ("batchId","eventId","issuerRuc","snapshotSha256","payload") VALUES ($1::uuid,$2::uuid,$3,$4,$5::jsonb)',b.batchId,event.eventId,b.issuerRuc,hash,JSON.stringify(event));
      for(const e of b.entries)await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesMember" ("batchId","documentId","snapshotSha256") VALUES ($1::uuid,$2::uuid,$3)',b.batchId,e.snapshot.documentId,fiscalSnapshotSha256(e.snapshot));
    },{isolationLevel:'Serializable'});
  }
  async load(id:string){return (await this.prisma.$queryRawUnsafe<ProductionBatchesRow[]>('SELECT * FROM "ProductionBatchesDispatch" WHERE "batchId"=$1::uuid',id))[0];}
  async prepared(row:ProductionBatchesRow,manifest:ProductionBatchesManifest,grant:ProductionBatchesGrant){
    return this.prisma.$transaction(async tx=>{
      const changed=await tx.$executeRawUnsafe('UPDATE "ProductionBatchesDispatch" SET "manifest"=$2::jsonb,"grant"=$3::jsonb,"state"=\'PREPARED\',"updatedAt"=now() WHERE "batchId"=$1::uuid AND "state"=\'QUEUED\'',row.batchId,JSON.stringify(manifest),JSON.stringify(grant));
      if(changed!==1)return false;
      for(const [documentId,original]of Object.entries(manifest.originals??{})){
        for(const [kind,file,mediaType]of [['SIGNED_XML',original.xml,'application/xml'],['SUBMISSION_ZIP',original.zip,'application/zip']] as const){
          const prior=await tx.documentArtifact.findUnique({where:{documentId_kind:{documentId,kind}}});
          if(prior&&(prior.sha256!==file.sha256||prior.storageKey!==file.storageKey))throw Error('Original firmado ya archivado; no se reemplaza');
          if(!prior)await tx.documentArtifact.create({data:{documentId,kind,...file,mediaType}});
        }
        const d=await tx.fiscalDocument.findUniqueOrThrow({where:{documentId}});if(d.digestValue&&d.digestValue!==original.digest)throw Error('Digest original ya fijado');
        await tx.fiscalDocument.update({where:{documentId},data:{digestValue:original.digest}});
      }
      return true;
    });
  }
  async claim(row:ProductionBatchesRow){
    return (await this.prisma.$executeRawUnsafe('UPDATE "ProductionBatchesDispatch" SET "state"=\'SENDING\',"updatedAt"=now() WHERE "batchId"=$1::uuid AND "state"=\'PREPARED\'',row.batchId))===1;
  }
  async outcome(row:ProductionBatchesRow,expected:ProductionBatchesState,state:ProductionBatchesState,ticket?:string,cdr?:ProductionBatchesRow['cdrManifest'],code?:string){
    return this.prisma.$transaction(async tx=>{
      const count=await tx.$executeRawUnsafe('UPDATE "ProductionBatchesDispatch" SET "state"=$3,"ticket"=COALESCE($4,"ticket"),"cdrManifest"=COALESCE($5::jsonb,"cdrManifest"),"responseCode"=$6,"updatedAt"=now() WHERE "batchId"=$1::uuid AND "state"=$2',row.batchId,expected,state,ticket??null,cdr?JSON.stringify(cdr):null,code??null);
      if(count!==1)return false;
      const b=row.payload.snapshot,body:Omit<ProductionBatchesStatus,'ownerProof'>={eventId:randomUUID(),eventName:'sunat.production.batches.status.v1',batchId:b.batchId,snapshotSha256:fiscalSnapshotSha256(b),issuerRuc:b.issuerRuc,status:state,...(code?{responseCode:code}:{}),...(cdr?{cdrZipSha256:cdr.zip.sha256}:{}),
        members:b.entries.map(e=>({documentId:e.snapshot.documentId,snapshotSha256:fiscalSnapshotSha256(e.snapshot),...(e.conditionCode?{conditionCode:e.conditionCode}:{})}))};
      if(state==='ACCEPTED'&&b.kind==='RC')for(const e of b.entries)if(e.conditionCode==='1')await tx.fiscalDocument.update({where:{documentId:e.snapshot.documentId},data:{status:'ACCEPTED',acceptedAt:new Date()}});
      const event:ProductionBatchesStatus={...body,ownerProof:this.status.sign(body)};
      if(state==='ACCEPTED' && b.kind==='RC'){
        for(const e of b.entries)if(e.conditionCode!=='3')await tx.$executeRawUnsafe('UPDATE "ProductionBatchesMember" SET "active"=false WHERE "batchId"=$1::uuid AND "documentId"=$2::uuid',b.batchId,e.snapshot.documentId);
      }
      await tx.$executeRawUnsafe('INSERT INTO "ProductionBatchesStatusOutbox" ("id","payload") VALUES ($1::uuid,$2::jsonb)',body.eventId,JSON.stringify(event));
      return true;
    });
  }
  /** SENDING crash recovery never re-enters PREPARED or performs sendSummary. */
  async recover(){
    const rows=await this.prisma.$queryRawUnsafe<ProductionBatchesRow[]>('SELECT * FROM "ProductionBatchesDispatch" WHERE "state"=\'SENDING\' AND "updatedAt"<now()-interval \'2 minutes\' LIMIT 30');
    for(const r of rows)await this.outcome(r,'SENDING','UNKNOWN');
  }
}
