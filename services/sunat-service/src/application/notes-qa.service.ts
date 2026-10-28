import { BadRequestException, ConflictException, HttpException, Inject, Injectable, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { AccessError, identity, LivePublisher, redisConnection, UUID } from '@factuez/service-access';
import { buildNoteQaSnapshot, noteQaCanonical, NOTES_QA_PROFILE, NOTES_QA_REASONS, parseNoteQaInput, validateNoteQaSnapshot, type NoteQaSnapshot } from '@factuez/sunat-core/dist/notes-qa';
import { LocalXmlValidationService } from './local-xml-validation.service';
import { NotesQaRepository, NOTES_QA_LEASE_MS, type NotesQaRow } from './notes-qa.repository';
import { isRetryableLocalPreparationError } from './local-preparation-policy';
import { NotesQaSigningService } from './notes-qa-signing.service';
import { PrismaService } from '../infrastructure/prisma.service';
import { ArtifactStore } from '../infrastructure/artifact-store';
import { SecretVault } from '../infrastructure/crypto/secret-vault';
import { parseCdrZip } from '../infrastructure/sunat/cdr-parser';
import { XsdValidationService, XSD_ARCHIVE_SHA256, XSD_PROFILE } from '../infrastructure/sunat/xsd-validation.service';
import { NotesTransportQaService } from './notes-transport-qa.service';
import { notesTransport } from './notes-transport-qa.types';
import { QA_SCENARIOS, type QaScenario } from '../infrastructure/sunat/bounded-soap.adapter';
import { notesTransportHash } from './notes-transport-qa-package';
import { CurrentPdfService } from './current-pdf.service';

const sha = (value: unknown) => createHash('sha256').update(noteQaCanonical(value)).digest('hex');
const QUEUE = 'notes-local-qa-signing-v1';
export const NOTES_QA_PDF_RENDERER = 'NOTES_QA_PDF_RENDERER';
/** El integrador provee un renderer específico de nota, nunca un Invoice disfrazado. */
export interface NotesQaPdfRenderer {
  render(note: NoteQaSnapshot, format: 'ticket' | 'a4', proof: { digestValue: string; signatureVerified: true; localOnly: true; xsdValidated: boolean }): Promise<Buffer>;
}

@Injectable()
export class NotesQaService implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue; private worker?: Worker; private timer?: NodeJS.Timeout; private dispatching = false;
  private readonly live = new LivePublisher();
  constructor(private readonly prisma: PrismaService, private readonly local: LocalXmlValidationService,
    private readonly repository: NotesQaRepository, private readonly signer: NotesQaSigningService,
    private readonly store: ArtifactStore, private readonly vault: SecretVault, private readonly xsd: XsdValidationService,
    @Optional() @Inject(NOTES_QA_PDF_RENDERER) private readonly pdf?: NotesQaPdfRenderer,
    @Optional() private readonly transport?: NotesTransportQaService,
    @Optional() private readonly previews: CurrentPdfService = new CurrentPdfService()) {}
  private enabled() {
    if (process.env.NOTES_QA_ENABLED !== 'true' || process.env.LOCAL_XML_VALIDATION_ENABLED !== 'true' || process.env.FISCAL_CIRCUIT_QA_ENABLED !== 'true') throw new ServiceUnavailableException('Notas locales QA deshabilitadas');
    if (process.env.SUNAT_BETA_TRANSMISSION_ENABLED === 'true') throw new ConflictException('Las notas QA requieren transmisión Beta real deshabilitada');
  }
  private async actor(authorization?: string, issue = false) {
    try {
      const user = await identity(authorization ?? '', issue ? 'document.issue' : 'document.view');
      if (!user.roles.includes('ADMIN') || user.scope.kind !== 'GLOBAL' || !user.permissions.includes('sunat.configure')) throw new AccessError(403, 'Notas QA sólo disponibles para administrador general');
      return user;
    } catch (error) { if (error instanceof AccessError) throw new HttpException(error.message, error.status); throw error; }
  }
  private async context(originalId: string, authorization?: string, issue = false) {
    this.enabled();
    if (!UUID.test(originalId)) throw new BadRequestException('Referencia de comprobante inválida');
    const user = await this.actor(authorization, issue);
    // Billing hace su filtro de alcance con JWT vigente, local.context compara con la copia propia.
    const context = await this.local.context(originalId, authorization);
    if (context.snapshot.currencyCode !== 'PEN' || context.snapshot.lines.length > 100) throw new BadRequestException('Perfil de notas: PEN, IGV 18%, hasta 100 ítems');
    const circuit = await this.prisma.fiscalCircuitQa.findUnique({ where: { documentId: originalId } });
    if (!circuit || !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(circuit.state) || !circuit.cdrZipArtifact) throw new ConflictException('El original requiere CDR aceptado del emulador local, no un estado fiscal oficial');
    try {
      const zip = await this.store.read(originalId, circuit.cdrZipArtifact as unknown as { storageKey: string; sha256: string; sizeBytes: number });
      const cdr = parseCdrZip(zip, { fileName: `R-${circuit.requestFileName.replace(/\.zip$/, '.xml')}`, issuerRuc: context.snapshot.issuer.identityNumber, reference: circuit.reference });
      if (!['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(cdr.status)) throw new Error();
    } catch { throw new ConflictException('CDR simulado del original no disponible o inconsistente'); }
    return { ...context, user, circuit };
  }
  private view(row: NotesQaRow) {
    const evidence = row.xsdEvidence as null | { profile?: string; archiveSha256?: string; xmlSha256?: string };
    const xsdValidated = Boolean(row.xmlArtifact && evidence?.profile === XSD_PROFILE && evidence.archiveSha256 === XSD_ARCHIVE_SHA256 && evidence.xmlSha256 === row.xmlArtifact.sha256);
    const transport = row.xsdEvidence ? notesTransport(row.xsdEvidence) : undefined;
    return { id: row.id, originalDocumentId: row.originalDocumentId, state: row.state, profile: NOTES_QA_PROFILE,
      snapshot: row.snapshot, digestValue: row.digestValue, description: row.description, createdAt: row.createdAt,
      signatureVerified: row.state === 'SIGNED_LOCAL', xsdValidated, sunatRulesValidated: false, trustAndRucVerified: false,
      fiscalTransmission: false, officialCdr: false, cdrAvailable: Boolean(transport?.cdrZip && transport.cdrXml),
      transportQa: transport ? { state: transport.state, scenario: transport.scenario, mode: transport.mode,
        requestFileName: transport.requestFileName, reference: transport.reference, ticket: transport.ticket,
        attempts: transport.attempts, polls: transport.polls, responseCode: transport.responseCode, notes: transport.notes,
        description: transport.description, requestAvailable: Boolean(transport.requestXml && transport.requestZip),
        cdrAvailable: Boolean(transport.cdrZip && transport.cdrXml), localOnly: true, simulated: true, fiscalTransmission: false, officialCdr: false } : null,
      xmlAvailable: row.state === 'SIGNED_LOCAL' && Boolean(row.xmlArtifact), zipAvailable: row.state === 'SIGNED_LOCAL' && Boolean(row.zipArtifact), pdfAvailable: row.state === 'SIGNED_LOCAL' && Boolean(this.pdf) };
  }
  async list(originalId: string, authorization?: string) {
    await this.context(originalId, authorization);
    return { profile: NOTES_QA_PROFILE, localOnly: true, reasons: NOTES_QA_REASONS, creditLimit: 'ONE_RESERVED_CREDIT_PER_ORIGINAL', items: (await this.repository.rows(originalId)).map(row => this.view(row)) };
  }
  async create(originalId: string, value: unknown, authorization?: string) {
    const context = await this.context(originalId, authorization, true);
    let input: ReturnType<typeof parseNoteQaInput>;
    try { input = parseNoteQaInput(value); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Solicitud inválida'); }
    const requestSha256 = sha(input);
    const previous = await this.repository.admitted(originalId, context.user.sub, input.idempotencyKey);
    if (previous) { if (previous.requestSha256 !== requestSha256) throw new ConflictException('Clave de idempotencia reutilizada con otra solicitud'); return this.view(previous); }
    const id = randomUUID(); const issueDate = new Date().toISOString();
    const makeSnapshot = (number: string) => {
      try { return buildNoteQaSnapshot(context.snapshot, input, { documentId: id, number, issueDate }); }
      catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'Nota fuera del perfil'); }
    };
    makeSnapshot('1'); // Validar antes de reservar numeración QA.
    const fresh = await this.context(originalId, authorization, true);
    if (sha(fresh.snapshot) !== sha(context.snapshot) || fresh.credentials.revision !== context.credentials.revision || fresh.circuit.id !== context.circuit.id || fresh.user.sub !== context.user.sub) throw new ConflictException('El contexto de la referencia cambió');
    const row = await this.repository.reserve({ id, originalDocumentId: originalId, actorId: context.user.sub,
      idempotencyKey: input.idempotencyKey, requestSha256, originalSha256: sha(context.snapshot),
      originalCircuitId: context.circuit.id, credentialRevision: context.credentials.revision,
      certificateFingerprint: context.credentials.certificateFingerprint! }, context.snapshot, makeSnapshot);
    await this.live.changed(originalId);
    return this.view(row);
  }
  async detail(id: string, authorization?: string) {
    this.enabled(); await this.actor(authorization);
    if (!UUID.test(id)) throw new BadRequestException('Nota inválida');
    const row = await this.repository.find(id); if (!row) throw new NotFoundException('Nota no disponible');
    await this.context(row.originalDocumentId, authorization);
    return this.view(row);
  }
  async enqueueTransport(id: string, value: unknown, authorization?: string) {
    this.enabled(); const user = await this.actor(authorization, true);
    if (!UUID.test(id) || !value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !('scenario' in value) || !QA_SCENARIOS.includes(value.scenario as QaScenario)) throw new BadRequestException('Indique únicamente un escenario de emulador QA válido');
    const row = await this.repository.find(id); if (!row) throw new NotFoundException('Nota no disponible');
    const verifyContext = async () => {
      const context = await this.context(row.originalDocumentId, authorization, true);
      validateNoteQaSnapshot(row.snapshot, context.snapshot);
      if (context.user.sub !== user.sub || sha(context.snapshot) !== row.originalSha256 || context.circuit.id !== row.originalCircuitId ||
        context.credentials.revision !== row.credentialRevision || context.credentials.certificateFingerprint !== row.certificateFingerprint) throw new ConflictException('El contexto de la nota cambió');
    };
    await verifyContext();
    if (!this.transport) throw new ServiceUnavailableException('Provider de transporte QA de notas no integrado');
    const queued = await this.transport.enqueue(row, (value as { scenario: QaScenario }).scenario, verifyContext);
    await this.live.changed(row.originalDocumentId); return this.view(queued);
  }
  async download(id: string, format: string, authorization?: string) {
    this.enabled(); await this.actor(authorization);
    if (!UUID.test(id) || !['xml', 'zip', 'ticket', 'a4', 'cdr-xml', 'cdr-zip', 'transport-xml', 'transport-zip'].includes(format)) throw new BadRequestException('Nota o formato inválido');
    const row = await this.repository.find(id); if (!row) throw new NotFoundException('Nota no disponible');
    const context = await this.context(row.originalDocumentId, authorization);
    if (row.state !== 'SIGNED_LOCAL' || !row.xmlArtifact || !row.zipArtifact || !row.digestValue) throw new ConflictException('La nota todavía no está firmada localmente');
    if (context.credentials.revision !== row.credentialRevision || context.credentials.certificateFingerprint !== row.certificateFingerprint) throw new ConflictException('Certificado cambió; descargue sólo representaciones de la revisión vigente');
    validateNoteQaSnapshot(row.snapshot, context.snapshot);
    if (sha(context.snapshot) !== row.originalSha256 || context.circuit?.id !== row.originalCircuitId) throw new ConflictException('Referencia archivada inconsistente');
    if (format.startsWith('cdr-') || format.startsWith('transport-')) {
      const transport = notesTransport(row.xsdEvidence);
      if (!transport || transport.snapshotSha256 !== notesTransportHash(row.snapshot) || transport.credentialRevision !== row.credentialRevision || transport.certificateFingerprint !== row.certificateFingerprint ||
        transport.mode !== (row.snapshot.reference.documentTypeCode === '01' ? 'sendBill' : 'sendSummary') ||
        transport.requestFileName !== `${row.snapshot.issuer.identityNumber}-${transport.mode === 'sendBill' ? `${row.snapshot.documentTypeCode}-${row.snapshot.fullNumber}` : transport.reference}.zip` ||
        (transport.mode === 'sendBill' ? transport.reference !== row.snapshot.fullNumber : !/^RC-\d{8}-[1-9]\d{0,4}$/.test(transport.reference))) throw new ConflictException('Transporte simulado no pertenece a la nota');
      const artifact = format === 'cdr-zip' ? transport.cdrZip : format === 'cdr-xml' ? transport.cdrXml : format === 'transport-xml' ? transport.requestXml : transport.requestZip;
      if (!artifact) throw new ConflictException('Artefacto simulado todavía no disponible');
      let bytes: Buffer;
      try {
        bytes = await this.store.read(row.id, artifact);
        if (format.startsWith('cdr-')) {
          if (!transport.cdrZip || !transport.cdrXml || !['ACCEPTED', 'OBSERVED', 'REJECTED'].includes(transport.state)) throw new Error();
          const cdr = parseCdrZip(await this.store.read(row.id, transport.cdrZip), { fileName: `R-${transport.requestFileName.replace(/\.zip$/, '.xml')}`, issuerRuc: row.snapshot.issuer.identityNumber, reference: transport.reference });
          if (!cdr.xml.equals(await this.store.read(row.id, transport.cdrXml))) throw new Error();
        }
      } catch { throw new ServiceUnavailableException('Artefacto simulado ausente o inconsistente'); }
      const extension = format.endsWith('xml') ? 'xml' : 'zip';
      return { bytes, mediaType: extension === 'xml' ? 'application/xml' : 'application/zip',
        fileName: `${format.startsWith('cdr-') ? 'R-' : ''}${transport.requestFileName.replace(/\.zip$/, '')}-SIMULADO-NO-FISCAL.${extension}` };
    }
    let bytes: Buffer;
    try {
      await this.store.read(row.id, row.xmlArtifact);
      bytes = await this.store.read(row.id, format === 'xml' ? row.xmlArtifact : row.zipArtifact);
    } catch { throw new ServiceUnavailableException('Artefactos de nota ausentes o inconsistentes'); }
    if (format === 'ticket' || format === 'a4') {
      if (!this.pdf) throw new ServiceUnavailableException('Renderer PDF específico de notas no instalado');
      bytes = await this.previews.document(row.snapshot, format, authorization, { digestValue: row.digestValue, status: 'SIGNED_LOCAL' }, context.printContext);
      if (bytes.length < 5 || bytes.length > 10 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new ServiceUnavailableException('PDF de nota inválido');
    }
    return { bytes, mediaType: format === 'xml' ? 'application/xml' : format === 'zip' ? 'application/zip' : 'application/pdf',
      fileName: `${row.snapshot.issuer.identityNumber}-${row.snapshot.documentTypeCode}-${row.snapshot.fullNumber}-PRUEBA-LOCAL${['ticket', 'a4'].includes(format) ? `-${format}` : ''}.${format === 'xml' ? 'xml' : format === 'zip' ? 'zip' : 'pdf'}` };
  }
  async onApplicationBootstrap() {
    if (process.env.NOTES_QA_ENABLED !== 'true') return;
    this.enabled(); await this.repository.checkInstalled();
    this.queue = new Queue(QUEUE, { connection: { ...redisConnection(), connectTimeout: 2000, maxRetriesPerRequest: 1 } });
    this.queue.on('error', () => {});
    this.worker = new Worker(QUEUE, job => this.process(String(job.data.id)), { connection: redisConnection(), concurrency: 1 });
    this.worker.on('error', () => {});
    this.timer = setInterval(() => void this.dispatch(), 2000);
  }
  private async dispatch() {
    if (this.dispatching || !this.queue) return; this.dispatching = true;
    try { for (const row of await this.repository.pending()) await this.queue.add('sign-local-note', { id: row.id }, { jobId: `${row.id}-${row.attempts}`, attempts: 1, removeOnComplete: 100, removeOnFail: 100 }); }
    catch { /* BD conserva cola durable; jamás logs de snapshots o secretos. */ }
    finally { this.dispatching = false; }
  }
  async process(id: string) {
    this.enabled(); if (!UUID.test(id)) return;
    const row = await this.repository.claim(id); if (!row) return;
    let leaseLost = false; let changed = false; let heartbeatInFlight: Promise<void> | undefined;
    const renew = async () => {
      if (leaseLost) return false;
      try { if (!await this.repository.heartbeat(row)) leaseLost = true; }
      catch { leaseLost = true; } // Sin confirmación de propiedad, dejar recuperar al dispatcher.
      return !leaseLost;
    };
    const ownsLease = async () => { if (heartbeatInFlight) await heartbeatInFlight; return renew(); };
    const heartbeat = setInterval(() => {
      if (!heartbeatInFlight && !leaseLost) heartbeatInFlight = renew().then(() => {}).finally(() => { heartbeatInFlight = undefined; });
    }, NOTES_QA_LEASE_MS / 4);
    try {
      const fiscal = await this.prisma.fiscalDocument.findUnique({ where: { documentId: row.originalDocumentId } });
      const original = fiscal?.immutablePayload as unknown as FiscalDocumentSnapshot;
      const circuit = await this.prisma.fiscalCircuitQa.findUnique({ where: { documentId: row.originalDocumentId } });
      const credentials = await this.prisma.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: row.snapshot.issuer.identityNumber, environment: 'BETA' } } });
      if (!fiscal || fiscal.environment !== 'BETA' || !/^00\d{9}$/.test(fiscal.issuerRuc) || !['QUEUED', 'BUILDING'].includes(fiscal.status) || sha(original) !== row.originalSha256 ||
        circuit?.id !== row.originalCircuitId || !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(circuit.state) || !circuit.cdrZipArtifact ||
        credentials?.revision !== row.credentialRevision || credentials.certificateFingerprint !== row.certificateFingerprint || credentials.certificateSelfSigned !== true ||
        !credentials.certificateExpiresAt || credentials.certificateExpiresAt <= new Date() || !credentials.certificateCipher || !credentials.certificatePasswordCipher) throw new Error();
      validateNoteQaSnapshot(row.snapshot, original);
      if (!await ownsLease()) return;
      const secretContext = { ruc: fiscal.issuerRuc, environment: 'BETA' };
      const bytes = this.vault.open(credentials.certificateCipher, { ...secretContext, field: 'certificate' });
      let password: Buffer | undefined; let prepared: Awaited<ReturnType<NotesQaSigningService['prepare']>>;
      try { password = this.vault.open(credentials.certificatePasswordCipher, { ...secretContext, field: 'certificatePassword' }); prepared = await this.signer.prepare(row.snapshot, original, bytes, password.toString()); }
      finally { bytes.fill(0); password?.fill(0); }
      if (prepared.certificateFingerprintSha256 !== row.certificateFingerprint || prepared.profile !== NOTES_QA_PROFILE) throw new Error();
      if (!await ownsLease()) return;
      const evidence = await this.xsd.validate(prepared.xml, row.snapshot.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote');
      if (!await ownsLease()) return;
      // No red: sólo paquete XSD fijado y proceso local, más el worker de firma.
      const xml = await this.store.put(row.id, `${prepared.fileName}-LOCAL-QA.xml`, Buffer.from(prepared.xml));
      const zip = await this.store.put(row.id, `${prepared.fileName}-LOCAL-QA.zip`, prepared.zip);
      if (evidence.xmlSha256 !== xml.sha256) throw new Error();
      const current = await this.prisma.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: fiscal.issuerRuc, environment: 'BETA' } } });
      if (current?.revision !== row.credentialRevision || current.certificateFingerprint !== row.certificateFingerprint) throw new Error();
      if (!await ownsLease()) return;
      changed = await this.repository.complete(row, { digestValue: prepared.digestValue, xml, zip, xsdEvidence: evidence });
    } catch (error) {
      if (!leaseLost) changed = isRetryableLocalPreparationError(error)
        ? await this.repository.defer(row) : await this.repository.block(row);
    } finally {
      clearInterval(heartbeat); if (heartbeatInFlight) await heartbeatInFlight;
      if (changed) await this.live.changed(row.originalDocumentId);
    }
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.worker?.close(); await this.queue?.close(); await this.live.close(); }
}
