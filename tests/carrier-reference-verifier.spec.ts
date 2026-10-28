import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGuideSidecarPki } from './helpers/guide-sidecar-ephemeral-pki.fixture';
import { carrierCryptoFixture, hashBytes } from './helpers/carrier-crypto.fixture';
let pki: ReturnType<typeof createGuideSidecarPki>;
// The sample CDR is historical. Generate its ephemeral certificates on the same
// test clock so advancing wall time cannot move NotBefore past acceptance.
beforeAll(() => { vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date('2026-10-23T16:00:00.000Z')); pki = createGuideSidecarPki('20000000001'); },30000);
afterAll(() => vi.useRealTimers());
describe('concrete private public09 reference signature/CDR verifier', () => {
  it('verifies the full signed 09, issuer pin and signed CDR before deriving reference evidence', async () => {
    const f = carrierCryptoFixture(pki), proof = await f.verifier.verify(f.input);
    expect(proof).toMatchObject({environment:'BETA',documentId:f.ownerSnapshot.documentId,issuerRuc:f.sender.ruc,
      fullNumber:'TQ31-9',snapshotSha256:f.input.projectionSha256,cdrSha256:f.input.cdrSha256,responseCode:'0',status:'ACCEPTED',acceptedAt:'2026-10-23T15:31:00.000Z'});
    expect(f.pins.current).toHaveBeenCalledTimes(2);
  });
  it.each(['item','issuer','xml','cdr','projection','pin','trust'] as const)('rejects %s substitution', async change => {
    const f = carrierCryptoFixture(pki);
    if (change === 'item') f.input.ownerSnapshot.body.items[0].quantity = '3';
    if (change === 'issuer') f.input.ownerSnapshot.issuer.ruc = '20000000028';
    if (change === 'xml') { f.input.signedXml = Buffer.from(f.signed.xml.replace('BIEN FICTICIO','BIEN MODIFICADO')); f.input.signedXmlSha256 = hashBytes(f.input.signedXml); }
    if (change === 'cdr') { f.input.cdrXml = Buffer.from(f.input.cdrXml.toString().replace('>09<','>31<')); f.input.cdrSha256 = hashBytes(f.input.cdrXml); }
    if (change === 'projection') f.input.projection.items[0].description = 'ALTERADO';
    if (change === 'pin') f.pins.current.mockResolvedValue({fingerprint:'c'.repeat(64),revision:'a'.repeat(64)});
    if (change === 'trust') f.trust.evaluate.mockResolvedValue({} as any);
    await expect(f.verifier.verify(f.input)).rejects.toThrow(/^CARRIER_REFERENCE_CRYPTO_UNVERIFIED$/);
  });
  it('detects pin revision changes while cryptographic work is in flight', async () => {
    const f = carrierCryptoFixture(pki), pin = {fingerprint:pki.issuer.fingerprint,revision:'a'.repeat(64)};
    f.pins.current.mockResolvedValueOnce(pin).mockResolvedValue({...pin,revision:'d'.repeat(64)});
    await expect(f.verifier.verify(f.input)).rejects.toThrow('CARRIER_REFERENCE_CRYPTO_UNVERIFIED');
  });
});
