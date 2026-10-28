import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GuideArtifactPipeline } from '../services/sunat-service/src/application/guide-artifact-pipeline';
import { CarrierGuideArtifactOwner } from '../services/sunat-service/src/application/guide-carrier-artifact-owner';
import { fiscalSnapshotSha256 as hash } from '../packages/sunat-core/src/fiscal-note';
import { carrierCryptoFixture } from './helpers/carrier-crypto.fixture';
import { createGuideSidecarPki } from './helpers/guide-sidecar-ephemeral-pki.fixture';
import { guideArtifactFixture } from './helpers/guide-artifact.fixture';
import { guideUuid } from './helpers/b2b-guide.fixture';
import { PrivateCarrierArtifactSource } from '../services/sunat-service/src/application/private-carrier-artifact-source';
let sender: ReturnType<typeof createGuideSidecarPki>, carrier: ReturnType<typeof createGuideSidecarPki>;
// Keep the generated PKI and the historical reference/CDR on one deterministic
// clock. Production certificate and signature checks are unchanged.
beforeAll(() => { vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date('2026-10-23T16:00:00.000Z')); sender = createGuideSidecarPki('20000000001'); carrier = createGuideSidecarPki('20000000028'); },30000);
afterAll(() => vi.useRealTimers());
async function fixture() {
  const r = carrierCryptoFixture(sender), backing = await guideArtifactFixture(carrier);
  const snapshot = {schemaVersion:'factuez.carrier-issued-local.v1',documentId:guideUuid(80),operationId:guideUuid(81),binding:r.binding,
    draftId:guideUuid(82),draftRevision:1,issuer:r.carrier,series:'VQ31',number:'1',fullNumber:'VQ31-1',at:'2026-10-23T15:50:00.000Z',
    body:{ issueDate:'2026-10-23T15:45:00.000Z',transferDate:r.projection.transferDate,sender:r.projection.sender,recipient:r.projection.recipient,
      origin:r.projection.origin,destination:r.projection.destination,grossWeight:r.projection.grossWeight,weightUnit:r.projection.weightUnit,
      transport:{mode:'01',carrier:{...r.carrier,mtcRegistration:'MTC00031'},vehicle:{plate:'ABC931',tuc:'TUC00031'},
        driver:{identityType:'1',identityNumber:'00000001',firstName:'CONDUCTOR',lastName:'FICTICIO',license:'A000000031'}},
      reference09:{documentId:r.projection.documentId,issuerRuc:r.sender.ruc,series:r.projection.series,number:r.projection.number,snapshotSha256:hash(r.projection)},
      items:r.projection.items,totalTransfer:true,freightPayer:'SENDER',subcontracted:false,regulatedGoods:false },
    bodySha256:'',contextSha256:'b'.repeat(64),candidateOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false,
    authorizedForTransfer:false,officialRulesValidated:false,officialCdrVerified:false,numberReserved:true };
  snapshot.bodySha256 = hash(snapshot.body);
  const issuance = {schemaVersion:'factuez.b2b.carrier-guide-issuance.v1',operationId:snapshot.operationId,draftId:snapshot.draftId,binding:r.binding,
    snapshot,snapshotSha256:hash(snapshot),replayed:false};
  const source = { artifactCurrent: vi.fn(async () => ({issuance:structuredClone(issuance),authorizationSha256:'a'.repeat(64),
    reference:{snapshot:structuredClone(r.projection),acceptance:await r.verifier.verify(r.input)}})) };
  const owner = new CarrierGuideArtifactOwner(source);
  const core = new GuideArtifactPipeline(owner,backing.store,backing.signer,[r.carrier.ruc]);
  const scope = {binding:r.binding,draftId:snapshot.draftId,operationId:snapshot.operationId};
  return {...r,backing,issuance,source,owner,core,scope};
}
describe('complete owned GT31 → independently reconstructed XML → signed original pipeline', () => {
  it('binds full reference and reserved V identity through signature and replay', async () => {
    const f = await fixture(), first = await f.core.prepare(f.scope,f.backing.access), again = await f.core.prepare(f.scope,f.backing.access);
    expect(first.record.metadata).toMatchObject({guideType:'31',fullNumber:'VQ31-1',issuerRuc:f.carrier.ruc,signatureVerifiedLocally:true,
      certificateTrusted:false,officialCdrVerified:false,authorizedForTransfer:false});
    expect(first.record.signedXml).toContain('<cbc:DespatchAdviceTypeCode'); expect(first.record.signedXml).toContain('>31</cbc:DespatchAdviceTypeCode>');
    expect(first.record.signedXml).toContain('TQ31-9'); expect(again.replayed).toBe(true); expect(again.record.zip).toEqual(first.record.zip);
    expect(f.backing.signer.sign).toHaveBeenCalledTimes(1); expect(f.backing.control.writes).toBe(1);
  });
  it('does not trust a serialized owner snapshot as a sealed render capability', async () => {
    const f = await fixture(); const raw = await f.owner.current(f.scope,f.backing.access,'ISSUE');
    const forged = {current:async () => structuredClone(raw)};
    const core = new GuideArtifactPipeline(forged,f.backing.store,f.backing.signer,[f.carrier.ruc]);
    await expect(core.prepare(f.scope,f.backing.access)).rejects.toThrow(); expect(f.backing.signer.sign).not.toHaveBeenCalled();
  });
  it('reference signature/trust revocation blocks a replayed stored package', async () => {
    const f = await fixture(); await f.core.prepare(f.scope,f.backing.access);
    f.trust.evaluate.mockResolvedValue({} as any);
    await expect(f.core.read(f.scope,f.backing.access)).rejects.toThrow('GUIDE_ARTIFACT_INVALID_CARRIER_OWNER');
    expect(f.backing.control.writes).toBe(1);
  });
  it('reference or number substitution with a recomputed hash cannot reuse original signed bytes', async () => {
    const f = await fixture(); await f.core.prepare(f.scope,f.backing.access);
    f.issuance.snapshot.number = '2'; f.issuance.snapshot.fullNumber = 'VQ31-2'; f.issuance.snapshotSha256 = hash(f.issuance.snapshot);
    await expect(f.core.read(f.scope,f.backing.access)).rejects.toThrow('GUIDE_ARTIFACT_INTEGRITY_FAILED');
  });
  it('private carrier owner RPC selects only its fixed path and obtains a freshly fenced complete owner receipt', async () => {
    const f = await fixture(), principal = {kind:'SERVICE' as const,clientId:guideUuid(90),revision:1,subjectId:null,userAuthRevision:null,
      environment:'BETA' as const,scopes:['b2b:documents:read','b2b:guides:issue','b2b:guides:read','b2b:guide-operations:read'],bindings:[f.binding.draft.anchor]};
    const identity = {authenticate:vi.fn(async () => structuredClone(principal))};
    const http = {post:vi.fn(async () => f.source.artifactCurrent())};
    const source = new PrivateCarrierArtifactSource(identity as any,http);
    const owned = await new CarrierGuideArtifactOwner(source).current(f.scope,f.backing.access,'READ');
    expect(owned.issuance.snapshot.fullNumber).toBe('VQ31-1');
    expect(http.post).toHaveBeenCalledWith('/internal/b2b/carrier-guides',
      {action:'ARTIFACT_OWNER',kind:'SERVICE',scope:f.scope,permission:'READ'},f.backing.access.token);
    expect(identity.authenticate.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(owned)).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE|password|pkcs12/);
  });
  it('private owner RPC cannot return bytes after a concurrent identity revision change', async () => {
    const f = await fixture(), principal = {kind:'SERVICE' as const,clientId:guideUuid(90),revision:1,subjectId:null,userAuthRevision:null,
      environment:'BETA' as const,scopes:['b2b:documents:read','b2b:guides:issue'],bindings:[f.binding.draft.anchor]};
    const identity = {authenticate:vi.fn(async () => structuredClone(principal))};
    const http = {post:vi.fn(async () => {const value=await f.source.artifactCurrent();principal.revision++;return value;})};
    const source = new PrivateCarrierArtifactSource(identity as any,http);
    await expect(source.artifactCurrent(f.scope,f.backing.access,'ISSUE')).rejects.toThrow('GUIDE_ARTIFACT_OWNER_UNAVAILABLE_OR_DENIED');
    expect(f.backing.signer.sign).not.toHaveBeenCalled();
  });
});
