import { EventNames, isDocumentIssuedEventV1, type FiscalDocumentSnapshot } from '@factuez/contracts';
import { B2bSecurityError, b2bBindingsContain, validB2bBinding, validB2bCorrectionBinding, type B2bBinding, type B2bCorrectionBinding } from '@factuez/contracts/b2b-security';
import { B2bOwnerReadFrame, type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { adminDigest, adminSnapshot } from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import { fiscalSnapshotSha256 as hash, validateFiscalOriginal } from '@factuez/sunat-core/dist/fiscal-note';
import { CorrectionJournalRepository } from '../application/correction-journal.repository';
import { BetaSupplementCommandRepository } from '../application/beta-supplement-command.repository';
import type { PrismaService } from '../infrastructure/prisma.service';
import { reportActor, type ReportsCorrectionReadAuthority } from './phase8-reports/source-types';

export type BatchCreditHistoryRequest = { binding: B2bBinding; originalDocumentId: string; originalSnapshotSha256: string; journalRevision: number; journalHeadSha256: string };
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha=/^[a-f0-9]{64}$/;
const fail=(code='BATCH_CREDIT_HISTORY_UNAVAILABLE',status=409):never=>{throw new B2bSecurityError(status,code);};
/** Concrete OWNED journal reader, not a complete signed-version source.
 * The caller pins the exact original hash and journal revision/head. No latest,
 * historical guessing or complete:true. Physical notes/outbox/events are reconciled
 * by CorrectionJournalRepository; every note additionally needs its independent
 * current READ grant and active full hierarchy. Never uses WRITE grants for reads.
 * States stay exact: REJECTED is not renamed RESERVED/ACCEPTED. */
export class BillingBatchCreditHistory {
  private readonly journal: CorrectionJournalRepository;
  private readonly pairs: readonly B2bCorrectionBinding[];
  constructor(private readonly db: PrismaService, private readonly identity: B2bIdentityPort,
    private readonly reads: ReportsCorrectionReadAuthority, pairs: readonly B2bCorrectionBinding[], private readonly now=()=>new Date().toISOString()) {
    if(!Array.isArray(pairs)||!pairs.length||pairs.length>100||!pairs.every(validB2bCorrectionBinding))fail('BATCH_CREDIT_HISTORY_BOUNDARIES_REQUIRED',503);
    this.pairs=adminSnapshot(pairs); this.journal=new CorrectionJournalRepository(new BetaSupplementCommandRepository(db));
  }
  async read(token:string,kind:'USER'|'SERVICE',input:BatchCreditHistoryRequest){
    try{return await this.inspect(token,kind,input);}catch(e){
      if(e instanceof B2bSecurityError&&['BATCH_CREDIT_HISTORY_INPUT_INVALID','BATCH_CREDIT_HISTORY_SCOPE_DENIED','BATCH_CREDIT_HISTORY_VERSION_MISSING','BATCH_CREDIT_HISTORY_PROFILE_UNSUPPORTED'].includes(e.code))throw e;
      return fail();
    }
  }
  private async inspect(token:string,kind:'USER'|'SERVICE',input:BatchCreditHistoryRequest){
    const q=adminSnapshot(input),asOf=this.now();
    if(!q||Object.keys(q).sort().join(',')!=='binding,journalHeadSha256,journalRevision,originalDocumentId,originalSnapshotSha256'||!validB2bBinding(q.binding)||
      !uuid.test(q.originalDocumentId)||!sha.test(q.originalSnapshotSha256)||!sha.test(q.journalHeadSha256)||!Number.isSafeInteger(q.journalRevision)||q.journalRevision<0||q.journalRevision>200)
      fail('BATCH_CREDIT_HISTORY_INPUT_INVALID',400);
    if(q.binding.documentType!=='01')fail('BATCH_CREDIT_HISTORY_PROFILE_UNSUPPORTED');
    const frame=new B2bOwnerReadFrame(this.identity,kind),scopes=['b2b:batches:read','b2b:documents:read','b2b:corrections:read','b2b:reports:read'] as const;
    const current=async()=>{const p=await frame.principal(token,[...scopes]);if(!b2bBindingsContain(p.bindings,q.binding))fail('BATCH_CREDIT_HISTORY_SCOPE_DENIED',403);return p;};
    const principal=await current(),pairs=this.pairs.filter(p=>adminDigest(p.reference)===adminDigest(q.binding));
    if(!pairs.length)fail('BATCH_CREDIT_HISTORY_SCOPE_DENIED',403);
    return this.db.$transaction(async tx=>{
      // Same aggregate lock as reserve/settle, before any source rows are loaded.
      await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',`factuez:beta-supplement:company:${q.binding.issuerId}:ruc:${q.binding.issuerRuc}`);
      const row=await tx.document.findFirst({where:{id:q.originalDocumentId,companyId:q.binding.issuerId,emissionPointId:q.binding.pointId,seriesCounterId:q.binding.seriesId,status:'ISSUED',type:'INVOICE'},select:{immutableSnapshot:true}});
      const original=adminSnapshot(row?.immutableSnapshot) as unknown as FiscalDocumentSnapshot;
      if(!original||hash(original)!==q.originalSnapshotSha256)fail('BATCH_CREDIT_HISTORY_VERSION_MISSING');
      validateFiscalOriginal(original,asOf);
      if(original.documentId!==q.originalDocumentId||original.environment!=='BETA'||original.companyId!==q.binding.issuerId||original.branchId!==q.binding.branchId||original.issuer.identityNumber!==q.binding.issuerRuc||original.documentTypeCode!=='01'||!original.series.startsWith('F'))fail('BATCH_CREDIT_HISTORY_SCOPE_DENIED',403);
      const issued=await tx.outboxEvent.findMany({where:{aggregateId:q.originalDocumentId,eventType:EventNames.documentIssued},select:{id:true,payload:true},take:2});
      const event=issued[0]?.payload;
      if(issued.length!==1||!isDocumentIssuedEventV1(event)||event.eventId!==issued[0].id||event.producer!=='billing-service'||hash(event.payload)!==q.originalSnapshotSha256||Date.parse(event.occurredAt)>Date.parse(asOf))return fail('BATCH_CREDIT_HISTORY_VERSION_MISSING');
      const loaded=await this.journal.load(tx,original),projection=loaded.projection;
      if(projection.revision!==q.journalRevision||projection.headSha256!==q.journalHeadSha256)fail('BATCH_CREDIT_HISTORY_VERSION_MISSING');
      const series=await tx.seriesCounter.findMany({where:{id:{in:[q.binding.seriesId,...pairs.map(p=>p.noteSeriesId)]},companyId:q.binding.issuerId,emissionPointId:q.binding.pointId,active:true,
        company:{ruc:q.binding.issuerRuc,environment:'BETA',active:true},emissionPoint:{branchId:q.binding.branchId,active:true,branch:{companyId:q.binding.issuerId,active:true}}},select:{id:true,series:true,documentType:true}});
      if(!series.some(s=>s.id===q.binding.seriesId&&s.series===original.series&&s.documentType==='INVOICE'))fail('BATCH_CREDIT_HISTORY_SCOPE_DENIED',403);
      const reserves=loaded.events.flatMap((e,index)=>e.kind==='RESERVE'?[{event:e,revision:index+1}]:[]);
      const notes=await tx.document.findMany({where:{id:{in:reserves.map(r=>r.event.command.payload.operationId)}},select:{id:true,companyId:true,emissionPointId:true,seriesCounterId:true,immutableSnapshot:true},take:101});
      if(notes.length!==reserves.length)fail('BATCH_CREDIT_HISTORY_VERSION_MISSING');
      const marks=new Map<string,string>(),entries=[];
      const authorize=async(pair:B2bCorrectionBinding)=>{
        const grant=adminSnapshot(await this.reads.current(token,kind,pair));
        if(grant.action!=='READ'||adminDigest(grant.binding)!==adminDigest(pair)||adminDigest(grant.actor)!==adminDigest(reportActor(principal))||grant.clientRevision!==principal.revision||!Number.isSafeInteger(grant.grantRevision)||grant.grantRevision<1)fail('BATCH_CREDIT_HISTORY_SCOPE_DENIED',403);
        const k=adminDigest(pair),stamp=adminDigest(grant);if(marks.has(k)&&marks.get(k)!==stamp)fail('BATCH_CREDIT_HISTORY_SCOPE_DENIED',403);marks.set(k,stamp);
      };
      for(const r of reserves){
        const command=r.event.command,envelope=command.payload.envelope;
        if(envelope.kind!=='NOTE'||Date.parse(command.occurredAt)>Date.parse(asOf))return fail('BATCH_CREDIT_HISTORY_VERSION_MISSING');
        const note=envelope.note,physical=notes.find(n=>n.id===note.documentId),pair=pairs.find(p=>p.noteSeriesId===physical?.seriesCounterId&&p.noteType===note.documentTypeCode);
        if(!physical||physical.companyId!==q.binding.issuerId||physical.emissionPointId!==q.binding.pointId||hash(physical.immutableSnapshot)!==hash(note)||!pair||
          !series.some(s=>s.id===pair.noteSeriesId&&s.series===note.series&&s.documentType===(pair.noteType==='07'?'CREDIT_NOTE':'DEBIT_NOTE')))return fail('BATCH_CREDIT_HISTORY_SCOPE_DENIED',403);
        await authorize(pair);
        const state=projection.operations.find(o=>o.operationId===note.documentId)?.state;
        const settlement=loaded.events.find(e=>e.kind==='SETTLE'&&e.operationId===note.documentId);
        if(!state||settlement?.kind==='SETTLE'&&Date.parse(settlement.evidence.acceptedAt)>Date.parse(asOf))fail('BATCH_CREDIT_HISTORY_VERSION_MISSING');
        entries.push({binding:pair,note:adminSnapshot(note),snapshotSha256:hash(note),state,reservationRevision:r.revision,reservationEventId:command.eventId,
          commandSha256:hash(command),settlement:settlement?.kind==='SETTLE'?adminSnapshot(settlement):null});
      }
      entries.sort((a,b)=>a.note.documentId.localeCompare(b.note.documentId));
      await current();for(const p of pairs)if(marks.has(adminDigest(p)))await authorize(p);
      // Reconcile once again under the same lock; missing/mixed ledgers never become coverage.
      const after=await this.journal.load(tx,original);
      if(hash(after.events)!==hash(loaded.events)||after.projection.headSha256!==q.journalHeadSha256)fail('BATCH_CREDIT_HISTORY_VERSION_MISSING');
      await current();
      return {schemaVersion:'factuez.billing.batch-credit-history.v1',environment:'BETA' as const,profile:'CORRECTION_JOURNAL_V2_F01' as const,
        coverage:'RECONCILED_JOURNAL_ONLY' as const,signedVersionCoverage:'NOT_PROVIDED' as const,acceptanceProof:'NOT_PROVIDED' as const,
        original:{snapshot:original,snapshotSha256:q.originalSnapshotSha256,issuanceEventId:event.eventId},
        journal:{revision:projection.revision,headSha256:projection.headSha256,eventsSha256:hash(loaded.events)},entries,checkedAt:asOf};
    },{isolationLevel:'Serializable',maxWait:3000,timeout:15000});
  }
}
