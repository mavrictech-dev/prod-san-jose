import { describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { changesFixture } from './integration-changes.fixture';
import { issuerRuc,otherRuc,documentId,secondId,batchId,sale,branchId } from './integration-read.fixture';
import { IntegrationChanges,ChangeLimits } from '../services/integration-export-service/src/changes';
import { changeQuery } from '../packages/service-access/src/integration-change-query';
import { OwnerChanges } from '../packages/service-access/src/integration-owner-changes';
import { IntegrationReads } from '../services/integration-service/src/read';
describe('Phase6 private durable checkpoint stream, entirely fictitious',()=>{
  it('links a private checkpoint to the stable cut and never includes a raw owner sequence',async()=>{
    const f=changesFixture(),cut=await f.core.documents('fixture-token',f.query),cp=cut.page.changeCheckpoint!;
    expect(cp).toMatch(/^[A-Za-z0-9_-]{16,4096}$/);expect(cp).not.toContain(issuerRuc);expect(cut.items[0].id).toBe(documentId);
    expect((await f.page(cp)).items).toEqual([]);expect(f.changeStore.records.size).toBe(0);
  });
  it('uses the same checkpoint on later pages of the same cut',async()=>{
    const f=changesFixture(),cut=await f.core.documents('fixture-token',f.query);
    const next=await f.core.documents('fixture-token',{...f.query,cursor:cut.page.nextCursor!});
    expect(next.page.changeCheckpoint).toBe(cut.page.changeCheckpoint);
  });
  it('follows changes committed while capture is completing, with no loss',async()=>{
    const f=changesFixture();f.setOnCapture(async()=>{f.rows.get(documentId)!.sunatStatus='REJECTED';f.append('BILLING');});
    const cut=await f.core.documents('fixture-token',f.query);expect(cut.items[0].state.transport).toBe('ACCEPTED');
    const page=await f.page(cut.page.changeCheckpoint!);expect(page.items[0].documentId).toBe(documentId);
    expect(page.items[0].version).not.toBe(cut.items[0].resourceVersion);
  });
  it('keeps exact nonempty delivery on retries and across service reconstruction',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.append('BILLING');const page=await f.page(cp);
    f.rows.get(documentId)!.sunatStatus='REJECTED';f.append('BILLING');
    const reconstructed=new IntegrationChanges(f.changeStore,f.vault,f.identity,f.billingHttp as any,f.sunatHttp as any,f.now);
    expect(await reconstructed.page('fixture-token',{issuerRuc,checkpoint:cp})).toEqual(page);
    expect((await f.page(page.nextCheckpoint)).items[0].eventId).not.toBe(page.items[0].eventId);
  });
  it('uses visible-only ordinal positions and alternates sources without claiming cross-owner commit order',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();const a=f.append('BILLING'),b=f.append('SUNAT','ARTIFACT_ADDED');
    const first=await f.page(cp,'1'),second=await f.page(first.nextCheckpoint,'1');
    expect(first.items[0].sequence).toBe('1');expect(second.items[0].sequence).toBe('2');expect(first.hasMore).toBe(true);expect(second.hasMore).toBe(false);
    expect(JSON.stringify(first.items)).not.toContain(a.id);expect(JSON.stringify(second.items)).not.toContain(b.id);
  });
  it.each(['DOCUMENT_CREATED','DOCUMENT_STATE_CHANGED','ARTIFACT_ADDED','DOCUMENT_RECONCILED'] as const)('delivers supported event %s',async kind=>{
    const f=changesFixture(),cp=await f.checkpoint();f.append(kind==='ARTIFACT_ADDED'?'SUNAT':'BILLING',kind);
    const p=await f.page(cp);expect(p.items[0].kind).toBe(kind);expect(p.items[0].eventId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it.each(['01','03','07','08'] as const)('delivers committed business type %s, never QA data',async type=>{
    const f=changesFixture();const id=randomUUID();f.rows.set(id,sale(type,id));const cp=(await f.core.documents('fixture-token',{...f.query,types:'01,03,07,08'})).page.changeCheckpoint!;f.append('BILLING','DOCUMENT_CREATED',id);
    expect((await f.page(cp)).items[0].type).toBe(type);
  });
  it('does not freeze empty polling forever, nor consume a delivery slot per poll',async()=>{
    const f=changesFixture(),cp=await f.checkpoint(),empty=await f.page(cp);f.append('BILLING');
    expect((await f.page(empty.nextCheckpoint)).items).toHaveLength(1);expect(f.changeStore.records.size).toBe(1);
    expect(f.changeStore.audit).toHaveBeenCalledTimes(2);
  });
  it('filters new events using the immutable cut filters, not caller supplied broader filters',async()=>{
    const f=changesFixture();const cut=await f.core.documents('fixture-token',{...f.query,types:'01'});f.append('BILLING','DOCUMENT_CREATED',secondId);
    const p=await f.page(cut.page.changeCheckpoint!);expect(p.items).toEqual([]);expect(p.hasMore).toBe(false);
  });
  it('skips an unauthorized document without revealing its ID or source increment',async()=>{
    const f=changesFixture();f.p.grants[0].branches={kind:'IDS',ids:[branchId]};const cp=await f.checkpoint();
    const hidden=randomUUID(),row=sale('01',hidden);row.immutableSnapshot.branchId=randomUUID();row.emissionPoint.branchId=row.immutableSnapshot.branchId;
    f.rows.set(hidden,row);f.append('BILLING','DOCUMENT_CREATED',hidden);f.append('BILLING');const p=await f.page(cp);
    expect(p.items).toHaveLength(1);expect(p.items[0].sequence).toBe('1');expect(JSON.stringify(p)).not.toContain(hidden);
  });
  it('authorizes every member of a shared batch even outside filters',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.append('SUNAT','ARTIFACT_ADDED',batchId,'BATCH');
    const page=await f.page(cp);expect(page.items[0].documentId).toBe(secondId);expect(f.sunatRepo.batch).toHaveBeenCalled();
    f.summaries.get(f.batches.get(batchId)!.summaryId)!.items=[];
    await expect(f.page(cp)).rejects.toMatchObject({code:'INCOMPLETE_BINDING'});
  });
  it('durably continues a batch fan-out across pages without dropping its remaining members',async()=>{
    const f=changesFixture();const ids=[secondId,randomUUID(),randomUUID()].sort();for(const id of ids)f.rows.set(id,sale('03',id));
    const b={id:batchId,issuerRuc,environment:'BETA',kind:'RC',identifier:'RC-20260101-1',membersComplete:true,
      members:ids.map(id=>({documentId:id,type:'03',fullNumber:'B001-00000001',conditionCode:'1',documentVersion:'a'.repeat(64)}))};
    const old=f.sunatHttp.json.getMockImplementation()!;f.sunatHttp.json.mockImplementation(async(path,t,body)=>
      path.includes('/batches/'+batchId)?b:old(path,t,body));
    const cp=await f.checkpoint();f.append('SUNAT','ARTIFACT_ADDED',batchId,'BATCH');
    const first=await f.page(cp,'1');expect(first.hasMore).toBe(true);
    const second=await f.page(first.nextCheckpoint,'1'),third=await f.page(second.nextCheckpoint,'1');
    expect([first,second,third].flatMap(p=>p.items.map(e=>e.documentId))).toEqual(ids);expect(third.hasMore).toBe(false);
    expect(first.items[0].sequence).toBe('1');expect(second.items[0].sequence).toBe('2');expect(third.items[0].sequence).toBe('3');
    expect(await f.page(first.nextCheckpoint,'1')).toEqual(second);
  });
  it('fails closed if a pending durable batch payload has expired or is missing',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.append('BILLING');const p=await f.page(cp);f.advance(ChangeLimits.ttlMs);await f.feed.sweep();
    expect(f.changeStore.records.size).toBe(0);await expect(f.page(p.nextCheckpoint)).rejects.toMatchObject({code:'CURSOR_EXPIRED'});
  });
  it('never publishes a successful next checkpoint after an upstream timeout',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.append('BILLING');f.billingHttp.json.mockRejectedValueOnce(new Error('synthetic timeout'));
    await expect(f.page(cp)).rejects.toThrow('synthetic timeout');expect(f.changeStore.records.size).toBe(0);
  });
  it('bounds unfinished work separately from HTTP connections and releases slots after completion',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.append('BILLING');let release!:()=>void;
    const gate=new Promise<void>(r=>{release=r;}),old=f.changeStore.get.bind(f.changeStore);f.changeStore.get=async(c,k)=>{await gate;return old(c,k);};
    const first=f.page(cp),second=f.page(cp);await expect(f.page(cp)).rejects.toMatchObject({status:429,code:'RATE_LIMITED'});
    release();const results=await Promise.all([first,second]);expect(results[0]).toEqual(results[1]);expect(await f.page(cp)).toEqual(results[0]);
  });
  it('fails closed on a malformed journal page instead of inferring an updatedAt checkpoint',async()=>{
    const f=changesFixture(),cp=await f.checkpoint(),old=f.billingHttp.json.getMockImplementation()!;
    f.billingHttp.json.mockImplementation(async(path,t,b)=>{const p=await old(path,t,b);if(path.includes('/journal'))p.head='9e9';return p;});
    await expect(f.page(cp)).rejects.toMatchObject({code:'EVIDENCE_INCONSISTENT'});
  });
  it('reports readiness only after both owner journals can serve the confirmed issuer',async()=>{
    const f=changesFixture();expect(await f.core.changesReady('fixture-token',issuerRuc)).toBe(true);
    f.sunatHttp.json.mockResolvedValueOnce({ready:false});expect(await f.core.changesReady('fixture-token',issuerRuc)).toBe(false);
  });
  it('does not rewrite original artifacts or send mail/emit while following the feed',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.append('SUNAT','ARTIFACT_ADDED');await f.page(cp);
    expect(f.sunatHttp.bytes).not.toHaveBeenCalled();expect(f.changeStore.records.size).toBe(1);
    expect([...f.changeStore.records.values()][0].payload.toString()).not.toContain('Cliente ficticio');
  });
  it.each(['BILLING','SUNAT'] as const)('expires checkpoint on %s source retention even for cached delivery',async source=>{
    const f=changesFixture(),cp=await f.checkpoint();f.append(source);await f.page(cp);f.journals[source].floor=1n;
    await expect(f.page(cp)).rejects.toMatchObject({status:410,code:'CURSOR_EXPIRED'});
  });
  it.each(['BILLING','SUNAT'] as const)('requires new cut on %s epoch change after restore',async source=>{
    const f=changesFixture(),cp=await f.checkpoint();f.journals[source].epoch=randomUUID();
    await expect(f.page(cp)).rejects.toMatchObject({status:410,code:'CURSOR_EXPIRED'});
  });
  it('expires checkpoints at the exact deadline without extending them on polling',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.advance(ChangeLimits.ttlMs);
    await expect(f.page(cp)).rejects.toMatchObject({status:410,code:'CURSOR_EXPIRED'});
  });
  it('invalidates old checkpoints when grants revision changes',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.p.revision++;
    await expect(f.page(cp)).rejects.toMatchObject({status:409,code:'CURSOR_CONTEXT_CHANGED'});
  });
  it('never allows another technical client to replay a checkpoint',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.p.clientId=randomUUID();
    await expect(f.page(cp)).rejects.toMatchObject({status:404,code:'RESOURCE_NOT_FOUND'});
  });
  it.each(['integration:changes:read','integration:documents:read'] as const)('requires fresh scope %s on replay',async scope=>{
    const f=changesFixture(),cp=await f.checkpoint();f.append('BILLING');await f.page(cp);f.p.scopes=f.p.scopes.filter(s=>s!==scope);
    await expect(f.page(cp)).rejects.toMatchObject({status:403,code:'INSUFFICIENT_SCOPE'});
  });
  it('rechecks revocation immediately before returning the body',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.append('BILLING');
    const old=f.billingHttp.json.getMockImplementation()!;f.billingHttp.json.mockImplementation(async(path,t,b)=>{const r=await old(path,t,b);if(path.endsWith('/reauthorize'))f.p.revision++;return r;});
    await expect(f.page(cp)).rejects.toMatchObject({status:401,code:'UNAUTHENTICATED'});
  });
  it('fails closed on audit failure, including cache retries',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.append('BILLING');await f.page(cp);f.changeStore.audit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(f.page(cp)).rejects.toThrow('audit unavailable');
  });
  it('fails closed on corrupted encrypted cached payload',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.append('BILLING');await f.page(cp);
    [...f.changeStore.records.values()][0].payload[30]^=1;await expect(f.page(cp)).rejects.toMatchObject({code:'INTEGRITY_FAILED'});
  });
  it('binds checkpoints to their issuer even when the principal has another issuer grant',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.p.grants.push({...f.p.grants[0],issuerRuc:otherRuc});
    await expect(f.feed.page('fixture-token',{issuerRuc:otherRuc,checkpoint:cp})).rejects.toMatchObject({code:'CURSOR_CONTEXT_CHANGED'});
  });
  it('keeps checkpoint in the export status and manifest identical to captured cut',async()=>{
    const f=changesFixture(),job=await f.core.create('fixture-token','phase6-export-idempotent',f.request);expect(job.changeCheckpoint).toBeTruthy();
    await f.core.runOne();const manifest=await f.core.manifest('fixture-token',job.id,issuerRuc);expect(manifest.changeCheckpoint).toBe(job.changeCheckpoint);
  });
  it('does not offer a checkpoint when changes scope was not granted',async()=>{
    const f=changesFixture();f.p.scopes=f.p.scopes.filter(s=>s!=='integration:changes:read');
    expect((await f.core.documents('fixture-token',f.query)).page.changeCheckpoint).toBeNull();
  });
  it('requires exact Billing MVCC barrier rather than substituting latest head after the snapshot',async()=>{
    const f=changesFixture(),old=f.billingHttp.json.getMockImplementation()!;
    f.billingHttp.json.mockImplementation(async(path,t,b)=>{const result=await old(path,t,b);if(path.endsWith('/capture'))delete result.changeBarrier;return result;});
    await expect(f.checkpoint()).rejects.toMatchObject({status:503,code:'CHANGE_FEED_NOT_READY'});
  });
  it('gateway exposes changes through owner only, without direct storage',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();f.append('BILLING');const owner={json:async(path:string,t:string)=>f.core.changes(t,Object.fromEntries(new URL(path,'https://fixture.invalid').searchParams)),bytes:async()=>{throw new Error('never');}};
    const gateway=new IntegrationReads(f.identity,f.billingHttp as any,f.sunatHttp as any,f.now,owner);
    expect((await gateway.changes('fixture-token',{issuerRuc,checkpoint:cp})).items).toHaveLength(1);
  });
  it('gateway missing dedicated owner gives explicit NOT_READY',async()=>{
    const f=changesFixture(),cp=await f.checkpoint();await expect(f.gateway.changes('fixture-token',{issuerRuc,checkpoint:cp})).rejects.toMatchObject({code:'CHANGE_FEED_NOT_READY'});
  });
  it('journal API validates principal and distinguishes private service metadata from public feed',async()=>{
    const f=changesFixture(),reader={read:async()=>({epoch:f.journals.BILLING.epoch,head:'0',floor:'0',position:{epoch:f.journals.BILLING.epoch,sequence:'0'},events:[]})};
    const owner=new OwnerChanges(reader,f.identity);expect(await owner.ready('fixture-token',{issuerRuc})).toEqual({ready:true});
    await expect(owner.read('human-fixture',{issuerRuc})).rejects.toMatchObject({code:'UNAUTHENTICATED'});
    await expect(owner.read('fixture-token',{issuerRuc,after:'0'})).rejects.toMatchObject({code:'INVALID_QUERY'});
  });
  it.each([{},{issuerRuc},{issuerRuc,checkpoint:'short'},{issuerRuc,checkpoint:'a'.repeat(4097)},
    {issuerRuc,checkpoint:'a'.repeat(64),environment:'PRODUCTION'},{issuerRuc,checkpoint:'a'.repeat(64),limit:'501'},
    {issuerRuc,checkpoint:'a'.repeat(64),limit:'0'},{issuerRuc,checkpoint:'a'.repeat(64),limit:'1e2'},
    {issuerRuc,checkpoint:['a'.repeat(64)]},{issuerRuc,checkpoint:'a'.repeat(64),from:'2026-01-01'},
    {issuerRuc,checkpoint:'a'.repeat(64),admin:'true'}])('rejects ambiguous/broadening query %j',q=>expect(()=>changeQuery(q)).toThrow());
  it.each(['a'.repeat(64),'A'.repeat(64),'_'.repeat(16)])('rejects fabricated opaque checkpoint %s',async cp=>{
    const f=changesFixture();await expect(f.page(cp)).rejects.toMatchObject({status:400,code:'INVALID_QUERY'});
  });
});
