import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventNames, assertProductionStatusProjection, productionDocumentSnapshotSha256 } from '../packages/contracts/src';
import type { FiscalDocumentSnapshot, ProductionStatusEvent } from '../packages/contracts/src';
import { buildInvoiceUbl, buildReceiptSummary, buildReceiptSummarySnapshot, calculateDocumentTotals, fiscalSnapshotSha256, limaIssueDate, receiptSummaryReconstructionAsOf } from '../packages/sunat-core/src';
import { ProductionIssuanceRepository } from '../services/sunat-service/src/application/production-issuance.repository';
import { ProductionIssuanceService } from '../services/sunat-service/src/application/production-issuance.service';
import { ArtifactStore } from '../services/sunat-service/src/infrastructure/artifact-store';
import { PublicSignerArchive } from '../services/sunat-service/src/infrastructure/crypto/public-signer-archive';
import { inspectCertificate } from '../services/sunat-service/src/infrastructure/crypto/certificate-inspector';
import { XmlSignerService, verifyLocalSignedInvoice } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import * as soapAuthority from '../services/sunat-service/src/infrastructure/sunat/production-soap-authorization';
import { prepareBetaXml } from '../services/sunat-service/src/infrastructure/crypto/beta-xml-pipeline';
import type { BetaDispatchRow } from '../services/sunat-service/src/application/beta-dispatch-pipeline';
import { createGuideSidecarPki, guideSidecarCdrXml, guideSidecarHash as hash, zipSync } from './helpers/guide-sidecar-ephemeral-pki.fixture';

