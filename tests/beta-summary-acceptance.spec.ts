// Focused, offline run: node node_modules/vitest/vitest.mjs run tests/beta-summary-acceptance.spec.ts --maxWorkers=1 --no-file-parallelism
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import {
  buildFiscalNoteSnapshot, fiscalSnapshotSha256,
  type FiscalAcceptanceEvidence, type FiscalNoteContext, type FiscalNoteInput,
} from '../packages/sunat-core/src/fiscal-note';
import { buildFiscalBatchSnapshot, buildFiscalBatchUbl, type FiscalBatchDocument, type FiscalRcEntry } from '../packages/sunat-core/src/fiscal-batch';
import {
  BetaSummaryAcceptanceError, verifyBetaSummaryAcceptance,
  type BetaSummaryAcceptedBatch, type BetaSummaryAcceptanceErrorCode, type BetaSummaryAcceptancePorts,
} from '../services/sunat-service/src/application/beta-summary-acceptance';

const { zipSync } = createRequire(new URL('../services/sunat-service/package.json', import.meta.url))('fflate') as typeof import('../services/sunat-service/node_modules/fflate');
const AS_OF = '2026-10-04T18:00:00Z';
const ACCEPTED_AT = '2026-10-03T18:00:00Z';
const RUC = '20100070970';
const IDENTIFIER = 'RC-20261003-1';
const XML_NAME = `R-${RUC}-${IDENTIFIER}.xml`;
const EXT = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const SIGNATURE = '<ds:Signature Id="fixture-only"><ds:SignedInfo/></ds:Signature>';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const uuid = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Identidades estructurales y evidencia simulada: sin certificados, SQL, red ni emisión.
// Signature es sólo un marcador; estas pruebas verifican el contrato del puerto,
// no acreditan criptografía ni confianza SUNAT (eso pertenece al adaptador).
function receipt(n: number, price = '118'): FiscalDocumentSnapshot {
  return {
    documentId: uuid(n), companyId: 1, branchId: uuid(999), documentTypeCode: '03', environment: 'BETA',
    series: 'B001', number: String(n), fullNumber: `B001-${n}`, issueDate: '2026-10-02T16:00:00Z',
    currencyCode: 'PEN', operationTypeCode: '0101',
    issuer: { identityType: '6', identityNumber: RUC, legalName: 'EMISOR FICTICIO & BETA', address: 'Dirección ficticia 123', ubigeo: '150101', establishmentCode: '0001' },
    customer: { identityType: '1', identityNumber: '12345678', legalName: 'CLIENTE FICTICIO' },
    ...calculateDocumentTotals([{ description: 'PRUEBA SIN VENTA', unitCode: 'NIU', quantity: '2', unitPriceWithTax: price, taxAffectationCode: '10', igvRate: '18' }]),
  };
}
function priorAcceptance(doc: FiscalBatchDocument['snapshot']): FiscalAcceptanceEvidence {
  return {
    environment: 'BETA', issuerRuc: RUC, documentId: doc.documentId, documentTypeCode: doc.documentTypeCode as '03' | '07' | '08',
    fullNumber: doc.fullNumber, snapshotSha256: fiscalSnapshotSha256(doc), cdrSha256: 'c'.repeat(64), responseCode: '0', status: 'ACCEPTED',
    acceptedAt: '2026-10-02T16:10:00Z',
    source: { kind: 'CDR_SUMMARY', identifier: 'RC-20261002-1', referenceDate: '2026-10-02', lineNumber: 1, conditionCode: '1' },
  };
}
function note(n: number, input: FiscalNoteInput): FiscalBatchDocument {
  const original = receipt(50);
  const noteContext: FiscalNoteContext = { original, acceptance: priorAcceptance(original), asOf: AS_OF, creditHistory: { complete: true, entries: [] } };
  return { snapshot: buildFiscalNoteSnapshot(noteContext, input, { documentId: uuid(n), series: 'BN01', number: String(n), issueDate: '2026-10-02T17:00:00Z' }), noteContext };
}
function members(): FiscalRcEntry[] {
  const old = receipt(2), cancelled = receipt(3);
  return [
    { conditionCode: '1', document: { snapshot: receipt(1) } },
    { conditionCode: '2', document: { snapshot: receipt(2, '59') }, previous: { document: { snapshot: old }, acceptance: priorAcceptance(old) } },
    { conditionCode: '3', document: { snapshot: cancelled }, previous: { document: { snapshot: cancelled }, acceptance: priorAcceptance(cancelled) },
      notDelivered: { status: 'NOT_DELIVERED', documentId: cancelled.documentId, documentTypeCode: '03', fullNumber: cancelled.fullNumber,
        issuerRuc: RUC, snapshotSha256: fiscalSnapshotSha256(cancelled), evidenceId: uuid(800), assertedAt: '2026-10-03T16:00:00Z' } },
    { conditionCode: '1', document: note(10, { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'Devolución parcial ficticia', lines: [{ originalLineNumber: 1, quantity: '1' }] }) },
    { conditionCode: '1', document: note(11, { documentTypeCode: '08', reasonCode: '01', reasonDescription: 'Mora ficticia', interestNature: 'MORATORIO', interestBasis: 'Sustento ficticio aislado', lines: [{ originalLineNumber: 1, interestAmount: '10.00' }] }) },
  ];
}
function cdrXml(observations = false): string {
  return `<?xml version="1.0" encoding="UTF-8"?><ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:ext="${EXT}" xmlns:cbc="${CBC}" xmlns:cac="${CAC}" xmlns:ds="${DS}">
<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent>${SIGNATURE}</ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>
<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:ID>CDR-FICTICIO</cbc:ID><cbc:IssueDate>2026-10-03</cbc:IssueDate>
${observations ? '<cbc:Note>OBSERVACIÓN FICTICIA</cbc:Note>' : ''}
<cac:SenderParty><cac:PartyIdentification><cbc:ID>20131312955</cbc:ID></cac:PartyIdentification></cac:SenderParty>
<cac:ReceiverParty><cac:PartyIdentification><cbc:ID>${RUC}</cbc:ID></cac:PartyIdentification></cac:ReceiverParty>
<cac:DocumentResponse><cac:Response><cbc:ReferenceID>${IDENTIFIER}</cbc:ReferenceID><cbc:ResponseCode>0</cbc:ResponseCode><cbc:Description>ACEPTACIÓN FICTICIA &amp; AISLADA</cbc:Description></cac:Response>
<cac:DocumentReference><cbc:ID>${IDENTIFIER}</cbc:ID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;
}
function pack(xml: Buffer, name = XML_NAME, dummy = false, level: 0 | 6 = 6): Buffer {
  return Buffer.from(zipSync({ [name]: xml, ...(dummy ? { 'dummy/': new Uint8Array() } : {}) }, { level }));
}
function fixture(lineNumber = 1, observations = false) {
  const batch = buildFiscalBatchSnapshot({ kind: 'RC', entries: members() }, {
    documentId: uuid(900), identifier: IDENTIFIER, issueDate: '2026-10-03', referenceDate: '2026-10-02',
  }, AS_OF);
  const doc = structuredClone(batch.input.entries[lineNumber - 1].document.snapshot);
  const xml = Buffer.from(cdrXml(observations)), zip = pack(xml);
  const status = observations ? 'ACCEPTED_WITH_OBSERVATIONS' as const : 'ACCEPTED' as const;
  const evidence: FiscalAcceptanceEvidence = { ...priorAcceptance(doc), acceptedAt: ACCEPTED_AT, cdrSha256: hash(zip), status,
    source: { kind: 'CDR_SUMMARY', identifier: IDENTIFIER, referenceDate: '2026-10-02', lineNumber, conditionCode: lineNumber === 2 ? '2' : '1' } };
  const record: BetaSummaryAcceptedBatch = { batch, completedAt: ACCEPTED_AT, status,
    cdrZip: { fileName: `R-${RUC}-${IDENTIFIER}.zip`, sha256: hash(zip), sizeBytes: zip.length, storageKey: 'memory/cdr-fixture' } };
  const f = { doc, evidence, record, xml, zip };
  const ports = {
    loadBatch: vi.fn(async (_ruc: string, _environment: 'BETA', _identifier: string): Promise<BetaSummaryAcceptedBatch | null> => record),
    readCdr: vi.fn(async (_record: BetaSummaryAcceptedBatch): Promise<Buffer> => f.zip),
    verifySignature: vi.fn(async (_xml: Buffer): Promise<boolean> => true),
  } satisfies BetaSummaryAcceptancePorts;
  return { ...f, ports, run: () => verifyBetaSummaryAcceptance(f.doc, f.evidence, AS_OF, ports),
    // Keep the port's byte source and the test's byte source synchronized.
    setZip(bytes: Buffer) { f.zip = bytes; this.zip = bytes; evidence.cdrSha256 = hash(bytes); record.cdrZip.sha256 = hash(bytes); record.cdrZip.sizeBytes = bytes.length; },
  };
}
type Fixture = ReturnType<typeof fixture>;
function replaceXml(f: Fixture, xml: string | Buffer, name = XML_NAME, dummy = false, level: 0 | 6 = 6) {
  f.xml = Buffer.isBuffer(xml) ? Buffer.from(xml) : Buffer.from(xml);
  f.setZip(pack(f.xml, name, dummy, level));
}
function requestXml(f: Fixture, xml = buildFiscalBatchUbl(f.record.batch, AS_OF)) {
  const bytes = Buffer.from(xml); f.record.requestXml = { bytes, sha256: hash(bytes) };
}
async function rejects(f: Fixture, code: BetaSummaryAcceptanceErrorCode) {
  const error = await f.run().then(() => { throw new Error(`Expected rejection: ${code}`); }, error => error);
  expect(error).toBeInstanceOf(BetaSummaryAcceptanceError);
  expect(error).toMatchObject({ code, name: 'BetaSummaryAcceptanceError' });
}

describe('RC BETA: acceptance bound to the exact member and version', () => {
  it.each([1, 2, 4, 5])('accepts line %s only after the complete CDR reaches the signature port and the batch is reread', async line => {
    const f = fixture(line), before = fiscalSnapshotSha256({ doc: f.doc, evidence: f.evidence, batch: f.record.batch });
    const result = await f.run();
    expect(result).toEqual({ environment: 'BETA', issuerRuc: RUC, batchDocumentId: uuid(900), identifier: IDENTIFIER,
      batchSnapshotSha256: fiscalSnapshotSha256(f.record.batch), documentId: f.doc.documentId, documentTypeCode: f.doc.documentTypeCode,
      fullNumber: f.doc.fullNumber, snapshotSha256: fiscalSnapshotSha256(f.doc), referenceDate: '2026-10-02', lineNumber: line,
      conditionCode: line === 2 ? '2' : '1', acceptedAt: ACCEPTED_AT, status: 'ACCEPTED', responseCode: '0', cdrFileName: XML_NAME,
      cdrZipSha256: hash(f.zip), cdrXmlSha256: hash(f.xml), description: 'ACEPTACIÓN FICTICIA & AISLADA', notes: [] });
    expect(f.ports.loadBatch.mock.calls).toEqual([[RUC, 'BETA', IDENTIFIER], [RUC, 'BETA', IDENTIFIER]]);
    expect(f.ports.readCdr).toHaveBeenCalledOnce(); expect(f.ports.verifySignature).toHaveBeenCalledExactlyOnceWith(f.xml);
    expect(f.ports.verifySignature.mock.invocationCallOrder[0]).toBeLessThan(f.ports.loadBatch.mock.invocationCallOrder[1]);
    expect(fiscalSnapshotSha256({ doc: f.doc, evidence: f.evidence, batch: f.record.batch })).toBe(before);
    expect(result).not.toHaveProperty('requestXmlSha256');
  });
  it('returns observations only when record, evidence and actual CDR agree', async () => {
    const f = fixture(1, true); expect(await f.run()).toMatchObject({ status: 'ACCEPTED_WITH_OBSERVATIONS', notes: ['OBSERVACIÓN FICTICIA'] });
  });
  it('accepts an equivalent fresh authoritative record on reread', async () => {
    const f = fixture(); f.ports.loadBatch.mockImplementation(async () => ({ ...f.record, batch: structuredClone(f.record.batch), cdrZip: { ...f.record.cdrZip } }));
    await expect(f.run()).resolves.toMatchObject({ documentId: f.doc.documentId });
  });
  it('condition 3 never accredits acceptance, even in a globally accepted mixed RC', async () => {
    const f = fixture(3); await rejects(f, 'MEMBER_CONDITION_INVALID'); expect(f.ports.readCdr).not.toHaveBeenCalled();
  });
  it.each([1, 2])('rejects a declaration of condition %s for the other valid condition', async condition => {
    const f = fixture(condition === 1 ? 2 : 1); if (f.evidence.source.kind === 'CDR_SUMMARY') f.evidence.source.conditionCode = String(condition) as '1' | '2';
    await rejects(f, 'MEMBER_CONDITION_INVALID'); expect(f.ports.readCdr).not.toHaveBeenCalled();
  });
  it('does not search for the right member after the declared line points elsewhere', async () => {
    const f = fixture(); if (f.evidence.source.kind === 'CDR_SUMMARY') f.evidence.source.lineNumber = 4;
    await rejects(f, 'MEMBER_VERSION_MISMATCH'); expect(f.ports.readCdr).not.toHaveBeenCalled();
  });
  it('rejects a declared line absent from the snapshot', async () => {
    const f = fixture(); if (f.evidence.source.kind === 'CDR_SUMMARY') f.evidence.source.lineNumber = 100;
    await rejects(f, 'MEMBER_NOT_FOUND');
  });
  it('does not accredit the previous version from an accepted modification', async () => {
    const f = fixture(2), entry = f.record.batch.input.entries[1] as FiscalRcEntry;
    if (entry.conditionCode !== '2') throw new Error('Fixture');
    Object.assign(f.doc, structuredClone(entry.previous.document.snapshot)); f.evidence.snapshotSha256 = fiscalSnapshotSha256(f.doc);
    await rejects(f, 'MEMBER_VERSION_MISMATCH');
  });
  it.each(['description', 'customer', 'branch', 'documentId'] as const)('checks the whole valid snapshot, including %s', async field => {
    const f = fixture();
    if (field === 'description') f.doc.lines[0].description = 'OTRA VERSIÓN';
    if (field === 'customer') f.doc.customer.legalName = 'OTRO CLIENTE';
    if (field === 'branch') f.doc.branchId = uuid(998);
    if (field === 'documentId') { f.doc.documentId = uuid(98); f.evidence.documentId = f.doc.documentId; }
    f.evidence.snapshotSha256 = fiscalSnapshotSha256(f.doc); await rejects(f, 'MEMBER_VERSION_MISMATCH');
  });
  it.each(['same-id', 'id-case-alias', 'same-number', 'number-leading-zero', 'series-case-alias'] as const)('rejects duplicate fiscal identities: %s', async scenario => {
    const f = fixture(), duplicate = structuredClone(f.record.batch.input.entries[0]);
    if (scenario === 'id-case-alias') duplicate.document.snapshot.documentId = f.doc.documentId.toUpperCase();
    if (!['same-id', 'id-case-alias'].includes(scenario)) duplicate.document.snapshot.documentId = uuid(98);
    if (scenario === 'number-leading-zero') { duplicate.document.snapshot.number = '01'; duplicate.document.snapshot.fullNumber = 'B001-01'; }
    if (scenario === 'series-case-alias') { duplicate.document.snapshot.series = 'b001'; duplicate.document.snapshot.fullNumber = 'b001-1'; }
    (f.record.batch.input.entries as FiscalRcEntry[]).push(duplicate as FiscalRcEntry);
    await rejects(f, 'MEMBER_DUPLICATE'); expect(f.ports.readCdr).not.toHaveBeenCalled();
  });
  it.each(['source-kind', 'condition-3', 'line-zero', 'line-fraction', 'other-hash', 'uppercase-hash', 'other-ruc', 'other-document', 'other-number', 'response-code', 'rejected', 'production', 'reference-date', 'bad-identifier'] as const)('rejects malformed or unrelated evidence before reading the batch: %s', async scenario => {
    const f = fixture(), e = f.evidence;
    switch (scenario) {
      case 'source-kind': e.source = { kind: 'CDR_DOCUMENT' }; break;
      case 'condition-3': if (e.source.kind === 'CDR_SUMMARY') e.source.conditionCode = '3' as never; break;
      case 'line-zero': if (e.source.kind === 'CDR_SUMMARY') e.source.lineNumber = 0; break;
      case 'line-fraction': if (e.source.kind === 'CDR_SUMMARY') e.source.lineNumber = 1.5; break;
      case 'other-hash': e.snapshotSha256 = 'f'.repeat(64); break;
      case 'uppercase-hash': e.cdrSha256 = 'A'.repeat(64); break;
      case 'other-ruc': e.issuerRuc = '20131312955'; break;
      case 'other-document': e.documentId = uuid(98); break;
      case 'other-number': e.fullNumber = 'B001-98'; break;
      case 'response-code': e.responseCode = '99' as never; break;
      case 'rejected': e.status = 'REJECTED' as never; break;
      case 'production': e.environment = 'PRODUCTION' as never; break;
      case 'reference-date': if (e.source.kind === 'CDR_SUMMARY') e.source.referenceDate = '2026-10-01'; break;
      case 'bad-identifier': if (e.source.kind === 'CDR_SUMMARY') e.source.identifier = 'RC-20260230-1'; break;
    }
    await rejects(f, 'FISCAL_EVIDENCE_INVALID'); expect(f.ports.loadBatch).not.toHaveBeenCalled(); expect(f.ports.verifySignature).not.toHaveBeenCalled();
  });
  it('rejects a production document before any port', async () => {
    const f = fixture(); f.doc.environment = 'PRODUCTION' as never; f.evidence.snapshotSha256 = fiscalSnapshotSha256(f.doc);
    await rejects(f, 'FISCAL_EVIDENCE_INVALID'); expect(f.ports.loadBatch).not.toHaveBeenCalled();
  });
  it.each(['environment', 'kind', 'identifier', 'referenceDate', 'issuer', 'totals', 'status'] as const)('rejects an invalid authoritative batch: %s', async field => {
    const f = fixture(), b = f.record.batch;
    if (field === 'environment') b.environment = 'PRODUCTION' as never;
    if (field === 'kind') b.kind = 'RA';
    if (field === 'identifier') b.identifier = 'RC-20261003-2';
    if (field === 'referenceDate') b.referenceDate = '2026-10-01';
    if (field === 'issuer') b.issuer.identityNumber = '20131312955';
    if (field === 'totals') b.totals.payableAmount = '0.00';
    if (field === 'status') f.record.status = 'REJECTED' as never;
    await rejects(f, 'BATCH_INVALID'); expect(f.ports.readCdr).not.toHaveBeenCalled();
  });
  it.each(['2026-10-03T18:01:00Z', '2026-10-03T13:00:00-05:00', '2026-10-05T18:00:00Z', '2026-10-02T18:00:00Z'])('requires the exact recorded acceptance instant: %s', async completedAt => {
    const f = fixture(); f.record.completedAt = completedAt; await rejects(f, 'ACCEPTANCE_TIME_MISMATCH');
  });
});

describe('RC CDR artifact, ZIP integrity and signature boundary', () => {
  it.each([false, true])('accepts a bounded ZIP with optional empty dummy directory: %s', async dummy => {
    const f = fixture(); replaceXml(f, f.xml, XML_NAME, dummy); await expect(f.run()).resolves.toMatchObject({ cdrZipSha256: hash(f.zip) });
  });
  it('accepts stored XML as well as deflated XML', async () => {
    const f = fixture(); replaceXml(f, f.xml, XML_NAME, false, 0); await expect(f.run()).resolves.toMatchObject({ cdrXmlSha256: hash(f.xml) });
  });
  it.each(['fileName', 'sha256', 'sizeBytes', 'oversized'] as const)('rejects CDR artifact metadata mismatch: %s', async field => {
    const f = fixture();
    if (field === 'fileName') f.record.cdrZip.fileName = `R-${RUC}-RC-20261003-2.zip`;
    if (field === 'sha256') f.record.cdrZip.sha256 = 'f'.repeat(64);
    if (field === 'sizeBytes') f.record.cdrZip.sizeBytes++;
    if (field === 'oversized') f.record.cdrZip.sizeBytes = 4 * 1024 * 1024 + 1;
    await rejects(f, 'CDR_ARTIFACT_MISMATCH'); expect(f.ports.verifySignature).not.toHaveBeenCalled();
  });
  it.each(['same-size-tamper', 'truncated'] as const)('hashes the actual archived bytes: %s', async scenario => {
    const f = fixture(), changed = Buffer.from(f.zip);
    changed[changed.length - 1] ^= 1;
    f.ports.readCdr.mockResolvedValue(scenario === 'truncated' ? changed.subarray(0, -1) : changed);
    await rejects(f, 'CDR_ARTIFACT_MISMATCH'); expect(f.ports.verifySignature).not.toHaveBeenCalled();
  });
  it('rejects forged CRC even when local/central headers and the outer SHA256 agree', async () => {
    const f = fixture(), zip = Buffer.from(f.zip), central = zip.readUInt32LE(zip.length - 6);
    const badCrc = (zip.readUInt32LE(central + 16) ^ 1) >>> 0;
    zip.writeUInt32LE(badCrc, 14); zip.writeUInt32LE(badCrc, central + 16); f.setZip(zip);
    await rejects(f, 'CDR_INVALID'); expect(f.ports.verifySignature).not.toHaveBeenCalled();
  });
  it.each(['local-crc', 'local-name', 'local-method', 'central-offset', 'encrypted', 'size-bomb', 'extra-file', 'dummy-content', 'path', 'wrong-name', 'trailing'] as const)('rejects ambiguous or unsafe ZIP: %s', async scenario => {
    const f = fixture(), zip = Buffer.from(f.zip), central = zip.readUInt32LE(zip.length - 6);
    switch (scenario) {
      case 'local-crc': zip.writeUInt32LE((zip.readUInt32LE(14) ^ 1) >>> 0, 14); break;
      case 'local-name': zip[30] ^= 1; break;
      case 'local-method': zip.writeUInt16LE(0, 8); break;
      case 'central-offset': zip.writeUInt32LE(1, central + 42); break;
      case 'encrypted': zip.writeUInt16LE(1, 6); zip.writeUInt16LE(1, central + 8); break;
      case 'size-bomb': zip.writeUInt32LE(2 * 1024 * 1024 + 1, central + 24); break;
      case 'extra-file': f.setZip(Buffer.from(zipSync({ [XML_NAME]: f.xml, 'extra.xml': f.xml }))); break;
      case 'dummy-content': f.setZip(Buffer.from(zipSync({ [XML_NAME]: f.xml, 'dummy/': Buffer.from('hidden') }))); break;
      case 'path': replaceXml(f, f.xml, `../${XML_NAME}`); break;
      case 'wrong-name': replaceXml(f, f.xml, `R-${RUC}-RC-20261003-2.xml`); break;
      case 'trailing': f.setZip(Buffer.concat([zip, Buffer.from([0])])); break;
    }
    if (['local-crc', 'local-name', 'local-method', 'central-offset', 'encrypted', 'size-bomb'].includes(scenario)) f.setZip(zip);
    await rejects(f, 'CDR_INVALID'); expect(f.ports.verifySignature).not.toHaveBeenCalled();
  });
  it.each(['receiver', 'sender', 'document-reference', 'response-reference', 'duplicate-sender-id', 'namespace-alias', 'duplicate-response-code', 'bad-date', 'doctype', 'invalid-utf8'] as const)('rejects wrong CDR identity or ambiguous XML: %s', async scenario => {
    const f = fixture(); let xml = cdrXml();
    if (scenario === 'receiver') xml = xml.replace(`<cbc:ID>${RUC}</cbc:ID>`, '<cbc:ID>20131312955</cbc:ID>');
    if (scenario === 'sender') xml = xml.replace('<cbc:ID>20131312955</cbc:ID>', `<cbc:ID>${RUC}</cbc:ID>`);
    if (scenario === 'document-reference') xml = xml.replace(`<cbc:ID>${IDENTIFIER}</cbc:ID>`, '<cbc:ID>RC-20261003-2</cbc:ID>');
    if (scenario === 'response-reference') xml = xml.replace(`<cbc:ReferenceID>${IDENTIFIER}</cbc:ReferenceID>`, '<cbc:ReferenceID>RC-20261003-2</cbc:ReferenceID>');
    if (scenario === 'duplicate-sender-id') xml = xml.replace('<cbc:ID>20131312955</cbc:ID>', '<cbc:ID>20131312955</cbc:ID><cbc:ID>20131312955</cbc:ID>');
    if (scenario === 'namespace-alias') xml = xml.replace('<cbc:ID>20131312955</cbc:ID>', '<cbc:ID>20131312955</cbc:ID><evil:ID xmlns:evil="urn:evil">20131312955</evil:ID>');
    if (scenario === 'duplicate-response-code') xml = xml.replace('<cbc:ResponseCode>0</cbc:ResponseCode>', '<cbc:ResponseCode>0</cbc:ResponseCode><cbc:ResponseCode>0</cbc:ResponseCode>');
    if (scenario === 'bad-date') xml = xml.replace('<cbc:IssueDate>2026-10-03</cbc:IssueDate>', '<cbc:IssueDate>2026-02-30</cbc:IssueDate>');
    if (scenario === 'doctype') xml = xml.replace('<ApplicationResponse ', '<!DOCTYPE ApplicationResponse [<!ENTITY x "fixture">]><ApplicationResponse ');
    replaceXml(f, scenario === 'invalid-utf8' ? Buffer.concat([Buffer.from(xml), Buffer.from([0xff])]) : xml);
    await rejects(f, 'CDR_INVALID'); expect(f.ports.verifySignature).not.toHaveBeenCalled();
  });
  it('does not accredit a rejected CDR even with accepted stored flags', async () => {
    const f = fixture(); replaceXml(f, cdrXml().replace('<cbc:ResponseCode>0</cbc:ResponseCode>', '<cbc:ResponseCode>99</cbc:ResponseCode>'));
    await rejects(f, 'CDR_REJECTED'); expect(f.ports.verifySignature).not.toHaveBeenCalled();
  });
  it.each(['record', 'evidence', 'cdr'] as const)('requires the observed CDR status to match %s', async scenario => {
    const f = fixture();
    if (scenario === 'record') f.record.status = 'ACCEPTED_WITH_OBSERVATIONS';
    if (scenario === 'evidence') f.evidence.status = 'ACCEPTED_WITH_OBSERVATIONS';
    if (scenario === 'cdr') replaceXml(f, cdrXml(true));
    await rejects(f, 'CDR_ARTIFACT_MISMATCH'); expect(f.ports.verifySignature).not.toHaveBeenCalled();
  });
  it.each(['missing', 'duplicate', 'outside-extension', 'wrong-namespace'] as const)('rejects an untrusted signature placement: %s', async scenario => {
    const f = fixture(); let xml = cdrXml();
    if (scenario === 'missing') xml = xml.replace(SIGNATURE, '');
    if (scenario === 'duplicate') xml = xml.replace(SIGNATURE, SIGNATURE + SIGNATURE);
    if (scenario === 'outside-extension') xml = xml.replace(SIGNATURE, '').replace('</ApplicationResponse>', `${SIGNATURE}</ApplicationResponse>`);
    if (scenario === 'wrong-namespace') xml = xml.replace(`xmlns:ds="${DS}"`, 'xmlns:ds="urn:evil"');
    replaceXml(f, xml); await rejects(f, 'CDR_UNTRUSTED'); expect(f.ports.verifySignature).not.toHaveBeenCalled();
  });
  it.each([false, undefined, 'true', 1])('requires literal true from the signature port, got %s', async result => {
    const f = fixture(); f.ports.verifySignature.mockResolvedValue(result as boolean);
    await rejects(f, 'CDR_UNTRUSTED'); expect(f.ports.loadBatch).toHaveBeenCalledOnce();
  });
  it('maps signature exceptions to an untrusted CDR', async () => {
    const f = fixture(); f.ports.verifySignature.mockRejectedValue(new Error('private adapter detail'));
    await rejects(f, 'CDR_UNTRUSTED'); expect(f.ports.loadBatch).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'load-error', 'read-error', 'reread-missing', 'reread-error'] as const)('fails closed on unavailable ports: %s', async scenario => {
    const f = fixture(); let code: BetaSummaryAcceptanceErrorCode;
    if (scenario === 'missing') { f.ports.loadBatch.mockResolvedValue(null); code = 'BATCH_NOT_FOUND'; }
    else if (scenario === 'load-error') { f.ports.loadBatch.mockRejectedValue(new Error('private detail')); code = 'BATCH_UNAVAILABLE'; }
    else if (scenario === 'read-error') { f.ports.readCdr.mockRejectedValue(new Error('private detail')); code = 'CDR_UNAVAILABLE'; }
    else if (scenario === 'reread-missing') { f.ports.loadBatch.mockResolvedValueOnce(f.record).mockResolvedValueOnce(null); code = 'BATCH_NOT_FOUND'; }
    else { f.ports.loadBatch.mockResolvedValueOnce(f.record).mockRejectedValueOnce(new Error('private detail')); code = 'BATCH_UNAVAILABLE'; }
    await rejects(f, code);
  });
});

describe('RC optional request XML and changes during async ports', () => {
  it('checks a signed request body without changing the archived buffer or batch', async () => {
    const f = fixture(); requestXml(f, buildFiscalBatchUbl(f.record.batch, AS_OF).replace('<ext:ExtensionContent/>', `<ext:ExtensionContent xmlns:ds="${DS}">${SIGNATURE}</ext:ExtensionContent>`));
    const before = Buffer.from(f.record.requestXml!.bytes), batchHash = fiscalSnapshotSha256(f.record.batch);
    expect(await f.run()).toMatchObject({ requestXmlSha256: hash(before) });
    expect(f.record.requestXml!.bytes.equals(before)).toBe(true); expect(fiscalSnapshotSha256(f.record.batch)).toBe(batchHash);
  });
  it('compares namespaces and attributes, allowing prefix aliases and indentation', async () => {
    const f = fixture(); requestXml(f, buildFiscalBatchUbl(f.record.batch, AS_OF)
      .replaceAll('cbc:', 'basic:').replace('xmlns:cbc=', 'xmlns:basic=')
      .replace('schemeID="6" schemeAgencyName="PE:SUNAT"', 'schemeAgencyName="PE:SUNAT" schemeID="6"').replaceAll('><', '>\n  <'));
    await expect(f.run()).resolves.toHaveProperty('requestXmlSha256');
  });
  it.each(['hash', 'amount', 'member-id', 'condition', 'reference-date', 'issuer', 'extra-line', 'namespace', 'missing-extension', 'duplicate-extension', 'malformed'] as const)('rejects a request mismatch even when its bytes are rehashed: %s', async scenario => {
    const f = fixture(); let xml = buildFiscalBatchUbl(f.record.batch, AS_OF);
    if (scenario === 'amount') xml = xml.replace('<sac:TotalAmount currencyID="PEN">236.00</sac:TotalAmount>', '<sac:TotalAmount currencyID="PEN">0.00</sac:TotalAmount>');
    if (scenario === 'member-id') xml = xml.replace('<cbc:ID>B001-1</cbc:ID>', '<cbc:ID>B001-98</cbc:ID>');
    if (scenario === 'condition') xml = xml.replace('<cbc:ConditionCode>1</cbc:ConditionCode>', '<cbc:ConditionCode>3</cbc:ConditionCode>');
    if (scenario === 'reference-date') xml = xml.replace('<cbc:ReferenceDate>2026-10-02</cbc:ReferenceDate>', '<cbc:ReferenceDate>2026-10-01</cbc:ReferenceDate>');
    if (scenario === 'issuer') xml = xml.replace(`<cbc:CustomerAssignedAccountID>${RUC}</cbc:CustomerAssignedAccountID>`, '<cbc:CustomerAssignedAccountID>20131312955</cbc:CustomerAssignedAccountID>');
    if (scenario === 'extra-line') xml = xml.replace('</SummaryDocuments>', '<sac:SummaryDocumentsLine/></SummaryDocuments>');
    if (scenario === 'namespace') xml = xml.replace(`xmlns:cbc="${CBC}"`, 'xmlns:cbc="urn:evil"');
    const extension = '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>';
    if (scenario === 'missing-extension') xml = xml.replace(extension, '');
    if (scenario === 'duplicate-extension') xml = xml.replace(extension, extension + extension);
    if (scenario === 'malformed') xml = '<broken>';
    requestXml(f, xml); if (scenario === 'hash') f.record.requestXml!.sha256 = 'f'.repeat(64);
    await rejects(f, 'REQUEST_XML_MISMATCH'); expect(f.ports.readCdr).not.toHaveBeenCalled();
  });
  it.each(['batch-member', 'batch-id', 'status', 'completedAt', 'artifact-hash', 'artifact-key', 'request-bytes', 'request-added', 'request-removed'] as const)('detects authoritative record changes on reread: %s', async scenario => {
    const f = fixture(); if (['request-bytes', 'request-removed'].includes(scenario)) requestXml(f);
    const current: BetaSummaryAcceptedBatch = { ...f.record, batch: structuredClone(f.record.batch), cdrZip: { ...f.record.cdrZip },
      ...(f.record.requestXml ? { requestXml: { ...f.record.requestXml, bytes: Buffer.from(f.record.requestXml.bytes) } } : {}) };
    if (scenario === 'batch-member') current.batch.input.entries[0].document.snapshot.lines[0].description = 'CHANGED';
    if (scenario === 'batch-id') current.batch.documentId = uuid(901);
    if (scenario === 'status') current.status = 'ACCEPTED_WITH_OBSERVATIONS';
    if (scenario === 'completedAt') current.completedAt = '2026-10-03T18:01:00Z';
    if (scenario === 'artifact-hash') current.cdrZip.sha256 = 'f'.repeat(64);
    if (scenario === 'artifact-key') current.cdrZip.storageKey = 'memory/replaced';
    if (scenario === 'request-bytes') current.requestXml!.bytes[0] ^= 1;
    if (scenario === 'request-added') current.requestXml = { bytes: Buffer.from('added'), sha256: 'f'.repeat(64) };
    if (scenario === 'request-removed') delete current.requestXml;
    f.ports.loadBatch.mockResolvedValueOnce(f.record).mockResolvedValueOnce(current);
    await rejects(f, 'BATCH_CHANGED'); expect(f.ports.verifySignature).toHaveBeenCalledOnce(); expect(f.ports.loadBatch).toHaveBeenCalledTimes(2);
  });
  it('detects mutation of the first record while signature verification awaits, even with a clean reread', async () => {
    const f = fixture(), clean: BetaSummaryAcceptedBatch = { ...f.record, batch: structuredClone(f.record.batch), cdrZip: { ...f.record.cdrZip } };
    f.ports.loadBatch.mockResolvedValueOnce(f.record).mockResolvedValueOnce(clean);
    f.ports.verifySignature.mockImplementation(async () => { await Promise.resolve(); f.record.cdrZip.storageKey = 'changed-during-await'; return true; });
    await rejects(f, 'BATCH_CHANGED');
  });
  it.each(['document', 'evidence', 'source'] as const)('detects caller input mutation while signature verification awaits: %s', async scenario => {
    const f = fixture(); f.ports.verifySignature.mockImplementation(async () => {
      await Promise.resolve();
      if (scenario === 'document') f.doc.lines[0].description = 'MUTATED INPUT';
      if (scenario === 'evidence') f.evidence.cdrSha256 = 'f'.repeat(64);
      if (scenario === 'source' && f.evidence.source.kind === 'CDR_SUMMARY') f.evidence.source.lineNumber = 2;
      return true;
    });
    await rejects(f, 'INPUT_CHANGED'); expect(f.ports.loadBatch).toHaveBeenCalledTimes(2);
  });
  it('detects caller mutation during the initial asynchronous load', async () => {
    const f = fixture(); f.ports.loadBatch.mockImplementationOnce(async () => { await Promise.resolve(); f.doc.customer.legalName = 'MUTATED INPUT'; return f.record; });
    await rejects(f, 'INPUT_CHANGED');
  });
  it('isolates the copies passed to the CDR and signature ports', async () => {
    const f = fixture(); requestXml(f); const expectedXml = Buffer.from(f.xml), expectedZip = Buffer.from(f.zip), expectedRequest = Buffer.from(f.record.requestXml!.bytes);
    f.ports.readCdr.mockImplementation(async copy => { copy.batch.input.entries[0].document.snapshot.lines[0].description = 'PORT MUTATION'; copy.cdrZip.sha256 = 'f'.repeat(64); copy.requestXml!.bytes.fill(0); return f.zip; });
    f.ports.verifySignature.mockImplementation(async copy => { expect(copy.equals(expectedXml)).toBe(true); copy.fill(0); return true; });
    const result = await f.run();
    expect(result.cdrXmlSha256).toBe(hash(expectedXml)); expect(result.cdrZipSha256).toBe(hash(expectedZip));
    expect(f.record.requestXml!.bytes.equals(expectedRequest)).toBe(true); expect(f.zip.equals(expectedZip)).toBe(true);
    expect(f.record.batch.input.entries[0].document.snapshot.lines[0].description).toBe('PRUEBA SIN VENTA');
  });
});
