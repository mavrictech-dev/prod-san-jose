import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src';
import { buildInvoiceUbl, buildReceiptSummary, buildReceiptSummarySnapshot, fiscalSnapshotSha256 } from '../packages/sunat-core/src';
import { renderProductionReceiptPdf, renderProductionInvoicePdf, renderLocalDocumentPdf } from '../packages/pdf-renderer/src';
import { ProductionPdfService } from '../services/sunat-service/src/application/production-pdf.service';
import { CurrentPdfService } from '../services/sunat-service/src/application/current-pdf.service';
import { PublicSignerArchive } from '../services/sunat-service/src/infrastructure/crypto/public-signer-archive';
import { CertificateTrustService } from '../services/sunat-service/src/infrastructure/crypto/certificate-trust.service';
import { CdrSignatureTrustService } from '../services/sunat-service/src/infrastructure/crypto/cdr-signature-trust.service';
import { inspectCertificate } from '../services/sunat-service/src/infrastructure/crypto/certificate-inspector';
import { XmlSignerService } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import { prepareBetaXml } from '../services/sunat-service/src/infrastructure/crypto/beta-xml-pipeline';
import { createGuideSidecarPki, guideSidecarHash as hash, guideSidecarCdrXml, guideSidecarPackCdr, zipSync } from './helpers/guide-sidecar-ephemeral-pki.fixture';
import { documentSample } from './qa-print-formats.mjs';
import PDFDocument from '../packages/pdf-renderer/node_modules/pdfkit';
import QRCode from '../packages/pdf-renderer/node_modules/qrcode';
vi.mock('@factuez/pdf-renderer', async () => await import('../packages/pdf-renderer/src'));
const require = createRequire(import.meta.url), { PNG } = require('pngjs'), decodeQr = require('jsqr');
const req = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const forge: typeof import('node-forge') = req('node-forge');
// New CJS export supplied from source in this process only; no dist rebuild/alias edit.
const runtimeRenderer = req('@factuez/pdf-renderer');
const priorReceiptExport = Object.getOwnPropertyDescriptor(runtimeRenderer, 'renderProductionReceiptPdf');
const reference = 'RC-20261002-1', ruc = '20100070970', token = 'Bearer FICTITIOUS.RECEIPT';
let directory: string, pki: ReturnType<typeof createGuideSidecarPki>, archive: PublicSignerArchive;
let snapshot: FiscalDocumentSnapshot, prepared: ReturnType<typeof prepareBetaXml>, expected: ReturnType<typeof buildReceiptSummarySnapshot>;
let document: any, submission: any, batch: any, manifest: any, metadata: any, db: any, store: any, draw: any;
let service: ProductionPdfService, visuals: CurrentPdfService, trust: CertificateTrustService, evaluate: any;
const pack = (name: string, xml: string | Buffer) => Buffer.from(zipSync({ [name]: Buffer.from(xml) }, { level: 0, mtime: new Date(2000, 0, 1) }));
beforeAll(async () => {
  pki = createGuideSidecarPki(); directory = await mkdtemp(join(tmpdir(), 'factuez-receipt-pdf-unit-'));
  archive = new PublicSignerArchive(join(directory, 'artifacts'));
  await archive.archive(ruc, inspectCertificate(pki.issuer.pkcs12, pki.password));
  await writeFile(join(directory, 'fictitious-cdr.pem'), pki.sunat.certificatePem + pki.rootPem, { flag: 'wx' });
}, 30000);
afterAll(async () => {
  for (const signer of [pki.issuer, pki.otherIssuer, pki.sunat]) signer.pkcs12.fill(0);
  if (!directory.startsWith(join(tmpdir(), 'factuez-receipt-pdf-unit-'))) throw new Error('UNSAFE_CLEANUP');
  await rm(directory, { recursive: true, force: true });
});
function add(owner: 'document' | 'batch', kind: string, bytes: Buffer, filename?: string) {
  const target = owner === 'document' ? document : batch, ownerId = owner === 'document' ? snapshot.documentId : expected.documentId;
  const storageKey = `${ownerId}/${hash(bytes)}-${filename ?? kind}`;
  const artifact = { [owner === 'document' ? 'documentId' : 'batchId']: owner === 'document' ? snapshot.documentId : batch.id,
    kind, storageKey, sha256: hash(bytes), sizeBytes: BigInt(bytes.length), mediaType: kind.endsWith('ZIP') ? 'application/zip' : 'application/xml' };
  target.artifacts = target.artifacts.filter((a: any) => a.kind !== kind); target.artifacts.push(artifact); store.bytes.set(storageKey, Buffer.from(bytes));
  return artifact;
}
const stored = (a: any) => ({ storageKey: a.storageKey, sha256: a.sha256, sizeBytes: Number(a.sizeBytes) });
function persistManifest() { submission.errorMessage = JSON.stringify(metadata); }
function summary(xml: string = prepared.request.xml, zip?: Buffer) {
  manifest.xml = stored(add('batch', 'SIGNED_XML', Buffer.from(xml), `${ruc}-${reference}.xml`));
  manifest.zip = stored(add('batch', 'SUBMISSION_ZIP', zip ?? pack(`${ruc}-${reference}.xml`, xml), `${ruc}-${reference}.zip`));
  submission.requestArtifactKey = manifest.zip.storageKey; persistManifest();
}
function cdr(code = '0', edit: (xml: string) => string = s => s, observations = false, id = reference) {
  const cdrExpected = { issuerRuc: ruc, documentType: 'RC', fullNumber: id } as any;
  let xml = guideSidecarCdrXml(cdrExpected, code);
  if (observations) xml = xml.replace('<cac:SenderParty>', '<cbc:Note>FICTITIOUS RC OBSERVATION</cbc:Note><cac:SenderParty>');
  const signed = pki.signCdr(edit(xml));
  // Production RC CDR name has no individual 03 segment.
  const zip = pack(`R-${ruc}-${id}.xml`, signed);
  add('batch', 'CDR_XML', Buffer.from(signed), `R-${ruc}-${id}.xml`); add('batch', 'CDR_ZIP', zip, `R-${ruc}-${id}.zip`);
  add('document', 'CDR_XML', Buffer.from(signed), `R-${ruc}-${id}.xml`);
  submission.responseArtifactKey = add('document', 'CDR_ZIP', zip, `R-${ruc}-${id}.zip`).storageKey;
}
const run = (format: 'a4' | 'ticket' = 'a4') => service.document(snapshot, format, token);
beforeEach(() => {
  Object.defineProperty(runtimeRenderer, 'renderProductionReceiptPdf', { configurable: true, value: renderProductionReceiptPdf });
  vi.stubEnv('PRINT_SETTINGS_ENABLED', 'false');
  for (const key of ['SUNAT_TRUST_STORE_FILE', 'SUNAT_TRUST_STORE_SHA256', 'SUNAT_CRL_BUNDLE_FILE', 'SUNAT_CRL_BUNDLE_SHA256', 'SUNAT_OPENSSL_PATH']) vi.stubEnv(key, '');
  vi.stubEnv('SUNAT_CDR_SIGNER_CERT_FILE', join(directory, 'fictitious-cdr.pem'));
  vi.stubEnv('SUNAT_CDR_SIGNER_CERT_SHA256', hash(pki.sunat.certificatePem + pki.rootPem));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NETWORK_FORBIDDEN'); }));
  snapshot = documentSample('03') as FiscalDocumentSnapshot;
  snapshot.environment = 'PRODUCTION'; snapshot.branchId = '20000000-0000-4000-8000-000000000001';
  Object.assign(snapshot.issuer, { identityNumber: ruc, establishmentCode: '0000' }); snapshot.customer.identityNumber = '20131312955';
  Object.assign(snapshot.printPresentation!, { issuerRuc: ruc, branchId: snapshot.branchId });
  prepared = prepareBetaXml(snapshot, pki.issuer.pkcs12, pki.password, reference);
  expected = buildReceiptSummarySnapshot(snapshot, reference);
  document = { documentId: snapshot.documentId, documentType: '03', issuerRuc: ruc, series: snapshot.series, number: 1n,
    environment: 'PRODUCTION', status: 'ACCEPTED', immutablePayload: structuredClone(snapshot), digestValue: prepared.document.digestValue,
    billingEventId: '50000000-0000-4000-8000-000000000010', acceptedAt: new Date(), artifacts: [] };
  batch = { id: '50000000-0000-4000-8000-000000000011', summaryId: snapshot.documentId, identifier: reference,
    environment: 'PRODUCTION', issuerRuc: ruc, status: 'ACCEPTED', billingEventId: document.billingEventId,
    immutablePayload: structuredClone(expected), artifacts: [] };
  store = { bytes: new Map<string, Buffer>(), read: vi.fn(async (id: string, a: any) => {
    if (!a.storageKey.startsWith(id + '/')) throw new Error('CROSS_OWNER_READ'); return Buffer.from(store.bytes.get(a.storageKey));
  }) };
  manifest = { reference, fileName: `${ruc}-${reference}.zip`, requestOwnerId: expected.documentId,
    revision: 7, fingerprint: pki.issuer.fingerprint, documentSnapshotSha256: fiscalSnapshotSha256(snapshot), digest: prepared.document.digestValue,
    documentXml: stored(add('document', 'SIGNED_XML', Buffer.from(prepared.document.xml))),
    individualXmlZip: stored(add('document', 'SUBMISSION_ZIP', prepared.individualZip!)), xsdEvidence: { fixtureOnly: true } };
  metadata = { version: 1, eventId: document.billingEventId, correlationId: '50000000-0000-4000-8000-000000000012', prepared: manifest };
  submission = { id: '50000000-0000-4000-8000-000000000013', documentId: snapshot.documentId, batchId: batch.id,
    channel: 'SOAP_SEND_SUMMARY', idempotencyKey: `production:${snapshot.documentId}:v1`, result: 'SUCCESS', errorCode: 'DONE', completedAt: new Date() };
  summary(); cdr();
  db = { fiscalDocument: { findUnique: vi.fn(async () => structuredClone(document)) },
    fiscalBatch: { findUnique: vi.fn(async () => structuredClone(batch)) },
    sunatSubmission: { findMany: vi.fn(async () => [structuredClone(submission)]) } };
  trust = new CertificateTrustService();
  // Ephemeral chain is cryptographically verified. Positive CRL policy is an explicit unit double.
  evaluate = vi.spyOn(trust, 'evaluate').mockImplementation(async (m, expectedRuc, now = new Date()) => {
    forge.pki.verifyCertificateChain(forge.pki.createCaStore([pki.rootPem]), [forge.pki.certificateFromPem(m.certificatePem)]);
    return { profile: 'OFFLINE-PINNED-ROOTS-CRL-v1', chainValid: true, identityMatched: m.subjectRucCandidates[0] === expectedRuc,
      revocation: 'VERIFIED_OFFLINE_CRL', certificateFingerprint: m.fingerprint, trustStoreSha256: hash(pki.rootPem), blockers: [], checkedAt: now.toISOString() };
  });
  visuals = new CurrentPdfService(); draw = vi.fn(async (s, format, proof) => Buffer.from('%PDF-' + JSON.stringify({ s, format, proof })));
  service = new ProductionPdfService(db, store, visuals, trust, new CdrSignatureTrustService(trust), archive, draw);
});
afterEach(() => {
  service.onModuleDestroy(); visuals.onModuleDestroy(); expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  if (priorReceiptExport) Object.defineProperty(runtimeRenderer, 'renderProductionReceiptPdf', priorReceiptExport);
  else delete runtimeRenderer.renderProductionReceiptPdf;
});

