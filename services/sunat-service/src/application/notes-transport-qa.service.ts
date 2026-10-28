import { ConflictException, Injectable, OnApplicationBootstrap, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { redisConnection, UUID, LivePublisher } from '@factuez/service-access';
import { limaIssueDate } from '@factuez/sunat-core';
import { validateNoteQaSnapshot, NOTES_QA_PROFILE } from '@factuez/sunat-core/dist/notes-qa';
import { NotesQaRepository, type NotesQaRow } from './notes-qa.repository';
import { NotesQaSigningService } from './notes-qa-signing.service';
import { PrismaService } from '../infrastructure/prisma.service';
import { ArtifactStore } from '../infrastructure/artifact-store';
import { SecretVault } from '../infrastructure/crypto/secret-vault';
import { XsdValidationService, XSD_PROFILE, XSD_ARCHIVE_SHA256 } from '../infrastructure/sunat/xsd-validation.service';
import { BoundedSoapAdapter, QA_SCENARIOS, SoapSubmissionError, type QaScenario } from '../infrastructure/sunat/bounded-soap.adapter';
import { parseCdrZip } from '../infrastructure/sunat/cdr-parser';
import { isRetryableLocalPreparationError, localPreparationRetryDelay } from './local-preparation-policy';
import { notesTransport, transportEvidence, NOTES_TRANSPORT_PROFILE, NOTES_TRANSPORT_LEASE_MS, NOTES_TRANSPORT_MAX_ATTEMPTS, NOTES_TRANSPORT_MAX_POLLS, type NotesTransportQa } from './notes-transport-qa.types';
import { notesTransportHash, notesBytesHash, verifyNotesTransportPackage } from './notes-transport-qa-package';

const QUEUE = 'notes-transport-local-qa-v1';
class LeaseLost extends Error {}
export function assertNotesTransportEnabled() {
  if (process.env.NOTES_QA_ENABLED !== 'true' || process.env.FISCAL_CIRCUIT_QA_ENABLED !== 'true' || process.env.LOCAL_XML_VALIDATION_ENABLED !== 'true' || process.env.SUNAT_BETA_TRANSMISSION_ENABLED === 'true') throw new ServiceUnavailableException('Transporte de notas QA deshabilitado');
}
/** Admisión expuesta sólo mediante NotesQaService (ADMIN GLOBAL + original verificado).
 * Worker independiente, únicamente BD propia SUNAT, SOAP fijo LOCAL_QA y PFX ficticio.
 * El integrador registra el provider; no modifica módulos ni activa flags. */
@Injectable()
export class NotesTransportQaService implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue; private worker?: Worker; private timer?: NodeJS.Timeout; private dispatching = false;
  private readonly live = new LivePublisher();
  constructor(private readonly prisma: PrismaService, private readonly repository: NotesQaRepository,
    private readonly store: ArtifactStore, private readonly vault: SecretVault,
    private readonly signer: NotesQaSigningService, private readonly xsd: XsdValidationService) {}

  private assertRow(row: NotesQaRow) {
    if (row.state !== 'SIGNED_LOCAL' || !row.xmlArtifact || !row.zipArtifact || !row.digestValue ||
      row.id !== row.snapshot.documentId || row.originalDocumentId !== row.snapshot.reference.documentId ||
      row.snapshot.environment !== 'BETA' || !/^00\d{9}$/.test(row.snapshot.issuer.identityNumber)) throw new ConflictException('Nota fuera del perfil firmado QA');
    const evidence = transportEvidence(row.xsdEvidence);
    if (evidence.profile !== XSD_PROFILE || evidence.archiveSha256 !== XSD_ARCHIVE_SHA256 || evidence.xmlSha256 !== row.xmlArtifact.sha256) throw new ConflictException('Evidencia XSD de nota ausente o inconsistente');
    const t = notesTransport(row.xsdEvidence); if (!t) return;
    if (t.snapshotSha256 !== notesTransportHash(row.snapshot) || t.credentialRevision !== row.credentialRevision || t.certificateFingerprint !== row.certificateFingerprint ||
      t.mode !== (row.snapshot.reference.documentTypeCode === '01' ? 'sendBill' : 'sendSummary') ||
      t.requestFileName !== `${row.snapshot.issuer.identityNumber}-${t.mode === 'sendBill' ? `${row.snapshot.documentTypeCode}-${row.snapshot.fullNumber}` : t.reference}.zip` ||
      (t.mode === 'sendBill' ? t.reference !== row.snapshot.fullNumber : !/^RC-\d{8}-[1-9]\d{0,4}$/.test(t.reference))) throw new ConflictException('Transporte no pertenece a la nota archivada');
  }
  private async storedContext(row: NotesQaRow) {
    this.assertRow(row);
    const fiscal = await this.prisma.fiscalDocument.findUnique({ where: { documentId: row.originalDocumentId } });
    const original = fiscal?.immutablePayload as unknown as FiscalDocumentSnapshot;
    const circuit = await this.prisma.fiscalCircuitQa.findUnique({ where: { documentId: row.originalDocumentId } });
    const credentials = await this.prisma.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: row.snapshot.issuer.identityNumber, environment: 'BETA' } } });
    if (!fiscal || fiscal.environment !== 'BETA' || fiscal.issuerRuc !== row.snapshot.issuer.identityNumber || !['QUEUED', 'BUILDING'].includes(fiscal.status) || notesTransportHash(original) !== row.originalSha256 ||
      circuit?.id !== row.originalCircuitId || !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(circuit.state) || !circuit.cdrZipArtifact ||
      credentials?.revision !== row.credentialRevision || credentials.certificateFingerprint !== row.certificateFingerprint || credentials.certificateSelfSigned !== true ||
      !credentials.certificateExpiresAt || credentials.certificateExpiresAt <= new Date() || !credentials.certificateCipher || !credentials.certificatePasswordCipher) throw new ConflictException('Snapshot, original o certificado QA cambiaron');
    validateNoteQaSnapshot(row.snapshot, original);
    const originalZip = await this.store.read(row.originalDocumentId, circuit.cdrZipArtifact as unknown as { storageKey: string; sha256: string; sizeBytes: number });
    const originalCdr = parseCdrZip(originalZip, { fileName: `R-${circuit.requestFileName.replace(/\.zip$/, '.xml')}`, issuerRuc: fiscal.issuerRuc, reference: circuit.reference });
    if (!['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(originalCdr.status)) throw new ConflictException('CDR simulado del original no aceptado');
    return { original, credentials };
  }
  async enqueue(row: NotesQaRow, scenario: QaScenario, reauthorize: () => Promise<void>) {
    assertNotesTransportEnabled(); if (!QA_SCENARIOS.includes(scenario)) throw new ConflictException('Escenario QA inválido');
    const { original } = await this.storedContext(row);
    const xml = await this.store.read(row.id, row.xmlArtifact!); const zip = await this.store.read(row.id, row.zipArtifact!);
    verifyNotesTransportPackage(row, original, xml, zip, `${row.snapshot.issuer.identityNumber}-${row.snapshot.documentTypeCode}-${row.snapshot.fullNumber}.zip`);
    const previous = notesTransport(row.xsdEvidence);
    await reauthorize(); // JWT, Billing autorizado y revisión vigente también después del trabajo local.
    if (previous) {
      if (previous.scenario !== scenario) throw new ConflictException('Escenario ya reservado; no reenviar la nota');
      return row;
    }
    const day = limaIssueDate(new Date().toISOString()).replaceAll('-', '');
    const mode = row.snapshot.reference.documentTypeCode === '01' ? 'sendBill' : 'sendSummary';
    const proposal: NotesTransportQa = { profile: NOTES_TRANSPORT_PROFILE, revision: 1, state: 'QUEUED', scenario, mode,
      reference: row.snapshot.fullNumber, requestFileName: `${row.snapshot.issuer.identityNumber}-${row.snapshot.documentTypeCode}-${row.snapshot.fullNumber}.zip`,
      snapshotSha256: notesTransportHash(row.snapshot), credentialRevision: row.credentialRevision, certificateFingerprint: row.certificateFingerprint,
      attempts: 0, polls: 0, notBefore: Date.now(), leaseUntil: 0, fence: null, ticket: null, postStarted: false,
      description: 'SIMULADO · Cola durable para emulador local. Sin valor fiscal' };
    return this.repository.admitTransport(row, original, proposal, day);
  }
  private adapter(row: NotesQaRow, t: NotesTransportQa) {
    // No lee claves SOL, endpoints configurables ni credenciales de otro entorno.
    return new BoundedSoapAdapter({ environment: 'LOCAL_QA', ruc: row.snapshot.issuer.identityNumber,
      solUser: 'LOCALONLY', solPassword: 'FICTICIO-NO-SUNAT', qaScenario: t.scenario });
  }
  async process(id: string) {
    assertNotesTransportEnabled(); if (!UUID.test(id)) return;
    let row = await this.repository.find(id); if (!row || row.state !== 'SIGNED_LOCAL') return;
    let t = notesTransport(row.xsdEvidence); if (!t) return;
    const advance = async (changes: Partial<NotesTransportQa>, guard: 'NONE' | 'READY' | 'OWNED' | 'EXPIRED' = 'OWNED', original?: FiscalDocumentSnapshot) => {
      const next = { ...t!, ...changes, revision: t!.revision + 1 };
      if (!await this.repository.transportCas(row!, next, guard, original)) throw new LeaseLost();
      t = next; row = { ...row!, xsdEvidence: { ...transportEvidence(row!.xsdEvidence), transportQa: next } };
      await this.live.changed(row.originalDocumentId);
    };
    try {
      if (t.state === 'SENDING') {
        if (t.leaseUntil > Date.now()) return;
        const state = t.ticket ? (t.polls < NOTES_TRANSPORT_MAX_POLLS ? 'WAITING_TICKET' : 'UNKNOWN')
          : t.postStarted ? 'UNKNOWN' : t.attempts < NOTES_TRANSPORT_MAX_ATTEMPTS ? 'QUEUED' : 'BLOCKED';
        await advance({ state, fence: null, leaseUntil: 0, notBefore: Date.now() + 2000,
          description: state === 'UNKNOWN' ? 'SIMULADO · Resultado incierto; jamás reenviar' : 'SIMULADO · Lease vencido, reserva conservada' }, 'EXPIRED');
        return;
      }
      if (!['QUEUED', 'WAITING_TICKET'].includes(t.state) || t.notBefore > Date.now() || t.leaseUntil > Date.now()) return;
      const polling = t.state === 'WAITING_TICKET';
      if ((!polling && t.postStarted) || (!polling && t.attempts >= NOTES_TRANSPORT_MAX_ATTEMPTS) || (polling && (!t.ticket || t.polls >= NOTES_TRANSPORT_MAX_POLLS))) {
        await advance({ state: polling || t.postStarted ? 'UNKNOWN' : 'BLOCKED', description: 'SIMULADO · Límite alcanzado; reserva conservada, no reenviar' }, 'READY'); return;
      }
      await advance({ state: 'SENDING', fence: randomUUID(), leaseUntil: Date.now() + NOTES_TRANSPORT_LEASE_MS,
        attempts: t.attempts + (polling ? 0 : 1), polls: t.polls + (polling ? 1 : 0), description: 'SIMULADO · Worker con propiedad CAS' }, 'READY');
      this.assertRow(row);
      const { original, credentials } = await this.storedContext(row);
      if (polling) {
        assertNotesTransportEnabled();
        await advance({ leaseUntil: Date.now() + NOTES_TRANSPORT_LEASE_MS }, 'OWNED', original);
        assertNotesTransportEnabled();
        const status = await this.adapter(row, t).getStatus(t.ticket!);
        if (status.kind === 'CDR') await this.receipt(row, t, status.cdrZip, advance);
        else if (status.kind === 'PROCESSING' || (status.kind === 'ERROR' && status.retryable)) await this.waitTicket(t, advance);
        else await advance({ state: 'UNKNOWN', fence: null, leaseUntil: 0, description: 'SIMULADO · Estado de ticket no conciliable; jamás reenviar' });
        return;
      }
      let xml: Buffer; let zip: Buffer;
      if (t.mode === 'sendBill') {
        xml = await this.store.read(row.id, row.xmlArtifact!); zip = await this.store.read(row.id, row.zipArtifact!);
      } else if (t.requestXml && t.requestZip) {
        xml = await this.store.read(row.id, t.requestXml); zip = await this.store.read(row.id, t.requestZip);
      } else {
        const secretContext = { ruc: row.snapshot.issuer.identityNumber, environment: 'BETA' };
        const bytes = this.vault.open(credentials.certificateCipher!, { ...secretContext, field: 'certificate' }); let password: Buffer | undefined;
        let prepared: Awaited<ReturnType<NotesQaSigningService['prepare']>>;
        try {
          password = this.vault.open(credentials.certificatePasswordCipher!, { ...secretContext, field: 'certificatePassword' });
          prepared = await this.signer.prepare(row.snapshot, original, bytes, password.toString(), t.reference);
        } finally { bytes.fill(0); password?.fill(0); }
        if (prepared.certificateFingerprintSha256 !== row.certificateFingerprint || prepared.profile !== NOTES_QA_PROFILE || `${prepared.fileName}.zip` !== t.requestFileName) throw new ConflictException('RC firmado fuera del contexto QA');
        xml = Buffer.from(prepared.xml); zip = prepared.zip;
      }
      verifyNotesTransportPackage(row, original, xml, zip, t.requestFileName, t.mode === 'sendSummary' ? t.reference : undefined);
      const kind = t.mode === 'sendSummary' ? 'SummaryDocuments' : row.snapshot.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote';
      const evidence = await this.xsd.validate(xml, kind); // SIEMPRE antes del POST, también después de recuperación.
      if (evidence.profile !== XSD_PROFILE || evidence.archiveSha256 !== XSD_ARCHIVE_SHA256 || evidence.xmlSha256 !== notesBytesHash(xml)) throw new ConflictException('Evidencia XSD del transporte inconsistente');
      const requestXml = t.mode === 'sendBill' ? row.xmlArtifact! : t.requestXml ?? await this.store.put(row.id, `${t.requestFileName.replace(/\.zip$/, '')}-SIMULADO.xml`, xml);
      const requestZip = t.mode === 'sendBill' ? row.zipArtifact! : t.requestZip ?? await this.store.put(row.id, `${t.requestFileName.replace(/\.zip$/, '')}-SIMULADO.zip`, zip);
      await this.storedContext(row); assertNotesTransportEnabled();
      const adapter = this.adapter(row, t);
      // Barrera durable. Ningún retry posterior puede emitir sendBill/sendSummary.
      await advance({ requestXml, requestZip, requestXsd: evidence, postStarted: true, leaseUntil: Date.now() + NOTES_TRANSPORT_LEASE_MS }, 'OWNED', original);
      assertNotesTransportEnabled();
      const pkg = { documentId: row.id, fileName: t.requestFileName, zip, sha256: notesBytesHash(zip) };
      if (t.mode === 'sendSummary') {
        const ticket = await adapter.submitSummary(pkg);
        await advance({ ticket, state: 'WAITING_TICKET', notBefore: Date.now() + 2000, fence: null, leaseUntil: 0, description: 'SIMULADO · Consultar el mismo ticket, sin reenviar RC' });
      } else {
        const response = await adapter.submit(pkg);
        if (response.kind !== 'CDR') throw new Error('sendBill sin CDR');
        await this.receipt(row, t, response.cdrZip, advance);
      }
    } catch (error) {
      if (error instanceof LeaseLost) return; // Una propiedad perdida nunca publica ni hace otro POST.
      if (!t.fence) throw error;
      try {
        if (t.ticket && (error instanceof SoapSubmissionError || isRetryableLocalPreparationError(error))) await this.waitTicket(t, advance);
        else if (t.postStarted) await advance({ state: error instanceof SoapSubmissionError && error.kind === 'BUSINESS' && !t.ticket ? 'REJECTED' : 'UNKNOWN',
          responseCode: error instanceof SoapSubmissionError ? error.code : undefined, fence: null, leaseUntil: 0,
          description: 'SIMULADO · Resultado de transporte incierto o rechazado; jamás reenviar' });
        else {
          const retry = isRetryableLocalPreparationError(error) && t.attempts < NOTES_TRANSPORT_MAX_ATTEMPTS;
          await advance({ state: retry ? 'QUEUED' : 'BLOCKED', fence: null, leaseUntil: 0,
            notBefore: Date.now() + localPreparationRetryDelay(t.attempts), description: retry ? 'SIMULADO · Preparación local diferida, todavía no enviada' : 'SIMULADO · Preparación o contexto fuera del perfil; no enviado' });
        }
      } catch { /* CAS/BD sin confirmación: dispatcher recuperará; no logs ni reenvíos. */ }
    }
  }
  private async waitTicket(t: NotesTransportQa, advance: (changes: Partial<NotesTransportQa>) => Promise<void>) {
    await advance({ state: t.polls >= NOTES_TRANSPORT_MAX_POLLS ? 'UNKNOWN' : 'WAITING_TICKET', fence: null, leaseUntil: 0,
      notBefore: Date.now() + Math.min(30000, 2000 * 2 ** Math.min(t.polls, 4)), description: 'SIMULADO · Mismo ticket; consultas acotadas, sin reenviar RC' });
  }
  private async receipt(row: NotesQaRow, t: NotesTransportQa, zip: Buffer, advance: (changes: Partial<NotesTransportQa>) => Promise<void>) {
    const cdr = parseCdrZip(zip, { fileName: `R-${t.requestFileName.replace(/\.zip$/, '.xml')}`, issuerRuc: row.snapshot.issuer.identityNumber, reference: t.reference });
    const cdrZip = await this.store.put(row.id, `R-${t.requestFileName.replace(/\.zip$/, '')}-SIMULADO.zip`, zip);
    const cdrXml = await this.store.put(row.id, `R-${t.requestFileName.replace(/\.zip$/, '')}-SIMULADO.xml`, cdr.xml);
    await advance({ state: cdr.status === 'ACCEPTED_WITH_OBSERVATIONS' ? 'OBSERVED' : cdr.status, cdrZip, cdrXml,
      responseCode: cdr.code, notes: cdr.notes, fence: null, leaseUntil: 0, description: `SIMULADO · NO FISCAL · ${cdr.description}` });
  }
  async onApplicationBootstrap() {
    if (process.env.NOTES_QA_ENABLED !== 'true' || process.env.FISCAL_CIRCUIT_QA_ENABLED !== 'true') return;
    assertNotesTransportEnabled(); await this.repository.checkInstalled();
    this.queue = new Queue(QUEUE, { connection: { ...redisConnection(), connectTimeout: 2000, maxRetriesPerRequest: 1 } });
    this.queue.on('error', () => {});
    this.worker = new Worker(QUEUE, job => this.process(String(job.data.id)), { connection: redisConnection(), concurrency: 1 });
    this.worker.on('error', () => {}); this.timer = setInterval(() => void this.dispatch(), 2000);
  }
  async dispatch() {
    if (this.dispatching || !this.queue) return; this.dispatching = true;
    try {
      assertNotesTransportEnabled();
      for (const row of await this.repository.transportPending()) {
        const t = notesTransport(row.xsdEvidence); if (t) await this.queue.add('notes-transport-qa', { id: row.id },
          { jobId: `transport-${row.id}-${t.revision}`, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
      }
    } catch { /* La reserva JSON conserva trabajo durable. No logs de snapshots o secretos. */ }
    finally { this.dispatching = false; }
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.worker?.close(); await this.queue?.close(); await this.live.close(); }
}
