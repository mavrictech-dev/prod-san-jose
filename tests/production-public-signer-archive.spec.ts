import 'reflect-metadata';
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir, lstat, mkdir, writeFile, symlink, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { X509Certificate } from 'node:crypto';
import { PublicSignerArchive } from '../services/sunat-service/src/infrastructure/crypto/public-signer-archive';
import { inspectCertificate } from '../services/sunat-service/src/infrastructure/crypto/certificate-inspector';
import { BetaIssuanceService } from '../services/sunat-service/src/application/beta-issuance.service';
import { ProductionIssuanceService } from '../services/sunat-service/src/application/production-issuance.service';
import { XmlSignerService } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import { buildInvoiceUbl } from '../packages/sunat-core/src';
import { prepareBetaXml } from '../services/sunat-service/src/infrastructure/crypto/beta-xml-pipeline';
import { createGuideSidecarPki, guideSidecarHash as hash } from './helpers/guide-sidecar-ephemeral-pki.fixture';
import { documentSample } from './qa-print-formats.mjs';

let pki: ReturnType<typeof createGuideSidecarPki>, directory: string, root: string, archive: PublicSignerArchive;
let metadata: ReturnType<typeof inspectCertificate>;
const ruc = '20100070970';
beforeAll(() => { pki = createGuideSidecarPki(); metadata = inspectCertificate(pki.issuer.pkcs12, pki.password); }, 30000);
afterAll(() => { for (const signer of [pki.issuer, pki.otherIssuer, pki.sunat]) signer.pkcs12.fill(0); });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'factuez-public-signer-test-')); root = join(directory, 'artifacts');
  archive = new PublicSignerArchive(root);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NETWORK_FORBIDDEN'); }));
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  if (!resolve(directory).startsWith(join(resolve(tmpdir()), 'factuez-public-signer-test-'))) throw new Error('UNSAFE_TEST_CLEANUP');
  await rm(directory, { recursive: true, force: true });
});
const file = () => join(root, 'public-signers-v1', ruc, `${metadata.fingerprint}.pem`);

