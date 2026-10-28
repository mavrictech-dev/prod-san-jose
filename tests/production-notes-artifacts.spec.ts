import 'reflect-metadata';
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FiscalDocumentSnapshot, ProductionNotesSnapshot } from '../packages/contracts/src';
import { PRODUCTION_NOTES_PROFILE, PRODUCTION_NOTES_ISSUED } from '../packages/contracts/src';
import { buildProductionNotesSnapshot, buildProductionNotesUbl, buildInvoiceUbl, fiscalSnapshotSha256 } from '../packages/sunat-core/src';
import { renderProductionNotePdf, renderLocalDocumentPdf } from '../packages/pdf-renderer/src';
import { ProductionNotesArtifactsService } from '../services/sunat-service/src/application/production-notes-artifacts.service';
import { ProductionNotesEvidenceService } from '../services/sunat-service/src/application/production-notes-evidence.service';
import { CertificateTrustService } from '../services/sunat-service/src/infrastructure/crypto/certificate-trust.service';
import { CdrSignatureTrustService } from '../services/sunat-service/src/infrastructure/crypto/cdr-signature-trust.service';
import { PublicSignerArchive } from '../services/sunat-service/src/infrastructure/crypto/public-signer-archive';
import { inspectCertificate } from '../services/sunat-service/src/infrastructure/crypto/certificate-inspector';
import { XmlSignerService } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import { CurrentPdfService } from '../services/sunat-service/src/application/current-pdf.service';
import { createGuideSidecarPki, guideSidecarHash as hash, guideSidecarCdrXml, zipSync } from './helpers/guide-sidecar-ephemeral-pki.fixture';
import { documentSample } from './qa-print-formats.mjs';
import PDFDocument from '../packages/pdf-renderer/node_modules/pdfkit';
import QRCode from '../packages/pdf-renderer/node_modules/qrcode';
vi.mock('@factuez/pdf-renderer', async () => await import('../packages/pdf-renderer/src'));
const req = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const forge: typeof import('node-forge') = req('node-forge');
const { PNG } = createRequire(import.meta.url)('pngjs'), decodeQr = createRequire(import.meta.url)('jsqr');
// Bridge new source export into Node's CJS package in this process only. No dist writes/build.
const runtime = req('@factuez/pdf-renderer'), oldExport = Object.getOwnPropertyDescriptor(runtime, 'renderProductionNotePdf');
const id = '50000000-0000-4000-8000-000000000021', ruc = '20100070970', token = 'Bearer FICTITIOUS.NOTES';
let directory: string, archive: PublicSignerArchive, pki: ReturnType<typeof createGuideSidecarPki>;
let original: FiscalDocumentSnapshot, note: ProductionNotesSnapshot, row: any, own: any, originalDoc: any;
let db: any, repository: any, store: any, trust: CertificateTrustService, evaluate: any, evidence: ProductionNotesEvidenceService;
let service: ProductionNotesArtifactsService, visuals: CurrentPdfService, draw: any, fetcher: any, noteSigned: any;
const pack = (filename: string, xml: Buffer | string) => Buffer.from(zipSync({ [filename]: Buffer.from(xml) }, { level: 0, mtime: new Date(2000, 0, 1) }));
beforeAll(async () => {
  pki = createGuideSidecarPki(); directory = await mkdtemp(join(tmpdir(), 'factuez-notes-artifacts-'));
  archive = new PublicSignerArchive(join(directory, 'artifacts'));
  await archive.archive(ruc, inspectCertificate(pki.issuer.pkcs12, pki.password));
  await writeFile(join(directory, 'fictitious-cdr.pem'), pki.sunat.certificatePem + pki.rootPem, { flag: 'wx' });
}, 30000);
afterAll(async () => {
  for (const signer of [pki.issuer, pki.otherIssuer, pki.sunat]) signer.pkcs12.fill(0);
  if (!directory.startsWith(join(tmpdir(), 'factuez-notes-artifacts-'))) throw new Error('UNSAFE_CLEANUP');
  await rm(directory, { recursive: true, force: true });
});
function add(doc: any, kind: string, bytes: Buffer) {
  const a = { documentId: doc.documentId, kind, storageKey: `${doc.documentId}/${hash(bytes)}-${kind}`, sha256: hash(bytes), sizeBytes: BigInt(bytes.length),
    mediaType: kind.endsWith('ZIP') ? 'application/zip' : 'application/xml' };
  doc.artifacts = doc.artifacts.filter((v: any) => v.kind !== kind); doc.artifacts.push(a); store.bytes.set(a.storageKey, Buffer.from(bytes)); return a;
}
const stored = (a: any) => ({ storageKey: a.storageKey, sha256: a.sha256, sizeBytes: Number(a.sizeBytes) });
function cdr(doc: any, type: string, number: string, code = '0', edit: (s: string) => string = s => s, observations = false) {
  let xml = guideSidecarCdrXml({ issuerRuc: ruc, documentType: type, fullNumber: number } as any, code);
  if (observations) xml = xml.replace('<cac:SenderParty>', '<cbc:Note>FICTITIOUS NOTE OBSERVATION</cbc:Note><cac:SenderParty>');
  const signed = pki.signCdr(edit(xml)), zip = pack(`R-${ruc}-${type}-${number}.xml`, signed);
  add(doc, 'CDR_XML', Buffer.from(signed)); const a = add(doc, 'CDR_ZIP', zip); doc.submissions[0].responseArtifactKey = a.storageKey;
}
function setup(type: '07' | '08' = '07') {
  note = buildProductionNotesSnapshot(original, {
    profile: 'PRODUCTION-01-ARCHIVE-v1', documentId: original.documentId, snapshotSha256: fiscalSnapshotSha256(original),
    signedXmlSha256: originalDoc.artifacts.find((a: any) => a.kind === 'SIGNED_XML').sha256,
    cdrXmlSha256: originalDoc.artifacts.find((a: any) => a.kind === 'CDR_XML').sha256,
    cdrZipSha256: originalDoc.artifacts.find((a: any) => a.kind === 'CDR_ZIP').sha256,
    acceptedAt: originalDoc.acceptedAt.toISOString(), checkedAt: '2026-10-02T16:00:00.000Z',
  }, type === '07' ? { documentTypeCode: type, reasonCode: '01', reasonDescription: 'ANULACIÓN TOTAL FICTICIA' } :
    { documentTypeCode: type, reasonCode: '02', reasonDescription: 'AUMENTO DE PRECIO FICTICIO', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '2.36' }] },
  { documentId: id, series: type === '07' ? 'FC71' : 'FD71', number: '1', issueDate: '2026-10-03T16:00:00.000Z' });
  noteSigned = new XmlSignerService().sign(buildProductionNotesUbl(note), pki.issuer.pkcs12, pki.password, type === '07' ? 'CreditNote' : 'DebitNote');
  const eventId = '50000000-0000-4000-8000-000000000022';
  own = { documentId: id, documentType: type, issuerRuc: ruc, series: note.series, number: 1n, environment: 'PRODUCTION', immutablePayload: structuredClone(note),
    status: 'ACCEPTED', digestValue: noteSigned.digestValue, billingEventId: eventId, acceptedAt: new Date('2026-10-03T16:30:00Z'), artifacts: [],
    submissions: [{ id: '50000000-0000-4000-8000-000000000023', documentId: id, batchId: null, channel: 'SOAP_SEND_BILL',
      idempotencyKey: `production-notes:${id}:v1`, result: 'SUCCESS', errorCode: 'DONE', completedAt: new Date() }] };
  const xml = add(own, 'SIGNED_XML', Buffer.from(noteSigned.xml)), zip = add(own, 'SUBMISSION_ZIP', pack(`${ruc}-${type}-${note.fullNumber}.xml`, noteSigned.xml));
  own.submissions[0].requestArtifactKey = zip.storageKey; cdr(own, type, note.fullNumber);
  const admission = { authorized: true, profile: PRODUCTION_NOTES_PROFILE, snapshotSha256: fiscalSnapshotSha256(note), grantVersion: 2,
    credentialRevision: 7, certificateFingerprint: pki.issuer.fingerprint };
  row = { documentId: id, eventId, snapshotSha256: fiscalSnapshotSha256(note), phase: 'DONE', lease: null, leaseUntil: null,
    manifest: { xml: stored(xml), zip: stored(zip), fileName: `${ruc}-${type}-${note.fullNumber}.zip`, digest: noteSigned.digestValue,
      fingerprint: pki.issuer.fingerprint, revision: 7, xsdEvidence: { fictitiousUnitEvidence: true } },
    payload: { eventId, eventName: PRODUCTION_NOTES_ISSUED, producer: 'billing-service', occurredAt: note.issueDate,
      correlationId: '50000000-0000-4000-8000-000000000024', ownerProof: { unitOnly: true },
      payload: { snapshot: structuredClone(note), original: structuredClone(original), creditHistory: [], ownerRevisionSha256: 'a'.repeat(64), admission } } };
}
beforeEach(() => {
  Object.defineProperty(runtime, 'renderProductionNotePdf', { configurable: true, value: renderProductionNotePdf });
  vi.stubEnv('PRINT_SETTINGS_ENABLED', 'false');
  for (const key of ['SUNAT_TRUST_STORE_FILE', 'SUNAT_TRUST_STORE_SHA256', 'SUNAT_CRL_BUNDLE_FILE', 'SUNAT_CRL_BUNDLE_SHA256', 'SUNAT_OPENSSL_PATH']) vi.stubEnv(key, '');
  vi.stubEnv('SUNAT_CDR_SIGNER_CERT_FILE', join(directory, 'fictitious-cdr.pem'));
  vi.stubEnv('SUNAT_CDR_SIGNER_CERT_SHA256', hash(pki.sunat.certificatePem + pki.rootPem));
  store = { bytes: new Map(), read: vi.fn(async (owner: string, a: any) => {
    if (!a.storageKey.startsWith(owner + '/')) throw new Error('CROSS_OWNER_READ'); return Buffer.from(store.bytes.get(a.storageKey));
  }) };
  original = documentSample('01') as FiscalDocumentSnapshot; original.environment = 'PRODUCTION';
  original.branchId = '20000000-0000-4000-8000-000000000001';
  Object.assign(original.issuer, { identityNumber: ruc, establishmentCode: '0000' }); original.customer.identityNumber = '20131312955';
  Object.assign(original.printPresentation!, { issuerRuc: ruc, branchId: original.branchId });
  const signed = new XmlSignerService().sign(buildInvoiceUbl(original, { mode: 'REAL_PREPARATION' }), pki.issuer.pkcs12, pki.password);
  originalDoc = { documentId: original.documentId, documentType: '01', issuerRuc: ruc, series: original.series, number: BigInt(original.number), environment: 'PRODUCTION',
    immutablePayload: structuredClone(original), status: 'ACCEPTED', digestValue: signed.digestValue, acceptedAt: new Date('2026-10-02T15:00:00Z'), artifacts: [],
    submissions: [{ documentId: original.documentId, channel: 'SOAP_SEND_BILL', batchId: null, idempotencyKey: `production:${original.documentId}:v1`, errorCode: 'DONE', result: 'SUCCESS', completedAt: new Date() }] };
  add(originalDoc, 'SIGNED_XML', Buffer.from(signed.xml));
  originalDoc.submissions[0].requestArtifactKey = add(originalDoc, 'SUBMISSION_ZIP', pack(`${ruc}-01-${original.fullNumber}.xml`, signed.xml)).storageKey;
  cdr(originalDoc, '01', original.fullNumber); setup();
  db = { fiscalDocument: { findUnique: vi.fn(async ({ where }: any) => structuredClone(where.documentId === id ? own : originalDoc)) } };
  repository = { load: vi.fn(async () => structuredClone(row)) };
  trust = new CertificateTrustService();
  // Real ephemeral chain, issuer signature and pinned CDR signature. Positive CRL is a unit policy double.
  evaluate = vi.spyOn(trust, 'evaluate').mockImplementation(async (m, owner, now = new Date()) => {
    forge.pki.verifyCertificateChain(forge.pki.createCaStore([pki.rootPem]), [forge.pki.certificateFromPem(m.certificatePem)]);
    return { profile: 'OFFLINE-PINNED-ROOTS-CRL-v1', chainValid: true, identityMatched: m.subjectRucCandidates[0] === owner,
      revocation: 'VERIFIED_OFFLINE_CRL', certificateFingerprint: m.fingerprint, checkedAt: now.toISOString(), trustStoreSha256: hash(pki.rootPem), blockers: [] };
  });
  evidence = new ProductionNotesEvidenceService(db, store, archive, trust, new CdrSignatureTrustService(trust));
  visuals = new CurrentPdfService(); draw = vi.fn(async (s, format, proof) => Buffer.from('%PDF-' + JSON.stringify({ s, format, proof })));
  service = new ProductionNotesArtifactsService(db, repository, store, evidence, visuals, draw);
  fetcher = vi.fn(async (url: string) => {
    const requested = url.endsWith('/' + id) ? note : original;
    return Response.json({ id: requested.documentId, immutableSnapshot: requested, companyId: 1,
      printContext: { companyId: 1, branchId: original.branchId }, accepted: true, cdrSignatureVerified: true });
  }); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  service.onModuleDestroy(); visuals.onModuleDestroy(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers();
  if (oldExport) Object.defineProperty(runtime, 'renderProductionNotePdf', oldExport); else delete runtime.renderProductionNotePdf;
});
const pdf = (format: 'a4' | 'ticket' = 'a4') => service.pdf(id, format, token);

describe('production notes artifacts: current owner access, exact note/original evidence and immutable files', () => {
  it.each(['07', '08'] as const)('%s authorizes both note and original and verifies all originals before each PDF cache hit', async type => {
    setup(type); const before = structuredClone({ row, own, originalDoc, note });
    const a = await pdf(), b = await pdf(); expect(a).toEqual(b); expect(draw).toHaveBeenCalledOnce();
    expect(a.fileName).toBe(`${ruc}-${type}-${note.fullNumber}-a4-PRODUCCION.pdf`); expect(a.sha256).toBe(hash(a.bytes));
    expect(fetcher).toHaveBeenCalledTimes(4); expect(repository.load).toHaveBeenCalledTimes(2); expect(evaluate).toHaveBeenCalledTimes(8);
    expect(fetcher.mock.invocationCallOrder[0]).toBeLessThan(repository.load.mock.invocationCallOrder[0]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: { Authorization: token, 'Cache-Control': 'no-store' }, redirect: 'error' });
    expect(draw.mock.calls[0][2]).toMatchObject({ status: 'ACCEPTED', digestValue: noteSigned.digestValue,
      qrPayload: [ruc, type, note.series, '1', note.totals.igvAmount, note.totals.payableAmount, '2026-10-03', '6', '20131312955', noteSigned.digestValue].join('|') + '|' });
    expect({ row, own, originalDoc, note }).toEqual(before); expect(Object.keys(db)).toEqual(['fiscalDocument']);
  });
  it.each(['signed-xml', 'submission-zip', 'cdr-xml', 'cdr-zip'] as const)('delivers exact original bytes for %s with correct name/media/hash', async kind => {
    const result = await service.download(id, kind, token), k = { 'signed-xml': 'SIGNED_XML', 'submission-zip': 'SUBMISSION_ZIP', 'cdr-xml': 'CDR_XML', 'cdr-zip': 'CDR_ZIP' }[kind];
    const artifact = own.artifacts.find((a: any) => a.kind === k); expect(result.bytes).toEqual(store.bytes.get(artifact.storageKey));
    expect(result.sha256).toBe(artifact.sha256); expect(result.fileName).toBe(`${kind.startsWith('cdr') ? 'R-' : ''}${ruc}-07-${note.fullNumber}.${kind.endsWith('zip') ? 'zip' : 'xml'}`);
    expect(result.mediaType).toBe(kind.endsWith('zip') ? 'application/zip' : 'application/xml'); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['signed-xml', 'submission-zip', 'cdr-xml', 'cdr-zip'] as const)('raw %s preserves historical bytes after expiry while PDF refuses a cached hit', async kind => {
    await pdf(); const before = await service.download(id, kind, token); evaluate.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.parse(new X509Certificate(pki.issuer.certificatePem).validTo) + 86400000));
    const result = await service.download(id, kind, token);
    expect(result.bytes).toEqual(before.bytes); expect(result.sha256).toBe(before.sha256);
    expect(result).toMatchObject({ verification: 'ORIGINAL_BYTES_INTEGRITY_ONLY', currentFiscalValidityVerified: false });
    expect(result).not.toHaveProperty('status'); expect(result).not.toHaveProperty('proof'); expect(evaluate).not.toHaveBeenCalled();
    await expect(pdf()).rejects.toMatchObject({ status: 409 }); expect(draw).toHaveBeenCalledOnce();
  });
  it('raw does not reaccredit trust/CRL or current CDR signer pins, while PDF remains strict', async () => {
    const originalVerifier = vi.spyOn(evidence, 'original'), signedVerifier = vi.spyOn(evidence, 'signed'), cdrVerifier = vi.spyOn(evidence, 'cdr');
    evaluate.mockRejectedValue(new Error('CURRENT_CRL_UNAVAILABLE')); vi.stubEnv('SUNAT_CDR_SIGNER_CERT_SHA256', '0'.repeat(64));
    for (const kind of ['signed-xml', 'submission-zip', 'cdr-xml', 'cdr-zip'] as const)
      await expect(service.download(id, kind, token)).resolves.toHaveProperty('currentFiscalValidityVerified', false);
    expect(evaluate).not.toHaveBeenCalled(); expect(originalVerifier).not.toHaveBeenCalled(); expect(signedVerifier).not.toHaveBeenCalled(); expect(cdrVerifier).not.toHaveBeenCalled();
    await expect(pdf()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it('raw reauthorizes both documents and rejects revoked original access before reading bytes', async () => {
    await service.download(id, 'signed-xml', token); store.read.mockClear();
    fetcher.mockResolvedValueOnce(Response.json({ id, immutableSnapshot: note })).mockResolvedValueOnce(Response.json({}, { status: 403 }));
    await expect(service.download(id, 'signed-xml', token)).rejects.toMatchObject({ status: 403 }); expect(store.read).not.toHaveBeenCalled();
  });
  it.each(['reason', 'line', 'source01'])('raw validates 07 reason/line/source01 congruence: %s', async change => {
    if (change === 'reason') note.reasonCode = '02'; if (change === 'line') note.lines[0].originalLineNumber = 99;
    if (change === 'source01') note.reference.documentTypeCode = '03' as any;
    row.payload.payload.snapshot = structuredClone(note); own.immutablePayload = structuredClone(note);
    row.snapshotSha256 = row.payload.payload.admission.snapshotSha256 = fiscalSnapshotSha256(note);
    await expect(service.download(id, 'signed-xml', token)).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['SIGNED_XML', 'SUBMISSION_ZIP', 'CDR_XML', 'CDR_ZIP'])('raw rejects altered note %s', async kind => {
    const a = own.artifacts.find((a: any) => a.kind === kind); store.bytes.set(a.storageKey, Buffer.from('TAMPERED'));
    await expect(service.download(id, 'signed-xml', token)).rejects.toMatchObject({ status: 409 });
  });
  it('raw rejects an incongruent original01 without calling current PKI', async () => {
    originalDoc.immutablePayload = { ...original, customer: { ...original.customer, legalName: 'OTHER SOURCE' } };
    await expect(service.download(id, 'signed-xml', token)).rejects.toMatchObject({ status: 409 }); expect(evaluate).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 500])('Billing %i denies before cached PDF, repository and originals', async status => {
    await pdf(); repository.load.mockClear(); store.read.mockClear();
    fetcher.mockResolvedValue(Response.json({}, { status }));
    await expect(pdf()).rejects.toMatchObject({ status: status === 500 ? 503 : status });
    expect(repository.load).not.toHaveBeenCalled(); expect(store.read).not.toHaveBeenCalled(); expect(draw).toHaveBeenCalledOnce();
  });
  it('revoked original access denies before fiscal original reads even with a valid note bearer response', async () => {
    fetcher.mockResolvedValueOnce(Response.json({ id, immutableSnapshot: note })).mockResolvedValueOnce(Response.json({}, { status: 403 }));
    await expect(pdf()).rejects.toMatchObject({ status: 403 }); expect(store.read).not.toHaveBeenCalled();
  });
  it.each(['id', 'snapshot', 'json', 'network'])('invalid Billing %s response never authorizes a fiscal read', async kind => {
    if (kind === 'network') fetcher.mockRejectedValue(new Error('OFFLINE'));
    if (kind === 'json') fetcher.mockResolvedValue(new Response('broken'));
    if (kind === 'id') fetcher.mockResolvedValue(Response.json({ id: original.documentId, immutableSnapshot: note }));
    if (kind === 'snapshot') fetcher.mockResolvedValue(Response.json({ id, immutableSnapshot: { ...note, documentId: original.documentId } }));
    await expect(pdf()).rejects.toThrow(); expect(repository.load).not.toHaveBeenCalled(); expect(draw).not.toHaveBeenCalled();
  });
  it('rejects bad IDs/formats and missing bearer without any external read', async () => {
    await expect(service.pdf('../escape', 'a4', token)).rejects.toMatchObject({ status: 400 });
    await expect(service.pdf(id, 'a4')).rejects.toMatchObject({ status: 401 });
    await expect(service.pdf(id, 'invalid' as any, token)).rejects.toMatchObject({ status: 400 });
    await expect(service.download(id, 'p12' as any, token)).rejects.toMatchObject({ status: 400 }); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['missing', 'snapshot', 'original', 'event', 'namespace', 'hash', 'admission', 'manifest', 'profile'])('rejects inconsistent notes dispatch %s', async change => {
    if (change === 'missing') repository.load.mockResolvedValue(undefined);
    if (change === 'snapshot') row.payload.payload.snapshot.customer.legalName = 'OTHER';
    if (change === 'original') row.payload.payload.original.customer.legalName = 'OTHER';
    if (change === 'event') row.eventId = original.documentId;
    if (change === 'namespace') row.payload.eventName = 'beta.qa';
    if (change === 'hash') row.snapshotSha256 = '0'.repeat(64);
    if (change === 'admission') row.payload.payload.admission.snapshotSha256 = '0'.repeat(64);
    if (change === 'manifest') row.manifest = null;
    if (change === 'profile') note.profile = 'OTHER' as any;
    await expect(pdf()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['fileName', 'fingerprint', 'digest', 'revision', 'xml', 'zip'])('rejects manifest %s mismatch before delivery', async field => {
    if (field === 'xml' || field === 'zip') row.manifest[field].sha256 = '0'.repeat(64);
    else row.manifest[field] = field === 'revision' ? 8 : 'OTHER';
    await expect(service.download(id, 'signed-xml', token)).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['documentId', 'environment', 'documentType', 'issuerRuc', 'series', 'number', 'billingEventId', 'digestValue', 'immutablePayload'])('rejects fiscal owner %s mismatch', async field => {
    own[field] = field === 'number' ? 2n : field === 'immutablePayload' ? { ...note, customer: { ...note.customer, legalName: 'OTHER' } } : 'OTHER';
    await expect(pdf()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['multiple', 'documentId', 'batchId', 'channel', 'idempotencyKey', 'requestArtifactKey', 'responseArtifactKey', 'result', 'errorCode', 'completedAt'])('rejects own notes submission %s mismatch', async field => {
    if (field === 'multiple') own.submissions.push({ ...own.submissions[0] });
    else own.submissions[0][field] = field === 'completedAt' ? null : 'OTHER';
    await expect(pdf()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['SIGNED_XML', 'SUBMISSION_ZIP', 'CDR_XML', 'CDR_ZIP'])('rechecks note original %s after cache', async kind => {
    await pdf(); const a = own.artifacts.find((a: any) => a.kind === kind); store.bytes.set(a.storageKey, Buffer.from('TAMPERED'));
    await expect(pdf()).rejects.toMatchObject({ status: 409 }); expect(draw).toHaveBeenCalledOnce();
  });
  it.each(['documentId', 'mediaType', 'sha256', 'sizeBytes', 'duplicate', 'missing'])('rejects artifact metadata %s', async field => {
    const a = own.artifacts[0]; if (field === 'duplicate') own.artifacts.push({ ...a }); else if (field === 'missing') own.artifacts = own.artifacts.slice(1);
    else a[field] = field === 'sizeBytes' ? 0n : 'OTHER';
    await expect(service.download(id, 'signed-xml', token)).rejects.toMatchObject({ status: 409 });
  });
  it.each(['state', 'xml', 'cdr', 'submission', 'acceptance'])('revalidates original accepted invoice %s and ignores HTTP acceptance booleans', async change => {
    if (change === 'state') originalDoc.status = 'REJECTED';
    if (change === 'xml' || change === 'cdr') { const kind = change === 'xml' ? 'SIGNED_XML' : 'CDR_XML'; const a = originalDoc.artifacts.find((a: any) => a.kind === kind); store.bytes.set(a.storageKey, Buffer.from('ALTERED')); }
    if (change === 'submission') originalDoc.submissions[0].idempotencyKey = `beta:${original.documentId}:v1`;
    if (change === 'acceptance') originalDoc.acceptedAt = new Date('2026-10-02T15:00:01Z');
    await expect(pdf()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it('does not deliver a validly signed different note under a replaced archive hash', async () => {
    const changed = structuredClone(note); changed.reasonDescription = 'OTHER REASON';
    const signed = new XmlSignerService().sign(buildProductionNotesUbl(changed), pki.issuer.pkcs12, pki.password, 'CreditNote');
    row.manifest.xml = stored(add(own, 'SIGNED_XML', Buffer.from(signed.xml))); row.manifest.zip = stored(add(own, 'SUBMISSION_ZIP', pack(`${ruc}-07-${note.fullNumber}.xml`, signed.xml)));
    row.manifest.digest = own.digestValue = signed.digestValue; own.submissions[0].requestArtifactKey = row.manifest.zip.storageKey;
    await expect(pdf()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it('rejects mismatching ZIP XML/CRC even when its archive hash and manifest are updated', async () => {
    const zip = pack(`${ruc}-07-${note.fullNumber}.xml`, noteSigned.xml); zip[14] ^= 1;
    row.manifest.zip = stored(add(own, 'SUBMISSION_ZIP', zip)); own.submissions[0].requestArtifactKey = row.manifest.zip.storageKey;
    await expect(pdf()).rejects.toMatchObject({ status: 409 });
  });
  it.each(['receiver', 'reference', 'type', 'signature', 'state', 'pin'])('rejects CDR %s mismatch', async change => {
    if (change === 'receiver') cdr(own, '07', note.fullNumber, '0', s => s.replace(`<cbc:ID>${ruc}</cbc:ID>`, '<cbc:ID>20131312955</cbc:ID>'));
    if (change === 'reference') cdr(own, '07', note.fullNumber, '0', s => s.replaceAll(note.fullNumber, 'FC71-2'));
    if (change === 'type') cdr(own, '07', note.fullNumber, '0', s => s.replace('<cbc:DocumentTypeCode>07', '<cbc:DocumentTypeCode>08'));
    if (change === 'state') cdr(own, '07', note.fullNumber, '2335');
    if (change === 'signature') { const a = own.artifacts.find((a: any) => a.kind === 'CDR_XML'), xml = store.bytes.get(a.storageKey).toString().replace('FICTITIOUS LOCAL RECEIPT', 'ALTERED'); add(own, 'CDR_XML', Buffer.from(xml)); own.submissions[0].responseArtifactKey = add(own, 'CDR_ZIP', pack(`R-${ruc}-07-${note.fullNumber}.xml`, xml)).storageKey; }
    if (change === 'pin') vi.stubEnv('SUNAT_CDR_SIGNER_CERT_SHA256', '0'.repeat(64));
    await expect(pdf()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['REJECTED', 'ACCEPTED_WITH_OBSERVATIONS'] as const)('prints %s only when all final owner states and verified CDR agree', async status => {
    own.status = status; own.submissions[0].result = status === 'REJECTED' ? 'BUSINESS_ERROR' : 'SUCCESS';
    cdr(own, '07', note.fullNumber, status === 'REJECTED' ? '2335' : '0', s => s, status === 'ACCEPTED_WITH_OBSERVATIONS');
    await pdf(); expect(draw.mock.calls[0][2].status).toBe(status);
  });
  it('pending signed notes deliver XML/ZIP and visibly pending PDF, never a fabricated CDR', async () => {
    row.phase = 'PREPARED'; own.status = 'SIGNED'; own.acceptedAt = null;
    own.submissions[0].errorCode = 'PREPARED'; own.submissions[0].result = 'PENDING'; own.submissions[0].completedAt = null; own.submissions[0].responseArtifactKey = null;
    own.artifacts = own.artifacts.filter((a: any) => !a.kind.startsWith('CDR'));
    await pdf(); expect(draw.mock.calls[0][2]).toMatchObject({ status: 'PENDING', digestValue: noteSigned.digestValue });
    await expect(service.download(id, 'signed-xml', token)).resolves.toHaveProperty('mediaType', 'application/xml');
    await expect(service.download(id, 'cdr-zip', token)).rejects.toMatchObject({ status: 409 });
  });
  it.each(['UNKNOWN', 'BLOCKED'] as const)('represents %s as pending without claiming acceptance or fabricating a CDR', async phase => {
    row.phase = phase; own.status = phase === 'UNKNOWN' ? 'RETRYABLE_ERROR' : 'PERMANENT_ERROR'; own.acceptedAt = null;
    Object.assign(own.submissions[0], { errorCode: phase, result: phase === 'UNKNOWN' ? 'UNKNOWN' : 'BUSINESS_ERROR', responseArtifactKey: null });
    own.artifacts = own.artifacts.filter((a: any) => !a.kind.startsWith('CDR'));
    await pdf(); expect(draw.mock.calls[0][2].status).toBe('PENDING');
    await expect(service.download(id, 'cdr-xml', token)).rejects.toMatchObject({ status: 409 });
  });
  it.each(['missing-date', 'phase', 'missing-cdr', 'history', 'original-hash'])('does not infer acceptance for %s', async change => {
    if (change === 'missing-date') own.acceptedAt = null;
    if (change === 'phase') row.phase = 'SENDING';
    if (change === 'missing-cdr') own.artifacts = own.artifacts.filter((a: any) => a.kind !== 'CDR_ZIP');
    if (change === 'history') row.payload.payload.creditHistory.push({ ...note, documentId: original.documentId });
    if (change === 'original-hash') {
      const frozen = { ...note.originalAcceptance, signedXmlSha256: '0'.repeat(64) };
      note.originalAcceptance = frozen; row.payload.payload.snapshot = structuredClone(note); own.immutablePayload = structuredClone(note);
      row.snapshotSha256 = row.payload.payload.admission.snapshotSha256 = fiscalSnapshotSha256(note);
    }
    await expect(pdf()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  function sending() {
    row.phase = 'SENDING'; own.status = 'SUBMITTED'; own.acceptedAt = null;
    Object.assign(own.submissions[0], { errorCode: 'SENDING', result: 'PENDING', completedAt: null, responseArtifactKey: null });
    own.artifacts = own.artifacts.filter((a: any) => !a.kind.startsWith('CDR'));
  }
  it.each(['07', '08'] as const)('%s SENDING delivers pending PDF/raw, never accepted or an invented CDR', async type => {
    setup(type); sending(); await pdf(); await pdf();
    expect(draw).toHaveBeenCalledOnce(); expect(draw.mock.calls[0][2].status).toBe('PENDING');
    expect(draw.mock.calls[0][2].responseCode).toBeUndefined();
    for (const kind of ['signed-xml', 'submission-zip'] as const)
      await expect(service.download(id, kind, token)).resolves.toHaveProperty('currentFiscalValidityVerified', false);
    await expect(service.download(id, 'cdr-xml', token)).rejects.toMatchObject({ status: 409 });
  });
  it.each(['SIGNED', 'ACCEPTED', 'SUCCESS', 'PREPARED', 'completed', 'wrong-phase'])('SENDING inconsistency %s fails closed for PDF and raw', async change => {
    sending();
    if (change === 'SIGNED' || change === 'ACCEPTED') own.status = change;
    if (change === 'SUCCESS') own.submissions[0].result = 'SUCCESS';
    if (change === 'PREPARED') own.submissions[0].errorCode = 'PREPARED';
    if (change === 'completed') own.submissions[0].completedAt = new Date();
    if (change === 'wrong-phase') { row.phase = 'PREPARED'; own.status = 'SIGNED'; }
    await expect(pdf()).rejects.toMatchObject({ status: 409 });
    await expect(service.download(id, 'signed-xml', token)).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it('binds a valid frozen ownerRevision to the cache and rejects malformed revisions', async () => {
    await pdf(); row.payload.payload.ownerRevisionSha256 = 'b'.repeat(64); await pdf(); expect(draw).toHaveBeenCalledTimes(2);
    row.payload.payload.ownerRevisionSha256 = 'INVALID';
    await expect(pdf()).rejects.toMatchObject({ status: 409 });
    await expect(service.download(id, 'signed-xml', token)).rejects.toMatchObject({ status: 409 });
  });
  it('does not introduce a current HMAC-key requirement for legacy owner-persisted RAW/PDF', async () => {
    delete row.payload.payload.ownerRevisionSha256; vi.stubEnv('PRODUCTION_NOTES_OWNER_KEY_FILE', '');
    await expect(service.download(id, 'signed-xml', token)).resolves.toHaveProperty('currentFiscalValidityVerified', false);
    await expect(pdf()).resolves.toHaveProperty('mediaType', 'application/pdf');
  });
  it('an unprepared note cannot invent a fiscal hash, PDF or signed XML', async () => {
    row.phase = 'AWAITING_AUTHORIZATION'; row.manifest = null; own.status = 'QUEUED'; own.artifacts = [];
    await expect(pdf()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it('trust/CRL degradation prevents a previous PDF cache hit', async () => {
    await pdf(); const originalEvaluation = evaluate.getMockImplementation();
    evaluate.mockImplementation(async (...args: any[]) => ({ ...await originalEvaluation(...args), revocation: 'INVALID' }));
    await expect(pdf()).rejects.toMatchObject({ status: 409 }); expect(draw).toHaveBeenCalledOnce();
  });
  it('cache identity includes exact note CDR bytes even when status and description stay equal', async () => {
    await pdf(); cdr(own, '07', note.fullNumber, '0', s => s.replace('FICTITIOUS-LOCAL-GUIDE-CDR', 'OTHER-FICTITIOUS-CDR'));
    await pdf(); expect(draw).toHaveBeenCalledTimes(2); expect(draw.mock.calls[0][2]).toEqual(draw.mock.calls[1][2]);
  });
  it('current profile/logo affects only presentation and is read before cache, never original fiscal facts', async () => {
    vi.stubEnv('PRINT_SETTINGS_ENABLED', 'true'); const profile = structuredClone(original.printPresentation!);
    profile.branchName = 'CURRENT NAME'; profile.branchAddress = 'CURRENT ADDRESS'; profile.profileRevision = 20;
    const billing = fetcher.getMockImplementation(); fetcher.mockImplementation(async (url: string) => url.includes('print-settings') ? Response.json(profile) : billing(url));
    await pdf(); await pdf(); expect(draw).toHaveBeenCalledOnce(); profile.settings.logoMode = 'NONE'; profile.profileRevision++; await pdf();
    expect(draw).toHaveBeenCalledTimes(2); expect(draw.mock.calls[1][0]).toMatchObject({ issuer: note.issuer, customer: note.customer, reference: note.reference, lines: note.lines, totals: note.totals });
    expect(draw.mock.calls[1][0].printPresentation.branchName).toBeUndefined();
    fetcher.mockImplementation(async (url: string) => url.includes('print-settings') ? Response.json({}, { status: 403 }) : billing(url));
    await expect(pdf()).rejects.toMatchObject({ status: 403 }); expect(draw).toHaveBeenCalledTimes(2);
  });
  it('render errors are not cached', async () => {
    draw.mockRejectedValueOnce(new Error('RENDER_UNAVAILABLE')); await expect(pdf()).rejects.toMatchObject({ status: 503 }); await pdf(); expect(draw).toHaveBeenCalledTimes(2);
  });
  it('default renderer produces a real productive note PDF without altering 01/03 service wiring', async () => {
    service.onModuleDestroy(); service = new ProductionNotesArtifactsService(db, repository, store, evidence, visuals);
    const result = await pdf(); expect(result.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(result.bytes.includes(Buffer.from('NOTA DE CRÉDITO ELECTRÓNICA · PRODUCCIÓN', 'utf16le').swap16())).toBe(true);
  });
});

describe('separate productive note renderer: frozen facts, own XML QR, reference and reason', () => {
  it.each([['07', 'a4'], ['07', 'ticket'], ['08', 'a4'], ['08', 'ticket']] as const)('draws %s %s with own digest/QR and no QA warnings', async (type, format) => {
    setup(type); await pdf(); const proof = draw.mock.calls[0][2], before = structuredClone(note);
    const text = vi.spyOn(PDFDocument.prototype, 'text'), qr = vi.spyOn(QRCode, 'toBuffer');
    const bytes = await renderProductionNotePdf(note, format, proof); expect(bytes.subarray(0, 5).toString()).toBe('%PDF-'); expect(note).toEqual(before);
    const messages = text.mock.calls.map((a: any[]) => a[0]).join('\n');
    expect(messages).toContain(type === '07' ? 'NOTA DE CRÉDITO ELECTRÓNICA' : 'NOTA DE DÉBITO ELECTRÓNICA');
    expect(messages).toContain('PRODUCCIÓN'); expect(messages).toContain(note.reasonDescription); expect(messages).toContain(format === 'a4' ? `${original.series}-${original.number.padStart(8, '0')}` : original.fullNumber);
    expect(messages).toContain(noteSigned.digestValue); expect(messages).not.toMatch(/LOCAL \/ BETA|CIRCUITO SIMULADO|DOCUMENTO LOCAL DE PRUEBA|QR pendiente/);
    const png = PNG.sync.read(await qr.mock.results[0].value); expect(decodeQr(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(proof.qrPayload);
  });
  it.each(['PENDING', 'REJECTED', 'ACCEPTED_WITH_OBSERVATIONS'])('labels %s distinctly on every page', async status => {
    await pdf(); const proof = structuredClone(draw.mock.calls[0][2]); proof.status = status;
    if (status === 'PENDING') delete proof.responseCode; if (status === 'REJECTED') proof.responseCode = '2335';
    const long = structuredClone(note); long.lines = Array.from({ length: 100 }, (_, index) => ({ ...note.lines[0], lineNumber: index + 1, description: 'FICTITIOUS LONG NOTE '.repeat(20) }));
    const text = vi.spyOn(PDFDocument.prototype, 'text'), bytes = await renderProductionNotePdf(long, 'a4', proof);
    const pages = bytes.toString('latin1').match(/\/Type \/Page\b/g)?.length ?? 0; expect(pages).toBeGreaterThan(1);
    const marker = status === 'PENDING' ? 'PENDIENTE' : status === 'REJECTED' ? 'RECHAZADA' : 'ACEPTADA CON OBSERVACIONES';
    expect(text.mock.calls.filter((a: any[]) => a[0].includes(`PRODUCCIÓN · ${marker}`))).toHaveLength(pages);
  });
  it.each(['BETA', '01', 'USD', 'reason', 'reference', 'digest', 'qr', 'cdr', 'summary'])('rejects incompatible productive note evidence: %s', async change => {
    await pdf(); const proof = structuredClone(draw.mock.calls[0][2]);
    if (change === 'BETA') note.environment = 'BETA' as any; if (change === '01') note.documentTypeCode = '01' as any; if (change === 'USD') note.currencyCode = 'USD';
    if (change === 'reason') note.reasonCode = '02'; if (change === 'reference') note.reference.documentTypeCode = '03' as any;
    if (change === 'digest') proof.digestValue = 'INVENTED'; if (change === 'qr') proof.qrPayload += '|'; if (change === 'cdr') proof.responseCode = '2335';
    if (change === 'summary') proof.receiptSummary = { identifier: 'RC-20261002-1' };
    await expect(renderProductionNotePdf(note, 'a4', proof)).rejects.toThrow();
  });
  it('LOCAL/BETA renderer still refuses productive notes', async () => {
    await expect(renderLocalDocumentPdf(note, 'a4')).rejects.toThrow('BETA');
  });
});
