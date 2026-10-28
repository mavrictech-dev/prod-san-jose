import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Queue, Worker } from 'bullmq';
import { identity, AccessError } from '@factuez/service-access';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { buildNoteQaSnapshot, noteQaCanonical, NOTES_QA_PROFILE } from '../packages/sunat-core/src/notes-qa';
import { buildNoteQaUbl } from '../packages/sunat-core/src/notes-ubl';
import { buildNoteQaSummary } from '../packages/sunat-core/src/notes-summary-ubl';
import { NotesQaRepository, type NotesQaRow } from '../services/sunat-service/src/application/notes-qa.repository';
import { NotesQaService } from '../services/sunat-service/src/application/notes-qa.service';
import { NotesTransportQaService } from '../services/sunat-service/src/application/notes-transport-qa.service';
import { notesTransport, type NotesTransportQa, NOTES_TRANSPORT_LEASE_MS, NOTES_TRANSPORT_MAX_POLLS } from '../services/sunat-service/src/application/notes-transport-qa.types';
import { verifyNotesTransportPackage } from '../services/sunat-service/src/application/notes-transport-qa-package';
import { LocalPreparationUnavailableError } from '../services/sunat-service/src/application/local-preparation-policy';
import { BoundedSoapAdapter, SoapSubmissionError, LOCAL_QA_ENDPOINT } from '../services/sunat-service/src/infrastructure/sunat/bounded-soap.adapter';
import { XSD_PROFILE, XSD_ARCHIVE_SHA256 } from '../services/sunat-service/src/infrastructure/sunat/xsd-validation.service';
import { parseCdrZip, RESPONSE_NS } from '../services/sunat-service/src/infrastructure/sunat/cdr-parser';
import { singleNotesTransportXml, validateNoteBillXml, validateNoteSummaryLines } from '../services/sunat-service/src/infrastructure/sunat/notes-transport-qa-validator';
import { safeXml, CBC_NS, CAC_NS, SOAP_NS, SERVICE_NS } from '../services/sunat-service/src/infrastructure/sunat/safe-xml';

