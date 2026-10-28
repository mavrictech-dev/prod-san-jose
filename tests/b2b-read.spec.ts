import { afterEach,describe,it,expect,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { B2bOwnerReadFrame } from '../packages/service-access/src/b2b-read-adapter';
import { B2bReads } from '../services/b2b-api-service/src/read';
import { b2bDocumentFilters,b2bQuery } from '../packages/contracts/src/b2b-read-query';
import { b2bReadFixture,invoiceBinding,receiptBinding } from './b2b-read.fixture';
import { documentId,secondId,artifactId,batchId,summaryId } from './integration-read.fixture';
import { ctx } from './b2b-identity.fixture';
const q={issuerId:'1',environment:'BETA'},dates={...q,from:'2026-01-01',to:'2026-01-02'};
const running:Awaited<ReturnType<typeof b2bReadFixture>>[]=[];
async function make(...args:Parameters<typeof b2bReadFixture>){const f=await b2bReadFixture(...args);running.push(f);return f;}
afterEach(()=>{for(const f of running.splice(0))f.close();});
describe('B2B-03 owner reads, isolation and truthful coverage',()=>{
  it('returns current identity and describes unsupported fiscal sources honestly',async()=>{
    const f=await make(),me=await f.gateway.me(f.token,'SERVICE');expect(me.actor).toEqual({kind:'SERVICE'});
    const c=await f.gateway.capabilities(f.token,'SERVICE',{environment:'BETA'});
    expect(c.fiscalActivation).toBe(false);expect(c.coverage.find(x=>x.type==='31')?.state).toBe('SOURCE_NOT_SUPPORTED');
    expect(c.features.find(x=>x.id==='issue')?.state).toBe('DISABLED');expect(JSON.stringify(me)).not.toContain('secret');
  });
  it.each(['issuers','branches','points','series','products'] as const)('authorized catalog %s has no counters or secrets',async resource=>{
    const f=await make(),result=await f.gateway.page(f.token,'SERVICE',resource,resource==='products'?{environment:'BETA'}:q);
    expect(result.items.length).toBe(resource==='series'?2:1);expect(result.page.complete).toBe(true);
    for(const forbidden of ['nextNumber','password','storageKey','secretHash','immutableSnapshot'])expect(JSON.stringify(result)).not.toContain(forbidden);
  });
  it('full detail preserves decimals/items but transport ACCEPTED is not verified SUNAT acceptance',async()=>{
    const f=await make(),d=await f.gateway.document(f.token,'SERVICE',documentId,q);
    expect(d.detail.kind).toBe('SALE');expect(d.detail.items).toHaveLength(1);expect(d.payableAmount).toBe('118.00');
    expect(d.state).toMatchObject({transport:'ACCEPTED',fiscal:'NOT_VERIFIED'});expect(d.context).toEqual(invoiceBinding);
    expect(JSON.stringify(d)).not.toMatch(/private-proof|immutableSnapshot|secretHash/);
    expect((await f.gateway.document(f.token,'SERVICE',null,{...q,type:'01',series:'F001',number:'1'})).id).toBe(documentId);
    expect(await f.gateway.document(f.token,'SERVICE',documentId,q,true)).toMatchObject({documentId,fiscal:'NOT_VERIFIED'});
  });
  it('stable cursor does not reread modified source; changed query or client cannot reuse it',async()=>{
    const f=await make(),a=await f.gateway.page(f.token,'SERVICE','documents',{...dates,limit:'1'});expect(a.page.nextCursor).toBeTruthy();
    f.old.rows.delete(secondId);
    const b=await f.gateway.page(f.token,'SERVICE','documents',{...dates,limit:'1',cursor:a.page.nextCursor!});
    expect(b.items[0].id).toBe(secondId);expect(b.page.snapshotId).toBe(a.page.snapshotId);expect(f.repository.capture).toHaveBeenCalledTimes(1);
    await expect(f.gateway.page(f.token,'SERVICE','documents',{...dates,limit:'2',cursor:a.page.nextCursor!})).rejects.toMatchObject({code:'CURSOR_CONTEXT_CHANGED'});
    f.auth.advance(301000);const fresh=await f.refresh();
    await expect(f.gateway.page(fresh,'SERVICE','documents',{...dates,limit:'1',cursor:a.page.nextCursor!})).rejects.toMatchObject({code:'CURSOR_EXPIRED'});
  });
  it('revocation also denies cached pages and in-flight file reads',async()=>{
    const f=await make(),a=await f.gateway.page(f.token,'SERVICE','documents',{...dates,limit:'1'});
    await f.auth.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());
    await expect(f.gateway.page(f.token,'SERVICE','documents',{...dates,limit:'1',cursor:a.page.nextCursor!})).rejects.toMatchObject({status:401});
    const g=await make();g.old.store.read.mockImplementationOnce(async()=>{await g.auth.core.change('human-step-up',g.made.client.id,{expectedRevision:1,enabled:false},ctx());return g.old.bytes;});
    await expect(g.gateway.content(g.token,'SERVICE',artifactId,q)).rejects.toMatchObject({status:401});expect(g.audit.record).not.toHaveBeenCalled();
  });
  it('whole tuple prevents mixing a granted point with a different granted series',async()=>{
    const f=await make([invoiceBinding]);
    await expect(f.gateway.document(f.token,'SERVICE',secondId,q)).rejects.toMatchObject({status:404});
    f.old.rows.get(documentId)!.seriesCounter.id=receiptBinding.seriesId;
    await expect(f.gateway.document(f.token,'SERVICE',documentId,q)).rejects.toMatchObject({status:404});
    await expect(f.gateway.document(f.token,'USER',documentId,q)).rejects.toMatchObject({code:'OIDC_NOT_CONFIGURED'});
  });
  it('scope-limited identity cannot access detail or artifacts',async()=>{
    const f=await make([invoiceBinding],['b2b:context:read','b2b:catalog:read']);
    await expect(f.gateway.document(f.token,'SERVICE',documentId,q)).rejects.toMatchObject({status:403});
    await expect(f.gateway.content(f.token,'SERVICE',artifactId,q)).rejects.toMatchObject({status:403});expect(f.old.store.read).not.toHaveBeenCalled();
  });
  it('original XML returned byte-for-byte with audit, never a generated replacement',async()=>{
    const f=await make(),meta=await f.gateway.artifacts(f.token,'SERVICE',documentId,q),file=await f.gateway.content(f.token,'SERVICE',artifactId,q);
    expect(meta.items[0]).toMatchObject({id:artifactId,representation:'ORIGINAL',verification:{signature:'UNVERIFIED',trust:'UNVERIFIED'}});
    expect(JSON.stringify(meta)).not.toContain('storageKey');expect(file.bytes).toEqual(f.old.bytes);
    expect(file.sha256).toBe(createHash('sha256').update(f.old.bytes).digest('hex'));expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({artifactId,representation:'ORIGINAL'}));
  });
  it('corrupted original and unavailable audit fail closed',async()=>{
    const f=await make();f.old.store.read.mockResolvedValueOnce(Buffer.from('corrupt'));
    await expect(f.gateway.content(f.token,'SERVICE',artifactId,q)).rejects.toMatchObject({code:'INTEGRITY_FAILED'});expect(f.audit.record).not.toHaveBeenCalled();
    f.audit.record.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(f.gateway.content(f.token,'SERVICE',artifactId,q)).rejects.toMatchObject({status:503});
  });
  it('a shared CDR requires authorization of every immutable batch member',async()=>{
    const f=await make([invoiceBinding]);const batch=f.old.batches.get(batchId)!;
    const a={...f.old.artifact,kind:'CDR_XML',storageKey:batchId+'/cdr.xml'};batch.artifacts.push(a);
    await expect(f.gateway.artifacts(f.token,'SERVICE',batchId,q,true)).rejects.toMatchObject({status:404});expect(f.old.store.read).not.toHaveBeenCalled();
    const g=await make();g.old.batches.get(batchId)!.artifacts.push({...a});
    expect((await g.gateway.artifacts(g.token,'SERVICE',batchId,q,true)).items[0].owner).toEqual({kind:'BATCH',id:batchId});
    g.old.summaries.get(summaryId)!.items.push({documentId,conditionCode:'1'});
    await expect(g.gateway.artifacts(g.token,'SERVICE',batchId,q,true)).rejects.toMatchObject({status:409});
  });
  it('PDF uses latest visual profile, not saved PDF; immutable snapshots remain identical',async()=>{
    const f=await make(),before=structuredClone(f.old.rows.get(documentId)!.immutableSnapshot);
    const first=await f.gateway.content(f.token,'SERVICE',documentId,q,'a4');
    await f.gateway.content(f.token,'SERVICE',documentId,q,'a4');expect(f.renderers.document).toHaveBeenCalledTimes(1);
    f.presentation.profileRevision++;f.presentation.settings.footerNote='Perfil actualizado';
    const changed=await f.gateway.content(f.token,'SERVICE',documentId,q,'a4');expect(changed.sha256).not.toBe(first.sha256);
    expect(f.renderers.document).toHaveBeenCalledTimes(2);expect(f.old.rows.get(documentId)!.immutableSnapshot).toEqual(before);
    expect(changed.fileName).toContain('PRUEBA');expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({artifactId:null,representation:'CURRENT_LOCAL'}));
  });
  it('local PDF does not pretend to be a verified fiscal representation',async()=>{
    const f=await make();Object.assign(f.old.docs.get(documentId)!,{status:'ACCEPTED'});
    await expect(f.gateway.content(f.token,'SERVICE',documentId,q,'a4')).rejects.toMatchObject({code:'FISCAL_PDF_PROFILE_NOT_AVAILABLE'});expect(f.renderers.document).not.toHaveBeenCalled();
  });
  it('mismatched owner snapshot is rejected before render/storage',async()=>{
    const f=await make();f.old.docs.get(documentId)!.immutablePayload.totals.payableAmount='900';
    await expect(f.gateway.content(f.token,'SERVICE',artifactId,q)).rejects.toMatchObject({code:'EVIDENCE_INCONSISTENT'});
    await expect(f.gateway.content(f.token,'SERVICE',documentId,q,'ticket')).rejects.toMatchObject({code:'EVIDENCE_INCONSISTENT'});
  });
  it('legacy compatibility is explicit, readonly, singleton and does not exchange tokens',async()=>{
    const f=await make(),frame=new B2bOwnerReadFrame(f.identity,'SERVICE');
    const p=await frame.authenticate(f.token,['integration:documents:read']);expect(p.grants).toHaveLength(2);
    expect(p.grants.every(g=>g.branches.kind==='IDS'&&g.points.kind==='IDS'&&g.series.kind==='IDS')).toBe(true);
    await expect(frame.authenticate(f.token,['integration:documents:issue'] as any)).rejects.toMatchObject({code:'READ_ADAPTER_SCOPE_NOT_SUPPORTED'});
  });
  it('facade independently rejects unsafe filename, wrong MIME and corrupted owner bytes',async()=>{
    const f=await make();for(const file of [
      {bytes:f.old.bytes,sha256:f.old.artifact.sha256,fileName:'../../secret.xml',mediaType:'application/xml'},
      {bytes:f.old.bytes,sha256:'0'.repeat(64),fileName:'safe.xml',mediaType:'application/xml'},
      {bytes:f.old.bytes,sha256:f.old.artifact.sha256,fileName:'safe.xml',mediaType:'text/html'}]){
      f.fiscalPort.file.mockResolvedValueOnce(file);await expect(f.gateway.content(f.token,'SERVICE',artifactId,q)).rejects.toMatchObject({code:'INTEGRITY_FAILED'});
    }
  });
  it('excessively broad cuts fail instead of silently truncating',async()=>{
    const f=await make();f.repository.capture.mockResolvedValueOnce(Array(10001).fill(f.old.rows.get(documentId)));
    await expect(f.gateway.page(f.token,'SERVICE','documents',dates)).rejects.toMatchObject({code:'NARROW_QUERY'});
  });
});
describe('B2B-03 strict untrusted queries',()=>{
  it.each([{...dates,environment:'PRODUCTION'},{...dates,from:'2026-02-30'},{...dates,from:'2024-01-01'},{...dates,from:'2026-01-03'},{...dates,types:'01,31'},{...dates,types:'01,01'},{...dates,issuerId:'1 OR 1=1'},{...dates,branchId:'../private'}])('rejects invalid filter %j',query=>expect(()=>b2bDocumentFilters(query)).toThrow());
  it.each([{environment:['BETA','PRODUCTION']},{environment:'BETA',password:'x'},null,[]])('rejects duplicate/nested/unexpected input %j',q=>expect(()=>b2bQuery(q,['environment'],['environment'])).toThrow());
});