describe('production boleta PDF: original individual XML, exact initial RC and summary CDR', () => {
  it('uses the individual 03 digest/QR and all exact RC/batch/submission originals before each cache hit', async () => {
    const before = structuredClone({ snapshot, document, submission, batch });
    const first = await run(), second = await run(); expect(first).toEqual(second); expect(draw).toHaveBeenCalledOnce();
    const proof = draw.mock.calls[0][2];
    expect(proof.status).toBe('ACCEPTED'); expect(proof.digestValue).toBe(prepared.document.digestValue);
    expect(proof.digestValue).not.toBe(prepared.request.digestValue);
    expect(proof.qrPayload).toBe([ruc, '03', snapshot.series, '1', '7.06', '46.25', '2026-10-01', '6', '20131312955', prepared.document.digestValue].join('|') + '|');
    expect(proof.receiptSummary).toMatchObject({ identifier: reference, summaryXmlSha256: manifest.xml.sha256, summaryZipSha256: manifest.zip.sha256,
      individualXmlSha256: manifest.documentXml.sha256, individualZipSha256: manifest.individualXmlZip.sha256,
      cdrXmlSha256: batch.artifacts.find((a: any) => a.kind === 'CDR_XML').sha256, cdrZipSha256: batch.artifacts.find((a: any) => a.kind === 'CDR_ZIP').sha256 });
    expect(db.sunatSubmission.findMany).toHaveBeenCalledTimes(2); expect(db.fiscalBatch.findUnique).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenCalledTimes(6); expect(store.read).toHaveBeenCalledTimes(16);
    expect({ snapshot, document, submission, batch }).toEqual(before);
  });
  it('reconstructs an old RC from its stable day after seven days without moving the PKI/CRL clock into the past', async () => {
    const oldBatch = structuredClone(batch.immutablePayload), oldUbl = buildReceiptSummary(snapshot, reference, 'REAL_PREPARATION');
    const downloadTime = new Date(Date.now() + 8 * 86400000);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(downloadTime);
    const stableTime = '2026-10-02T23:59:59.999-05:00';
    expect(buildReceiptSummarySnapshot(snapshot, reference, stableTime)).toEqual(oldBatch);
    // The seven-day rule relates RC day to member issue day, not download day to RC day.
    expect(buildReceiptSummary(snapshot, reference, 'REAL_PREPARATION')).toBe(oldUbl);
    await run(); expect(draw).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls).toHaveLength(3);
    expect(evaluate.mock.calls.slice(0, 2).every((call: any[]) => call[2].getTime() === downloadTime.getTime())).toBe(true);
    // CDR trust uses evaluate's default current clock, not an explicit asOf parameter.
    for (const result of evaluate.mock.results) expect((await result.value).checkedAt).toBe(downloadTime.toISOString());
  });
  it.each(['REJECTED', 'ACCEPTED_WITH_OBSERVATIONS'])('derives %s only from matching original RC CDR and member owner states', async status => {
    document.status = batch.status = status; submission.result = status === 'REJECTED' ? 'BUSINESS_ERROR' : 'SUCCESS';
    cdr(status === 'REJECTED' ? '2335' : '0', s => s, status === 'ACCEPTED_WITH_OBSERVATIONS');
    await run(); expect(draw.mock.calls[0][2]).toMatchObject({ status, receiptSummary: { identifier: reference } });
    if (status === 'ACCEPTED_WITH_OBSERVATIONS') expect(draw.mock.calls[0][2].cdrNotes).toEqual(['FICTITIOUS RC OBSERVATION']);
  });
  it('allows pending only with exact signed member/RC binding and no final CDR evidence', async () => {
    document.status = batch.status = 'SUBMITTED'; document.acceptedAt = null; submission.result = 'PENDING'; submission.errorCode = 'WAITING_TICKET'; submission.completedAt = null;
    document.artifacts = document.artifacts.filter((a: any) => !a.kind.startsWith('CDR')); batch.artifacts = batch.artifacts.filter((a: any) => !a.kind.startsWith('CDR'));
    await run(); expect(draw.mock.calls[0][2]).toMatchObject({ status: 'PENDING', receiptSummary: { identifier: reference } });
    expect(draw.mock.calls[0][2].responseCode).toBeUndefined(); expect(draw.mock.calls[0][2].receiptSummary.cdrXmlSha256).toBeUndefined();
  });
  it.each(['missing', 'multiple', 'namespace', 'document', 'batch', 'channel', 'request', 'response', 'phase', 'result', 'completion', 'metadata-json', 'metadata-version', 'event'])('fails closed for submission %s', async change => {
    if (change === 'missing') db.sunatSubmission.findMany.mockResolvedValue([]);
    if (change === 'multiple') db.sunatSubmission.findMany.mockResolvedValue([submission, submission]);
    if (change === 'namespace') submission.idempotencyKey = `beta:${snapshot.documentId}:v1`;
    if (change === 'document') submission.documentId = batch.id; if (change === 'batch') submission.batchId = snapshot.documentId;
    if (change === 'channel') submission.channel = 'SOAP_SEND_BILL'; if (change === 'request') submission.requestArtifactKey = 'OTHER';
    if (change === 'response') submission.responseArtifactKey = 'OTHER'; if (change === 'phase') submission.errorCode = 'CDR_UNVERIFIED';
    if (change === 'result') submission.result = 'PENDING'; if (change === 'completion') submission.completedAt = null;
    if (change === 'metadata-json') submission.errorMessage = '{broken'; if (change === 'metadata-version') { metadata.version = 2; persistManifest(); }
    if (change === 'event') { metadata.eventId = batch.id; persistManifest(); }
    await expect(run()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['missing', 'id', 'summaryId', 'environment', 'issuerRuc', 'identifier', 'billingEventId', 'status', 'member', 'condition', 'duplicate'])('fails closed for batch %s', async change => {
    if (change === 'missing') db.fiscalBatch.findUnique.mockResolvedValue(null);
    else if (change === 'member') batch.immutablePayload.input.entries[0].document.snapshot.totals.payableAmount = '999.00';
    else if (change === 'condition') batch.immutablePayload.input.entries[0].conditionCode = '3';
    else if (change === 'duplicate') batch.immutablePayload.input.entries.push(structuredClone(batch.immutablePayload.input.entries[0]));
    else batch[change] = change === 'environment' ? 'BETA' : 'OTHER';
    await expect(run()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['missing', 'reference', 'fileName', 'requestOwnerId', 'fingerprint', 'digest', 'documentSnapshotSha256', 'revision', 'documentXml', 'individualXmlZip', 'xml', 'zip'])('fails closed for prepared manifest %s', async change => {
    if (change === 'missing') delete metadata.prepared;
    else if (['documentXml', 'individualXmlZip', 'xml', 'zip'].includes(change)) manifest[change].sha256 = '0'.repeat(64);
    else manifest[change] = change === 'revision' ? -1 : 'OTHER';
    persistManifest(); await expect(run()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['document:SIGNED_XML', 'document:SUBMISSION_ZIP', 'batch:SIGNED_XML', 'batch:SUBMISSION_ZIP', 'batch:CDR_XML', 'batch:CDR_ZIP', 'document:CDR_XML', 'document:CDR_ZIP'])('rechecks original %s after an existing cache hit', async key => {
    await run(); const [owner, kind] = key.split(':'), a = (owner === 'document' ? document : batch).artifacts.find((a: any) => a.kind === kind);
    store.bytes.set(a.storageKey, Buffer.from('TAMPERED'));
    await expect(run()).rejects.toMatchObject({ status: 409 }); expect(draw).toHaveBeenCalledOnce();
  });
  it.each(['SIGNED_XML', 'SUBMISSION_ZIP', 'CDR_XML', 'CDR_ZIP'])('requires exact batch original %s without substituting individual files', async kind => {
    batch.artifacts = batch.artifacts.filter((a: any) => a.kind !== kind);
    await expect(run()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['owner', 'duplicate', 'media', 'path'])('rejects batch artifact %s mismatch', async change => {
    const a = batch.artifacts.find((a: any) => a.kind === 'SIGNED_XML');
    if (change === 'owner') a.batchId = snapshot.documentId; if (change === 'duplicate') batch.artifacts.push({ ...a });
    if (change === 'media') a.mediaType = 'text/plain';
    if (change === 'path') { a.storageKey = `${snapshot.documentId}/summary.xml`; manifest.xml.storageKey = a.storageKey; persistManifest(); }
    await expect(run()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['member', 'duplicate', 'condition', 'signer', 'digest', 'xmlzip', 'crc', 'filename'])('rejects canonical signed RC or exact ZIP mismatch: %s', async change => {
    let xml = buildReceiptSummary(snapshot, reference, 'REAL_PREPARATION');
    if (change === 'member') xml = xml.replace(snapshot.fullNumber, 'BQ00-2');
    if (change === 'condition') xml = xml.replace('<cbc:ConditionCode>1', '<cbc:ConditionCode>3');
    if (change === 'duplicate') { const line = xml.match(/<sac:SummaryDocumentsLine>[\s\S]*?<\/sac:SummaryDocumentsLine>/)![0]; xml = xml.replace('</SummaryDocuments>', line + '</SummaryDocuments>'); }
    const signed = new XmlSignerService().sign(xml, change === 'signer' ? pki.otherIssuer.pkcs12 : pki.issuer.pkcs12, pki.password, 'SummaryDocuments');
    if (change === 'digest') signed.xml = signed.xml.replace('46.25', '46.26');
    if (change === 'xmlzip') summary(signed.xml, pack(`${ruc}-${reference}.xml`, prepared.document.xml));
    else if (change === 'filename') summary(signed.xml, pack(`${ruc}-03-${snapshot.fullNumber}.xml`, signed.xml));
    else if (change === 'crc') { const zip = pack(`${ruc}-${reference}.xml`, signed.xml); zip[14] ^= 1; summary(signed.xml, zip); }
    else summary(signed.xml);
    await expect(run()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it('rejects an individual ZIP with a different XML even when its manifest/hash are replaced consistently', async () => {
    manifest.individualXmlZip = stored(add('document', 'SUBMISSION_ZIP', pack(`${ruc}-03-${snapshot.fullNumber}.xml`, prepared.request.xml)));
    persistManifest(); await expect(run()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it.each(['individual', 'other-summary', 'receiver', 'response-reference', 'type', 'signature', 'state', 'copy', 'pin'])('rejects CDR without exact summary relationship: %s', async change => {
    if (change === 'individual') {
      const xml = pki.signCdr(guideSidecarCdrXml({ issuerRuc: ruc, fullNumber: snapshot.fullNumber, documentType: '03' } as any));
      const zip = guideSidecarPackCdr(xml, { issuerRuc: ruc, fullNumber: snapshot.fullNumber, documentType: '03' } as any);
      add('batch', 'CDR_XML', Buffer.from(xml)); add('batch', 'CDR_ZIP', zip); add('document', 'CDR_XML', Buffer.from(xml)); submission.responseArtifactKey = add('document', 'CDR_ZIP', zip).storageKey;
    }
    if (change === 'other-summary') cdr('0', s => s, false, 'RC-20261002-2');
    if (change === 'receiver') cdr('0', xml => xml.replace(`<cbc:ID>${ruc}</cbc:ID>`, '<cbc:ID>20131312955</cbc:ID>'));
    if (change === 'response-reference') cdr('0', xml => xml.replace(`<cbc:ReferenceID>${reference}`, '<cbc:ReferenceID>RC-20261002-2'));
    if (change === 'type') cdr('0', xml => xml.replace('<cbc:DocumentTypeCode>RC', '<cbc:DocumentTypeCode>03'));
    if (change === 'state') cdr('2335');
    if (change === 'signature') {
      const a = batch.artifacts.find((a: any) => a.kind === 'CDR_XML'), xml = store.bytes.get(a.storageKey).toString().replace('FICTITIOUS LOCAL RECEIPT', 'TAMPERED');
      const zip = pack(`R-${ruc}-${reference}.xml`, xml); add('batch', 'CDR_XML', Buffer.from(xml)); add('batch', 'CDR_ZIP', zip); add('document', 'CDR_XML', Buffer.from(xml)); submission.responseArtifactKey = add('document', 'CDR_ZIP', zip).storageKey;
    }
    if (change === 'copy') add('document', 'CDR_XML', Buffer.from('OTHER ORIGINAL'));
    if (change === 'pin') vi.stubEnv('SUNAT_CDR_SIGNER_CERT_SHA256', '0'.repeat(64));
    await expect(run()).rejects.toMatchObject({ status: 409 }); expect(draw).not.toHaveBeenCalled();
  });
  it('revalidates summary issuer chain/CRL before hits instead of relying on a summary HTTP flag', async () => {
    await run(); const implementation = evaluate.getMockImplementation(); let checks = 0;
    evaluate.mockImplementation(async (...args: any[]) => {
      const proof = await implementation(...args); return ++checks === 2 ? { ...proof, revocation: 'INVALID' } : proof;
    });
    await expect(run()).rejects.toMatchObject({ status: 409 }); expect(draw).toHaveBeenCalledOnce(); expect(checks).toBe(2);
  });
  it('cache identity includes exact original CDR bytes even when status, code and description stay identical', async () => {
    await run(); cdr('0', xml => xml.replace('<cbc:ID>FICTITIOUS-LOCAL-GUIDE-CDR', '<cbc:ID>OTHER-FICTITIOUS-CDR-ID'));
    await run(); expect(draw).toHaveBeenCalledTimes(2);
    expect(draw.mock.calls[0][2].receiptSummary.cdrXmlSha256).not.toBe(draw.mock.calls[1][2].receiptSummary.cdrXmlSha256);
    expect(draw.mock.calls[0][2].qrPayload).toBe(draw.mock.calls[1][2].qrPayload);
  });
  it('cache identity includes exact signed RC/ZIP bytes without replacing the individual QR digest', async () => {
    await run(); const xml = prepared.request.xml.replace('<SummaryDocuments ', '<SummaryDocuments\n ');
    // Canonical XML is unchanged; the original byte hash still changes the productive cache key.
    summary(xml); await run(); expect(draw).toHaveBeenCalledTimes(2);
    expect(draw.mock.calls[0][2].receiptSummary.summaryXmlSha256).not.toBe(draw.mock.calls[1][2].receiptSummary.summaryXmlSha256);
    expect(draw.mock.calls[0][2].digestValue).toBe(draw.mock.calls[1][2].digestValue);
  });
  it('default productive renderer dispatches 03 independently of the strict 01 and QA entries', async () => {
    service.onModuleDestroy(); service = new ProductionPdfService(db, store, visuals, trust, new CdrSignatureTrustService(trust), archive);
    const pdf = await run(); expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // Check the real PDF metadata bytes across the CJS/ESM boundary (UTF-16BE in PDFKit).
    expect(pdf.includes(Buffer.from('BOLETA DE VENTA ELECTRÓNICA · PRODUCCIÓN', 'utf16le').swap16())).toBe(true);
    expect(pdf.includes(Buffer.from('FACTURA ELECTRÓNICA · PRODUCCIÓN', 'utf16le').swap16())).toBe(false);
  });
});

describe('production boleta renderer: individual XML QR, summary CDR and clear state', () => {
  it.each(['a4', 'ticket'] as const)('renders %s with correct 03 label, individual digest and RC reference', async format => {
    await run(); const proof = draw.mock.calls[0][2], text = vi.spyOn(PDFDocument.prototype, 'text'), qr = vi.spyOn(QRCode, 'toBuffer');
    const pdf = await renderProductionReceiptPdf(snapshot, format, proof); expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const messages = text.mock.calls.map((a: any[]) => a[0]).join('\n');
    expect(messages).toContain('BOLETA DE VENTA ELECTRÓNICA · PRODUCCIÓN'); expect(messages).toContain(`CDR Resumen RC: ${reference}`);
    expect(messages).toContain(snapshot.fullNumber); expect(messages).toContain(prepared.document.digestValue);
    expect(messages).not.toContain(prepared.request.digestValue); expect(messages).not.toMatch(/FACTURA ELECTRÓNICA|LOCAL \/ BETA|CIRCUITO SIMULADO/);
    const png = PNG.sync.read(await qr.mock.results[0].value);
    expect(decodeQr(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(proof.qrPayload);
  });
  it.each(['PENDING', 'REJECTED', 'ACCEPTED_WITH_OBSERVATIONS'])('labels %s distinctly with summary scope', async status => {
    await run(); const proof = structuredClone(draw.mock.calls[0][2]); proof.status = status;
    if (status === 'PENDING') { delete proof.responseCode; delete proof.receiptSummary.cdrXmlSha256; delete proof.receiptSummary.cdrZipSha256; }
    if (status === 'REJECTED') proof.responseCode = '2335';
    const text = vi.spyOn(PDFDocument.prototype, 'text'); await renderProductionReceiptPdf(snapshot, 'a4', proof);
    expect(text.mock.calls.map((a: any[]) => a[0]).join('\n')).toContain(status === 'PENDING' ? 'PENDIENTE' : status === 'REJECTED' ? 'RECHAZADA' : 'ACEPTADA CON OBSERVACIONES');
  });
  it.each(['01', 'BETA', 'USD', 'missing-rc', 'rc-hash', 'cdr-hash', 'qr-summary-digest'])('rejects incompatible boleta representation %s', async change => {
    await run(); const proof = structuredClone(draw.mock.calls[0][2]);
    if (change === '01') snapshot.documentTypeCode = '01'; if (change === 'BETA') snapshot.environment = 'BETA'; if (change === 'USD') snapshot.currencyCode = 'USD';
    if (change === 'missing-rc') delete proof.receiptSummary; if (change === 'rc-hash') proof.receiptSummary.summaryXmlSha256 = 'INVALID';
    if (change === 'cdr-hash') delete proof.receiptSummary.cdrZipSha256;
    if (change === 'qr-summary-digest') proof.qrPayload = proof.qrPayload.replace(prepared.document.digestValue, prepared.request.digestValue);
    await expect(renderProductionReceiptPdf(snapshot, 'a4', proof)).rejects.toThrow();
  });
  it('the invoice renderer and local renderer still reject a productive boleta', async () => {
    await run(); await expect(renderProductionInvoicePdf(snapshot, 'a4', draw.mock.calls[0][2])).rejects.toThrow();
    await expect(renderLocalDocumentPdf(snapshot, 'a4')).rejects.toThrow('BETA');
  });
});


describe('aceptación original de boleta para notas y bajas, sin PDF ni emisión',()=>{
  it('vincula XML individual, RC firmado y CDR original con prueba de aceptación',async()=>{
    const proof=await service.acceptedArchive(snapshot);
    expect(proof).toMatchObject({profile:'PRODUCTION-03-RC-ARCHIVE-v1',documentId:snapshot.documentId,snapshotSha256:fiscalSnapshotSha256(snapshot),acceptedAt:document.acceptedAt.toISOString(),receiptSummary:{identifier:reference,individualXmlSha256:manifest.documentXml.sha256,summaryXmlSha256:manifest.xml.sha256,summaryZipSha256:manifest.zip.sha256}});
    expect(proof.receiptSummary?.cdrXmlSha256).toBe(proof.cdrXmlSha256);expect(proof.receiptSummary?.cdrZipSha256).toBe(proof.cdrZipSha256);
    expect(draw).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['pending','rejected','missing-time','different-snapshot','different-company','wrong-rc-status','cdr-tampered'])('no acredita %s',async change=>{
    if(change==='pending')document.status='PROCESSING';if(change==='rejected')document.status='REJECTED';if(change==='missing-time')document.acceptedAt=null;
    if(change==='different-snapshot')document.immutablePayload.customer.legalName='SYNTHETIC OTHER';if(change==='different-company')document.issuerRuc='20600000000';
    if(change==='wrong-rc-status')batch.status='REJECTED';if(change==='cdr-tampered'){const a=document.artifacts.find((a:any)=>a.kind==='CDR_XML');store.bytes.set(a.storageKey,Buffer.from('<ApplicationResponse>TAMPERED</ApplicationResponse>'));}
    await expect(service.acceptedArchive(snapshot)).rejects.toThrow();expect(draw).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
});