// Ephemeral keys only. PKI/CRL is an explicit double; XML signatures, canonical binding and artifact IO are real.
let pki: ReturnType<typeof createGuideSidecarPki>, metadata: ReturnType<typeof inspectCertificate>, directory: string;
const NOW = new Date(), RUC = '20100070970';
const identifier = 'RC-' + limaIssueDate(NOW.toISOString()).replaceAll('-', '') + '-8';
beforeAll(() => { pki = createGuideSidecarPki(); metadata = inspectCertificate(pki.issuer.pkcs12, pki.password); }, 30000);
afterAll(() => { pki.issuer.pkcs12.fill(0); pki.otherIssuer.pkcs12.fill(0); pki.sunat.pkcs12.fill(0); });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'factuez-production-receipt-')); vi.stubEnv('ARTIFACTS_ROOT', directory);
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('NETWORK_FORBIDDEN'); }));
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  if (!resolve(directory).startsWith(join(resolve(tmpdir()), 'factuez-production-receipt-'))) throw Error('UNSAFE_CLEANUP');
  await rm(directory, { recursive: true, force: true });
});
function receipt(): FiscalDocumentSnapshot {
  return { documentId: randomUUID(), companyId: 1, environment: 'PRODUCTION', documentTypeCode: '03', series: 'B001', number: '1', fullNumber: 'B001-1',
    issueDate: NOW.toISOString(), currencyCode: 'PEN', operationTypeCode: '0101', paymentTerms: { type: 'CONTADO' },
    issuer: { identityType: '6', identityNumber: RUC, legalName: 'FICTITIOUS LOCAL ISSUER', address: 'TEST ONLY', ubigeo: '150101', establishmentCode: '0000' },
    customer: { identityType: '0', identityNumber: '0', legalName: 'FICTITIOUS LOCAL CUSTOMER' },
    ...calculateDocumentTotals([{ description: 'TEST ONLY', quantity: '1', unitCode: 'NIU', unitPriceWithTax: '1.18', igvRate: '18', taxAffectationCode: '10' }]) };
}
async function fixture() {
  const snapshot = receipt(), eventId = randomUUID(), batchId = randomUUID();
  const row: BetaDispatchRow = { id: randomUUID(), documentId: snapshot.documentId, snapshot, phase: 'PREPARING', attempt: 1, owner: new Date(), ticket: null };
  const document: any = { documentId: snapshot.documentId, issuerRuc: RUC, environment: 'PRODUCTION', immutablePayload: JSON.parse(JSON.stringify(snapshot)), status: 'BUILDING' };
  const submission: any = { id: row.id, documentId: row.documentId, idempotencyKey: 'production:' + row.documentId + ':v1', attempt: 1,
    startedAt: row.owner, errorCode: 'PREPARING', result: 'PENDING', completedAt: null, nextRetryAt: new Date(Date.now() + 60000),
    batchId: null, ticket: null, errorMessage: JSON.stringify({ version: 1, eventId, correlationId: randomUUID() }) };
  const credentials = { revision: 4, certificateFingerprint: metadata.fingerprint, certificateCipher: 'FICTITIOUS_IN_MEMORY',
    solUsernameCipher: 'FICTITIOUS_IN_MEMORY', solPasswordCipher: 'FICTITIOUS_IN_MEMORY',
    certificatePasswordCipher: 'FICTITIOUS_IN_MEMORY', certificateSelfSigned: false, certificateExpiresAt: metadata.expiresAt };
  let batch: any;
  const docs = new Map(), batches = new Map(), events: any[] = [];
  function artifacts(map: Map<string, any>, key: string) { return {
    findUnique: vi.fn(async ({ where }: any) => map.get(where[key].kind) ?? null),
    upsert: vi.fn(async ({ where, create }: any) => { const kind = where[key].kind; if (!map.has(kind)) map.set(kind, create); return map.get(kind); }),
  }; }
  const prisma: any = {
    $executeRawUnsafe: vi.fn(async () => 1), $queryRawUnsafe: vi.fn(async () => [{ maximum: 7 }]),
    sunatCredentials: { findUnique: vi.fn(async () => credentials) },
    sunatSubmission: {
      findFirst: vi.fn(async ({ where }: any) => submission.errorCode === where.errorCode && submission.result === 'PENDING' &&
        submission.startedAt.getTime() === where.startedAt.getTime() && submission.attempt === where.attempt &&
        submission.nextRetryAt > new Date() ? { id: row.id } : null),
      findUnique: vi.fn(async () => ({ ...submission, document })), findUniqueOrThrow: vi.fn(async () => ({ ...submission })),
      update: vi.fn(async ({ data }: any) => Object.assign(submission, data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const phases = where.errorCode?.in ?? [where.errorCode];
        if (where.id && where.id !== row.id || where.errorCode && !phases.includes(submission.errorCode) ||
            where.startedAt && where.startedAt.getTime() !== submission.startedAt.getTime() ||
            where.attempt && where.attempt !== submission.attempt || where.result && where.result !== submission.result) return { count: 0 };
        Object.assign(submission, { ...data, ...(data.attempt?.increment ? { attempt: submission.attempt + data.attempt.increment } : {}) }); return { count: 1 };
      }),
    },
    fiscalDocument: { findUnique: vi.fn(async () => document), update: vi.fn(async ({ data }: any) => Object.assign(document, data)) },
    fiscalBatch: { findUnique: vi.fn(async () => batch), create: vi.fn(async ({ data }: any) => batch = { ...data, id: batchId }),
      update: vi.fn(async ({ data }: any) => Object.assign(batch, data)) },
    documentArtifact: artifacts(docs, 'documentId_kind'), batchArtifact: artifacts(batches, 'batchId_kind'),
    cdrLog: { create: vi.fn(async () => ({})) }, outboxEvent: { create: vi.fn(async ({ data }: any) => events.push(data.payload)) },
  };
  prisma.$transaction = async (run: any) => run(prisma);
  const repository = new ProductionIssuanceRepository(prisma), store = new ArtifactStore(directory);
  const opened: Buffer[] = [];
  const vault = { open: vi.fn((_cipher: string, aad: any) => { const bytes = Buffer.from(aad.field === 'certificate' ? pki.issuer.pkcs12 : Buffer.from(pki.password)); opened.push(bytes); return bytes; }) };
  const inspection = { inspect: vi.fn(async () => structuredClone(metadata)) };
  const trust = { evaluate: vi.fn(async (_meta: any, _ruc: string, now = new Date()) => ({ profile: 'OFFLINE-PINNED-ROOTS-CRL-v1',
    chainValid: true, identityMatched: true, revocation: 'VERIFIED_OFFLINE_CRL', certificateFingerprint: metadata.fingerprint,
    checkedAt: now.toISOString(), trustStoreSha256: hash(pki.rootPem), blockers: [] })) };
  const signer = { prepare: vi.fn(async (s: FiscalDocumentSnapshot, bytes: Buffer, password: string, rc?: string) => prepareBetaXml(s, bytes, password, rc)) };
  const xsd = { validate: vi.fn(async (xml: string | Buffer) => ({ xmlSha256: hash(xml) })) };
  const policy = { assertCurrent: vi.fn(async () => {}) };
  const service: any = new ProductionIssuanceService(prisma, repository, store, vault as never, inspection as never, trust as never,
    signer as never, xsd as never, pki.cdrVerifier as never, policy as never);
  const signedCdr = pki.signCdr(guideSidecarCdrXml({ issuerRuc: RUC, fullNumber: identifier, documentType: 'RC' } as any));
  const cdrZip = Buffer.from(zipSync({ ['R-' + RUC + '-' + identifier + '.xml']: Buffer.from(signedCdr) }));
  const adapter = { submit: vi.fn(async () => { throw Error('SENDBILL_FORBIDDEN'); }), submitSummary: vi.fn(async () => 'FICTITIOUS_RC_TICKET'),
    getStatus: vi.fn(async () => ({ kind: 'CDR', cdrZip })) };
  const savedAdapter = service.adapter.bind(service);
  service.adapter = vi.fn(async () => adapter);
  return { snapshot, row, document, submission, credentials, prisma, repository, store, signer, service, opened, adapter, savedAdapter, policy,
    events, docs, batches, batch: () => batch, prepare: () => service.prepare(row) };
}

