import 'reflect-metadata';
import { describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { snapshotHash, ownerRuntimeConfig, validPrincipal, readQuery, privateRequest, PrivateReadHttp } from '../packages/service-access/src/integration';
import { mapBillingDocument } from '../services/billing-service/src/integration/read';
import { readFixture, sale, principal, issuerRuc, otherRuc, documentId, secondId, batchId, summaryId, artifactId, branchId, counterId } from './integration-read.fixture';
const token='fixture-token',q={issuerRuc};
describe('Billing M2M reads: immutable snapshots, exact tuple, no fiscal writes',()=>{
  it.each(['01','03','07','08'] as const)('maps full frozen %s without current customer/product or false acceptance',type=>{
    const result=mapBillingDocument(sale(type),principal(),issuerRuc).document;
    expect(result.type).toBe(type);expect(result.detail.kind).toBe('SALE');expect(result.state.fiscal).toBe('NOT_CHECKED');
    expect(result.state.transport).toBe('ACCEPTED');expect(result.detail.items[0].unitValue).toBe('100.123456');
    expect(result.number).toBe('00000001');expect(result.issueDate).toBe('2026-01-01');expect(result.issueTime).toBe('23:30:00');
    expect(result.detail.totals.exemptAmount).toBeNull();expect(result.detail.paymentTerms.type).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private-proof');expect(result).not.toHaveProperty('immutableSnapshot');
  });
  it.each(['environment','documentId','documentTypeCode','series','number','fullNumber','companyId','branchId'])( 'rejects altered frozen header %s',field=>{
    const row=sale();row.immutableSnapshot[field]=field==='number'?'2':'wrong';
    expect(()=>mapBillingDocument(row,principal(),issuerRuc)).toThrow();
  });
  it.each(['companyId','emissionPointId','documentType','series'])('rejects wrong canonical counter binding %s',field=>{
    const row=sale();(row.seriesCounter as any)[field]='wrong';expect(()=>mapBillingDocument(row,principal(),issuerRuc)).toThrow();
  });
  it.each(['branches','points','series'])('denies restrictive %s grant',field=>{
    const p=principal();(p.grants[0] as any)[field]={kind:'IDS',ids:[randomUUID()]};
    expect(()=>mapBillingDocument(sale(),p,issuerRuc)).toThrow('RESOURCE_NOT_FOUND');
  });
  it('does not combine fragments of different grants into a broader tuple',()=>{
    const p=principal();p.grants=[{...p.grants[0],branches:{kind:'IDS',ids:[randomUUID()]}},
      {...p.grants[0],series:{kind:'IDS',ids:[randomUUID()]}}];
    expect(()=>mapBillingDocument(sale(),p,issuerRuc)).toThrow('RESOURCE_NOT_FOUND');
  });
  it.each(['00044232378',otherRuc])('refuses a foreign/synthetic issuer %s before repository lookup',async r=>{
    const f=readFixture();await expect(f.billing.document(token,r,documentId)).rejects.toThrow();expect(f.billingRepo.document).not.toHaveBeenCalled();
  });
  it('uses exact BigInt numeric lookup while preserving frozen number format',async()=>{
    const f=readFixture();const r=await f.billing.lookup(token,{...q,type:'01',series:'F001',number:'1'});expect(r.document.number).toBe('00000001');
    expect(f.billingRepo.document).toHaveBeenCalledWith(issuerRuc,{type:'01',series:'F001',number:1n});
  });
  it('preserves integers above JS precision as text',()=>{
    const row=sale();row.number=9007199254740993n;row.immutableSnapshot.number='9007199254740993';
    row.fullNumber=row.immutableSnapshot.fullNumber='F001-9007199254740993';expect(mapBillingDocument(row,principal(),issuerRuc).document.number).toBe('9007199254740993');
  });
  it.each(['09','31'])('never treats laboratory/diagnostic %s as business source',async type=>{
    const f=readFixture();await expect(f.billing.lookup(token,{...q,type,series:'T001',number:'1'})).rejects.toThrow('SOURCE_NOT_SUPPORTED');
    expect(f.billingRepo.document).not.toHaveBeenCalled();
  });
  it.each(['18.1234567890123','NaN',18,{},'1e2'])('rejects non-contract decimals %j',value=>{
    const row=sale();row.immutableSnapshot.lines[0].igvAmount=value;expect(()=>mapBillingDocument(row,principal(),issuerRuc)).toThrow('EVIDENCE_INCONSISTENT');
  });
  it('maps credit installments without defaulting missing terms to cash',()=>{
    const row=sale();row.immutableSnapshot.paymentTerms={type:'CREDITO',pendingAmount:'118.00',installments:[{amount:'118.00',dueDate:'2026-02-01'}]};
    expect(mapBillingDocument(row,principal(),issuerRuc).document.detail.paymentTerms).toEqual(row.immutableSnapshot.paymentTerms);
  });
  it('refuses mismatched total or duplicate item identities',()=>{
    const row=sale();row.payableAmount='119';expect(()=>mapBillingDocument(row,principal(),issuerRuc)).toThrow();
    row.payableAmount='118';row.immutableSnapshot.lines.push({...row.immutableSnapshot.lines[0]});expect(()=>mapBillingDocument(row,principal(),issuerRuc)).toThrow();
  });
  it('catalog filters branches, points and types using the same grant tuple',async()=>{
    const f=readFixture();f.p.grants[0].series={kind:'IDS',ids:[randomUUID()]};const result=await f.billing.catalog(token,issuerRuc);
    expect(result.branches).toEqual([]);expect(result.points).toEqual([]);expect(result.issuer.issuerRuc).toBe(issuerRuc);
  });
});
describe('SUNAT owner originals and shared CDR protection',()=>{
  it('returns original inventory without storage paths, bytes or false cryptographic verification',async()=>{
    const f=readFixture(),result=await f.sunat.artifacts(token,issuerRuc,documentId,'DOCUMENT');expect(result.items).toHaveLength(1);
    expect(result.items[0].verification).toMatchObject({integrity:'UNVERIFIED',signature:'UNVERIFIED',trust:'UNVERIFIED'});
    expect(JSON.stringify(result)).not.toContain('storageKey');expect(f.store.read).not.toHaveBeenCalled();
  });
  it('serves verified bytes and records only safe read-receipt metadata',async()=>{
    const f=readFixture(),result=await f.sunat.content(token,issuerRuc,artifactId);expect(result.bytes).toEqual(f.bytes);
    expect(f.sunatRepo.audit).toHaveBeenCalledWith(expect.objectContaining({artifactId,issuerRuc,byteLength:f.bytes.length,sha256:f.artifact.sha256}));
    expect(JSON.stringify(f.sunatRepo.audit.mock.calls)).not.toContain('storageKey');
  });
  it.each(['PRODUCTION','UNKNOWN'])('blocks frozen SUNAT environment %s',async environment=>{
    const f=readFixture();f.docs.get(documentId)!.environment=environment;
    await expect(f.sunat.content(token,issuerRuc,artifactId)).rejects.toThrow('EVIDENCE_INCONSISTENT');expect(f.store.read).not.toHaveBeenCalled();
  });
  it('blocks immutable payload drift from Billing',async()=>{
    const f=readFixture();(f.docs.get(documentId)!.immutablePayload as any).customer.legalName='Changed';
    await expect(f.sunat.content(token,issuerRuc,artifactId)).rejects.toThrow('EVIDENCE_INCONSISTENT');
  });
  it.each(['missing','corrupt','wrongLength','storageFailure','auditFailure'])('fails closed for %s and returns no bytes',async failure=>{
    const f=readFixture();if(failure==='missing') f.docs.clear();
    if(failure==='corrupt') f.store.read.mockResolvedValue(Buffer.from('bad'));
    if(failure==='wrongLength') f.artifact.sizeBytes=1;
    if(failure==='storageFailure') f.store.read.mockRejectedValue(new Error('private/path'));
    if(failure==='auditFailure') f.sunatRepo.audit.mockRejectedValue(new Error('private/SQL'));
    await expect(f.sunat.content(token,issuerRuc,artifactId)).rejects.toThrow();
    if(failure!=='auditFailure') expect(f.sunatRepo.audit).not.toHaveBeenCalled();
  });
  it('revocation after byte load prevents delivery and audit',async()=>{
    const f=readFixture();f.store.read.mockImplementation(async()=>{f.p.revision++;return f.bytes;});
    await expect(f.sunat.content(token,issuerRuc,artifactId)).rejects.toThrow('UNAUTHENTICATED');expect(f.sunatRepo.audit).not.toHaveBeenCalled();
  });
  it('recognizes a legacy singleton RC and verifies Billing summary membership',async()=>{
    const f=readFixture(),r=await f.sunat.batch(token,issuerRuc,batchId);expect(r.membersComplete).toBe(true);expect(r.members[0].documentId).toBe(secondId);
    expect(r.state.fiscal).toBe('NOT_CHECKED');expect(r.kind).toBe('RC');
  });
  function multiple(f:ReturnType<typeof readFixture>) {
    const row=sale('03');f.rows.set(documentId,row);
    Object.assign(f.docs.get(documentId)!,{documentType:'03',series:row.series,immutablePayload:structuredClone(row.immutableSnapshot)});
    f.summaries.get(summaryId)!.items.push({documentId,conditionCode:'2'});
    f.batches.get(batchId)!.immutablePayload=structuredClone({environment:'BETA',issuer:{identityNumber:issuerRuc},kind:'RC',identifier:'RC-20260101-1',
      input:{kind:'RC',entries:[{conditionCode:'1',document:{snapshot:f.rows.get(secondId)!.immutableSnapshot}},
        {conditionCode:'2',document:{snapshot:row.immutableSnapshot}}]}});
  }
  it('authorizes every member of a multiple RC',async()=>{
    const f=readFixture();multiple(f);expect((await f.sunat.batch(token,issuerRuc,batchId)).members).toHaveLength(2);
  });
  it('resolves complete RA membership without authorizing an RC-only receipt',async()=>{
    const f=readFixture();f.batches.get(batchId)!.identifier='RA-20260101-1';
    f.batches.get(batchId)!.immutablePayload={environment:'BETA',issuer:{identityNumber:issuerRuc},kind:'RA',identifier:'RA-20260101-1',
      input:{kind:'RA',entries:[{document:{snapshot:f.rows.get(documentId)!.immutableSnapshot}}]}};
    f.summaries.set(summaryId,{identifier:'RA-20260101-1',items:[{documentId,conditionCode:'3'}]});
    expect((await f.sunat.batch(token,issuerRuc,batchId)).kind).toBe('RA');
    (f.batches.get(batchId)!.immutablePayload as any).input.entries[0].document.snapshot=f.rows.get(secondId)!.immutableSnapshot;
    f.summaries.get(summaryId)!.items[0].documentId=secondId;
    await expect(f.sunat.batch(token,issuerRuc,batchId)).rejects.toThrow('INCOMPLETE_BINDING');
  });
  it.each(['duplicate','missing','foreign','drift','condition','identifier'])('refuses incomplete/inconsistent batch %s',async scenario=>{
    const f=readFixture();multiple(f);const payload=f.batches.get(batchId)!.immutablePayload as any;
    if(scenario==='duplicate') payload.input.entries[1]=payload.input.entries[0];
    if(scenario==='missing') f.summaries.get(summaryId)!.items.pop();
    if(scenario==='foreign') payload.input.entries[1].document.snapshot.issuer.identityNumber=otherRuc;
    if(scenario==='drift') payload.input.entries[1].document.snapshot.lines[0].description='wrong';
    if(scenario==='condition') payload.input.entries[1].conditionCode='3';
    if(scenario==='identifier') payload.identifier='RC-20260101-2';
    await expect(f.sunat.batch(token,issuerRuc,batchId)).rejects.toThrow();
  });
  it('authorizes copied CDR by full batch, not just clicked document',async()=>{
    const f=readFixture();multiple(f);
    const batchArtifact={...f.artifact,id:randomUUID(),kind:'CDR_XML',storageKey:batchId+'/cdr.xml'};
    f.batches.get(batchId)!.artifacts.push(batchArtifact);f.artifact.kind='CDR_XML';f.shared.push({artifact:batchArtifact,batchId});
    f.rows.get(secondId)!.seriesCounter.id=randomUUID();f.p.grants[0].series={kind:'IDS',ids:[counterId]};
    await expect(f.sunat.content(token,issuerRuc,artifactId)).rejects.toThrow('RESOURCE_NOT_FOUND');expect(f.store.read).not.toHaveBeenCalled();
    f.p.grants[0].series={kind:'ALL'};const result=await f.sunat.content(token,issuerRuc,artifactId);
    expect(result.fileName).toContain('RC-20260101-1');expect(f.store.read).toHaveBeenCalledWith(batchId,expect.objectContaining({id:batchArtifact.id}));
  });
  it('does not export unbound receipt CDR as an individual response',async()=>{
    const f=readFixture();f.docs.get(secondId)!.artifacts.push({...f.artifact,id:randomUUID(),kind:'CDR_XML'});
    await expect(f.sunat.artifacts(token,issuerRuc,secondId,'DOCUMENT')).rejects.toThrow('INCOMPLETE_BINDING');
  });
  it('rejects unsupported PDF substitution rather than serving current PDF as original',async()=>{
    const f=readFixture();f.artifact.kind='PDF_A4';f.artifact.mediaType='application/pdf';
    await expect(f.sunat.content(token,issuerRuc,artifactId)).rejects.toThrow('SOURCE_NOT_SUPPORTED');
  });
});
describe('Independent integration service: stable authorized catalog and proxy',()=>{
  it('reads single document and exact fiscal key without direct database or files',async()=>{
    const f=readFixture();expect((await f.gateway.document(token,documentId,q)).id).toBe(documentId);
    expect((await f.gateway.document(token,null,{...q,type:'01',series:'F001',number:'1'})).id).toBe(documentId);
  });
  it('advertises unsupported GR/GT and pending consistency/feed honestly',async()=>{
    const f=readFixture(),c=await f.gateway.capabilities(token,q);
    expect(c.types.filter(t=>['09','31'].includes(t.type)).every(t=>t.readState==='UNSUPPORTED')).toBe(true);
    expect(c.consistency).toBe('NOT_READY');expect(c.changes).toBe('NOT_READY');
  });
  it.each([{issuerRuc,environment:'PRODUCTION'},{issuerRuc,foo:'bar'},{issuerRuc:[issuerRuc]},{issuerRuc:'*'},{}])('rejects query %j',async query=>{
    const f=readFixture();await expect(f.gateway.document(token,documentId,query)).rejects.toThrow('INVALID_QUERY');expect(f.billingHttp.json).not.toHaveBeenCalled();
  });
  it('rejects future snapshot cuts explicitly, not falsely as latest document',async()=>{
    const f=readFixture();await expect(f.gateway.document(token,documentId,{...q,snapshotId:randomUUID()})).rejects.toThrow('CONSISTENT_READ_UNAVAILABLE');
  });
  it('keeps catalog snapshot stable despite subsequent source edits',async()=>{
    const f=readFixture();f.catalog.branches.push({...f.catalog.branches[0],id:randomUUID(),name:'Second'});
    f.catalog.points.push({...f.catalog.points[0],id:randomUUID(),branchId:f.catalog.branches[1].id});
    const first=await f.gateway.catalog(token,'branches',{...q,limit:'1'});f.catalog.branches[1].name='Changed';
    const next=await f.gateway.catalog(token,'branches',{...q,limit:'1',cursor:first.page.nextCursor!});
    expect(next.items[0].name).toBe('Second');expect(next.page.snapshotId).toBe(first.page.snapshotId);expect(next.page.hasMore).toBe(false);
  });
  it.each(['revision','scope','kind','limit','expiry'])('invalidates cursor on %s',async scenario=>{
    const f=readFixture();f.catalog.points.push({...f.catalog.points[0],id:randomUUID()});
    const first=await f.gateway.catalog(token,'points',{...q,branchId,limit:'1'});
    if(scenario==='revision') f.p.revision++;
    if(scenario==='scope') f.p.scopes=f.p.scopes.filter(s=>s!=='integration:documents:read');
    if(scenario==='expiry') f.advance(900001);
    await expect(f.gateway.catalog(token,scenario==='kind'?'branches':'points',scenario==='kind'?{...q,limit:'1',cursor:first.page.nextCursor!}:
      {...q,branchId,limit:scenario==='limit'?'2':'1',cursor:first.page.nextCursor!})).rejects.toThrow();
  });
  it('reauthorizes cached pages and loaded proxy bytes',async()=>{
    const f=readFixture();await f.gateway.catalog(token,'issuers',{});f.identity.authenticate.mockRejectedValue(new Error('revoked'));
    await expect(f.gateway.catalog(token,'issuers',{})).rejects.toThrow('revoked');
  });
  it('verifies owner checksum before returning the proxy response',async()=>{
    const f=readFixture();expect((await f.gateway.content(token,artifactId,q)).bytes).toEqual(f.bytes);
    f.sunatHttp.bytes.mockResolvedValue({bytes:Buffer.from('altered'),headers:{'content-type':'application/xml','content-length':'7',
      'x-content-sha256':f.artifact.sha256,'content-disposition':'attachment; filename="file.xml"'}});
    await expect(f.gateway.content(token,artifactId,q)).rejects.toThrow('INTEGRITY_FAILED');
  });
});
describe('Boundary utilities',()=>{
  it('disabled runtimes do not read missing PEMs, DB or env secrets',()=>expect(ownerRuntimeConfig({},'UNSET')).toBeNull());
  it.each(['PRODUCTION','SYNTHETIC',''])('runtime refuses non-Beta %s',environment=>expect(()=>ownerRuntimeConfig({ON:'true',INTEGRATION_READ_ENVIRONMENT:environment},'ON')).toThrow());
  it('hashes canonically and bounds recursive or malformed payloads',()=>{
    expect(snapshotHash({b:2,a:1})).toBe(snapshotHash({a:1,b:2}));const cyclic:any={};cyclic.self=cyclic;expect(()=>snapshotHash(cyclic)).toThrow();
    expect(()=>snapshotHash({secret:undefined})).toThrow();
  });
  it('does not trust forwarded TLS/user headers',()=>{
    expect(()=>privateRequest({headers:{authorization:'Bearer human','x-forwarded-proto':'https'},socket:{encrypted:false} as any},[])).toThrow('INSUFFICIENT_SCOPE');
  });
  it.each(['http://localhost:3002','https://user:pass@localhost','https://localhost/api','https://localhost?q=1'])('rejects request-controlled/nonprivate origin %s',origin=>{
    expect(()=>new PrivateReadHttp(origin,{ca:Buffer.alloc(0),cert:Buffer.alloc(0),key:Buffer.alloc(0)})).toThrow();
  });
  it('denies forged principal or array queries',()=>{
    expect(validPrincipal({...principal(),clientId:'admin'})).toBe(false);expect(()=>readQuery({issuerRuc:[issuerRuc]},['issuerRuc'])).toThrow();
  });
});
