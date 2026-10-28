import 'reflect-metadata';
import { describe,it,expect,vi } from 'vitest';
import { ProductionBatchesDispatchService } from '../services/sunat-service/src/application/production-batches-dispatch.service';
import { ProductionBatchesOwnerRuntime } from '../services/billing-service/src/application/production-batches-runtime';
import { ProductionBatchesAuthenticator } from '../packages/sunat-core/src/production-batches-proof';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';
import { batch,uuid,asOf } from './production-batches-fixture';
import type { ProductionBatchesIssued,ProductionBatchesStatus } from '../packages/contracts/src/production-batches';
const auth=new ProductionBatchesAuthenticator(Buffer.alloc(32,7),'billing-owner');
function event():ProductionBatchesIssued{
 const body:Omit<ProductionBatchesIssued,'ownerProof'>={eventId:uuid(9001),eventName:'billing.production.batches.issued.v1',occurredAt:asOf,actorId:uuid(9002),operationId:uuid(9000),snapshot:batch()};
 return {...body,ownerProof:auth.sign(body)};
}
function fixture(state='PREPARED'){
 const row:any={batchId:uuid(9000),payload:event(),state,ticket:state==='SUBMITTED'?'synthetic-ticket':null,manifest:{fileName:'20100070970-RC-20261028-1.zip',zip:{sha256:'a'.repeat(64)},xml:{}},grant:{}};
 const repository:any={
  load:vi.fn(async()=>({...row})),
  claim:vi.fn(async()=>{if(row.state!=='PREPARED')return false;row.state='SENDING';return true;}),
  outcome:vi.fn(async(_r:unknown,from:string,to:string,ticket?:string)=>{if(row.state!==from)return false;row.state=to;if(ticket)row.ticket=ticket;return true;}),
 };
 const adapter={submitSummary:vi.fn(async()=> 'synthetic-ticket'),getStatus:vi.fn(async()=>({kind:'PROCESSING'}))};
 const service:any=new ProductionBatchesDispatchService(repository,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any);
 // Substitutions exist only in tests. Production uses concrete PKI/archive and fixed official SOAP adapter.
 service.authorize=vi.fn(async()=>{});service.archived=vi.fn(async()=>Buffer.from('synthetic package'));
 service.adapter=vi.fn(async()=>adapter);
 return {row,repository,adapter,service};
}
describe('durable production batch dispatch',()=>{
 it('claims at most one sendSummary under concurrent workers',async()=>{
  const {service,adapter,row}=fixture();
  await Promise.all([service.process(row.batchId),service.process(row.batchId)]);
  expect(adapter.submitSummary).toHaveBeenCalledTimes(1);expect(row.state).toBe('SUBMITTED');
 });
 it('leaves uncertain POST in UNKNOWN and never auto-posts again',async()=>{
  const {service,adapter,row}=fixture();adapter.submitSummary.mockRejectedValueOnce(Error('uncertain synthetic timeout'));
  await service.process(row.batchId);expect(row.state).toBe('UNKNOWN');
  await service.process(row.batchId);expect(adapter.submitSummary).toHaveBeenCalledTimes(1);
 });
 it.each(['SENDING','UNKNOWN','ACCEPTED','REJECTED','BLOCKED'])('does no POST or polling from %s',async state=>{
  const {service,adapter,row}=fixture(state);await service.process(row.batchId);
  expect(adapter.submitSummary).not.toHaveBeenCalled();expect(adapter.getStatus).not.toHaveBeenCalled();
 });
 it('known ticket uses getStatus only; transient polling failure retains the ticket',async()=>{
  const {service,adapter,row}=fixture('SUBMITTED');
  adapter.getStatus.mockRejectedValueOnce(Error('temporary synthetic read failure'));
  await service.process(row.batchId);expect(row.state).toBe('SUBMITTED');expect(row.ticket).toBe('synthetic-ticket');
  await service.process(row.batchId);expect(adapter.getStatus).toHaveBeenCalledTimes(2);expect(adapter.submitSummary).not.toHaveBeenCalled();
 });
 it('revocation blocks before claim and before adapter invocation',async()=>{
  const {service,repository,adapter,row}=fixture();service.authorize.mockRejectedValueOnce(Error('grant revoked'));
  await expect(service.process(row.batchId)).rejects.toThrow('grant revoked');
  expect(repository.claim).not.toHaveBeenCalled();expect(adapter.submitSummary).not.toHaveBeenCalled();
 });
 it('owner projection refuses unknown HMAC audience and incomplete final evidence before writes',async()=>{
  const statusAuth=new ProductionBatchesAuthenticator(Buffer.alloc(32,7),'sunat-status'),prisma={$transaction:vi.fn()},runtime=new ProductionBatchesOwnerRuntime(prisma as any,statusAuth);
  const b=batch(),body:Omit<ProductionBatchesStatus,'ownerProof'>={eventId:uuid(44),eventName:'sunat.production.batches.status.v1',batchId:b.batchId,snapshotSha256:fiscalSnapshotSha256(b),issuerRuc:b.issuerRuc,status:'ACCEPTED',members:b.entries.map(e=>({documentId:e.snapshot.documentId,snapshotSha256:fiscalSnapshotSha256(e.snapshot),conditionCode:e.conditionCode}))};
  await expect(runtime.project({...body,ownerProof:auth.sign(body)})).rejects.toThrow();
  await expect(runtime.project({...body,ownerProof:statusAuth.sign(body)})).rejects.toThrow();
  expect(prisma.$transaction).not.toHaveBeenCalled();
 });
});
