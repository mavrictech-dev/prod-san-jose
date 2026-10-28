import { describe, it, expect } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { sealSyntheticRecovery, openSyntheticRecovery } from '../infra/integration/synthetic-recovery.mjs';
const input = () => ({ runId: randomUUID(), sourceMode: 'SYNTHETIC', environment: 'BETA', epoch: randomUUID(),
  counts: { history: 2, exports: 1, exportAudits: 1, deliveries: 1, deliveryAudits: 1 },
  databaseDump: Buffer.from('PGDMP SYNTHETIC NOT A DATABASE'), originals: [{ name: 'document.xml', bytes: Buffer.from('<SYNTHETIC/>') }] });
describe('Synthetic recovery envelope, before any restore destination is opened', () => {
  it('restores exact dump and originals, without plaintext in the backup', () => {
    const c = input(), key = randomBytes(32), sealed = sealSyntheticRecovery(c, key);
    expect(sealed.includes(Buffer.from('SYNTHETIC'))).toBe(false); expect(openSyntheticRecovery(sealed, key, c.runId)).toEqual(c);
  });
  it.each([0, 1, 13, 29, 40])('rejects tampered ciphertext at offset %s', offset => {
    const c = input(), key = randomBytes(32), sealed = sealSyntheticRecovery(c, key); sealed[offset] ^= 1;
    expect(() => openSyntheticRecovery(sealed, key, c.runId)).toThrow('SYNTHETIC_RECOVERY_INTEGRITY_FAILED');
  });
  it('wrong key/context reject; same unchanged backup with original key recovers', () => {
    const c = input(), key = randomBytes(32), sealed = sealSyntheticRecovery(c, key), before = Buffer.from(sealed);
    expect(() => openSyntheticRecovery(sealed, randomBytes(32), c.runId)).toThrow();
    expect(() => openSyntheticRecovery(sealed, key, randomUUID())).toThrow(); expect(sealed).toEqual(before);
    expect(openSyntheticRecovery(sealed, key, c.runId)).toEqual(c);
  });
  it.each(['PRODUCTION', 'TEST', null])('rejects environment %s', environment => {
    expect(() => sealSyntheticRecovery({ ...input(), environment }, randomBytes(32))).toThrow();
  });
  it.each(['AUTHORIZED_COPY', 'LIVE', '', null])('does not enable real data by changing source mode %s', sourceMode => {
    expect(() => sealSyntheticRecovery({ ...input(), sourceMode }, randomBytes(32))).toThrow();
  });
  it.each(['../original.xml', 'C:/original.xml', '/original.xml', 'document.xml\n', 'cert.p12'])('rejects original name %s', name => {
    const c = input(); c.originals[0].name = name; expect(() => sealSyntheticRecovery(c, randomBytes(32))).toThrow();
  });
  it('rejects duplicate originals, missing fields, malformed dump and oversized original', () => {
    const c = input(); c.originals.push(c.originals[0]); expect(() => sealSyntheticRecovery(c, randomBytes(32))).toThrow();
    expect(() => sealSyntheticRecovery({ ...input(), epoch: 'x' }, randomBytes(32))).toThrow();
    expect(() => sealSyntheticRecovery({ ...input(), databaseDump: Buffer.from('not-pgdump') }, randomBytes(32))).toThrow();
    const large = input(); large.originals[0].bytes = Buffer.alloc(10 * 1024 * 1024 + 1); expect(() => sealSyntheticRecovery(large, randomBytes(32))).toThrow();
  });
});
