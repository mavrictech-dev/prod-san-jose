import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BatchCreditHistoryReconciliation } from '../services/billing-service/src/b2b/batch-credit-history-reconciliation';

function fixture() {
 const request:any={binding:{},originalDocumentId:randomUUID(),originalSnapshotSha256:'a'.repeat(64),journalRevision:4,journalHeadSha256:'b'.repeat(64)};
 const item=(state:string)=>({member:{documentId:randomUUID(),version:1,snapshotSha256:'c'.repeat(64)},state});
 const rows=[item('RESERVED'),item('ACCEPTED'),item('ACCEPTED_WITH_OBSERVATIONS'),item('REJECTED')];
 const record:any={coverage:'RECONCILED_JOURNAL_ONLY',signedVersionCoverage:'NOT_PROVIDED',acceptanceProof:'NOT_PROVIDED',original:{snapshotSha256:request.originalSnapshotSha256},journal:{revision:4,headSha256:request.journalHeadSha256},entries:rows,checkedAt:'2026-10-27T12:00:00Z'};
 const catalogue:any={originalDocumentId:request.originalDocumentId,originalSnapshotSha256:request.originalSnapshotSha256,journalRevision:4,journalHeadSha256:request.journalHeadSha256,entries:structuredClone(rows).reverse()};
 const history={read:vi.fn(async()=>structuredClone(record))};
 const inventory={read:vi.fn(async()=>structuredClone(catalogue))};
 return {request,rows,record,catalogue,history,inventory,core:new BatchCreditHistoryReconciliation(history as any,inventory)};
}
describe('independent BETA credit history reconciliation; synthetic sources',()=>{
 it('compares every state and exact version, independently of ordering, without asserting completeness',async()=>{
  const f=fixture(),r=await f.core.read('synthetic','SERVICE',f.request);
  expect(r).toMatchObject({comparison:'MATCHED_OWNER_INVENTORY',completeness:'NOT_PROVEN',signedVersionCoverage:'NOT_PROVIDED',acceptanceProof:'NOT_PROVIDED'});
  expect(r.entries).toHaveLength(4);expect(r.entries.map(x=>x.state).sort()).toEqual(['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED','RESERVED']);
  expect(f.history.read).toHaveBeenCalledTimes(2);expect(f.inventory.read).toHaveBeenCalledTimes(2);
 });
 it('handles an empty matching journal without asserting completeness',async()=>{
  const f=fixture();f.record.entries=[];f.catalogue.entries=[];
  expect((await f.core.read('synthetic','USER',f.request)).completeness).toBe('NOT_PROVEN');
 });
 it.each(['missing','extra','state','version','hash','duplicate','unknown','foreign','head','extra-field'] as const)('rejects %s discrepancies',async variant=>{
  const f=fixture(),c=f.catalogue;
  if(variant==='missing')c.entries.pop(); if(variant==='extra')c.entries.push({member:{documentId:randomUUID(),version:1,snapshotSha256:'d'.repeat(64)},state:'RESERVED'});
  if(variant==='state')c.entries[0].state='RESERVED'; if(variant==='version')c.entries[0].member.version++;
  if(variant==='hash')c.entries[0].member.snapshotSha256='d'.repeat(64); if(variant==='duplicate')c.entries.push(structuredClone(c.entries[0]));
  if(variant==='unknown')c.entries[0].state='APPROVED'; if(variant==='foreign')c.originalDocumentId=randomUUID();
  if(variant==='head')c.journalHeadSha256='e'.repeat(64); if(variant==='extra-field')c.complete=true;
  await expect(f.core.read('synthetic','SERVICE',f.request)).rejects.toMatchObject({code:'BATCH_CREDIT_HISTORY_RECONCILIATION_FAILED'});
 });
 it('never queries inventory if existing authority denies access',async()=>{
  const f=fixture();f.history.read.mockRejectedValueOnce(new Error('DENIED'));
  await expect(f.core.read('synthetic','SERVICE',f.request)).rejects.toThrow('DENIED');expect(f.inventory.read).not.toHaveBeenCalled();
 });
 it('rejects inventory or history changes and propagates revoked authorization',async()=>{
  const f=fixture();f.inventory.read.mockImplementationOnce(async()=>structuredClone(f.catalogue)).mockImplementationOnce(async()=>({...structuredClone(f.catalogue),entries:[]}));
  await expect(f.core.read('synthetic','SERVICE',f.request)).rejects.toMatchObject({code:'BATCH_CREDIT_HISTORY_RECONCILIATION_FAILED'});
  const g=fixture();g.history.read.mockImplementationOnce(async()=>structuredClone(g.record)).mockImplementationOnce(async()=>({...structuredClone(g.record),journal:{...g.record.journal,revision:5}}));
  await expect(g.core.read('synthetic','SERVICE',g.request)).rejects.toMatchObject({code:'BATCH_CREDIT_HISTORY_RECONCILIATION_FAILED'});
  const h=fixture();h.history.read.mockResolvedValueOnce(structuredClone(h.record)).mockRejectedValueOnce(new Error('REVOKED'));
  await expect(h.core.read('synthetic','SERVICE',h.request)).rejects.toThrow('REVOKED');
 });
});

