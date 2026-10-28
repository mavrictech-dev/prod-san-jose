import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {BillingBatchCreditHistory} from '../services/billing-service/src/b2b/batch-credit-history';
import type {B2bBinding,B2bPrincipal} from '@factuez/contracts/b2b-security';
import {EventNames} from '../packages/contracts/src/events';
import {fiscalSnapshotSha256} from '../packages/sunat-core/src/fiscal-note';
import {projectCorrectionJournal} from '../packages/sunat-core/src/fiscal-correction-journal';
import {supplementCommandFixture} from './helpers/fiscal-supplement.fixture';

/** Synthetic boundaries only: the incomplete reader is not an issuance or CDR test. */
function fixture(){
 const binding:B2bBinding={issuerId:1,issuerRuc:'20000000001',environment:'BETA',branchId:randomUUID(),pointId:randomUUID(),seriesId:randomUUID(),documentType:'01'};
 const pair={reference:binding,noteSeriesId:randomUUID(),noteType:'07' as const};
 const principal:B2bPrincipal={kind:'SERVICE',clientId:randomUUID(),revision:1,subjectId:null,userAuthRevision:null,environment:'BETA',bindings:[binding],
  scopes:['b2b:batches:read','b2b:documents:read','b2b:corrections:read','b2b:reports:read']};
 const identity={authenticate:vi.fn(async()=>structuredClone(principal))};
 const tx={$queryRawUnsafe:vi.fn(async()=>[]),document:{findFirst:vi.fn(async()=>({immutableSnapshot:{documentId:randomUUID()}}))}};
 const db={$transaction:vi.fn(async(work:any)=>work(tx))};
 const reads={current:vi.fn(async()=>{throw Error('SHOULD_NOT_REACH_NOTE_READ');})};
 const source=new BillingBatchCreditHistory(db as any,identity as any,reads as any,[pair],()=> '2026-10-03T18:00:00Z');
 const query={binding,originalDocumentId:randomUUID(),originalSnapshotSha256:'a'.repeat(64),journalRevision:1,journalHeadSha256:'b'.repeat(64)};
 return {binding,pair,principal,identity,tx,db,reads,source,query};
}
describe('Billing BETA credit history source boundaries',()=>{
 it('rejects unconfigured, malformed and cross-series correction boundaries',()=>{
  const f=fixture();
  expect(()=>new BillingBatchCreditHistory(f.db as any,f.identity as any,f.reads as any,[])).toThrow('BOUNDARIES_REQUIRED');
  expect(()=>new BillingBatchCreditHistory(f.db as any,f.identity as any,f.reads as any,[{...f.pair,noteSeriesId:f.binding.seriesId}])).toThrow('BOUNDARIES_REQUIRED');
 });
 it.each(['extra','negative','hash','document'] as const)('rejects invalid %s request before touching storage',async which=>{
  const f=fixture(),q:any={...f.query};
  if(which==='extra')q.accepted=true;if(which==='negative')q.journalRevision=-1;if(which==='hash')q.journalHeadSha256='bad';if(which==='document')q.originalDocumentId='bad';
  await expect(f.source.read('token','SERVICE',q)).rejects.toMatchObject({code:'BATCH_CREDIT_HISTORY_INPUT_INVALID'});
  expect(f.db.$transaction).not.toHaveBeenCalled();expect(f.identity.authenticate).not.toHaveBeenCalled();
 });
 it('rejects boletas until a supported history profile is implemented',async()=>{
  const f=fixture();await expect(f.source.read('token','SERVICE',{...f.query,binding:{...f.binding,documentType:'03'}})).rejects.toMatchObject({code:'BATCH_CREDIT_HISTORY_PROFILE_UNSUPPORTED'});
  expect(f.db.$transaction).not.toHaveBeenCalled();
 });
 it('rejects a different issuer, branch or series before reading the journal',async()=>{
  const f=fixture();f.principal.bindings=[{...f.binding,seriesId:randomUUID()}];
  await expect(f.source.read('token','SERVICE',f.query)).rejects.toMatchObject({code:'BATCH_CREDIT_HISTORY_SCOPE_DENIED'});
  expect(f.db.$transaction).not.toHaveBeenCalled();expect(f.reads.current).not.toHaveBeenCalled();
 });
 it('rejects missing permissions without reading any fiscal record',async()=>{
  const f=fixture();f.principal.scopes=f.principal.scopes.filter(s=>s!=='b2b:corrections:read');
  await expect(f.source.read('token','SERVICE',f.query)).rejects.toMatchObject({code:'BATCH_CREDIT_HISTORY_UNAVAILABLE'});
  expect(f.db.$transaction).not.toHaveBeenCalled();
 });
 it('holds the aggregate lock and refuses a mismatched snapshot rather than guessing a latest version',async()=>{
  const f=fixture();await expect(f.source.read('token','SERVICE',f.query)).rejects.toMatchObject({code:'BATCH_CREDIT_HISTORY_VERSION_MISSING'});
  expect(f.tx.$queryRawUnsafe).toHaveBeenCalledOnce();expect(f.tx.document.findFirst).toHaveBeenCalledOnce();expect(f.reads.current).not.toHaveBeenCalled();
 });
 it('reads and reconciles an empty owner journal twice without asserting signature or SUNAT proof',async()=>{
  const {doc}=supplementCommandFixture(),binding:B2bBinding={issuerId:doc.companyId!,issuerRuc:doc.issuer.identityNumber,environment:'BETA',branchId:doc.branchId!,pointId:randomUUID(),seriesId:randomUUID(),documentType:'01'};
  const pair={reference:binding,noteSeriesId:randomUUID(),noteType:'07' as const},eventId=randomUUID();
  const principal:B2bPrincipal={kind:'SERVICE',clientId:randomUUID(),revision:1,subjectId:null,userAuthRevision:null,environment:'BETA',bindings:[binding],scopes:['b2b:batches:read','b2b:documents:read','b2b:corrections:read','b2b:reports:read']};
  const physical={companyId:doc.companyId,emissionPointId:binding.pointId,type:'INVOICE',status:'ISSUED',sunatStatus:'ACCEPTED',series:doc.series,number:BigInt(doc.number),fullNumber:doc.fullNumber,currencyCode:doc.currencyCode,
   immutableSnapshot:doc,taxableAmount:doc.totals.taxableAmount,igvAmount:doc.totals.igvAmount,payableAmount:doc.totals.payableAmount,unaffectedAmount:'0.00',issueDate:new Date(doc.issueDate),operationTypeCode:doc.operationTypeCode,
   customerIdentityType:doc.customer.identityType,customerIdentityNumber:doc.customer.identityNumber,customerLegalName:doc.customer.legalName,customerAddress:null};
  const issued={id:eventId,payload:{eventId,eventName:EventNames.documentIssued,correlationId:randomUUID(),producer:'billing-service',occurredAt:doc.issueDate,payload:doc}};
  const raw=vi.fn(async(sql:string)=>sql.includes('to_regclass')?[{name:null}]:[]);
  const tx={$queryRawUnsafe:raw,document:{findFirst:vi.fn(async()=>({immutableSnapshot:doc})),findUnique:vi.fn(async()=>physical),findMany:vi.fn(async()=>[])},
   outboxEvent:{findMany:vi.fn(async()=>[issued])},seriesCounter:{findMany:vi.fn(async()=>[{id:binding.seriesId,series:doc.series,documentType:'INVOICE'}])},
   financialLedgerStream:{findUnique:vi.fn(async()=>null)},dailySummaryItem:{findFirst:vi.fn(async()=>null)}};
  const db={$transaction:vi.fn(async(work:any)=>work(tx))},identity={authenticate:vi.fn(async()=>principal)},reads={current:vi.fn()};
  const reader=new BillingBatchCreditHistory(db as any,identity as any,reads as any,[pair],()=> '2026-10-03T18:00:00Z');
  const result=await reader.read('token','SERVICE',{binding,originalDocumentId:doc.documentId,originalSnapshotSha256:fiscalSnapshotSha256(doc),journalRevision:0,journalHeadSha256:projectCorrectionJournal(doc,[]).headSha256});
  expect(result).toMatchObject({coverage:'RECONCILED_JOURNAL_ONLY',signedVersionCoverage:'NOT_PROVIDED',acceptanceProof:'NOT_PROVIDED',entries:[],journal:{revision:0}});
  expect(tx.document.findUnique).toHaveBeenCalledTimes(2);expect(identity.authenticate).toHaveBeenCalledTimes(3);expect(reads.current).not.toHaveBeenCalled();
 });
});
