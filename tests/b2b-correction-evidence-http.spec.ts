import 'reflect-metadata';
import {beforeAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {b2bCertificates} from './b2b-tls.fixture';
import {correctionEvidenceHttpFixture,AS_OF,TOKEN} from './helpers/b2b-correction-evidence-http.fixture';
import {correctionEvidenceHash} from '../packages/service-access/src/b2b-correction-evidence-wire';
import {fiscalSnapshotSha256} from '../packages/sunat-core/src/fiscal-note';
import {isBetaOwnerDocumentAcceptance} from '../services/sunat-service/src/application/beta-document-acceptance';
import {isBetaVerifiedSupplementOutcome} from '../services/sunat-service/src/application/beta-verified-supplement-outcome';

describe('B2B-06 private Billing ↔ SUNAT evidence callback over isolated loopback mTLS',()=>{
  let tls:ReturnType<typeof b2bCertificates>,f:Awaited<ReturnType<typeof correctionEvidenceHttpFixture>>;
  beforeAll(()=>{tls=b2bCertificates();},30000);
  beforeEach(async()=>{f=await correctionEvidenceHttpFixture(tls);},15000);
  afterEach(async()=>{await f?.close();});

  it('binds the original owner proof through both private routes with two fresh callbacks',async()=>{
    const proof=await f.client.original(f.original.doc as never,AS_OF);
    expect(f.client.ownsOriginal(proof)).toBe(true);
    expect(proof.evidence).toMatchObject({documentId:f.original.doc.documentId,snapshotSha256:fiscalSnapshotSha256(f.original.doc),environment:'BETA'});
    expect(f.authority.current).toHaveBeenCalledTimes(4);expect(f.scope.inspect).toHaveBeenCalledTimes(4);
    expect(f.original.ports.read).toHaveBeenCalledTimes(6);
    for(const [token,kind,binding] of f.authority.current.mock.calls){expect(token).toBe(TOKEN);expect(kind).toBe('SERVICE');expect(binding).toEqual(f.binding);}
    expect(f.client.ownsOriginal(structuredClone(proof))).toBe(false);
    expect(isBetaOwnerDocumentAcceptance(proof)).toBe(false); // a distinct Billing-local capability, not a serialized SUNAT seal
    expect(Object.isFrozen(proof.fence)).toBe(true);
  });
  it('composes actual prerequisite owner seals, then mints a separate Billing-local capability',async()=>{
    const proof=await f.client.prerequisites(f.command,AS_OF);
    expect(proof.commandSha256).toBe(fiscalSnapshotSha256(f.command));expect(proof.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.client.ownsPrerequisites(proof)).toBe(true);expect(f.client.ownsPrerequisites(structuredClone(proof))).toBe(false);
    expect(f.acceptance.verify).toHaveBeenCalledTimes(1);expect(f.authority.current).toHaveBeenCalledTimes(4);
    expect(f.client.correctionEvidence().owns(proof)).toBe(true);
  });
  it('binds a verified note outcome and its XML/request/CDR hashes without signing or transmitting',async()=>{
    const proof=await f.client.verify(f.command,AS_OF);
    expect(proof.operationId).toBe(f.command.payload.operationId);expect(proof.commandSha256).toBe(fiscalSnapshotSha256(f.command));
    expect(proof.evidence).toMatchObject({status:'ACCEPTED',responseCode:'0',cdrSha256:f.outcome.record.cdrZip.sha256,requestSha256:f.outcome.record.requestZip.sha256});
    expect(f.outcome.owner.read).toHaveBeenCalledTimes(6);expect(f.client.owns(proof)).toBe(true);
    expect(f.client.owns(structuredClone(proof))).toBe(false);expect(isBetaVerifiedSupplementOutcome(proof)).toBe(false);
    const port=f.client.financialEvidence();expect(await port.command(f.command.payload.operationId)).toEqual(f.command);expect(port.owns(proof)).toBe(true);
  });
  it.each(['billing','sunat'] as const)('%s route enforces client certificate, trusted CA and pinned peer independently',async target=>{
    const path=target==='billing'?'/internal/b2b/correction-evidence-authorize':'/internal/b2b/correction-evidence';
    await expect(f.send(target,path,f.body(),{peer:null})).rejects.toThrow();
    await expect(f.send(target,path,f.body(),{trust:false})).rejects.toThrow();
    const result=await f.send(target,path,f.body(),{peer:'other',headers:{'X-Forwarded-Client-Cert':'ADMIN','X-User-Role':'ADMIN_GENERAL','X-Forwarded-For':'127.0.0.1'}});
    expect(result.status).toBe(403);expect(result.body.code).toBe('PRIVATE_PEER_REQUIRED');
    expect(f.original.ports.read).not.toHaveBeenCalled();expect(f.authority.current).not.toHaveBeenCalled();
  });
  it('does not treat the caller peer as the callback peer, or the callback peer as the caller',async()=>{
    expect((await f.send('billing','/internal/b2b/correction-evidence-authorize',f.body(),{peer:'edge'})).status).toBe(403);
    expect((await f.send('sunat','/internal/b2b/correction-evidence',f.body(),{peer:'resource'})).status).toBe(403);
    expect(f.authority.current).not.toHaveBeenCalled();
  });
  it.each(['billing','sunat'] as const)('%s responses explicitly prohibit cache and content sniffing',async target=>{
    const r=await f.send(target,target==='billing'?'/internal/b2b/correction-evidence-authorize':'/internal/b2b/correction-evidence',f.body());
    expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('private, no-store');expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body).toMatchObject({candidateOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false});
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);expect(JSON.stringify(r.body)).not.toContain('BEGIN CERTIFICATE');
  });
  it.each(['bad.jwt.token',''] as const)('rejects token %j before any artifact is read',async token=>{
    const r=await f.send('sunat','/internal/b2b/correction-evidence',f.body(),{token});
    expect(r.status).toBe(401);expect(f.original.ports.read).not.toHaveBeenCalled();
  });
  it('denies production, malformed grants and caller-supplied trust fields before artifact IO',async()=>{
    const cases=[{...f.body(),binding:{...f.binding,reference:{...f.binding.reference,environment:'PRODUCTION'}}},
      {...f.body(),actor:{role:'ADMIN'}},{...f.body(),officialCdr:true},
      {...f.body(),binding:{...f.binding,noteSeriesId:f.binding.reference.seriesId}}];
    for(const body of cases){const r=await f.send('sunat','/internal/b2b/correction-evidence',body);expect(r.status).toBe(400);}
    expect(f.original.ports.read).not.toHaveBeenCalled();expect(f.authority.current).not.toHaveBeenCalled();
  });
  it.each(['2026-10-04T17:59:29.000Z','2026-10-04T18:00:03.000Z'])('rejects stale or future asOf %s before authorization and reads',async asOf=>{
    const r=await f.send('sunat','/internal/b2b/correction-evidence',{...f.body(),asOf});
    expect(r.status).toBe(409);expect(f.authority.current).not.toHaveBeenCalled();expect(f.original.ports.read).not.toHaveBeenCalled();
  });
  it('rejects crossed issuer/branch/point/series/type bindings rather than trusting IDs from the payload',async()=>{
    const pairs=[{...f.binding,reference:{...f.binding.reference,issuerId:100}},
      {...f.binding,reference:{...f.binding.reference,branchId:'abcdefab-0000-4000-8000-000000000800'}},
      {...f.binding,reference:{...f.binding.reference,pointId:'abcdefab-0000-4000-8000-000000000801'}},
      {...f.binding,reference:{...f.binding.reference,seriesId:'abcdefab-0000-4000-8000-000000000802'}},
      {...f.binding,noteType:'08'}];
    for(const binding of pairs){const r=await f.send('sunat','/internal/b2b/correction-evidence',{...f.body(),binding});expect(r.status).toBe(404);}
    expect(f.original.ports.read).not.toHaveBeenCalled();
  });
  it('fails closed when Billing callback is unavailable, without reading an artifact or leaking transport errors',async()=>{
    await f.closeBilling();const r=await f.send('sunat','/internal/b2b/correction-evidence',f.body());
    expect(r.status).toBe(503);expect(r.body).toMatchObject({code:'OWNER_UNAVAILABLE'});expect(JSON.stringify(r.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|synthetic-local-only-token/);
    expect(f.original.ports.read).not.toHaveBeenCalled();
  });
  it('rechecks revocation on the next request rather than trusting a cached authority receipt',async()=>{
    await f.client.original(f.original.doc as never,AS_OF);const reads=f.original.ports.read.mock.calls.length;f.state.revoked=true;
    await expect(f.client.original(f.original.doc as never,AS_OF)).rejects.toMatchObject({status:401});expect(f.original.ports.read).toHaveBeenCalledTimes(reads);
  });
  it('rejects a grant revision changing between the two owner callbacks',async()=>{
    const normal=f.authority.current.getMockImplementation()!;let count=0;
    f.authority.current.mockImplementation(async(...args)=>{if(++count===3)f.state.revision++;return normal(...args);});
    const r=await f.send('sunat','/internal/b2b/correction-evidence',f.body());
    expect(r.status).toBe(409);expect(r.body.code).toBe('CORRECTION_AUTHORITY_CHANGED');
    expect(f.original.ports.read).toHaveBeenCalledTimes(6);
  });
  it('rejects an owner scope changing within Billing reauthorization before artifact access',async()=>{
    const normal=f.scope.inspect.getMockImplementation()!;let count=0;
    f.scope.inspect.mockImplementation(async(...args)=>{if(++count===2)f.state.scopeChanged=true;return normal(...args);});
    const r=await f.send('sunat','/internal/b2b/correction-evidence',f.body());
    expect(r.status).toBe(409);expect(f.original.ports.read).not.toHaveBeenCalled();
  });
  it('does not serialize a copied SUNAT original proof as trusted evidence',async()=>{
    const genuine=await f.original.run();f.acceptance.verify.mockResolvedValueOnce(structuredClone(genuine));
    const r=await f.send('sunat','/internal/b2b/correction-evidence',f.body());
    expect(r.status).toBe(503);expect(r.body.code).toBe('OWNER_EVIDENCE_PROVENANCE_REQUIRED');
  });
  it('rejects copied prerequisite and outcome seals even if their complete JSON matches',async()=>{
    const prerequisite=await f.prerequisites.verify(f.command,AS_OF),outcome=await f.outcomeCore.verify(f.command,AS_OF);
    vi.spyOn(f.prerequisites,'verify').mockResolvedValueOnce(structuredClone(prerequisite));
    expect((await f.send('sunat','/internal/b2b/correction-evidence',f.body('PREREQUISITES'))).body.code).toBe('OWNER_EVIDENCE_PROVENANCE_REQUIRED');
    vi.spyOn(f.outcomeCore,'verify').mockResolvedValueOnce(structuredClone(outcome));
    expect((await f.send('sunat','/internal/b2b/correction-evidence',f.body('OUTCOME'))).body.code).toBe('OWNER_EVIDENCE_PROVENANCE_REQUIRED');
  });
  it('sanitizes untrusted CDR rejection and never returns partial evidence',async()=>{
    f.original.ports.verifyCdr.mockRejectedValueOnce(new Error('SECRET_FIXTURE_INTERNAL_PATH'));
    const r=await f.send('sunat','/internal/b2b/correction-evidence',f.body());
    expect(r.status).toBe(503);expect(r.body.code).toBe('OWNER_UNAVAILABLE');expect(JSON.stringify(r.body)).not.toContain('SECRET_FIXTURE_INTERNAL_PATH');expect(r.body.result).toBeUndefined();
  });
  it('does not expose public issuance, production, login, signing or submission routes on either private application',async()=>{
    for(const target of ['billing','sunat'] as const)for(const path of ['/b2b/v1/credit-notes','/b2b/v1/debit-notes','/api/v1/auth/login','/internal/b2b/submit','/internal/b2b/production']){
      expect((await f.send(target,path,{})).status).toBe(404);
    }
    expect(f.authority.current).not.toHaveBeenCalled();expect(f.original.ports.read).not.toHaveBeenCalled();
  });
  it('uses detached, bound request hashes and rejects an unrelated Billing-owned operation',async()=>{
    const r=await f.send('sunat','/internal/b2b/correction-evidence',f.body());expect(r.status).toBe(200);
    expect(r.body.requestSha256).toBe(correctionEvidenceHash(f.body()));
    await expect(f.client.financialEvidence().command('abcdefab-0000-4000-8000-000000000999')).rejects.toThrow();
  });
  it('bounds request JSON before remote reads and cannot use a permitted private transport to call arbitrary routes',async()=>{
    await expect(f.sunatRpc.post('/internal/b2b/correction-evidence',{...f.body(),padding:'x'.repeat(2*1024*1024)},TOKEN)).rejects.toMatchObject({status:400});
    await expect(f.sunatRpc.post('/internal/b2b/sign',f.body(),TOKEN)).rejects.toMatchObject({status:400});
    expect(f.original.ports.read).not.toHaveBeenCalled();expect(f.authority.current).not.toHaveBeenCalled();
  });
});
