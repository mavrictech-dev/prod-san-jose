import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { X509Certificate, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src';
import { assertFiscalSnapshot, buildInvoiceUbl, validateFiscalSnapshot } from '../packages/sunat-core/src';
import { renderLocalDocumentPdf, renderProductionInvoicePdf, type ProductionPdfEvidence } from '../packages/pdf-renderer/src';
import { ArtifactDeliveryService } from '../services/sunat-service/src/application/artifact-delivery.service';
import { ProductionPdfService } from '../services/sunat-service/src/application/production-pdf.service';
import { CurrentPdfService } from '../services/sunat-service/src/application/current-pdf.service';
import { CertificateTrustService } from '../services/sunat-service/src/infrastructure/crypto/certificate-trust.service';
import { CdrSignatureTrustService } from '../services/sunat-service/src/infrastructure/crypto/cdr-signature-trust.service';
import { PublicSignerArchive } from '../services/sunat-service/src/infrastructure/crypto/public-signer-archive';
import { inspectCertificate } from '../services/sunat-service/src/infrastructure/crypto/certificate-inspector';
import { XmlSignerService, verifyLocalSignedInvoice } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import { createGuideSidecarPki, guideSidecarCdrXml, guideSidecarPackCdr, guideSidecarHash as hash } from './helpers/guide-sidecar-ephemeral-pki.fixture';
import { documentSample } from './qa-print-formats.mjs';
import PDFDocument from '../packages/pdf-renderer/node_modules/pdfkit';
import QRCode from '../packages/pdf-renderer/node_modules/qrcode';

// Consume source without rebuilding dist or changing module wiring/gates.
vi.mock('@factuez/pdf-renderer', async () => await import('../packages/pdf-renderer/src'));
const req = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const forge: typeof import('node-forge') = req('node-forge');
const { PNG } = createRequire(import.meta.url)('pngjs');
const decodeQr = createRequire(import.meta.url)('jsqr');
const token = 'Bearer FICTITIOUS.PDF', branchId = '20000000-0000-4000-8000-000000000001';
let pki: ReturnType<typeof createGuideSidecarPki>, directory: string;
let snapshot: FiscalDocumentSnapshot, signed: ReturnType<XmlSignerService['sign']>;
let production: ProductionPdfService, visuals: CurrentPdfService, delivery: ArtifactDeliveryService;
let row: any, db: any, store: any, draw: any, fetcher: any, trust: CertificateTrustService, evaluate: any, certificates: any;

beforeAll(async () => {
  pki = createGuideSidecarPki();
  directory = await mkdtemp(join(tmpdir(), 'factuez-production-pdf-unit-'));
  await writeFile(join(directory, 'fictitious-cdr-public.pem'), pki.sunat.certificatePem + pki.rootPem, { flag: 'wx' });
}, 30000);
afterAll(async () => {
  pki.issuer.pkcs12.fill(0); pki.otherIssuer.pkcs12.fill(0); pki.sunat.pkcs12.fill(0);
  if (directory && directory.startsWith(join(tmpdir(), 'factuez-production-pdf-unit-'))) await rm(directory, { recursive: true, force: true });
});
function add(kind: string, bytes: Buffer) {
  row.artifacts = row.artifacts.filter((a: any) => a.kind !== kind);
  const artifact = { documentId: snapshot.documentId, kind, storageKey: `${snapshot.documentId}/${kind}`, sha256: hash(bytes),
    sizeBytes: BigInt(bytes.length), mediaType: kind === 'CDR_ZIP' ? 'application/zip' : 'application/xml' };
  row.artifacts.push(artifact); store.bytes.set(artifact.storageKey, Buffer.from(bytes));
}
function cdr(code = '0', edit: (xml: string) => string = s => s, notes = false) {
  const expected = { issuerRuc: snapshot.issuer.identityNumber, documentType: '01', fullNumber: snapshot.fullNumber } as any;
  let xml = guideSidecarCdrXml(expected, code);
  if (notes) xml = xml.replace('<cac:SenderParty>', '<cbc:Note>FICTITIOUS OBSERVATION</cbc:Note><cac:SenderParty>');
  const signedCdr = pki.signCdr(edit(xml));
  add('CDR_XML', Buffer.from(signedCdr)); add('CDR_ZIP', guideSidecarPackCdr(signedCdr, expected));
}
const download = (format = 'a4') => delivery.download(snapshot.documentId, format, token);
function evidence(status: ProductionPdfEvidence['status'] = 'ACCEPTED'): ProductionPdfEvidence {
  return { environment: 'PRODUCTION', status, digestValue: signed.digestValue,
    ...(status === 'PENDING' ? {} : { responseCode: status === 'REJECTED' ? '2335' : '0', cdrDescription: 'FICTITIOUS LOCAL RECEIPT', cdrNotes: status === 'ACCEPTED_WITH_OBSERVATIONS' ? ['FICTITIOUS OBSERVATION'] : [] }),
    qrPayload: [snapshot.issuer.identityNumber, '01', snapshot.series, snapshot.number, snapshot.totals.igvAmount,
      snapshot.totals.payableAmount, '2026-10-01', snapshot.customer.identityType, snapshot.customer.identityNumber, signed.digestValue].join('|') + '|' };
}
beforeEach(() => {
  vi.stubEnv('PRINT_SETTINGS_ENABLED', 'false');
  for (const name of ['SUNAT_TRUST_STORE_FILE', 'SUNAT_TRUST_STORE_SHA256', 'SUNAT_CRL_BUNDLE_FILE', 'SUNAT_CRL_BUNDLE_SHA256', 'SUNAT_OPENSSL_PATH']) vi.stubEnv(name, '');
  vi.stubEnv('SUNAT_CDR_SIGNER_CERT_FILE', join(directory, 'fictitious-cdr-public.pem'));
  vi.stubEnv('SUNAT_CDR_SIGNER_CERT_SHA256', hash(pki.sunat.certificatePem + pki.rootPem));
  snapshot = documentSample('01') as FiscalDocumentSnapshot;
  Object.assign(snapshot, { environment: 'PRODUCTION', branchId });
  Object.assign(snapshot.issuer, { identityNumber: '20100070970', establishmentCode: '0000' });
  snapshot.customer.identityNumber = '20131312955';
  Object.assign(snapshot.printPresentation!, { issuerRuc: snapshot.issuer.identityNumber, branchId,
    branchName: 'SEDE HISTÓRICA', branchAddress: 'DIRECCIÓN HISTÓRICA' });
  assertFiscalSnapshot(snapshot, { mode: 'REAL_PREPARATION' });
  signed = new XmlSignerService().sign(buildInvoiceUbl(snapshot, { mode: 'REAL_PREPARATION' }), pki.issuer.pkcs12, pki.password);
  row = { documentId: snapshot.documentId, issuerRuc: snapshot.issuer.identityNumber, documentType: '01', series: snapshot.series,
    number: 1n, environment: 'PRODUCTION', status: 'ACCEPTED', digestValue: signed.digestValue,
    immutablePayload: structuredClone(snapshot), acceptedAt: new Date(), artifacts: [] };
  db = { fiscalDocument: { findUnique: vi.fn(async () => structuredClone(row)) } };
  store = { bytes: new Map<string, Buffer>(), read: vi.fn(async (_id: string, a: any) => Buffer.from(store.bytes.get(a.storageKey))) };
  add('SIGNED_XML', Buffer.from(signed.xml)); cdr();
  trust = new CertificateTrustService();
  // Unit policy port: genuine ephemeral chain verification, CRL result is an explicit double.
  // Actual production code uses CertificateTrustService's pinned offline OpenSSL/CRL verifier.
  evaluate = vi.spyOn(trust, 'evaluate').mockImplementation(async (metadata, ruc, now = new Date()) => {
    forge.pki.verifyCertificateChain(forge.pki.createCaStore([pki.rootPem]), [forge.pki.certificateFromPem(metadata.certificatePem)]);
    return { profile: 'OFFLINE-PINNED-ROOTS-CRL-v1', chainValid: true, identityMatched: metadata.subjectRucCandidates[0] === ruc,
      revocation: 'VERIFIED_OFFLINE_CRL', trustStoreSha256: hash(pki.rootPem), certificateFingerprint: metadata.fingerprint,
      checkedAt: now.toISOString(), blockers: [] };
  });
  certificates = { load: vi.fn(async (ruc: string, fingerprint: string) => {
    if (ruc !== snapshot.issuer.identityNumber || fingerprint !== pki.issuer.fingerprint) throw new Error('PUBLIC_PIN_MISSING');
    return { certificatePem: pki.issuer.certificatePem, chainPems: pki.issuer.chainPems };
  }) };
  visuals = new CurrentPdfService();
  draw = vi.fn(async (s, format, proof) => Buffer.from('%PDF-' + JSON.stringify({ s, format, proof })));
  production = new ProductionPdfService(db, store, visuals, trust, new CdrSignatureTrustService(trust), certificates, draw);
  delivery = new ArtifactDeliveryService(db, store, visuals, production);
  fetcher = vi.fn(async (url: string) => {
    if (!url.includes('/api/v1/documents/')) throw new Error('UNEXPECTED_NETWORK');
    return Response.json({ id: snapshot.documentId, companyId: 1, immutableSnapshot: snapshot });
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { production.onModuleDestroy(); visuals.onModuleDestroy(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('production PDF delivery: authorized exact snapshot and original cryptographic evidence', () => {
  it('authorizes before owner read and validates originals before every cache hit; no writes or SUNAT access', async () => {
    const before = structuredClone(row), source = structuredClone(snapshot);
    const first = await download(), second = await download();
    expect(first).toEqual(second); expect(first.fileName).toBe('20100070970-01-FQ00-1-a4-PRODUCCION.pdf');
    expect(fetcher).toHaveBeenCalledTimes(2); expect(db.fiscalDocument.findUnique).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.invocationCallOrder[0]).toBeLessThan(db.fiscalDocument.findUnique.mock.invocationCallOrder[0]);
    expect(store.read).toHaveBeenCalledTimes(6); expect(evaluate).toHaveBeenCalledTimes(4); expect(draw).toHaveBeenCalledOnce();
    expect(draw.mock.calls[0][2]).toEqual(evidence()); expect(row).toEqual(before); expect(snapshot).toEqual(source);
    expect(Object.keys(db)).toEqual(['fiscalDocument']); expect(fetcher.mock.calls.every(([url]: any[]) => url.includes('/api/v1/documents/'))).toBe(true);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: { Authorization: token, 'Cache-Control': 'no-store' }, redirect: 'error' });
  });
  it.each([401, 403, 404, 500])('authorization %i blocks an existing cache hit before owner/artifact access', async status => {
    await download(); db.fiscalDocument.findUnique.mockClear(); store.read.mockClear(); evaluate.mockClear();
    fetcher.mockResolvedValue(Response.json({ accepted: true }, { status }));
    await expect(download()).rejects.toMatchObject({ status: status === 500 ? 503 : status });
    expect(db.fiscalDocument.findUnique).not.toHaveBeenCalled(); expect(store.read).not.toHaveBeenCalled(); expect(evaluate).not.toHaveBeenCalled(); expect(draw).toHaveBeenCalledOnce();
  });
  it('does not treat an HTTP acceptance boolean or Billing status as fiscal evidence', async () => {
    fetcher.mockResolvedValue(Response.json({ id: snapshot.documentId, immutableSnapshot: snapshot, accepted: true, status: 'ACCEPTED', officialCdr: true }));
    row.artifacts = row.artifacts.filter((a: any) => a.kind !== 'CDR_XML');
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['issuerRuc', 'environment', 'series', 'number', 'documentType', 'documentId', 'immutablePayload', 'missing'])('rejects own SUNAT mismatch: %s', async key => {
    if (key === 'missing') db.fiscalDocument.findUnique.mockResolvedValue(null);
    else row[key] = key === 'number' ? 2n : key === 'immutablePayload' ? { ...snapshot, customer: { ...snapshot.customer, legalName: 'CHANGED' } } : 'OTHER';
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(store.read).not.toHaveBeenCalled(); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['03', '07', '08', 'USD', 'missing-environment'])('fails closed outside production 01/PEN: %s', async change => {
    if (change === 'USD') snapshot.currencyCode = 'USD'; else if (change === 'missing-environment') delete snapshot.environment;
    else snapshot.documentTypeCode = change as any;
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['SIGNED_XML', 'CDR_XML', 'CDR_ZIP'])('requires %s after final acceptance', async kind => {
    row.artifacts = row.artifacts.filter((a: any) => a.kind !== kind);
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['SIGNED_XML', 'CDR_XML', 'CDR_ZIP'])('rechecks %s original integrity even after a cache hit', async kind => {
    await download(); const a = row.artifacts.find((a: any) => a.kind === kind); store.bytes.set(a.storageKey, Buffer.from('TAMPERED'));
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(draw).toHaveBeenCalledOnce();
  });
  it.each(['documentId', 'sha256', 'sizeBytes', 'mediaType', 'duplicate'])('rejects bad original metadata: %s', async key => {
    const a = row.artifacts[0]; if (key === 'duplicate') row.artifacts.push({ ...a });
    else a[key] = key === 'sizeBytes' ? 0n : 'INVALID';
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it('rejects signed XML different from the immutable snapshot even with updated original SHA and digest', async () => {
    const other = structuredClone(snapshot); other.customer.legalName = 'OTHER FICTITIOUS CUSTOMER';
    const changed = new XmlSignerService().sign(buildInvoiceUbl(other, { mode: 'REAL_PREPARATION' }), pki.issuer.pkcs12, pki.password);
    add('SIGNED_XML', Buffer.from(changed.xml)); row.digestValue = changed.digestValue;
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['signature', 'digest', 'identity', 'pin'])('rejects issuer %s mismatch', async kind => {
    if (kind === 'digest') row.digestValue = 'a'.repeat(43) + '=';
    if (kind === 'signature') add('SIGNED_XML', Buffer.from(signed.xml.replace('39.19', '39.18')));
    if (kind === 'identity') {
      const changed = new XmlSignerService().sign(buildInvoiceUbl(snapshot, { mode: 'REAL_PREPARATION' }), pki.otherIssuer.pkcs12, pki.password);
      certificates.load.mockResolvedValue({ certificatePem: pki.otherIssuer.certificatePem, chainPems: pki.otherIssuer.chainPems });
      add('SIGNED_XML', Buffer.from(changed.xml));
    }
    if (kind === 'pin') certificates.load.mockRejectedValue(new Error('UNPINNED'));
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each([{ chainValid: false }, { identityMatched: false }, { revocation: 'PENDING' }, { revocation: 'INVALID' },
    { blockers: ['REVOKED'] }, { certificateFingerprint: '0'.repeat(64) }, { trustStoreSha256: null }, { profile: 'OTHER' }])(
    'never reuses cache after issuer trust/CRL degradation %j', async delta => {
      await download(); const baseline = await evaluate.mock.results[0].value;
      evaluate.mockResolvedValue({ ...baseline, ...delta });
      await expect(download()).rejects.toMatchObject({ status: 409 }); expect(draw).toHaveBeenCalledOnce();
    });
  it('actual unconfigured CertificateTrustService refuses the fictitious chain without touching private material', async () => {
    evaluate.mockRestore();
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['receiver', 'reference', 'type', 'response-reference', 'signature', 'zip-xml', 'state', 'crc'])('rejects CDR %s mismatch', async change => {
    if (change === 'receiver') cdr('0', xml => xml.replace(`<cbc:ID>${snapshot.issuer.identityNumber}</cbc:ID>`, '<cbc:ID>20131312955</cbc:ID>'));
    if (change === 'reference') cdr('0', xml => xml.replaceAll(snapshot.fullNumber, 'FQ00-2'));
    if (change === 'type') cdr('0', xml => xml.replace('<cbc:DocumentTypeCode>01', '<cbc:DocumentTypeCode>03'));
    if (change === 'response-reference') cdr('0', xml => xml.replace(`<cbc:ReferenceID>${snapshot.fullNumber}`, '<cbc:ReferenceID>FQ00-2'));
    if (change === 'state') cdr('2335');
    if (change === 'zip-xml') cdr('0', xml => xml.replace('FICTITIOUS LOCAL RECEIPT', 'OTHER RECEIPT'));
    if (change === 'zip-xml') { const a = row.artifacts.find((a: any) => a.kind === 'CDR_ZIP'); const b = Buffer.from(store.bytes.get(a.storageKey)); cdr(); add('CDR_ZIP', b); }
    if (change === 'signature') { const a = row.artifacts.find((a: any) => a.kind === 'CDR_XML'); const b = store.bytes.get(a.storageKey).toString().replace('FICTITIOUS LOCAL RECEIPT', 'TAMPERED'); add('CDR_XML', Buffer.from(b)); add('CDR_ZIP', guideSidecarPackCdr(b, { issuerRuc: snapshot.issuer.identityNumber, documentType: '01', fullNumber: snapshot.fullNumber } as any)); }
    if (change === 'crc') { const a = row.artifacts.find((a: any) => a.kind === 'CDR_ZIP'); const b = Buffer.from(store.bytes.get(a.storageKey)); b[14] ^= 1; add('CDR_ZIP', b); }
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it('requires the externally pinned CDR signer even if the CDR carries a valid signature', async () => {
    vi.stubEnv('SUNAT_CDR_SIGNER_CERT_SHA256', '0'.repeat(64));
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['SUBMITTED', 'SIGNED', 'QUEUED', 'RETRYABLE_ERROR', 'PERMANENT_ERROR'])('shows %s as pending without inventing acceptance or CDR', async status => {
    row.status = status; row.acceptedAt = null; row.artifacts = row.artifacts.filter((a: any) => a.kind === 'SIGNED_XML');
    await download(); expect(draw.mock.calls[0][2]).toEqual(evidence('PENDING'));
  });
  it.each(['cdr-before-final', 'acceptedAt-before-final'])('requires reconciliation for %s', async reason => {
    row.status = 'SUBMITTED';
    if (reason === 'cdr-before-final') row.acceptedAt = null;
    else row.artifacts = row.artifacts.filter((a: any) => a.kind === 'SIGNED_XML');
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it('does not pretend an unsigned preparation has a fiscal QR', async () => {
    row.status = 'QUEUED'; row.acceptedAt = null; row.artifacts = [];
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it('marks rejected and observed documents from their own verified original CDR', async () => {
    row.status = 'REJECTED'; row.acceptedAt = null; cdr('2335'); await download();
    expect(draw.mock.calls[0][2]).toEqual(evidence('REJECTED'));
    row.status = 'ACCEPTED_WITH_OBSERVATIONS'; cdr('0', s => s, true); await download();
    expect(draw.mock.calls[1][2]).toEqual(evidence('ACCEPTED_WITH_OBSERVATIONS'));
  });
  it('updates visual profile before hits and preserves all frozen fiscal facts and historical branch', async () => {
    vi.stubEnv('PRINT_SETTINGS_ENABLED', 'true');
    const profile = structuredClone(snapshot.printPresentation!); profile.profileRevision = 7; profile.branchName = 'CURRENT NAME'; profile.branchAddress = 'CURRENT ADDRESS';
    fetcher.mockImplementation(async (url: string) => url.includes('/print-settings/') ? Response.json(profile) : Response.json({ id: snapshot.documentId, immutableSnapshot: snapshot }));
    await download(); await download(); expect(draw).toHaveBeenCalledOnce();
    profile.settings.logoMode = 'NONE'; profile.profileRevision++; await download();
    expect(draw).toHaveBeenCalledTimes(2); const printable = draw.mock.calls[1][0];
    expect(printable).toMatchObject({ issuer: snapshot.issuer, customer: snapshot.customer, lines: snapshot.lines, totals: snapshot.totals,
      printPresentation: { profileRevision: 8, branchName: 'SEDE HISTÓRICA', branchAddress: 'DIRECCIÓN HISTÓRICA' } });
    await download('ticket'); expect(draw).toHaveBeenCalledTimes(3);
    fetcher.mockResolvedValue(Response.json({}, { status: 403 })); await expect(download()).rejects.toMatchObject({ status: 403 });
    expect(draw).toHaveBeenCalledTimes(3);
  });
  it('default resolver reads the automatically archived public chain without per-issuer pins or current P12', async () => {
    vi.stubEnv('ARTIFACTS_ROOT', join(directory, `automatic-${randomUUID()}`));
    const archive = new PublicSignerArchive();
    await archive.archive(snapshot.issuer.identityNumber, inspectCertificate(pki.issuer.pkcs12, pki.password));
    production.onModuleDestroy();
    production = new ProductionPdfService(db, store, visuals, trust, new CdrSignatureTrustService(trust), undefined, draw);
    delivery = new ArtifactDeliveryService(db, store, visuals, production);
    await download(); expect(draw).toHaveBeenCalledOnce(); expect(draw.mock.calls[0][2]).toEqual(evidence());
  });
  it('explicit historical limitation: a signer valid at issuance but expired NOW blocks even an existing PDF cache hit', async () => {
    const cert = new X509Certificate(pki.issuer.certificatePem), issuedAt = new Date();
    expect(issuedAt.getTime()).toBeGreaterThan(Date.parse(cert.validFrom));
    expect(issuedAt.getTime()).toBeLessThan(Date.parse(cert.validTo));
    snapshot.issueDate = issuedAt.toISOString(); row.immutablePayload = structuredClone(snapshot);
    signed = new XmlSignerService().sign(buildInvoiceUbl(snapshot, { mode: 'REAL_PREPARATION' }), pki.issuer.pkcs12, pki.password);
    row.digestValue = signed.digestValue; add('SIGNED_XML', Buffer.from(signed.xml));
    await download(); expect(draw).toHaveBeenCalledOnce(); evaluate.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.parse(cert.validTo) + 1000));
    // Fiscal snapshot has no "too old" cutoff. Cryptographic mathematics still verify.
    expect(validateFiscalSnapshot(snapshot, { mode: 'REAL_PREPARATION' }).valid).toBe(true);
    expect(verifyLocalSignedInvoice(signed.xml, pki.issuer.certificatePem, buildInvoiceUbl(snapshot, { mode: 'REAL_PREPARATION' }))).toBe(signed.digestValue);
    await expect(download()).rejects.toMatchObject({ status: 409 });
    expect(evaluate).not.toHaveBeenCalled(); expect(draw).toHaveBeenCalledOnce();
    // No fake historical PKI: archived PEM and a claimed issueDate cannot authorize an asOf bypass.
  });
  it('REAL_PREPARATION snapshot validation still uses the current clock and denies a future issueDate before any original read', async () => {
    snapshot.issueDate = new Date(Date.now() + 10 * 60 * 1000).toISOString(); row.immutablePayload = structuredClone(snapshot);
    const report = validateFiscalSnapshot(snapshot, { mode: 'REAL_PREPARATION' });
    expect(report.issues.some(issue => issue.code === 'FUTURE_DATE')).toBe(true);
    expect(validateFiscalSnapshot(snapshot, { mode: 'REAL_PREPARATION', now: new Date(snapshot.issueDate) }).valid).toBe(true);
    await expect(download()).rejects.toMatchObject({ status: 409 }); expect(store.read).not.toHaveBeenCalled(); expect(draw).not.toHaveBeenCalled();
  });
  it('does not cache a render failure or return an older QA PDF', async () => {
    draw.mockRejectedValueOnce(new Error('RENDER_FAILED')); await expect(download()).rejects.toMatchObject({ status: 503 });
    await download(); expect(draw).toHaveBeenCalledTimes(2);
  });
  it('missing assembly fails closed while the local renderer still rejects production', async () => {
    delivery = new ArtifactDeliveryService(db, store, visuals);
    await expect(download()).rejects.toMatchObject({ status: 503 });
    await expect(visuals.document(snapshot, 'a4', token)).rejects.toMatchObject({ status: 409 });
    await expect(renderLocalDocumentPdf(snapshot, 'a4')).rejects.toThrow('BETA');
  });
});

describe('separate productive renderer: real PDF, existing geometry/logos and XML QR', () => {
  it.each(['a4', 'ticket'] as const)('renders %s with original digest/QR and no QA warnings', async format => {
    const text = vi.spyOn(PDFDocument.prototype, 'text'), qr = vi.spyOn(QRCode, 'toBuffer');
    const before = structuredClone(snapshot), pdf = await renderProductionInvoicePdf(snapshot, format, evidence());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-'); expect(snapshot).toEqual(before);
    const messages = text.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(messages).toContain('PRODUCCIÓN'); expect(messages).toContain('ACEPTADA');
    expect(messages).not.toMatch(/LOCAL \/ BETA|DOCUMENTO LOCAL DE PRUEBA|EVIDENCIA DE PRUEBA QA|CIRCUITO SIMULADO|Prueba local|impresa local|QR pendiente|Autorización de emisión electrónica: pendiente/);
    expect(messages).toContain(signed.digestValue); expect(qr).toHaveBeenCalledExactlyOnceWith(evidence().qrPayload, expect.anything());
    const png = PNG.sync.read(await qr.mock.results[0].value);
    expect(decodeQr(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(evidence().qrPayload);
  });
  it.each(['PENDING', 'REJECTED', 'ACCEPTED_WITH_OBSERVATIONS'] as const)('prints %s prominently on every A4 page', async status => {
    const s = structuredClone(snapshot); s.lines = Array.from({ length: 100 }, (_, i) => ({ ...s.lines[0], lineNumber: i + 1, description: 'FICTITIOUS LONG PAGINATION '.repeat(15) }));
    const text = vi.spyOn(PDFDocument.prototype, 'text'); const pdf = await renderProductionInvoicePdf(s, 'a4', evidence(status));
    const pages = pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0;
    expect(pages).toBeGreaterThan(1);
    const marker = status === 'PENDING' ? 'PENDIENTE' : status === 'REJECTED' ? 'RECHAZADA' : 'ACEPTADA CON OBSERVACIONES';
    expect(text.mock.calls.filter((c: any[]) => c[0].includes(`PRODUCCIÓN · ${marker}`))).toHaveLength(pages);
  });
  it.each(['BETA', '03', 'USD', 'digest', 'qr', 'status', 'response'])('rejects incompatible productive evidence: %s', async change => {
    const proof = evidence();
    if (change === 'BETA') snapshot.environment = 'BETA'; if (change === '03') snapshot.documentTypeCode = '03'; if (change === 'USD') snapshot.currencyCode = 'USD';
    if (change === 'digest') proof.digestValue = 'INVENTED'; if (change === 'qr') proof.qrPayload += '|'; if (change === 'status') proof.status = 'SIGNED_LOCAL' as any;
    if (change === 'response') proof.responseCode = '2335';
    await expect(renderProductionInvoicePdf(snapshot, 'a4', proof)).rejects.toThrow();
  });
  it('retains the explicit LOCAL/BETA warning in the QA renderer', async () => {
    snapshot.environment = 'BETA'; const text = vi.spyOn(PDFDocument.prototype, 'text');
    await renderLocalDocumentPdf(snapshot, 'a4');
    expect(text.mock.calls.map((c: any[]) => c[0]).join('\n')).toContain('DOCUMENTO LOCAL DE PRUEBA');
  });
});
