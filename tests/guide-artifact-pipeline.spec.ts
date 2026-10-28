import 'reflect-metadata';
import { beforeAll, describe, expect, it } from 'vitest';
import { GuideArtifactPipeline } from '../services/sunat-service/src/application/guide-artifact-pipeline';
import { GuideDispatchCoordinator } from '../services/sunat-service/src/application/guide-dispatch';
import { GuideDispatchCdrReview } from '../services/sunat-service/src/application/guide-dispatch-cdr-review';
import { GuideDispatchMemoryStore } from './helpers/guide-dispatch.fixture';
import { createHash } from 'node:crypto';
import { fiscalSnapshotSha256 as hash } from '../packages/sunat-core/src/fiscal-note';
import { guideArtifactFixture } from './helpers/guide-artifact.fixture';
import { createGuideSidecarPki, guideSidecarCdrXml, guideSidecarPackCdr } from './helpers/guide-sidecar-ephemeral-pki.fixture';

let pki: ReturnType<typeof createGuideSidecarPki>;
beforeAll(() => { pki = createGuideSidecarPki('20000000001'); }, 30000);
describe('owned numbered guide → signed immutable originals → reviewed local CDR', () => {
  it('uses actual producer snapshot, signs its reserved number, and never consumes another number', async () => {
    const f = await guideArtifactFixture(pki), before = f.f.state(), r = await f.core.prepare(f.scope, f.access);
    expect(r.replayed).toBe(false); expect(r.record.signedXml).toContain('<cbc:ID>T001-1</cbc:ID>');
    expect(r.record.signedXml).toContain('signatureFactuEz'); expect(r.record.metadata.snapshotSha256).toBe(f.owned.issuance.snapshotSha256);
    expect(r.record.metadata).toMatchObject({ signatureVerifiedLocally: true, certificateTrusted: false, officialCdrVerified: false,
      transmissionAuthorized: false, authorizedForTransfer: false, environment: 'BETA' });
    expect(f.f.state()).toEqual(before); expect(f.control.writes).toBe(1);
  });
  it('replays concurrent preparation and restart without resigning or duplicate writes', async () => {
    const f = await guideArtifactFixture(pki), a = await Promise.all([f.core.prepare(f.scope, f.access), f.core.prepare(f.scope, f.access)]);
    expect(a.map(r => r.replayed)).toEqual([false, true]); expect(f.signer.sign).toHaveBeenCalledTimes(1);
    const b = await f.restart().prepare(f.scope, f.access); expect(b.record.zip).toEqual(a[0].record.zip);
    expect(b.record.signedXml).toBe(a[0].record.signedXml); expect(f.control.writes).toBe(1);
  });
  it('READ cannot prepare/sign when no original exists', async () => {
    const f = await guideArtifactFixture(pki);
    await expect(f.core.read(f.scope, f.access)).rejects.toThrow('GUIDE_ARTIFACT_NOT_PREPARED');
    expect(f.signer.sign).not.toHaveBeenCalled(); expect(f.state.artifact).toBeNull();
  });
  it.each(['signed','insert'] as const)('revocation during %s rolls back the whole artifact', async phase => {
    const f = await guideArtifactFixture(pki); f.hooks[phase] = () => { f.control.revoked = true; };
    await expect(f.core.prepare(f.scope, f.access)).rejects.toThrow();
    expect(f.state.artifact).toBeNull(); expect(f.control.writes).toBe(0);
  });
  it('a new authorization fence during signing cannot bless old authorization', async () => {
    const f = await guideArtifactFixture(pki); f.hooks.signed = () => { f.owned.authorizationSha256 = 'b'.repeat(64); };
    await expect(f.core.prepare(f.scope, f.access)).rejects.toThrow('GUIDE_ARTIFACT_OWNER_CHANGED');
    expect(f.state.artifact).toBeNull();
  });
  it('a recomputed altered owner body cannot reuse an archived signed XML', async () => {
    const f = await guideArtifactFixture(pki); await f.core.prepare(f.scope, f.access);
    f.owned.issuance.snapshot.body.items[0].description = 'ALTERED FICTITIOUS ITEM';
    f.owned.issuance.snapshot.bodySha256 = hash(f.owned.issuance.snapshot.body);
    f.owned.issuance.snapshotSha256 = hash(f.owned.issuance.snapshot);
    await expect(f.core.read(f.scope, f.access)).rejects.toThrow('GUIDE_ARTIFACT_INTEGRITY_FAILED');
    expect(f.signer.sign).toHaveBeenCalledTimes(1);
  });
  it.each(['signedXml','zip','metadata'] as const)('detects persisted %s corruption on every read', async field => {
    const f = await guideArtifactFixture(pki); await f.core.prepare(f.scope, f.access);
    if (field === 'signedXml') f.state.artifact!.signedXml = f.state.artifact!.signedXml.replace('T001-1','T001-2');
    if (field === 'zip') f.state.artifact!.zip[50] ^= 1;
    if (field === 'metadata') (f.state.artifact!.metadata as any).officialCdrVerified = true;
    await expect(f.core.read(f.scope, f.access)).rejects.toThrow('GUIDE_ARTIFACT_INTEGRITY_FAILED');
  });
  it('returned buffers and metadata cannot mutate stored originals', async () => {
    const f = await guideArtifactFixture(pki), r = await f.core.prepare(f.scope, f.access), bytes = Buffer.from(r.record.zip);
    r.record.zip.fill(0); r.record.metadata.fullNumber = 'T001-999';
    const read = await f.core.read(f.scope, f.access); expect(read.record.zip).toEqual(bytes); expect(read.record.metadata.fullNumber).toBe('T001-1');
  });
  it('explicit RUC policy rejects another issuer before key access', async () => {
    const f = await guideArtifactFixture(pki), core = new GuideArtifactPipeline(f.owner, f.store, f.signer, ['20000000010']);
    await expect(core.prepare(f.scope, f.access)).rejects.toThrow('GUIDE_ARTIFACT_RUC_NOT_ALLOWED'); expect(f.signer.sign).not.toHaveBeenCalled();
  });
  async function receipt(f: Awaited<ReturnType<typeof guideArtifactFixture>>, code = '0') {
    const { record: { metadata: m } } = await f.core.prepare(f.scope, f.access);
    const expected = { issuerRuc: m.issuerRuc, documentType: '09' as const, fullNumber: m.fullNumber,
      requestXmlSha256: m.xmlSha256, requestZipSha256: m.zipSha256, issuedAt: '2026-10-21T15:30:00.000Z', receivedAt: '2026-10-23T16:00:00.000Z' };
    return guideSidecarPackCdr(pki.signCdr(guideSidecarCdrXml(expected, code)), expected);
  }
  it.each(['0','2000'])('archives and revalidates an ephemeral signed CDR code %s without official acceptance', async code => {
    const f = await guideArtifactFixture(pki), zip = await receipt(f, code), r = await f.core.reviewCdr(f.scope, f.access, zip);
    expect(r.zip).toEqual(zip); expect(r.evidence).toMatchObject({ signatureTrusted: true, source: 'LOCAL_EMULATOR',
      responseCode: code, officialCdrVerified: false, requestHashesBoundByCdr: false, authorizedForTransfer: false });
    expect(r.evidence.status).toBe(code === '0' ? 'ACCEPTED' : 'REJECTED');
    const again = await f.restart().readCdr(f.scope, f.access); expect(again.zip).toEqual(zip);
    await f.core.reviewCdr(f.scope, f.access, zip); expect(f.control.cdrWrites).toBe(1);
    expect(f.verifier.verify).toHaveBeenCalledTimes(3);
  });
  it('untrusted CDR signature never enters the archive', async () => {
    const f = await guideArtifactFixture(pki), zip = await receipt(f); f.verifier.verify.mockResolvedValue(false);
    await expect(f.core.reviewCdr(f.scope, f.access, zip)).rejects.toThrow('GUIDE_CDR_SIGNATURE_UNTRUSTED');
    expect(f.state.cdr).toBeNull(); expect(f.control.cdrWrites).toBe(0);
  });
  it('conflicting signed CDR is preserved as conflict instead of overwriting the original', async () => {
    const f = await guideArtifactFixture(pki), first = await receipt(f), other = await receipt(f,'2000');
    await f.core.reviewCdr(f.scope, f.access, first);
    await expect(f.core.reviewCdr(f.scope, f.access, other)).rejects.toThrow('GUIDE_ARTIFACT_CDR_CONFLICT');
    expect(f.state.cdr!.zip).toEqual(first);
  });
  it('CDR read requires an existing original and never generates one', async () => {
    const f = await guideArtifactFixture(pki); await expect(f.core.readCdr(f.scope, f.access)).rejects.toThrow('GUIDE_ARTIFACT_NOT_PREPARED');
    expect(f.signer.sign).not.toHaveBeenCalled();
  });
  it('constructs the local dispatch manifest only from authenticated persisted bytes', async () => {
    const f = await guideArtifactFixture(pki), r = await f.core.prepare(f.scope, f.access), manifest = await f.core.manifest(f.scope, f.access);
    expect(manifest).toMatchObject({ source: 'LOCAL_EMULATOR', xmlSha256: r.record.metadata.xmlSha256,
      zipSha256: r.record.metadata.zipSha256, snapshotSha256: f.owned.issuance.snapshotSha256 });
    const owner = f.core.dispatchOwner(f.scope, f.access);
    expect(await owner.current({ ...manifest.key, issuerRuc: '20000000010' })).toBeNull();
    expect(await owner.current(manifest.key)).toEqual(manifest);
  });
  it('runs numbered producer, signed archive, durable intent, local ticket and bound CDR end to end without resubmitting', async () => {
    const f = await guideArtifactFixture(pki), bytes = await receipt(f), manifest = await f.core.manifest(f.scope, f.access);
    let submissions = 0;
    const emulator = { mode: 'ISOLATED_LOCAL_EMULATOR' as const,
      submit: async () => { submissions++; return { ticket: 'FICTITIOUS_LOCAL_TICKET' }; },
      findTicket: async () => ({ ticket: 'FICTITIOUS_LOCAL_TICKET' }),
      poll: async () => ({ state: 'RESULT' as const, receiptSha256: createHash('sha256').update(bytes).digest('hex') }) };
    const store = new GuideDispatchMemoryStore(), owner = f.core.dispatchOwner(f.scope, f.access);
    const dispatch = () => new GuideDispatchCoordinator(store, owner, emulator, () => '2026-10-23T16:00:00.000Z', 5000);
    await dispatch().dispatch(manifest.key); await dispatch().poll(manifest.key);
    const archive = await new GuideDispatchCdrReview(f.core, dispatch()).review(f.scope, f.access, bytes);
    expect(archive.zip).toEqual(bytes); expect(archive.evidence.officialCdrVerified).toBe(false);
    await dispatch().dispatch(manifest.key); expect(submissions).toBe(1); expect(f.f.state().next).toBe(2);
    const wrong = await receipt(f, '2000');
    await expect(new GuideDispatchCdrReview(f.core, dispatch()).review(f.scope, f.access, wrong))
      .rejects.toThrow('GUIDE_ARTIFACT_DISPATCH_RECEIPT_MISMATCH');
    expect((await f.core.readCdr(f.scope, f.access)).zip).toEqual(bytes);
  });
});