vi.mock('bullmq', () => ({ Queue: vi.fn(() => { throw new Error('REDIS PROHIBIDO'); }), Worker: vi.fn(() => { throw new Error('WORKER REAL PROHIBIDO'); }) }));
vi.mock('node:worker_threads', () => ({ Worker: vi.fn(() => { throw new Error('PFX REAL PROHIBIDO'); }) }));
vi.mock('../services/sunat-service/src/infrastructure/prisma.service', () => ({ PrismaService: class {} }));
vi.mock('../services/sunat-service/src/application/notes-transport-qa-package', async original => ({
  ...await original<object>(), verifyNotesTransportPackage: vi.fn(() => {}),
}));
vi.mock('@factuez/service-access', async original => ({ ...await original<object>(), identity: vi.fn() }));
const require = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const { zipSync } = require('fflate'); const { BadRequestException } = require('@nestjs/common');
const hash = (v: unknown) => createHash('sha256').update(noteQaCanonical(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const copy = <T>(v: T): T => structuredClone(v);
const now = new Date('2026-10-02T21:00:00Z');
const fingerprint = 'a'.repeat(64);
const admin = { sub: randomUUID(), roles: ['ADMIN'], scope: { kind: 'GLOBAL' }, permissions: ['sunat.configure', 'document.issue', 'document.view'] };
function receipt(fileName: string, reference: string, ruc: string, scenario = 'ACCEPTED') {
  const xml = `<ApplicationResponse xmlns="${RESPONSE_NS}" xmlns:cbc="${CBC_NS}" xmlns:cac="${CAC_NS}">${scenario === 'OBSERVED' ? '<cbc:Note>SIMULADO observación</cbc:Note>' : ''}<cac:ReceiverParty><cac:PartyIdentification><cbc:ID>${ruc}</cbc:ID></cac:PartyIdentification></cac:ReceiverParty><cac:DocumentResponse><cac:Response><cbc:ResponseCode>${scenario === 'REJECTED' ? '2335' : '0'}</cbc:ResponseCode><cbc:Description>SIMULADO NO FISCAL</cbc:Description></cac:Response><cac:DocumentReference><cbc:ID>${reference}</cbc:ID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;
  return Buffer.from(zipSync({ [`R-${fileName.replace(/\.zip$/, '.xml')}`]: Buffer.from(xml) }));
}
function fixture(originalType: '01' | '03' = '01', noteType: '07' | '08' = '07') {
  const series = originalType === '01' ? 'FQ01' : 'BQ01';
  const original: FiscalDocumentSnapshot = { documentId: randomUUID(), documentTypeCode: originalType, environment: 'BETA', series, number: '1', fullNumber: `${series}-1`, issueDate: '2026-10-01T16:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
    issuer: { identityType: '6', identityNumber: '00000000001', legalName: 'EMISOR FICTICIO', ubigeo: '150101', establishmentCode: '0001' },
    customer: { identityType: '6', identityNumber: '00000000000', legalName: 'CLIENTE FICTICIO' },
    ...calculateDocumentTotals([{ description: 'SÓLO PRUEBA', unitCode: 'NIU', quantity: '1', unitPriceWithTax: '1.18', taxAffectationCode: '10', igvRate: '18' }]) };
  const note = buildNoteQaSnapshot(original, { idempotencyKey: randomUUID(), documentTypeCode: noteType, reasonCode: noteType === '07' ? '01' : '02', reasonDescription: 'PRUEBA', ...(noteType === '08' ? { lines: [{ originalLineNumber: 1, quantity: '1', unitPriceWithTax: '1.18' }] } : {}) }, { documentId: randomUUID(), number: '17', issueDate: now.toISOString() });
  const noteFileName = `${note.issuer.identityNumber}-${note.documentTypeCode}-${note.fullNumber}.zip`;
  const circuit = { id: randomUUID(), state: 'ACCEPTED', reference: originalType === '01' ? original.fullNumber : 'RC-20261001-1', requestFileName: `${note.issuer.identityNumber}-${originalType === '01' ? `01-${original.fullNumber}` : 'RC-20261001-1'}.zip`, cdrZipArtifact: undefined as unknown };
  const credentials = { revision: 1, certificateFingerprint: fingerprint, certificateSelfSigned: true, certificateExpiresAt: new Date('2030-01-01T00:00:00Z'), certificateCipher: 'MOCK-NOT-PFX', certificatePasswordCipher: 'MOCK-NOT-PASSWORD' };
  const files = new Map<string, Buffer>();
  const artifact = (id: string, name: string, bytes: Buffer) => { const result = { storageKey: `${id}/${bytesHash(bytes)}-${name}`, sha256: bytesHash(bytes), sizeBytes: bytes.length }; files.set(result.storageKey, bytes); return result; };
  const xml = Buffer.from(buildNoteQaUbl(note, original)); const zip = Buffer.from(zipSync({ [noteFileName.replace(/\.zip$/, '.xml')]: xml }));
  circuit.cdrZipArtifact = artifact(original.documentId, 'original-simulated.zip', receipt(circuit.requestFileName, circuit.reference, note.issuer.identityNumber));
  const xmlArtifact = artifact(note.documentId, 'signed-local.xml', xml); const zipArtifact = artifact(note.documentId, 'signed-local.zip', zip);
  const row: NotesQaRow = { id: note.documentId, originalDocumentId: original.documentId, actorId: admin.sub, idempotencyKey: randomUUID(), requestSha256: 'b'.repeat(64), originalSha256: hash(original), originalCircuitId: circuit.id, credentialRevision: 1, certificateFingerprint: fingerprint,
    snapshot: note, state: 'SIGNED_LOCAL', attempts: 1, claimedAt: null, createdAt: now, digestValue: 'MOCK-DIGEST', xmlArtifact, zipArtifact, xsdEvidence: { profile: XSD_PROFILE, archiveSha256: XSD_ARCHIVE_SHA256, xmlSha256: xmlArtifact.sha256, verifiedAt: now.toISOString(), retainedCustomField: 'KEEP' }, description: 'FIRMADA LOCAL' };
  let rcCounter = 0; let rejectPublication = false; let rejectAllCas = false;
  const matchesContext = () => hash(original) === row.originalSha256 && credentials.revision === row.credentialRevision && credentials.certificateFingerprint === row.certificateFingerprint && credentials.certificateSelfSigned && credentials.certificateExpiresAt > new Date() && circuit.state === 'ACCEPTED';
  const prisma = {
    fiscalDocument: { findUnique: vi.fn(async () => ({ issuerRuc: original.issuer.identityNumber, environment: original.environment, status: 'BUILDING', immutablePayload: original })) },
    fiscalCircuitQa: { findUnique: vi.fn(async () => circuit) }, sunatCredentials: { findUnique: vi.fn(async () => credentials) },
    $queryRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
      if (sql.startsWith('INSERT INTO "FiscalQaCounter"')) { rcCounter++; return [{ lastNumber: rcCounter }]; }
      if (sql.includes('WHERE "id"=$1::uuid')) return args[0] === row.id ? [copy(row)] : [];
      expect(sql).toContain("'{transportQa,profile}'=$1");
      const t = notesTransport(row.xsdEvidence);
      return t && ((['QUEUED', 'WAITING_TICKET'].includes(t.state) && t.notBefore <= Date.now()) || (t.state === 'SENDING' && t.leaseUntil <= Date.now())) ? [copy(row)] : [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
      if (sql.startsWith('SELECT pg_advisory')) return 1;
      // Ejecuta el predicado del CAS real sobre memoria y comprueba su SQL fijo.
      expect(sql).toContain('jsonb_set(n."xsdEvidence",\'{transportQa}\',$3::jsonb,true)');
      expect(sql).toContain('n."xsdEvidence"=$2::jsonb'); expect(sql).toContain('n."snapshot"=$4::jsonb');
      expect(sql).toContain('n."state"=\'SIGNED_LOCAL\''); expect(sql).toContain('c."certificateSelfSigned"=true');
      expect(sql).not.toMatch(/SET.*"(?:state|snapshot|attempts|idempotencyKey)"=/);
      const next = JSON.parse(String(args[2])) as NotesTransportQa; const t = notesTransport(row.xsdEvidence);
      if (rejectAllCas || (rejectPublication && ['WAITING_TICKET', 'ACCEPTED', 'OBSERVED', 'REJECTED', 'UNKNOWN'].includes(next.state))) return 0;
      if (args[0] !== row.id || row.state !== 'SIGNED_LOCAL' || hash(row.xsdEvidence) !== hash(JSON.parse(String(args[1]))) || hash(row.snapshot) !== hash(JSON.parse(String(args[3]))) || args[4] !== row.credentialRevision || args[5] !== row.certificateFingerprint) return 0;
      if (args[6] === 'OWNED' && (!t?.fence || t.leaseUntil <= Date.now())) return 0;
      if (args[6] === 'READY' && (!t || !['QUEUED', 'WAITING_TICKET'].includes(t.state) || t.notBefore > Date.now() || t.leaseUntil > Date.now())) return 0;
      if (args[6] === 'EXPIRED' && (!t || t.leaseUntil > Date.now())) return 0;
      if (args[8] !== null && (!matchesContext() || hash(original) !== hash(JSON.parse(String(args[8]))))) return 0;
      row.xsdEvidence = { ...(row.xsdEvidence as object), transportQa: next }; return 1;
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const repository = new NotesQaRepository(prisma as never);
  const store = { put: vi.fn(async (id: string, name: string, bytes: Buffer) => artifact(id, name, bytes)), read: vi.fn(async (id: string, a: { storageKey: string; sha256: string; sizeBytes: number }) => { const bytes = files.get(a.storageKey); if (!bytes || !a.storageKey.startsWith(`${id}/`) || a.sizeBytes !== bytes.length || a.sha256 !== bytesHash(bytes)) throw new Error('Artefacto inconsistente'); return bytes; }) };
  const secretBuffers: Buffer[] = [];
  const vault = { open: vi.fn(() => { const bytes = Buffer.from('MOCK-NOT-PFX'); secretBuffers.push(bytes); return bytes; }) };
  const signer = { prepare: vi.fn(async (_n: unknown, _o: unknown, _bytes: unknown, _password: unknown, identifier: string) => {
    const xml = buildNoteQaSummary(note, original, identifier); const fileName = `${note.issuer.identityNumber}-${identifier}`;
    return { xml, fileName, zip: Buffer.from(zipSync({ [`${fileName}.xml`]: Buffer.from(xml) })), certificateFingerprintSha256: fingerprint, profile: NOTES_QA_PROFILE, digestValue: 'MOCK-DIGEST-RC' };
  }) };
  const xsd = { validate: vi.fn(async (xml: Buffer) => ({ profile: XSD_PROFILE, archiveSha256: XSD_ARCHIVE_SHA256, xmlSha256: bytesHash(xml), verifiedAt: now.toISOString() })) };
  const make = () => new NotesTransportQaService(prisma as never, repository, store as never, vault as never, signer as never, xsd as never);
  const local = { context: vi.fn(async () => ({ snapshot: original, credentials })) };
  const makeApi = () => new NotesQaService(prisma as never, local as never, repository, signer as never, store as never, vault as never, xsd as never, undefined, make());
  const service = make(); const t = () => notesTransport(row.xsdEvidence)!;
  const enqueue = (scenario: 'ACCEPTED' | 'OBSERVED' | 'REJECTED' | 'UNCERTAIN' | 'INVALID_CDR' | 'TRANSIENT_STATUS' = 'ACCEPTED') => service.enqueue(copy(row), scenario, async () => {});
  const submit = vi.spyOn(BoundedSoapAdapter.prototype, 'submit').mockImplementation(async pkg => ({ kind: 'CDR', cdrZip: receipt(pkg.fileName, t().reference, note.issuer.identityNumber, t().scenario) }));
  const summary = vi.spyOn(BoundedSoapAdapter.prototype, 'submitSummary').mockResolvedValue('LOCAL-TICKET-ORIGINAL');
  const status = vi.spyOn(BoundedSoapAdapter.prototype, 'getStatus').mockImplementation(async () => ({ kind: 'CDR', cdrZip: receipt(t().requestFileName, t().reference, note.issuer.identityNumber, t().scenario) }));
  return { original, note, row, circuit, credentials, prisma, repository, store, files, vault, signer, xsd, service, t, enqueue, submit, summary, status, make, makeApi, local, secretBuffers,
    rcCounter: () => rcCounter, rejectPublication: (v: boolean) => { rejectPublication = v; }, rejectAllCas: (v: boolean) => { rejectAllCas = v; } };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks();
  for (const flag of ['NOTES_QA_ENABLED', 'LOCAL_XML_VALIDATION_ENABLED', 'FISCAL_CIRCUIT_QA_ENABLED']) vi.stubEnv(flag, 'true');
  vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'false'); vi.stubEnv('WORKSPACE_LIVE_ENABLED', 'false');
  vi.mocked(identity).mockResolvedValue(admin as never);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('RED REAL PROHIBIDA'); }));
});
afterEach(() => { expect(Queue).not.toHaveBeenCalled(); expect(Worker).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('transporte propio durable 07/08 exclusivamente simulado', () => {
  it.each(['07', '08'] as const)('nota F %s conserva XSD/snapshot/key/contador y recibe CDR propio', async type => {
    const f = fixture('01', type); const before = copy(f.row); await f.enqueue(); await f.service.process(f.row.id);
    expect(f.t().state).toBe('ACCEPTED'); expect(f.t().postStarted).toBe(true); expect(f.submit).toHaveBeenCalledOnce(); expect(f.summary).not.toHaveBeenCalled();
    expect(f.vault.open).not.toHaveBeenCalled(); expect(f.signer.prepare).not.toHaveBeenCalled();
    expect(f.xsd.validate).toHaveBeenCalledWith(expect.any(Buffer), type === '07' ? 'CreditNote' : 'DebitNote');
    const { transportQa: _t, ...evidence } = f.row.xsdEvidence as Record<string, unknown>; expect(evidence).toEqual(before.xsdEvidence);
    for (const key of ['snapshot', 'idempotencyKey', 'attempts', 'digestValue', 'xmlArtifact', 'zipArtifact', 'state'] as const) expect(f.row[key]).toEqual(before[key]);
    expect(f.rcCounter()).toBe(0); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['07', '08'] as const)('nota B %s reserva RC una vez, consulta mismo ticket y descarga su CDR', async type => {
    const f = fixture('03', type); await f.enqueue(); expect(f.t().requestFileName).toMatch(/-RC-20261002-1.zip$/); expect(f.rcCounter()).toBe(1);
    await f.make().process(f.row.id); expect(f.t().state).toBe('WAITING_TICKET'); expect(f.summary).toHaveBeenCalledOnce(); expect(f.submit).not.toHaveBeenCalled();
    expect(f.secretBuffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
    const request = f.files.get(f.t().requestXml!.storageKey)!.toString(); expect(request).toContain(`<cbc:DocumentTypeCode>${type}</cbc:DocumentTypeCode>`); expect(request).toContain('<cbc:ReferenceDate>2026-10-02</cbc:ReferenceDate>'); expect(request).toContain(`<cbc:ID>${f.original.fullNumber}</cbc:ID><cbc:DocumentTypeCode>03</cbc:DocumentTypeCode>`);
    await vi.advanceTimersByTimeAsync(2000); await f.make().process(f.row.id); expect(f.t().state).toBe('ACCEPTED'); expect(f.status).toHaveBeenCalledWith('LOCAL-TICKET-ORIGINAL'); expect(f.rcCounter()).toBe(1);
    const cdr = await f.makeApi().download(f.row.id, 'cdr-zip', 'Bearer mock'); expect(cdr.fileName).toContain('SIMULADO-NO-FISCAL'); expect(cdr.bytes.equals(f.files.get(f.t().cdrZip!.storageKey)!)).toBe(true);
  });
  it.each(['OBSERVED', 'REJECTED'] as const)('CDR válido %s conserva artefactos con resultado simulado', async scenario => {
    const f = fixture(); await f.enqueue(scenario); await f.service.process(f.row.id); expect(f.t().state).toBe(scenario); expect(f.t().cdrZip).toBeDefined(); expect(f.t().cdrXml).toBeDefined();
    if (scenario === 'OBSERVED') expect(f.t().notes).toEqual(['SIMULADO observación']);
  });
  it('idempotencia usa reserva existente e impide cambiar escenario aun después de UNKNOWN', async () => {
    const f = fixture('03'); await f.enqueue(); await f.enqueue(); expect(f.rcCounter()).toBe(1);
    await expect(f.enqueue('REJECTED')).rejects.toThrow('Escenario'); await f.service.process(f.row.id); await f.enqueue(); expect(f.summary).toHaveBeenCalledOnce(); expect(f.rcCounter()).toBe(1);
  });
  it('dos workers compiten por CAS y sólo uno publica POST/CDR', async () => {
    const f = fixture(); await f.enqueue(); await Promise.all([f.service.process(f.row.id), f.make().process(f.row.id)]); expect(f.submit).toHaveBeenCalledOnce(); expect(f.t().state).toBe('ACCEPTED');
  });
  it('antes del POST un XSD ocupado reintenta 3 veces con límite durable', async () => {
    const f = fixture(); await f.enqueue(); f.xsd.validate.mockRejectedValue(new LocalPreparationUnavailableError('Ocupado'));
    for (let i = 1; i <= 3; i++) { await f.make().process(f.row.id); expect(f.t().attempts).toBe(i); if (i < 3) { expect(f.t().state).toBe('QUEUED'); await vi.advanceTimersByTimeAsync(2 ** i * 1000); } }
    expect(f.t().state).toBe('BLOCKED'); expect(f.submit).not.toHaveBeenCalled(); expect(f.t().postStarted).toBe(false);
  });
  it('un XSD permanentemente inválido bloquea sin POST y sin reemplazar evidencia de nota', async () => {
    const f = fixture(); const evidence = copy(f.row.xsdEvidence); await f.enqueue(); f.xsd.validate.mockRejectedValue(new BadRequestException('XML inválido')); await f.service.process(f.row.id);
    expect(f.t().state).toBe('BLOCKED'); expect(f.submit).not.toHaveBeenCalled(); expect((f.row.xsdEvidence as Record<string, unknown>).xmlSha256).toBe((evidence as Record<string, unknown>).xmlSha256);
  });
  it.each(['UNCERTAIN', 'INVALID_CDR'] as const)('%s queda UNKNOWN, persiste al reiniciar y nunca se reenvía', async scenario => {
    const f = fixture(); await f.enqueue(scenario);
    if (scenario === 'UNCERTAIN') f.submit.mockRejectedValue(new SoapSubmissionError('UNKNOWN', 'RESPONSE_LOST'));
    else f.submit.mockResolvedValue({ kind: 'CDR', cdrZip: receipt(f.t().requestFileName, 'FCQ1-999', f.note.issuer.identityNumber) });
    await f.service.process(f.row.id); expect(f.t().state).toBe('UNKNOWN'); expect(f.t().cdrZip).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100000); expect(await f.repository.transportPending()).toEqual([]); await f.make().process(f.row.id); await f.enqueue(scenario); await f.make().process(f.row.id); expect(f.submit).toHaveBeenCalledOnce();
  });
  it('ticket perdido por fallo de persistencia jamás vuelve a emitir sendSummary', async () => {
    const f = fixture('03'); await f.enqueue(); f.rejectPublication(true); await f.service.process(f.row.id); expect(f.t().state).toBe('SENDING'); expect(f.t().postStarted).toBe(true); expect(f.t().ticket).toBeNull();
    f.rejectPublication(false); await vi.advanceTimersByTimeAsync(NOTES_TRANSPORT_LEASE_MS); await f.make().process(f.row.id); expect(f.t().state).toBe('UNKNOWN'); await f.make().process(f.row.id); expect(f.summary).toHaveBeenCalledOnce();
  });
  it('poll temporalmente fallido conserva ticket; se limita a 8 consultas sin repost', async () => {
    const f = fixture('03'); await f.enqueue('TRANSIENT_STATUS'); await f.service.process(f.row.id);
    f.status.mockRejectedValue(new SoapSubmissionError('UNKNOWN', 'TEMPORARY'));
    for (let i = 1; i <= NOTES_TRANSPORT_MAX_POLLS; i++) { await vi.advanceTimersByTimeAsync(30000); await f.make().process(f.row.id); expect(f.t().polls).toBe(i); expect(f.t().ticket).toBe('LOCAL-TICKET-ORIGINAL'); }
    expect(f.t().state).toBe('UNKNOWN'); expect(f.summary).toHaveBeenCalledOnce(); expect(f.status).toHaveBeenCalledTimes(8); expect(f.status.mock.calls.every(([ticket]) => ticket === 'LOCAL-TICKET-ORIGINAL')).toBe(true);
  });
  it('98 seguido de CDR observa el mismo ticket', async () => {
    const f = fixture('03'); await f.enqueue('OBSERVED'); await f.service.process(f.row.id); f.status.mockResolvedValueOnce({ kind: 'PROCESSING' });
    await vi.advanceTimersByTimeAsync(2000); await f.service.process(f.row.id); expect(f.t().state).toBe('WAITING_TICKET'); await vi.advanceTimersByTimeAsync(4000); await f.make().process(f.row.id); expect(f.t().state).toBe('OBSERVED'); expect(f.summary).toHaveBeenCalledOnce();
  });
  it('lease previo al POST vencido permite preparar la misma reserva y cerca al worker viejo', async () => {
    const f = fixture(); await f.enqueue(); const old = { ...f.t(), state: 'SENDING' as const, attempts: 1, fence: randomUUID(), leaseUntil: Date.now() - 1, revision: 2 };
    await f.repository.transportCas(copy(f.row), old); const stale = copy(f.row); await f.make().process(f.row.id); expect(f.t().state).toBe('QUEUED');
    expect(await f.repository.transportCas(stale, { ...old, state: 'ACCEPTED', revision: 3 }, 'OWNED')).toBe(false);
    await vi.advanceTimersByTimeAsync(2000); await f.make().process(f.row.id); expect(f.submit).toHaveBeenCalledOnce(); expect(f.t().attempts).toBe(2);
  });
  it('lease vencido durante getStatus recupera el mismo ticket, nunca envía RC nuevamente', async () => {
    const f = fixture('03'); await f.enqueue(); await f.service.process(f.row.id);
    await f.repository.transportCas(copy(f.row), { ...f.t(), state: 'SENDING', polls: 1, fence: randomUUID(), leaseUntil: Date.now() - 1, revision: f.t().revision + 1 });
    await f.make().process(f.row.id); expect(f.t().state).toBe('WAITING_TICKET'); await vi.advanceTimersByTimeAsync(2000); await f.make().process(f.row.id); expect(f.t().state).toBe('ACCEPTED'); expect(f.summary).toHaveBeenCalledOnce();
  });
  it.each(['certificate', 'snapshot', 'original', 'xsd', 'artifact', 'original-cdr'] as const)('cambio %s bloquea antes de POST', async changed => {
    const f = fixture(); await f.enqueue();
    if (changed === 'certificate') f.credentials.revision++;
    if (changed === 'snapshot') f.row.snapshot.reasonDescription = 'CAMBIO';
    if (changed === 'original') f.original.customer.legalName = 'CAMBIO';
    if (changed === 'xsd') (f.row.xsdEvidence as Record<string, unknown>).xmlSha256 = 'f'.repeat(64);
    if (changed === 'artifact') f.files.set(f.row.xmlArtifact!.storageKey, Buffer.from('CORRUPTO'));
    if (changed === 'original-cdr') f.files.clear();
    await f.service.process(f.row.id); expect(f.t().state).toBe('BLOCKED'); expect(f.submit).not.toHaveBeenCalled();
  });
  it('certificado cambiado durante XSD se detecta antes de barrera durable', async () => {
    const f = fixture(); await f.enqueue(); f.xsd.validate.mockImplementationOnce(async xml => { f.credentials.revision++; return { profile: XSD_PROFILE, archiveSha256: XSD_ARCHIVE_SHA256, xmlSha256: bytesHash(xml), verifiedAt: now.toISOString() }; });
    await f.service.process(f.row.id); expect(f.t().state).toBe('BLOCKED'); expect(f.t().postStarted).toBe(false); expect(f.submit).not.toHaveBeenCalled();
  });
  it('XSD no acredita otra revisión/otro XML aunque el validador responda sin error', async () => {
    const f = fixture(); await f.enqueue(); f.xsd.validate.mockResolvedValueOnce({ profile: XSD_PROFILE, archiveSha256: XSD_ARCHIVE_SHA256, xmlSha256: 'f'.repeat(64), verifiedAt: now.toISOString() });
    await f.service.process(f.row.id); expect(f.t().state).toBe('BLOCKED'); expect(f.submit).not.toHaveBeenCalled();
  });
  it('CAS guard READY exige notBefore y no permite reclamar estados terminales', async () => {
    const f = fixture(); await f.enqueue(); const future = { ...f.t(), revision: f.t().revision + 1, notBefore: Date.now() + 1000 };
    await f.repository.transportCas(copy(f.row), future);
    expect(await f.repository.transportCas(copy(f.row), { ...future, state: 'SENDING', fence: randomUUID(), leaseUntil: Date.now() + 60000, revision: future.revision + 1 }, 'READY')).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); await f.service.process(f.row.id); expect(f.t().state).toBe('ACCEPTED');
    expect(await f.repository.transportCas(copy(f.row), { ...f.t(), state: 'SENDING', revision: f.t().revision + 1 }, 'READY')).toBe(false);
  });
  it('el cambio de flag después del CAS y antes del POST deja UNKNOWN sin emisión', async () => {
    const f = fixture('03'); await f.enqueue(); const realCas = f.repository.transportCas.bind(f.repository);
    vi.spyOn(f.repository, 'transportCas').mockImplementation(async (row, next, guard, original) => { const result = await realCas(row, next, guard, original); if (result && next.postStarted && !next.ticket) vi.stubEnv('NOTES_QA_ENABLED', 'false'); return result; });
    await f.service.process(f.row.id); expect(f.t().state).toBe('UNKNOWN'); expect(f.summary).not.toHaveBeenCalled();
  });
  it('CAS perdido antes de barrera no publica POST', async () => {
    const f = fixture(); await f.enqueue(); f.xsd.validate.mockImplementationOnce(async xml => { f.rejectAllCas(true); return { profile: XSD_PROFILE, archiveSha256: XSD_ARCHIVE_SHA256, xmlSha256: bytesHash(xml), verifiedAt: now.toISOString() }; });
    await f.service.process(f.row.id); expect(f.t().postStarted).toBe(false); expect(f.submit).not.toHaveBeenCalled();
  });
  it('desactivar flags o activar transmisión Beta real detiene admisión y worker', async () => {
    const f = fixture(); await f.enqueue(); vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'true'); await expect(f.service.process(f.row.id)).rejects.toThrow('deshabilitado'); expect(f.submit).not.toHaveBeenCalled();
    vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'false'); vi.stubEnv('NOTES_QA_ENABLED', 'false'); await expect(f.enqueue()).rejects.toThrow('deshabilitado');
  });
  it('errores de verificación de firma archivada bloquean envío', async () => {
    const f = fixture(); await f.enqueue(); vi.mocked(verifyNotesTransportPackage).mockImplementationOnce(() => { throw new Error('Firma fuera del snapshot'); }); await f.service.process(f.row.id); expect(f.t().state).toBe('BLOCKED'); expect(f.submit).not.toHaveBeenCalled();
  });
});

describe('admisión autenticada y artefactos de notas', () => {
  it('API valida ADMIN GLOBAL, original y revisión dos veces y expone marcas no fiscales', async () => {
    const f = fixture(); const view = await f.makeApi().enqueueTransport(f.row.id, { scenario: 'ACCEPTED' }, 'Bearer mock'); expect(view.state).toBe('SIGNED_LOCAL'); expect(view.transportQa).toMatchObject({ state: 'QUEUED', simulated: true, fiscalTransmission: false, officialCdr: false }); expect(f.local.context).toHaveBeenCalledTimes(2);
  });
  it.each(['unauthenticated', 'operator', 'scoped-admin', 'missing-config'] as const)('deniega %s antes de leer nota', async failure => {
    const f = fixture();
    if (failure === 'unauthenticated') vi.mocked(identity).mockRejectedValueOnce(new AccessError(401, 'Inicie sesión'));
    else vi.mocked(identity).mockResolvedValueOnce({ ...admin, ...(failure === 'operator' ? { roles: ['OPERATOR'] } : failure === 'scoped-admin' ? { scope: { kind: 'BRANCH' } } : { permissions: ['document.issue'] }) } as never);
    await expect(f.makeApi().enqueueTransport(f.row.id, { scenario: 'ACCEPTED' }, 'Bearer mock')).rejects.toThrow(); expect(f.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
  it('no acepta destinos, RUC, estados ni credenciales libres en body', async () => {
    const f = fixture(); for (const body of [{ scenario: 'ACCEPTED', url: 'https://sunat.gob.pe' }, { scenario: 'OFFICIAL' }, { ruc: '00000000001' }, null]) await expect(f.makeApi().enqueueTransport(f.row.id, body, 'Bearer mock')).rejects.toThrow(); expect(f.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
  it('revocación en Billing durante verificación impide encolar', async () => {
    const f = fixture(); f.local.context.mockResolvedValueOnce({ snapshot: f.original, credentials: f.credentials }).mockRejectedValueOnce(new Error('Billing no autorizado')); await expect(f.makeApi().enqueueTransport(f.row.id, { scenario: 'ACCEPTED' }, 'Bearer mock')).rejects.toThrow('Billing'); expect(f.t()).toBeUndefined();
  });
  it('descargas CDR rechazan revisión obsoleta, artefacto corrupto y requieren autenticación', async () => {
    const f = fixture(); await f.enqueue(); await f.service.process(f.row.id); const api = f.makeApi();
    vi.mocked(identity).mockRejectedValueOnce(new AccessError(401, 'Inicie sesión')); await expect(api.download(f.row.id, 'cdr-xml', 'Bearer mock')).rejects.toThrow();
    f.credentials.revision++; await expect(api.download(f.row.id, 'cdr-zip', 'Bearer mock')).rejects.toThrow('Certificado'); f.credentials.revision--;
    f.files.set(f.t().cdrXml!.storageKey, Buffer.from('CORRUPTO')); await expect(api.download(f.row.id, 'cdr-xml', 'Bearer mock')).rejects.toThrow('inconsistente');
  });
});

describe('validators de sendBill/RC y CDR usando sólo fixtures en memoria', () => {
  it.each(['07', '08'] as const)('admite %s F y rechaza nota B por sendBill antes de fetch', async type => {
    const f = fixture('01', type); f.submit.mockRestore();
    const zip = f.files.get(f.row.zipArtifact!.storageKey)!; const fileName = `${f.note.issuer.identityNumber}-${type}-${f.note.fullNumber}.zip`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`<soap:Envelope xmlns:soap="${SOAP_NS}"><soap:Body><ser:sendBillResponse xmlns:ser="${SERVICE_NS}"><applicationResponse>${receipt(fileName, f.note.fullNumber, f.note.issuer.identityNumber).toString('base64')}</applicationResponse></ser:sendBillResponse></soap:Body></soap:Envelope>`)));
    const adapter = new BoundedSoapAdapter({ environment: 'LOCAL_QA', ruc: f.note.issuer.identityNumber, solUser: 'LOCALONLY', solPassword: 'FICTICIO-NO-SUNAT' });
    await adapter.submit({ documentId: f.row.id, fileName, zip, sha256: bytesHash(zip) }); expect(fetch).toHaveBeenCalledWith(LOCAL_QA_ENDPOINT, expect.objectContaining({ method: 'POST', redirect: 'error' }));
    await expect(adapter.submit({ documentId: f.row.id, fileName: fileName.replace('-F', '-B'), zip, sha256: bytesHash(zip) })).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
  });
  it('RC exige nota B, BillingReference 03 y fecha de la nota; no utiliza otra boleta', () => {
    const f = fixture('03'); const xml = buildNoteQaSummary(f.note, f.original, 'RC-20261002-1'); validateNoteSummaryLines(safeXml(xml));
    for (const bad of [xml.replace('BCQ1-17', 'FCQ1-17'), xml.replace('<cbc:DocumentTypeCode>03</cbc:DocumentTypeCode>', '<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode>'), xml.replace('<cac:BillingReference>', '<cac:Otro>').replace('</cac:BillingReference>', '</cac:Otro>')]) expect(() => validateNoteSummaryLines(safeXml(bad))).toThrow();
    expect(() => buildNoteQaSummary(f.note, f.original, 'RC-20261001-1')).toThrow(); expect(() => buildNoteQaSummary({ ...f.note, reasonCode: '10' }, f.original, 'RC-20261002-1')).toThrow();
  });
  it('validator SOAP exige tipo correcto, RUC y referencia F', () => {
    const f = fixture(); const xml = buildNoteQaUbl(f.note, f.original); const fileName = `${f.note.issuer.identityNumber}-07-${f.note.fullNumber}.zip`; validateNoteBillXml(xml, fileName, f.note.issuer.identityNumber);
    expect(() => validateNoteBillXml(xml, fileName.replace('-07-', '-08-'), f.note.issuer.identityNumber)).toThrow(); expect(() => validateNoteBillXml(xml.replace('FQ01-1', 'BQ01-1'), fileName, f.note.issuer.identityNumber)).toThrow();
  });
  it.each(['ruc', 'reference', 'zip-path', 'duplicate', 'extra', 'dtd'] as const)('CDR %s inválido se rechaza por scope/estructura', failure => {
    const f = fixture(); const fileName = `${f.note.issuer.identityNumber}-07-${f.note.fullNumber}.zip`; const expected = { fileName: `R-${fileName.replace(/\.zip$/, '.xml')}`, reference: f.note.fullNumber, issuerRuc: f.note.issuer.identityNumber };
    let zip = receipt(fileName, failure === 'reference' ? 'FCQ1-18' : f.note.fullNumber, failure === 'ruc' ? '00000000002' : f.note.issuer.identityNumber);
    let xml = parseCdrZip(receipt(fileName, f.note.fullNumber, f.note.issuer.identityNumber), expected).xml;
    if (failure === 'duplicate') xml = Buffer.from(xml.toString().replace('<cbc:ResponseCode>0</cbc:ResponseCode>', '<cbc:ResponseCode>0</cbc:ResponseCode><cbc:ResponseCode>0</cbc:ResponseCode>'));
    if (failure === 'dtd') xml = Buffer.from('<!DOCTYPE x>' + xml.toString());
    if (['zip-path', 'duplicate', 'extra', 'dtd'].includes(failure)) zip = Buffer.from(zipSync({ [failure === 'zip-path' ? '../R.xml' : expected.fileName]: xml, ...(failure === 'extra' ? { 'extra.xml': xml } : {}) }));
    expect(() => parseCdrZip(zip, expected)).toThrow();
  });
  it('ZIP de nota no admite rutas ni entradas extras', () => {
    const f = fixture(); expect(() => singleNotesTransportXml(Buffer.from(zipSync({ '../note.xml': Buffer.from('x') })), 'note.zip')).toThrow(); expect(() => singleNotesTransportXml(Buffer.from(zipSync({ 'note.xml': Buffer.from('x'), 'other.xml': Buffer.from('x') })), 'note.zip')).toThrow();
  });
});