describe('PublicSignerArchive: private, public-only, immutable RUC/fingerprint history', () => {
  it('automatically archives only canonical public PEM and can load from a new instance without issuer pins', async () => {
    vi.stubEnv('ARTIFACTS_ROOT', root); archive = new PublicSignerArchive();
    await archive.archive(ruc, { ...metadata, password: 'DO-NOT-STORE', pkcs12: pki.issuer.pkcs12 } as any);
    const raw = await readFile(file(), 'utf8');
    expect(raw).toBe(new X509Certificate(metadata.certificatePem).toString() + new X509Certificate(metadata.chainPems[0]).toString());
    expect(raw).not.toMatch(/PRIVATE KEY|PKCS12|DO-NOT-STORE|fingerprint|expiresAt/);
    expect(await new PublicSignerArchive().load(ruc, metadata.fingerprint)).toEqual({ certificatePem: new X509Certificate(metadata.certificatePem).toString(), chainPems: [new X509Certificate(metadata.chainPems[0]).toString()] });
    expect(await readdir(join(root, 'public-signers-v1', ruc))).toEqual([`${metadata.fingerprint}.pem`]);
    if (process.platform !== 'win32') {
      expect((await lstat(file())).mode & 0o077).toBe(0);
      expect((await lstat(join(root, 'public-signers-v1'))).mode & 0o077).toBe(0);
    }
  });
  it('repeats idempotently without rewriting bytes, inode or modification time', async () => {
    await archive.archive(ruc, metadata); const before = await lstat(file()), raw = await readFile(file());
    await archive.archive(ruc, { ...metadata, certificatePem: metadata.certificatePem.replaceAll('\r\n', '\n') });
    expect(await readFile(file())).toEqual(raw); const after = await lstat(file());
    expect([after.ino, after.mtimeMs, after.size]).toEqual([before.ino, before.mtimeMs, before.size]);
  });
  it('never replaces a changed chain with the same leaf fingerprint; requires versioned historical migration', async () => {
    await archive.archive(ruc, metadata); const raw = await readFile(file());
    await expect(archive.archive(ruc, { ...metadata, chainPems: [] })).rejects.toThrow('CHAIN_CONFLICT_REQUIRES_VERSIONED_HISTORY');
    expect(await readFile(file())).toEqual(raw); expect(await readdir(join(root, 'public-signers-v1', ruc))).toHaveLength(1);
  });
  it('handles concurrent identical first writes atomically and leaves no temp records', async () => {
    await Promise.all(Array.from({ length: 12 }, () => archive.archive(ruc, metadata)));
    await expect(archive.load(ruc, metadata.fingerprint)).resolves.toBeDefined();
    expect(await readdir(join(root, 'public-signers-v1', ruc))).toEqual([`${metadata.fingerprint}.pem`]);
  });
  it('concurrent different chains cannot replace each other; exactly one is published', async () => {
    const values = await Promise.allSettled([archive.archive(ruc, metadata), archive.archive(ruc, { ...metadata, chainPems: [] })]);
    expect(values.filter(v => v.status === 'fulfilled')).toHaveLength(1);
    expect(values.filter(v => v.status === 'rejected')).toHaveLength(1);
    expect(await readdir(join(root, 'public-signers-v1', ruc))).toHaveLength(1);
  });
  it.each(['../20100070970', '20100070970/../../escape', '20100070970:stream', 'CON', '２０１０００７０９７０', '2010007097'])('rejects unsafe RUC %s before any directory is created', async id => {
    await expect(archive.archive(id, metadata)).rejects.toThrow('IDENTITY_INVALID');
    await expect(archive.load(id, metadata.fingerprint)).rejects.toThrow('IDENTITY_INVALID'); expect(await readdir(directory)).toEqual([]);
  });
  it.each(['../escape', 'a'.repeat(64) + ':x', 'A'.repeat(64), '', '0'.repeat(63)])('rejects unsafe fingerprint %s', async fingerprint => {
    await expect(archive.archive(ruc, { ...metadata, fingerprint })).rejects.toThrow('IDENTITY_INVALID');
    await expect(archive.load(ruc, fingerprint)).rejects.toThrow('IDENTITY_INVALID'); expect(await readdir(directory)).toEqual([]);
  });
  it.each(['relative/path', '.', ''])('rejects a relative artifact root %s', value => { expect(() => new PublicSignerArchive(value)).toThrow('ROOT_REQUIRED'); });
  it.each(['ruc', 'fingerprint', 'private-key', 'p12', 'oversized', 'duplicate-chain', 'leaf-in-chain'])('rejects invalid public input: %s', async change => {
    const copy = structuredClone(metadata); let owner = ruc;
    if (change === 'ruc') owner = '20131312955';
    if (change === 'fingerprint') copy.fingerprint = '0'.repeat(64);
    if (change === 'private-key') copy.certificatePem += '\n-----BEGIN PRIVATE KEY-----\nPRIVATE\n-----END PRIVATE KEY-----';
    if (change === 'p12') copy.certificatePem = pki.issuer.pkcs12.toString('base64');
    if (change === 'oversized') copy.certificatePem = 'x'.repeat(65537);
    if (change === 'duplicate-chain') copy.chainPems.push(copy.chainPems[0]);
    if (change === 'leaf-in-chain') copy.chainPems = [copy.certificatePem];
    await expect(archive.archive(owner, copy)).rejects.toThrow(); expect(await readdir(directory)).toEqual([]);
  });
  it('load never creates a missing archive or tries current credentials', async () => {
    await expect(archive.load(ruc, metadata.fingerprint)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readdir(directory)).toEqual([]);
  });
  it.each(['artifacts-root', 'archive-root', 'issuer'])('rejects a symlink/junction at %s for writes and reads', async position => {
    const outside = join(directory, 'outside'); await mkdir(outside);
    let alias = root;
    if (position !== 'artifacts-root') { await mkdir(root); alias = join(root, 'public-signers-v1'); }
    if (position === 'issuer') { await mkdir(alias); alias = join(alias, ruc); }
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(archive.archive(ruc, metadata)).rejects.toThrow('UNSAFE_DIRECTORY');
    await expect(archive.load(ruc, metadata.fingerprint)).rejects.toThrow('UNSAFE_DIRECTORY');
    expect(await readdir(outside)).toEqual([]); await unlink(alias);
  });
  it('rejects a file symlink and leaves its target unchanged', async context => {
    await mkdir(join(root, 'public-signers-v1', ruc), { recursive: true, mode: 0o700 });
    const outside = join(directory, 'outside.pem'); await writeFile(outside, 'UNCHANGED');
    try { await symlink(outside, file(), 'file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; } throw error; }
    await expect(archive.archive(ruc, metadata)).rejects.toThrow('UNSAFE_FILE');
    await expect(archive.load(ruc, metadata.fingerprint)).rejects.toThrow('UNSAFE_FILE'); expect(await readFile(outside, 'utf8')).toBe('UNCHANGED');
    await unlink(file());
  });
  it('rejects a hardlinked record', async () => {
    await archive.archive(ruc, metadata); const outside = join(directory, 'alias.pem'); await link(file(), outside);
    await expect(archive.load(ruc, metadata.fingerprint)).rejects.toThrow('NOT_SINGLE_LINK'); await unlink(outside);
  });
  it('rejects a modified public record instead of repairing or replacing it silently', async () => {
    await archive.archive(ruc, metadata); await writeFile(file(), 'CORRUPT PUBLIC HISTORY');
    await expect(archive.archive(ruc, metadata)).rejects.toThrow(); await expect(archive.load(ruc, metadata.fingerprint)).rejects.toThrow();
    expect(await readFile(file(), 'utf8')).toBe('CORRUPT PUBLIC HISTORY');
  });
  it('keeps expired public material readable without asserting historical PKI trust', async () => {
    await archive.archive(ruc, metadata); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(metadata.expiresAt.getTime() + 1000));
    await expect(archive.load(ruc, metadata.fingerprint)).resolves.toBeDefined();
  });
});

function fixture(environment: 'BETA' | 'PRODUCTION' = 'PRODUCTION', injected: PublicSignerArchive | undefined = archive) {
  const snapshot = documentSample('01') as any; snapshot.environment = environment; snapshot.branchId = '20000000-0000-4000-8000-000000000001';
  Object.assign(snapshot.issuer, { identityNumber: ruc, establishmentCode: '0000' }); snapshot.customer.identityNumber = '20131312955';
  Object.assign(snapshot.printPresentation, { issuerRuc: ruc, branchId: snapshot.branchId });
  const prepared = prepareBetaXml(snapshot, pki.issuer.pkcs12, pki.password);
  const credentials = { certificateCipher: 'IN_MEMORY_TEST', certificatePasswordCipher: 'IN_MEMORY_TEST', certificateFingerprint: metadata.fingerprint, revision: 1 };
  const opened: Buffer[] = [], vault = { open: vi.fn((_cipher, aad) => { const b = Buffer.from(aad.field === 'certificate' ? pki.issuer.pkcs12 : Buffer.from(pki.password)); opened.push(b); return b; }) };
  const inspection = { inspect: vi.fn(async () => structuredClone(metadata)) };
  // Explicit PKI/CRL policy double; signatures and archive filesystem remain real.
  const trust = { evaluate: vi.fn(async (m, _ruc, now: Date) => ({ profile: 'OFFLINE-PINNED-ROOTS-CRL-v1', chainValid: true, identityMatched: true,
    revocation: 'VERIFIED_OFFLINE_CRL', certificateFingerprint: m.fingerprint, checkedAt: now.toISOString(), trustStoreSha256: hash(pki.rootPem), blockers: [] })) };
  const signer = { prepare: vi.fn(async () => prepared) }, xsd = { validate: vi.fn(async (xml: string) => ({ xmlSha256: hash(xml) })) };
  const store = { put: vi.fn(async (id, name, bytes) => {
    if (environment === 'PRODUCTION') await new PublicSignerArchive(root).load(ruc, metadata.fingerprint);
    return { storageKey: `${id}/${name}`, sha256: hash(bytes), sizeBytes: bytes.length };
  }) };
  const repo = { owns: vi.fn(async () => true) };
  const service = new BetaIssuanceService({} as never, repo as never, store as never, vault as never, inspection as never, trust as never, signer as never, xsd as never, {} as never, injected) as any;
  if (environment === 'PRODUCTION') Object.defineProperty(service, 'environment', { value: 'PRODUCTION' });
  service.context = vi.fn(async () => credentials);
  const row = { id: 'FICTITIOUS_PREPARATION', documentId: snapshot.documentId, snapshot, phase: 'PREPARING' };
  return { service, row, prepared, trust, signer, xsd, store, repo, vault, inspection, opened, credentials,
    run: () => service.prepare(row) };
}

describe('production preparation: archive the exact verified signer before prepared artifacts/commit', () => {
  it('publishes the public chain before the first artifact write and before the manifest exists', async () => {
    const save = vi.spyOn(archive, 'archive'), f = fixture();
    await f.run(); expect(save).toHaveBeenCalledOnce(); expect(save.mock.invocationCallOrder[0]).toBeLessThan(f.store.put.mock.invocationCallOrder[0]);
    const manifest = f.service.manifests.get(f.row.id); expect(manifest.fingerprint).toBe(metadata.fingerprint);
    expect(await new PublicSignerArchive(root).load(ruc, manifest.fingerprint)).toBeDefined();
    expect(f.opened.every(b => b.every(byte => byte === 0))).toBe(true);
  });
  it('the real ProductionIssuanceService constructor inherits automatic archive behavior without new per-issuer input', async () => {
    vi.stubEnv('ARTIFACTS_ROOT', root); const f = fixture();
    const service = new ProductionIssuanceService({} as never, f.repo as never, f.store as never, f.vault as never,
      f.inspection as never, f.trust as never, f.signer as never, f.xsd as never, {} as never, {} as never) as any;
    service.context = f.service.context;
    // Run preparation only: no policy override, bootstrap, transport or emission is invoked.
    await service.prepare(f.row);
    expect(service.manifests.get(f.row.id).fingerprint).toBe(metadata.fingerprint);
    expect(await new PublicSignerArchive().load(ruc, metadata.fingerprint)).toBeDefined();
  });
  it('does not touch the public archive for Beta preparation', async () => {
    const save = vi.spyOn(archive, 'archive'), f = fixture('BETA'); await f.run();
    expect(save).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]); expect(f.service.manifests.size).toBe(1);
  });
  it.each(['trust', 'crl', 'fingerprint', 'blockers', 'profile'])('does not archive when production verification fails: %s', async change => {
    const save = vi.spyOn(archive, 'archive'), f = fixture();
    const good = await f.trust.evaluate(metadata, ruc, new Date());
    const delta = change === 'trust' ? { chainValid: false } : change === 'crl' ? { revocation: 'PENDING' } :
      change === 'fingerprint' ? { certificateFingerprint: '0'.repeat(64) } : change === 'blockers' ? { blockers: ['DENIED'] } : { profile: 'UNKNOWN' };
    f.trust.evaluate.mockImplementation(async (_m, _r, now) => ({ ...good, checkedAt: now.toISOString(), ...delta }));
    await expect(f.run()).rejects.toThrow(); expect(save).not.toHaveBeenCalled(); expect(f.signer.prepare).not.toHaveBeenCalled(); expect(f.store.put).not.toHaveBeenCalled();
    expect(f.opened.every(b => b.every(byte => byte === 0))).toBe(true);
  });
  it.each(['claimed-fingerprint', 'actual-signer', 'digest', 'request', 'snapshot', 'xsd', 'lease', 'revision'])('refuses mismatching prepared proof before archive: %s', async change => {
    const save = vi.spyOn(archive, 'archive'), f = fixture();
    if (change === 'claimed-fingerprint') f.prepared.document.certificateFingerprintSha256 = '0'.repeat(64);
    if (change === 'actual-signer') {
      const other = new XmlSignerService().sign(buildInvoiceUbl(f.row.snapshot, { mode: 'REAL_PREPARATION' }), pki.otherIssuer.pkcs12, pki.password);
      f.prepared.document.xml = other.xml;
    }
    if (change === 'digest') f.prepared.document.digestValue = 'a'.repeat(43) + '=';
    if (change === 'request') f.prepared.request = { ...f.prepared.request, certificateFingerprintSha256: '0'.repeat(64) };
    if (change === 'snapshot') f.row.snapshot.customer.legalName = 'OTHER FICTITIOUS CUSTOMER';
    if (change === 'xsd') f.xsd.validate.mockRejectedValue(new Error('XSD_REJECTED'));
    if (change === 'lease') f.repo.owns.mockResolvedValue(false);
    if (change === 'revision') f.service.context.mockResolvedValueOnce(f.credentials).mockRejectedValue(new Error('REVISION_CHANGED'));
    await expect(f.run()).rejects.toThrow(); expect(save).not.toHaveBeenCalled(); expect(f.store.put).not.toHaveBeenCalled(); expect(f.service.manifests.size).toBe(0);
  });
  it('a changed public chain prevents artifacts and commit, retaining the old history', async () => {
    await archive.archive(ruc, { ...metadata, chainPems: [] }); const before = await readFile(file()), f = fixture();
    await expect(f.run()).rejects.toThrow('CHAIN_CONFLICT_REQUIRES_VERSIONED_HISTORY');
    expect(f.store.put).not.toHaveBeenCalled(); expect(f.service.manifests.size).toBe(0); expect(await readFile(file())).toEqual(before);
  });
  it('archive failure prevents the prepared manifest from reaching commit', async () => {
    vi.spyOn(archive, 'archive').mockRejectedValue(new Error('DISK_UNAVAILABLE')); const f = fixture();
    await expect(f.run()).rejects.toThrow('DISK_UNAVAILABLE'); expect(f.store.put).not.toHaveBeenCalled(); expect(f.service.manifests.size).toBe(0);
  });
  it('losing the lease after public publication prevents artifacts/commit, keeping harmless public history', async () => {
    const f = fixture(); f.repo.owns.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(f.run()).rejects.toThrow('lease'); expect(f.store.put).not.toHaveBeenCalled(); expect(f.service.manifests.size).toBe(0);
    expect(await archive.load(ruc, metadata.fingerprint)).toBeDefined();
  });
});