describe('Production 03, registered service/repository with real local archives', () => {
  it('reserves RC with production locks and exact snapshot; repeat reuses the same identifier without consuming Billing counters', async () => {
    const f = await fixture(); expect(await f.repository.reserveSummary(f.row)).toBe(identifier);
    expect(await f.repository.reserveSummary(f.row)).toBe(identifier);
    expect(f.batch().immutablePayload).toEqual(buildReceiptSummarySnapshot(f.snapshot, identifier));
    expect(f.batch().immutablePayload.environment).toBe('PRODUCTION');
    expect(f.prisma.$executeRawUnsafe.mock.calls.map((call: any) => call[1])).toEqual([RUC + ':PRODUCTION:supplement', RUC + ':PRODUCTION:RC', RUC + ':PRODUCTION:supplement', RUC + ':PRODUCTION:RC']);
    expect(f.prisma.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('"environment"::text=$2'), RUC, 'PRODUCTION', expect.stringContaining('^RC-'));
    expect(f.prisma.fiscalBatch.create).toHaveBeenCalledOnce();
  });
  it('archives both signatures with the same public signer, separate member ZIP and exact RC ZIP', async () => {
    const f = await fixture(), prepared = await f.prepare(), manifest = f.service.manifests.get(f.row.id);
    await f.repository.savePrepared(f.row, manifest);
    const exact = await f.service.archived(f.row); expect(exact.zip).toEqual(prepared.zip);
    expect(manifest.documentSnapshotSha256).toBe(fiscalSnapshotSha256(f.snapshot));
    expect(manifest.requestOwnerId).not.toBe(f.row.documentId); expect(manifest.individualXmlZip.sha256).not.toBe(manifest.zip.sha256);
    const memberXml = await f.store.read(f.row.documentId, manifest.documentXml), requestXml = await f.store.read(manifest.requestOwnerId, manifest.xml);
    expect(verifyLocalSignedInvoice(memberXml.toString(), metadata.certificatePem, buildInvoiceUbl(f.snapshot, { mode: 'REAL_PREPARATION' }))).toBe(manifest.digest);
    expect(() => verifyLocalSignedInvoice(requestXml.toString(), metadata.certificatePem, buildReceiptSummary(f.snapshot, identifier, 'REAL_PREPARATION'), 'SummaryDocuments')).not.toThrow();
    expect(await new PublicSignerArchive(directory).load(RUC, metadata.fingerprint)).toBeDefined();
    expect(f.docs.get('SUBMISSION_ZIP').sha256).toBe(manifest.individualXmlZip.sha256); // Production document owns its individual ZIP; batch owns the submitted RC.
    expect(f.opened.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  });
  it('validates signed individual 03 and signed RC against local official XSDs without network', async () => {
    const f = await fixture(); await f.prepare(); const manifest = f.service.manifests.get(f.row.id);
    const xml = await f.store.read(f.row.documentId, manifest.documentXml), summary = await f.store.read(manifest.requestOwnerId, manifest.xml);
    const code = [
      'import json,sys', 'from pathlib import Path', "sys.path.insert(0,str(Path.cwd()/'tests'))",
      "from runpy import run_path; helpers=run_path('tests/validate-official-xsd.py'); parser=helpers['parser']; xml_root=helpers['xml_root']; bounded=helpers['bounded']", 'from lxml import etree',
      "root=Path('tmp/sunat-schema/ubl21-browser/Archivos XSD').resolve(strict=True)", 'data=json.load(sys.stdin)',
      "for key,rel in [('xml','2.1/maindoc/UBL-Invoice-2.1.xsd'),('summary','2.0/maindoc/UBLPE-SummaryDocuments-1.0.xsd')]:",
      ' schema=etree.XMLSchema(etree.parse(str(bounded(root/rel,root)),parser(root)))', " schema.assertValid(xml_root(data[key].encode('utf-8')))",
    ].join('\n');
    const result = spawnSync('python', ['-c', code], { cwd: resolve('.'), input: JSON.stringify({ xml: xml.toString(), summary: summary.toString() }), encoding: 'utf8', timeout: 15000 });
    expect(result.error).toBeUndefined(); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
  });
  it.each(['request-amount', 'request-extra-line', 'request-signer', 'document-signer'])('refuses mismatching %s before publishing public chain or prepared artifacts', async change => {
    const f = await fixture(); const original = f.signer.prepare.getMockImplementation()!;
    f.signer.prepare.mockImplementation(async (...args: any[]) => {
      const value = await (original as any)(...args), signer = new XmlSignerService();
      if (change === 'document-signer') value.document = { ...signer.sign(buildInvoiceUbl(f.snapshot, { mode: 'REAL_PREPARATION' }), pki.otherIssuer.pkcs12, pki.password), certificateFingerprintSha256: metadata.fingerprint };
      else {
        let unsigned = buildReceiptSummary(f.snapshot, identifier, 'REAL_PREPARATION');
        if (change === 'request-amount') unsigned = unsigned.replace('>1.18</sac:TotalAmount>', '>9.99</sac:TotalAmount>');
        if (change === 'request-extra-line') unsigned = unsigned.replace('</SummaryDocuments>', unsigned.match(/<sac:SummaryDocumentsLine>[\s\S]*?<\/sac:SummaryDocumentsLine>/)![0] + '</SummaryDocuments>');
        value.request = { ...signer.sign(unsigned, change === 'request-signer' ? pki.otherIssuer.pkcs12 : pki.issuer.pkcs12, pki.password, 'SummaryDocuments'), certificateFingerprintSha256: metadata.fingerprint };
      }
      return value;
    });
    await expect(f.prepare()).rejects.toThrow(); expect(f.service.manifests.size).toBe(0);
    await expect(new PublicSignerArchive(directory).load(RUC, metadata.fingerprint)).rejects.toThrow();
  });
  it.each(['request-xml', 'request-zip', 'document-rc-copy', 'individual-xml', 'individual-zip'])('physical alteration of %s blocks recovery', async change => {
    const f = await fixture(); await f.prepare(); const m = f.service.manifests.get(f.row.id); await f.repository.savePrepared(f.row, m);
    const stored = change === 'request-xml' ? m.xml : change === 'request-zip' ? m.zip : change === 'document-rc-copy' ? m.documentZip : change === 'individual-xml' ? m.documentXml : m.individualXmlZip;
    const path = join(directory, stored.storageKey), before = await readFile(path); before[before.length - 1] ^= 1; await writeFile(path, before);
    await expect(f.service.archived(f.row)).rejects.toThrow('Integridad'); expect(f.adapter.submitSummary).not.toHaveBeenCalled();
  });
  it('requires exact immutable batch metadata on repeated reservation and recovery', async () => {
    const f = await fixture(); await f.prepare(); const m = f.service.manifests.get(f.row.id); await f.repository.savePrepared(f.row, m);
    f.submission.errorCode = 'PREPARING';
    f.batch().immutablePayload.input.entries[0].document.snapshot.customer.legalName = 'DIFFERENT MEMBER';
    await expect(f.repository.reserveSummary(f.row)).rejects.toThrow(); await expect(f.service.archived(f.row)).rejects.toThrow('exactamente');
  });
  it('real process sends one RC, polls its archived ticket and emits final evidence accepted against Billing snapshot', async () => {
    const f = await fixture(); f.submission.errorCode = 'AWAITING_AUTHORIZATION'; f.submission.nextRetryAt = new Date(0);
    await f.service.process(f.row.id); expect(f.submission.errorCode).toBe('WAITING_TICKET'); expect(f.adapter.submitSummary).toHaveBeenCalledOnce();
    f.submission.nextRetryAt = new Date(0); await f.service.process(f.row.id);
    expect(f.submission.errorCode).toBe('DONE'); expect(f.adapter.getStatus).toHaveBeenCalledExactlyOnceWith('FICTITIOUS_RC_TICKET');
    expect(f.adapter.submit).not.toHaveBeenCalled(); expect(f.adapter.submitSummary).toHaveBeenCalledOnce();
    const event = f.events.at(-1); expect(event.payload.documentTypeCode).toBe('03');
    expect(event.payload.evidence).toMatchObject({ cdrScope: 'RECEIPT_SUMMARY', summaryIdentifier: identifier, documentSnapshotSha256: fiscalSnapshotSha256(f.snapshot) });
    expect(() => assertProductionStatusProjection(event, f.snapshot)).not.toThrow();
    expect(f.batch().status).toBe('ACCEPTED'); expect(f.document.status).toBe('ACCEPTED');
    const other = structuredClone(f.snapshot); other.customer.legalName = 'OTHER BILLING SNAPSHOT';
    expect(() => assertProductionStatusProjection(event, other)).toThrow('Billing');
  });
  it('cannot project a trusted individual CDR as a 03 result', async () => {
    const f = await fixture(); await f.prepare(); const m = f.service.manifests.get(f.row.id); await f.repository.savePrepared(f.row, m);
    f.submission.errorCode = 'POLLING';
    await expect(f.repository.transition(f.row, 'POLLING', 'DONE', { cdr: { trusted: true, status: 'ACCEPTED', code: '0', description: 'INDIVIDUAL IS NOT RC', notes: [] } })).rejects.toThrow('vínculo exacto');
    expect(f.events).toHaveLength(0); expect(f.document.status).toBe('BUILDING');
  });
  it('a lost sendSummary response remains UNKNOWN and process never reposts', async () => {
    const f = await fixture(); f.submission.errorCode = 'AWAITING_AUTHORIZATION'; f.submission.nextRetryAt = new Date(0);
    f.adapter.submitSummary.mockRejectedValueOnce(Error('LOST_RESPONSE'));
    await f.service.process(f.row.id); expect(f.submission.errorCode).toBe('UNKNOWN');
    await f.service.process(f.row.id); expect(f.adapter.submitSummary).toHaveBeenCalledOnce(); expect(f.adapter.getStatus).not.toHaveBeenCalled();
  });
  it('the registered production adapter grants sendSummary/getStatus only and rechecks policy before either call', async () => {
    const f = await fixture(); await f.prepare(); await f.repository.savePrepared(f.row, f.service.manifests.get(f.row.id));
    const factory = vi.spyOn(soapAuthority, 'createProductionSoapAuthorization');
    await f.savedAdapter(f.row); expect(factory).toHaveBeenCalledOnce();
    const cap = factory.mock.results[0].value;
    expect(factory.mock.calls[0][0]).toEqual({ ruc: RUC, operations: ['sendSummary', 'getStatus'] });
    await expect(soapAuthority.assertProductionSoapAuthorized(cap, RUC, 'sendBill')).rejects.toThrow();
    await expect(soapAuthority.assertProductionSoapAuthorized(cap, RUC, 'sendSummary')).resolves.toBeUndefined();
    await expect(soapAuthority.assertProductionSoapAuthorized(cap, RUC, 'getStatus')).resolves.toBeUndefined();
    f.policy.assertCurrent.mockRejectedValue(Error('REVOKED'));
    await expect(soapAuthority.assertProductionSoapAuthorized(cap, RUC, 'getStatus')).rejects.toThrow();
    await expect(soapAuthority.assertProductionSoapAuthorized(cap, '20131312955', 'sendSummary')).rejects.toThrow();
  });
  it('only expands the profile CHECK in the unapplied SQL, preserving all existing grants and counters', async () => {
    const sql = await readFile('services/sunat-service/prisma/production-receipt-profile-expand.sql', 'utf8');
    expect(sql).toContain("'01-PEN-0101-IGV18-v1', '01-03-PEN-0101-IGV18-v2'");
    expect(sql).toContain('pg_advisory_xact_lock'); expect(sql).toContain("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s'"); expect(sql).toContain("existing.contype <> 'c'");
    expect(sql).toContain('existing.conkey IS DISTINCT FROM'); expect(sql).toContain('RETURN; -- Already installed');
    expect(sql).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|TRUNCATE|ADD\s+COLUMN)\b/i);
  });
  it.each(['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'] as const)('03 final %s requires every RC identity/hash and the exact Billing snapshot', status => {
    const document = receipt();
    const event: ProductionStatusEvent = { eventId: randomUUID(), eventName: EventNames.sunatStatusChanged, producer: 'sunat-service', occurredAt: NOW.toISOString(), correlationId: randomUUID(),
      payload: { documentId: document.documentId, status, environment: 'PRODUCTION', provenance: 'SUNAT_PRODUCTION', documentTypeCode: '03',
        evidence: { transport: 'SUNAT_PRODUCTION', environment: 'PRODUCTION', issuerRuc: RUC, submissionId: randomUUID(), officialCdr: true, cdrSignatureVerified: true,
          cdrScope: 'RECEIPT_SUMMARY', summaryIdentifier: identifier, summaryXmlSha256: 'a'.repeat(64), summaryZipSha256: 'b'.repeat(64), documentSnapshotSha256: fiscalSnapshotSha256(document) } } };
    expect(() => assertProductionStatusProjection(event, document)).not.toThrow();
    for (const field of ['cdrScope', 'summaryIdentifier', 'summaryXmlSha256', 'summaryZipSha256', 'documentSnapshotSha256']) {
      const bad = structuredClone(event); delete (bad.payload.evidence as any)[field];
      expect(() => assertProductionStatusProjection(bad, document)).toThrow('CDR RC');
    }
    const changed = structuredClone(document); changed.lines[0].description = 'OTHER LINE IN BILLING';
    expect(() => assertProductionStatusProjection(event, changed)).toThrow('Billing');
    for (const field of ['officialCdr', 'cdrSignatureVerified']) {
      const bad = structuredClone(event); (bad.payload.evidence as any)[field] = false;
      expect(() => assertProductionStatusProjection(bad, document)).toThrow('CDR oficial');
    }
  });
  it('archive reconstruction is deterministic a year later without moving any trust or issuance clock', () => {
    const s = receipt(), asOf = receiptSummaryReconstructionAsOf(identifier);
    const expected = buildReceiptSummarySnapshot(s, identifier, asOf), xml = buildReceiptSummary(s, identifier, 'REAL_PREPARATION', asOf);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW.getTime() + 366 * 86400000));
    expect(buildReceiptSummarySnapshot(s, identifier, asOf)).toEqual(expected);
    expect(buildReceiptSummary(s, identifier, 'REAL_PREPARATION', asOf)).toBe(xml);
    expect(Date.now()).toBe(NOW.getTime() + 366 * 86400000);
    expect(receiptSummaryReconstructionAsOf('RC-20261028-1')).toBe('2026-10-28T23:59:59.999-05:00');
    expect(() => receiptSummaryReconstructionAsOf('RC-20260230-1')).toThrow();
    const expiredWindow = 'RC-' + limaIssueDate(new Date(NOW.getTime() + 9 * 86400000).toISOString()).replaceAll('-', '') + '-1';
    expect(() => buildReceiptSummarySnapshot(s, expiredWindow)).toThrow('7 días');
  });
  it('canonical contract hash matches sunat-core for Unicode, omitted optionals and reordered object keys', () => {
    const s = receipt(); s.customer.legalName = 'FICTICIO & á漢字';
    expect(productionDocumentSnapshotSha256(s)).toBe(fiscalSnapshotSha256(s));
    expect(productionDocumentSnapshotSha256({ ...s, customer: { ...s.customer, address: undefined } })).toBe(fiscalSnapshotSha256(s));
  });
});
