import { describe,it,expect } from 'vitest';
import { randomBytes,createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { exportFixture } from './integration-export.fixture';
import { issuerRuc,documentId,secondId,otherRuc,sale,artifactId,batchId } from './integration-read.fixture';
import { IntegrationExports } from '../services/integration-export-service/src/core';
import { ExportVault } from '../services/integration-export-service/src/vault';
import { deny } from '../packages/service-access/src/integration';
const AdmZip=createRequire(resolve('packages/evidence-core/package.json'))('adm-zip');
const token='fixture-token',key='fictitious-key-000001';
const error=(code:string)=>({code});
describe('Phase5 encrypted stable cuts and durable export core (fictitious)',()=>{
  it('lists once, then excludes new writes and freezes state through all pages',async()=>{
    const f=exportFixture(),first=await f.core.documents(token,f.query);expect(first.page.hasMore).toBe(true);
    expect(first.items[0].id).toBe(documentId);expect(first.items[0]).not.toHaveProperty('detail');
    f.rows.set('40000000-0000-4000-8000-000000000003',sale('01','40000000-0000-4000-8000-000000000003'));
    f.rows.get(secondId)!.sunatStatus='REJECTED';
    const next=await f.core.documents(token,{...f.query,cursor:first.page.nextCursor!});
    expect(next.items.map(v=>v.id)).toEqual([secondId]);expect(next.items[0].state.transport).toBe('ACCEPTED');
    expect(next.page.snapshotId).toBe(first.page.snapshotId);expect(next.page.hasMore).toBe(false);expect(next.page.changeCheckpoint).toBeNull();
  });
  it('reads frozen complete item detail after live state changes',async()=>{
    const f=exportFixture(),p=await f.core.documents(token,f.query);f.rows.get(documentId)!.sunatStatus='REJECTED';
    const d=await f.core.detail(token,documentId,p.page.snapshotId,issuerRuc);
    expect(d.state.transport).toBe('ACCEPTED');expect(d.detail.items[0].quantity).toBe('1.000');
  });
  it.each(['issuerRuc','from','to','types','limit','series'])('cursor binds %s to its normalized query',async field=>{
    const f=exportFixture(),p=await f.core.documents(token,f.query);
    const values:any={issuerRuc:otherRuc,from:'2025-12-31',to:'2026-01-02',types:'01',limit:'2',series:'F001'};
    await expect(f.core.documents(token,{...f.query,[field]:values[field],cursor:p.page.nextCursor!})).rejects.toMatchObject(error(field==='issuerRuc'?'RESOURCE_NOT_FOUND':'CURSOR_CONTEXT_CHANGED'));
  });
  it('rejects tampered/forged cursor without making an owner query',async()=>{
    const f=exportFixture();await expect(f.core.documents(token,{...f.query,cursor:'A'.repeat(128)})).rejects.toMatchObject(error('INVALID_QUERY'));
    expect(f.billingHttp.json).not.toHaveBeenCalled();
  });
  it('reloaded service/key/store preserves cut, cursor and frozen details',async()=>{
    const f=exportFixture(),page=await f.core.documents(token,f.query);
    const restarted=new IntegrationExports(f.store,new ExportVault(f.key),f.identity,f.billingHttp as any,f.sunatHttp as any,f.now);
    expect((await restarted.documents(token,{...f.query,cursor:page.page.nextCursor!})).items[0].id).toBe(secondId);
  });
  it('client change cannot use another client cut',async()=>{
    const f=exportFixture(),p=await f.core.documents(token,f.query);f.p.clientId='80000000-0000-4000-8000-000000000002';
    await expect(f.core.detail(token,documentId,p.page.snapshotId,issuerRuc)).rejects.toMatchObject(error('RESOURCE_NOT_FOUND'));
  });
  it('grant revision change invalidates existing cursor and detail',async()=>{
    const f=exportFixture(),p=await f.core.documents(token,f.query);f.p.revision++;
    await expect(f.core.documents(token,{...f.query,cursor:p.page.nextCursor!})).rejects.toMatchObject(error('CURSOR_CONTEXT_CHANGED'));
    await expect(f.core.detail(token,documentId,p.page.snapshotId,issuerRuc)).rejects.toMatchObject(error('CURSOR_CONTEXT_CHANGED'));
  });
  it('expires cursor and snapshots at 15 minutes',async()=>{
    const f=exportFixture(),p=await f.core.documents(token,f.query);f.advance(900000);
    await expect(f.core.documents(token,{...f.query,cursor:p.page.nextCursor!})).rejects.toMatchObject(error('CURSOR_EXPIRED'));
    await expect(f.core.detail(token,documentId,p.page.snapshotId,issuerRuc)).rejects.toMatchObject(error('SNAPSHOT_EXPIRED'));
  });
  it('canonical source identity/snapshot changes deny frozen retrieval',async()=>{
    const f=exportFixture(),p=await f.core.documents(token,f.query);f.rows.get(documentId)!.immutableSnapshot.lines[0].description='CHANGED';
    await expect(f.core.detail(token,documentId,p.page.snapshotId,issuerRuc)).rejects.toMatchObject(error('EVIDENCE_INCONSISTENT'));
  });
  it('mixed available and unsupported types never declare complete',async()=>{
    const f=exportFixture(),p=await f.core.documents(token,{...f.query,types:'01,09,31'});expect(p.coverage.complete).toBe(false);
    expect(p.coverage.types.filter(t=>t.state==='UNSUPPORTED').map(t=>t.type)).toEqual(['09','31']);
  });
  it('persists only encrypted snapshots, never bearer/PII in records',async()=>{
    const f=exportFixture();await f.core.documents(token,f.query);const row=[...f.store.records.values()][0];
    expect(row.payload?.toString()).not.toContain('Cliente ficticio');expect(JSON.stringify(row)).not.toContain(token);
    expect(row.payload?.subarray(0,1).toString('hex')).toBe('01');
  });
  it('checks both scopes and quotas before returning a cut',async()=>{
    const f=exportFixture();for(let i=0;i<8;i++)await f.core.documents(token,f.query);
    await expect(f.core.documents(token,f.query)).rejects.toMatchObject(error('RATE_LIMITED'));
    f.p.scopes=f.p.scopes.filter(s=>s!=='integration:documents:read');
    await expect(f.core.documents(token,f.query)).rejects.toMatchObject(error('INSUFFICIENT_SCOPE'));
  });
  it('packages JSONL, exact originals and a checksum manifest asynchronously',async()=>{
    const f=exportFixture(),job=await f.core.create(token,key,f.request);expect(job.state).toBe('QUEUED');expect(job.complete).toBe(false);
    expect((await f.core.status(token,job.id,issuerRuc)).state).toBe('QUEUED');await f.core.runOne();
    const ready=await f.core.status(token,job.id,issuerRuc);expect(ready.state).toBe('READY');expect(ready.complete).toBe(true);
    const manifest=await f.core.manifest(token,job.id,issuerRuc),content=await f.core.content(token,job.id,issuerRuc),zip=new AdmZip(content.bytes);
    expect(zip.readFile(`artifacts/${artifactId}.xml`)).toEqual(f.bytes);
    const detail=JSON.parse(zip.readAsText('documents.jsonl').trim());expect(detail.detail.items[0].unitValue).toBe('100.123456');
    expect(JSON.parse(zip.readAsText('manifest.json'))).toEqual(manifest);expect(manifest.changeCheckpoint).toBeNull();
    expect(manifest.files).toHaveLength(2);
    for(const file of manifest.files)expect(createHash('sha256').update(zip.readFile(file.path)).digest('hex')).toBe(file.sha256);
    expect(createHash('sha256').update(zip.readFile('manifest.json')).digest('hex')).toBe(ready.manifestSha256);
    expect(f.store.records.get(job.id)?.content?.toString()).not.toContain('FICTITIOUS-NOT-OFFICIAL');
  });
  it('same idempotency key returns same job across restarts without recapturing',async()=>{
    const f=exportFixture(),a=await f.core.create(token,key,f.request);f.billingHttp.json.mockClear();
    const b=await f.core.create(token,key,f.request);expect(a.id).toBe(b.id);
    expect(f.billingHttp.json.mock.calls.some(c=>c[0].endsWith('/capture'))).toBe(false);
  });
  it('concurrent identical creation reserves one durable job',async()=>{
    const f=exportFixture(),result=await Promise.all([f.core.create(token,key,f.request),f.core.create(token,key,f.request)]);
    expect(result[0].id).toBe(result[1].id);expect(f.store.records.size).toBe(1);
  });
  it('changed body under same idempotency key is a conflict',async()=>{
    const f=exportFixture();await f.core.create(token,key,f.request);
    await expect(f.core.create(token,key,{...f.request,artifactKinds:[]})).rejects.toMatchObject(error('IDEMPOTENCY_CONFLICT'));
  });
  it('does not retain access token for worker or retry',async()=>{
    const f=exportFixture();await f.core.create(token,key,f.request);f.identity.authenticate.mockRejectedValue(new Error('TOKEN EXPIRED'));
    f.billingHttp.json.mockClear();f.sunatHttp.bytes.mockClear();await f.core.runOne();
    expect([...f.store.records.values()][0].state).toBe('READY');expect(f.billingHttp.json).not.toHaveBeenCalled();expect(f.sunatHttp.bytes).not.toHaveBeenCalled();
  });
  it('worker lease recovers an interrupted packaging attempt',async()=>{
    const f=exportFixture(),job=await f.core.create(token,key,f.request);const old=await f.store.claim(new Date(f.now()).toISOString());
    expect(old?.id).toBe(job.id);expect(await f.core.runOne()).toBe(false);f.advance(60001);
    expect(await f.core.runOne()).toBe(true);expect((await f.core.status(token,job.id,issuerRuc)).state).toBe('READY');
  });
  it.each(['STATUS','MANIFEST','DOWNLOAD'])('cached %s still denies revocation/revision changes',async mode=>{
    const f=exportFixture(),job=await f.core.create(token,key,f.request);await f.core.runOne();f.p.revision++;
    const call=mode==='STATUS'?f.core.status(token,job.id,issuerRuc):mode==='MANIFEST'?f.core.manifest(token,job.id,issuerRuc):f.core.content(token,job.id,issuerRuc);
    await expect(call).rejects.toMatchObject(error('CURSOR_CONTEXT_CHANGED'));
  });
  it('other clients cannot retrieve jobs even with identical RUC grants',async()=>{
    const f=exportFixture(),job=await f.core.create(token,key,f.request);f.p.clientId='80000000-0000-4000-8000-000000000002';
    await expect(f.core.status(token,job.id,issuerRuc)).rejects.toMatchObject(error('RESOURCE_NOT_FOUND'));
  });
  it('REPORT preserves originals that exist and lists exact missing classes',async()=>{
    const f=exportFixture(),job=await f.core.create(token,key,{...f.request,artifactKinds:['SIGNED_XML','CDR_XML','ORIGINAL_PDF'],missingArtifacts:'REPORT'});
    await f.core.runOne();const manifest=await f.core.manifest(token,job.id,issuerRuc);expect(manifest.complete).toBe(false);
    expect(manifest.missingArtifacts).toEqual([{documentId,kind:'CDR_XML',code:'ARTIFACT_UNAVAILABLE'},{documentId,kind:'ORIGINAL_PDF',code:'SOURCE_NOT_SUPPORTED'}]);
  });
  it.each(['CDR_XML','ORIGINAL_PDF'])('FAIL never packages missing %s',async kind=>{
    const f=exportFixture();await expect(f.core.create(token,key,{...f.request,artifactKinds:[kind]})).rejects.toMatchObject(error(kind==='ORIGINAL_PDF'?'SOURCE_NOT_SUPPORTED':'ARTIFACT_UNAVAILABLE'));
    expect([...f.store.records.values()][0].state).toBe('FAILED');expect(await f.core.runOne()).toBe(false);
  });
  it('metadata-only job needs no artifact scope or SUNAT calls',async()=>{
    const f=exportFixture();f.p.scopes=f.p.scopes.filter(s=>s!=='integration:artifacts:read');
    const job=await f.core.create(token,key,{...f.request,artifactKinds:[]});await f.core.runOne();
    expect((await f.core.manifest(token,job.id,issuerRuc)).files).toHaveLength(1);expect(f.sunatHttp.json).not.toHaveBeenCalled();
  });
  it('mixed unsupported source cannot pass FAIL, REPORT exposes incomplete coverage',async()=>{
    const f=exportFixture(),request={...f.request,filters:{...f.request.filters,types:['01','09']},artifactKinds:[]};
    await expect(f.core.create(token,key,request)).rejects.toMatchObject(error('SOURCE_NOT_SUPPORTED'));
    const job=await f.core.create(token,key+'2',{...request,missingArtifacts:'REPORT'});await f.core.runOne();
    expect((await f.core.manifest(token,job.id,issuerRuc)).complete).toBe(false);
  });
  it('bad SHA or changed inventory fails before enqueueing',async()=>{
    const f=exportFixture();f.sunatHttp.bytes.mockImplementationOnce(async()=>({bytes:Buffer.from('TAMPERED'),headers:{}}));
    await expect(f.core.create(token,key,f.request)).rejects.toMatchObject(error('INTEGRITY_FAILED'));expect([...f.store.records.values()][0].state).toBe('FAILED');
  });
  it('inventory revision change after byte verification denies the capture',async()=>{
    const f=exportFixture(),old=f.sunatHttp.json.getMockImplementation()!;let n=0;
    f.sunatHttp.json.mockImplementation(async(path:string,t:string)=>{const value:any=await old(path,t);
      if(path.includes('/artifacts')&&++n===2)value.items[0].sha256='a'.repeat(64);return value;});
    await expect(f.core.create(token,key,f.request)).rejects.toMatchObject(error('EVIDENCE_INCONSISTENT'));
  });
  it('a shared CDR batch is deduplicated and its complete membership remains authorized',async()=>{
    const f=exportFixture(),thirdId='40000000-0000-4000-8000-000000000003',third=sale('03',thirdId);
    third.number=2n;third.fullNumber='B001-00000002';third.immutableSnapshot.number='00000002';third.immutableSnapshot.fullNumber=third.fullNumber;
    f.rows.set(thirdId,third);
    const entries=[secondId,thirdId].map(id=>({document:{snapshot:structuredClone(f.rows.get(id)!.immutableSnapshot)},conditionCode:'1'}));
    f.batches.get(batchId)!.immutablePayload={environment:'BETA',issuer:{identityNumber:issuerRuc},identifier:'RC-20260101-1',kind:'RC',input:{kind:'RC',entries}};
    f.summaries.values().next().value!.items.push({documentId:thirdId,conditionCode:'1'});
    const canonical={...f.artifact,id:'70000000-0000-4000-8000-000000000002',kind:'CDR_XML',storageKey:batchId+'/cdr.xml'};
    f.batches.get(batchId)!.artifacts=[canonical];f.shared.push({artifact:canonical,batchId});
    for(const id of [secondId,thirdId])f.docs.set(id,{documentId:id,issuerRuc,environment:'BETA',documentType:'03',series:'B001',number:f.rows.get(id)!.number,
      immutablePayload:structuredClone(f.rows.get(id)!.immutableSnapshot),artifacts:[{...canonical,id:id===secondId?'70000000-0000-4000-8000-000000000003':'70000000-0000-4000-8000-000000000004',storageKey:id+'/copy.xml'}]});
    const request={...f.request,filters:{...f.request.filters,types:['03']},artifactKinds:['CDR_XML']};
    const job=await f.core.create(token,key,request);await f.core.runOne();const manifest=await f.core.manifest(token,job.id,issuerRuc);
    expect(manifest.files).toHaveLength(2);expect(manifest.files[1].owner).toEqual({kind:'BATCH',id:batchId});
    expect(new Set(manifest.files[1].documentIds)).toEqual(new Set([secondId,thirdId]));
    // Narrow grants while the complete batch remains in the cached ZIP: no delivery of original CDR.
    f.p.revision++;f.p.grants[0].documentTypes=['01'];
    await expect(f.core.content(token,job.id,issuerRuc)).rejects.toMatchObject(error('CURSOR_CONTEXT_CHANGED'));
  });
  it('batch membership change after capture denies a cached original CDR',async()=>{
    const f=exportFixture(),canonical={...f.artifact,id:'70000000-0000-4000-8000-000000000002',kind:'CDR_XML',storageKey:batchId+'/cdr.xml'};
    f.batches.get(batchId)!.artifacts=[canonical];f.shared.push({artifact:canonical,batchId});f.docs.get(secondId)!.artifacts=[{...canonical,id:'70000000-0000-4000-8000-000000000003',storageKey:secondId+'/copy.xml'}];
    const job=await f.core.create(token,key,{...f.request,filters:{...f.request.filters,types:['03']},artifactKinds:['CDR_XML']});await f.core.runOne();
    f.summaries.values().next().value!.items[0].conditionCode='2';
    await expect(f.core.content(token,job.id,issuerRuc)).rejects.toMatchObject(error('INCOMPLETE_BINDING'));
  });
  it('an unavailable owner/audit never delivers snapshot or archive',async()=>{
    const f=exportFixture(),job=await f.core.create(token,key,f.request);await f.core.runOne();f.store.audit.mockRejectedValue(new Error('private-db'));
    await expect(f.core.content(token,job.id,issuerRuc)).rejects.toThrow('private-db');
    f.billingHttp.json.mockRejectedValue(new Error('unavailable'));await expect(f.core.status(token,job.id,issuerRuc)).rejects.toThrow();
  });
  it('24-hour expiry wipes temporary ciphertext, not source history',async()=>{
    const f=exportFixture(),job=await f.core.create(token,key,f.request);await f.core.runOne();f.advance(86400000);await f.core.sweep();
    expect(f.store.records.get(job.id)?.payload).toBeNull();expect(f.store.records.get(job.id)?.content).toBeNull();expect(f.rows.has(documentId)).toBe(true);
    await expect(f.core.content(token,job.id,issuerRuc)).rejects.toMatchObject(error('EXPORT_EXPIRED'));
    await expect(f.core.create(token,key,f.request)).rejects.toMatchObject(error('EXPORT_EXPIRED'));
  });
  it.each(['PRODUCTION','QA'])('cannot create an export for %s',async environment=>{
    const f=exportFixture();await expect(f.core.create(token,key,{...f.request,filters:{...f.request.filters,environment}})).rejects.toMatchObject(error('INVALID_REQUEST'));
    expect(f.store.records.size).toBe(0);
  });
  it('encrypts using authenticated version/AAD and fails on wrong key, moved record or bit flip',()=>{
    const v=new ExportVault(randomBytes(32)),b=v.seal(Buffer.from('fictitious'),'one');expect(v.open(b,'one').toString()).toBe('fictitious');
    expect(()=>v.open(b,'two')).toThrow();expect(()=>new ExportVault(randomBytes(32)).open(b,'one')).toThrow();
    b[b.length-1]^=1;expect(()=>v.open(b,'one')).toThrow();expect(()=>new ExportVault(Buffer.alloc(31))).toThrow();
  });
});
