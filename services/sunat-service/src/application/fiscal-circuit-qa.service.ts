import { Injectable, ConflictException, BadRequestException, ServiceUnavailableException, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LocalXmlValidationService } from './local-xml-validation.service';
import { PrismaService } from '../infrastructure/prisma.service';
import { ArtifactStore } from '../infrastructure/artifact-store';
import { SecretVault } from '../infrastructure/crypto/secret-vault';
import { LocalXmlWorkerService } from '../infrastructure/crypto/local-xml-worker.service';
import { BoundedSoapAdapter, SoapSubmissionError, QA_SCENARIOS, type QaScenario } from '../infrastructure/sunat/bounded-soap.adapter';
import { parseCdrZip } from '../infrastructure/sunat/cdr-parser';
import type { FiscalCircuitQa } from '../generated/prisma/client';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { limaIssueDate } from '@factuez/sunat-core';
import { isDeepStrictEqual } from 'node:util';
import { safeXml } from '../infrastructure/sunat/safe-xml';
import { XsdValidationService, XSD_PROFILE, XSD_ARCHIVE_SHA256 } from '../infrastructure/sunat/xsd-validation.service';
import { unzipSync } from 'fflate';
import { LivePublisher } from '@factuez/service-access';
import { isRetryableLocalPreparationError, LOCAL_PREPARATION_MAX_ATTEMPTS, localPreparationRetryDelay } from './local-preparation-policy';
import { CurrentPdfService } from './current-pdf.service';

type Stored = { storageKey: string; sha256: string; sizeBytes: number };
const QUEUE = 'fiscal-circuit-local-qa';
const connection = () => ({ host: process.env.REDIS_HOST ?? 'redis', port: Number(process.env.REDIS_PORT ?? 6379), password: process.env.REDIS_PASSWORD_FILE ? readFileSync(process.env.REDIS_PASSWORD_FILE, 'utf8').trim() : undefined });

@Injectable()
export class FiscalCircuitQaService implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue; private worker?: Worker; private timer?: NodeJS.Timeout; private flushing = false;
  private readonly live = new LivePublisher();
  constructor(private readonly prisma: PrismaService, private readonly local: LocalXmlValidationService,
    private readonly store: ArtifactStore, private readonly vault: SecretVault, private readonly signer: LocalXmlWorkerService,
    private readonly xsd: XsdValidationService,
    @Optional() private readonly previews: CurrentPdfService = new CurrentPdfService()) {}
  private enabled() {
    if (process.env.FISCAL_CIRCUIT_QA_ENABLED !== 'true') throw new ServiceUnavailableException('Circuito simulado deshabilitado');
    if (process.env.SUNAT_BETA_TRANSMISSION_ENABLED === 'true') throw new ConflictException('QA requiere transmisión externa deshabilitada');
  }
  private view(row: FiscalCircuitQa | null) {
    return { ready: Boolean(row), id: row?.id ?? null, state: row?.state ?? 'NOT_STARTED', scenario: row?.scenario ?? null,
      transport: 'LOCAL_SIMULATION', officialCdr: false, fiscalTransmission: false,
      xsdValidated: this.hasXsdEvidence(row), xsdProfile: this.hasXsdEvidence(row) ? XSD_PROFILE : null,
      sunatRulesValidated: false,
      requestFileName: row?.requestFileName ?? null, ticket: row?.ticket ?? null, pollAttempts: row?.pollAttempts ?? 0,
      responseCode: row?.responseCode ?? null, description: row?.description ?? null, notes: row?.notes ?? [],
      digestValue: row?.documentDigestValue ?? null, cdrAvailable: Boolean(row?.cdrZipArtifact), createdAt: row?.createdAt ?? null };
  }
  private hasXsdEvidence(row: FiscalCircuitQa | null) {
    const proof = row?.xsdEvidence as null | { profile?: string; archiveSha256?: string; documentXmlSha256?: string; requestXmlSha256?: string };
    return Boolean(row && proof?.profile === XSD_PROFILE && proof.archiveSha256 === XSD_ARCHIVE_SHA256 &&
      proof.documentXmlSha256 === (row.documentXmlArtifact as unknown as Stored).sha256 &&
      proof.requestXmlSha256 === (row.signedXmlArtifact as unknown as Stored).sha256);
  }
  async status(id: string, authorization?: string) {
    this.enabled(); await this.local.context(id, authorization);
    return this.view(await this.prisma.fiscalCircuitQa.findUnique({ where: { documentId: id } }));
  }
  async start(id: string, actorId: string, scenario: unknown, authorization?: string) {
    this.enabled();
    if (typeof scenario !== 'string' || !QA_SCENARIOS.includes(scenario as QaScenario)) throw new BadRequestException('Escenario de prueba inválido');
    const context = await this.local.context(id, authorization);
    const prior = await this.prisma.fiscalCircuitQa.findUnique({ where: { documentId: id } });
    if (prior) {
      if (prior.scenario !== scenario) throw new ConflictException('Este documento ya tiene un escenario; use otra operación ficticia');
      return this.view(prior);
    }
    if (await this.prisma.fiscalBatchQaMember.findUnique({ where: { documentId_action: { documentId:id,action:'ALTA' } } })) throw new ConflictException('Boleta reservada en un resumen múltiple QA; no iniciar otro envío');
    await this.local.prepare(id, actorId, authorization);
    const validation = await this.prisma.localXmlValidation.findUniqueOrThrow({ where: { documentId_profile_credentialRevision: { documentId: id, profile: 'LOCAL-QA-UBL21-RSA256-v1', credentialRevision: context.credentials.revision } } });
    const documentXml = await this.store.read(id, { storageKey: validation.xmlStorageKey, sha256: validation.xmlSha256, sizeBytes: validation.xmlSizeBytes });
    const { snapshot, credentials } = context;
    let request = { xml: documentXml.toString(), zip: await this.store.read(id, { storageKey: validation.zipStorageKey, sha256: validation.zipSha256, sizeBytes: validation.zipSizeBytes }), fileName: `${snapshot.issuer.identityNumber}-${snapshot.documentTypeCode}-${snapshot.fullNumber}`, digestValue: validation.digestValue };
    if (snapshot.documentTypeCode === '03') {
      // RC de una boleta para QA, sin consumir un nuevo correlativo de venta.
      const day = limaIssueDate(new Date().toISOString()).replaceAll('-', '');
      const counter = await this.prisma.fiscalQaCounter.upsert({ where: { id: `${snapshot.issuer.identityNumber}:${day}` }, create: { id: `${snapshot.issuer.identityNumber}:${day}`, lastNumber: 1 }, update: { lastNumber: { increment: 1 } } });
      if (counter.lastNumber > 99999) throw new ConflictException('Límite de resúmenes QA');
      const identifier = `RC-${day}-${counter.lastNumber}`;
      const secretContext = { ruc: snapshot.issuer.identityNumber, environment: 'BETA' };
      const bytes = this.vault.open(credentials.certificateCipher!, { ...secretContext, field: 'certificate' });
      let password: Buffer | undefined;
      try { password = this.vault.open(credentials.certificatePasswordCipher!, { ...secretContext, field: 'certificatePassword' }); request = await this.signer.prepare(snapshot, bytes, password.toString(), identifier); }
      finally { bytes.fill(0); password?.fill(0); }
    }
    // Control obligatorio antes de encolar; no confundir XSD con reglas fiscales.
    const documentXsd = await this.xsd.validate(documentXml, 'Invoice');
    const requestXsd = snapshot.documentTypeCode === '03' ? await this.xsd.validate(request.xml, 'SummaryDocuments') : documentXsd;
    const xsdEvidence = { profile: XSD_PROFILE, archiveSha256: XSD_ARCHIVE_SHA256,
      documentXmlSha256: documentXsd.xmlSha256, requestXmlSha256: requestXsd.xmlSha256, verifiedAt: requestXsd.verifiedAt };
    const runId = randomUUID();
    const requestArtifact = await this.store.put(id, `QA-${runId}.zip`, request.zip);
    const signedXmlArtifact = await this.store.put(id, `QA-${runId}.xml`, Buffer.from(request.xml));
    await this.local.context(id, authorization);
    const row = await this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', `${snapshot.issuer.identityNumber}:BETA`);
      const current = await tx.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: snapshot.issuer.identityNumber, environment: 'BETA' } } });
      if (current?.revision !== credentials.revision) throw new ConflictException('Las credenciales cambiaron. Repita la preparación');
      if (await tx.fiscalBatchQaMember.findUnique({ where: { documentId_action: { documentId:id,action:'ALTA' } } })) throw new ConflictException('Boleta reservada en resumen múltiple; no reenviar');
      return tx.fiscalCircuitQa.upsert({ where: { documentId: id }, update: {}, create: {
        id: runId, documentId: id, actorId, credentialRevision: credentials.revision, scenario,
        requestFileName: `${request.fileName}.zip`, reference: snapshot.documentTypeCode === '01' ? snapshot.fullNumber : request.fileName.slice(12),
        digestValue: request.digestValue, documentDigestValue: validation.digestValue, notes: [],
        xsdEvidence,
        requestArtifact, signedXmlArtifact, documentXmlArtifact: { storageKey: validation.xmlStorageKey, sha256: validation.xmlSha256, sizeBytes: Number(validation.xmlSizeBytes) },
      } });
    });
    if (row.scenario !== scenario) throw new ConflictException('Otra prueba fue iniciada para este documento');
    await this.live.changed(id);
    return this.view(row);
  }
  onApplicationBootstrap() {
    if (process.env.FISCAL_CIRCUIT_QA_ENABLED !== 'true') return;
    this.queue = new Queue(QUEUE, { connection: connection() });
    this.worker = new Worker(QUEUE, job => this.process(String(job.data.id)), { connection: connection(), concurrency: 1 });
    this.worker.on('error', () => { /* La BD conserva el estado; no volcar job/errores externos. */ });
    this.timer = setInterval(() => void this.dispatch(), 2000);
  }
  private async dispatch() {
    if (this.flushing || !this.queue) return; this.flushing = true;
    try {
      const stale = new Date(Date.now() - 60000);
      // Crash tras envío: desconocido, nunca volver a sendBill/sendSummary.
      await this.prisma.fiscalCircuitQa.updateMany({ where: { state: 'SENDING', claimedAt: { lt: stale } }, data: { state: 'UNKNOWN', responseCode: 'WORKER_INTERRUPTED', description: 'Conciliar recepción; no reenviar automáticamente' } });
      await this.prisma.fiscalCircuitQa.updateMany({ where: { state: 'POLLING', claimedAt: { lt: stale } }, data: { state: 'WAITING_TICKET', nextPollAt: new Date() } });
      const rows = await this.prisma.fiscalCircuitQa.findMany({ where: { state: { in: ['QUEUED', 'WAITING_TICKET'] }, nextPollAt: { lte: new Date() } }, take: 20, orderBy: { createdAt: 'asc' } });
      for (const row of rows) await this.queue.add('qa-circuit', { id: row.id }, { jobId: `${row.id}-${row.pollAttempts}`, attempts: 1 });
    } catch { /* Reintentar dispatch, sin log de payload/secretos. */ } finally { this.flushing = false; }
  }
  async process(id: string) {
    this.enabled();
    const row = await this.prisma.fiscalCircuitQa.findUnique({ where: { id } });
    if (!row || !['QUEUED', 'WAITING_TICKET'].includes(row.state) || row.nextPollAt > new Date()) return;
    const polling = row.state === 'WAITING_TICKET';
    const owner = new Date(); const activeAttempt = row.pollAttempts + (polling ? 1 : 0);
    const claim = await this.prisma.fiscalCircuitQa.updateMany({ where: { id, state: row.state, pollAttempts: row.pollAttempts }, data: { state: polling ? 'POLLING' : 'SENDING', claimedAt: owner, ...(polling ? { pollAttempts: { increment: 1 } } : {}) } });
    if (claim.count !== 1) return;
    const activeState = polling ? 'POLLING' : 'SENDING';
    const update = async (data: Parameters<PrismaService['fiscalCircuitQa']['updateMany']>[0]['data']) => {
      const result = await this.prisma.fiscalCircuitQa.updateMany({ where: { id, state: activeState, claimedAt: owner, pollAttempts: activeAttempt }, data });
      if (result.count === 1) await this.live.changed(row.documentId);
      return result;
    };
    let transmissionAttempted = false;
    try {
      const document = await this.prisma.fiscalDocument.findUniqueOrThrow({ where: { documentId: row.documentId } });
      const snapshot = document.immutablePayload as unknown as FiscalDocumentSnapshot;
      const credentials = await this.prisma.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: document.issuerRuc, environment: 'BETA' } } });
      if (document.environment !== 'BETA' || !/^00\d{9}$/.test(document.issuerRuc) || credentials?.revision !== row.credentialRevision || credentials.certificateSelfSigned !== true || !credentials.certificateExpiresAt || credentials.certificateExpiresAt <= new Date() || !['QUEUED', 'BUILDING'].includes(document.status)) {
        await update({ state: 'BLOCKED', responseCode: 'QA_CONTEXT_CHANGED', description: 'Contexto de prueba o credenciales cambiaron; no enviado' }); return;
      }
      const adapter = new BoundedSoapAdapter({ environment: 'LOCAL_QA', ruc: document.issuerRuc, solUser: 'LOCALONLY', solPassword: 'FICTICIO-NO-SUNAT', qaScenario: row.scenario as QaScenario });
      if (polling) {
        if (!row.ticket) throw new Error();
        const result = await adapter.getStatus(row.ticket);
        if (result.kind === 'PROCESSING') {
          await update({ state: row.pollAttempts >= 19 ? 'POLL_LIMIT' : 'WAITING_TICKET', nextPollAt: new Date(Date.now() + Math.min(30000, 2000 * 2 ** Math.min(4, row.pollAttempts))) }); return;
        }
        if (result.kind === 'ERROR') { await update({ state: 'UNKNOWN', responseCode: result.code, description: result.message }); return; }
        await this.archiveCdr(row, result.cdrZip, activeState, owner, activeAttempt); return;
      }
      const zip = await this.store.read(row.documentId, row.requestArtifact as unknown as Stored);
      // Verifica de nuevo bytes archivados y que el ZIP contiene EXACTAMENTE el XML validado.
      const requestXml = await this.store.read(row.documentId, row.signedXmlArtifact as unknown as Stored);
      const documentXml = await this.store.read(row.documentId, row.documentXmlArtifact as unknown as Stored);
      let zipEntries = 0;
      const contents = unzipSync(zip, { filter: file => {
        if (++zipEntries !== 1 || file.originalSize > 2 * 1024 * 1024 || file.name !== row.requestFileName.replace(/\.zip$/, '.xml')) throw new Error();
        return true;
      } }); const names = Object.keys(contents);
      if (names.length !== 1 || names[0] !== row.requestFileName.replace(/\.zip$/, '.xml') || !Buffer.from(contents[names[0]]).equals(requestXml)) throw new Error();
      if (snapshot.documentTypeCode === '01' && !requestXml.equals(documentXml)) throw new Error();
      const documentXsd = await this.xsd.validate(documentXml, 'Invoice');
      const requestXsd = snapshot.documentTypeCode === '03' ? await this.xsd.validate(requestXml, 'SummaryDocuments') : documentXsd;
      const checked = await update({ xsdEvidence: { profile: XSD_PROFILE, archiveSha256: XSD_ARCHIVE_SHA256,
        documentXmlSha256: documentXsd.xmlSha256, requestXmlSha256: requestXsd.xmlSha256, verifiedAt: requestXsd.verifiedAt } });
      if (checked.count !== 1) return;
      const pkg = { documentId: row.documentId, fileName: row.requestFileName, zip, sha256: (row.requestArtifact as unknown as Stored).sha256 };
      if (snapshot.documentTypeCode === '03') {
        transmissionAttempted = true;
        const ticket = await adapter.submitSummary(pkg);
        await update({ state: 'WAITING_TICKET', ticket, pollAttempts: 1, nextPollAt: new Date(Date.now() + 2000) });
      } else {
        transmissionAttempted = true;
        const result = await adapter.submit(pkg); if (result.kind !== 'CDR') throw new Error();
        await this.archiveCdr(row, result.cdrZip, activeState, owner, activeAttempt);
      }
    } catch (error) {
      if (!polling && !transmissionAttempted) {
        const retry = isRetryableLocalPreparationError(error) && row.pollAttempts + 1 < LOCAL_PREPARATION_MAX_ATTEMPTS;
        await update({ state: retry ? 'QUEUED' : 'BLOCKED', claimedAt: null, pollAttempts: row.pollAttempts + 1,
          nextPollAt: new Date(Date.now() + localPreparationRetryDelay(row.pollAttempts + 1)),
          responseCode: retry ? 'QA_PREFLIGHT_RETRY' : 'QA_PREFLIGHT_FAILED',
          description: retry ? 'Validador local temporalmente no disponible; reintento antes del POST, mismo paquete' : 'No enviado: falló integridad, perfil XSD o preparación del circuito local' }); return;
      }
      const code = error instanceof SoapSubmissionError ? error.code : 'INVALID_ARTIFACT_OR_CDR';
      if (polling && error instanceof SoapSubmissionError && error.kind === 'UNKNOWN') {
        await update({ state: row.pollAttempts >= 19 ? 'POLL_LIMIT' : 'WAITING_TICKET', responseCode: code, description: 'Consulta fallida; se consultará el MISMO ticket, sin reenviar', nextPollAt: new Date(Date.now() + Math.min(30000, 2000 * 2 ** Math.min(4, row.pollAttempts))) });
      } else await update({ state: 'UNKNOWN', responseCode: code, description: 'Requiere revisión/conciliación. No se reenvía ni consume correlativo' });
    }
  }
  private async archiveCdr(row: FiscalCircuitQa, zip: Buffer, state: string, owner: Date, attempt: number) {
    const ruc = row.requestFileName.slice(0, 11);
    const cdr = parseCdrZip(zip, { fileName: `R-${row.requestFileName.replace(/\.zip$/, '.xml')}`, issuerRuc: ruc, reference: row.reference });
    const cdrZipArtifact = await this.store.put(row.documentId, `QA-CDR-${row.id}.zip`, zip);
    const cdrXmlArtifact = await this.store.put(row.documentId, `QA-CDR-${row.id}.xml`, cdr.xml);
    const result = await this.prisma.fiscalCircuitQa.updateMany({ where: { id: row.id, state, claimedAt: owner, pollAttempts: attempt }, data: { state: cdr.status, responseCode: cdr.code, description: cdr.description, notes: cdr.notes, cdrZipArtifact, cdrXmlArtifact } });
    if (result.count === 1) await this.live.changed(row.documentId);
  }
  async download(id: string, format: string, authorization?: string) {
    this.enabled(); const context = await this.local.context(id, authorization);
    const row = await this.prisma.fiscalCircuitQa.findUnique({ where: { documentId: id } });
    if (!row || row.credentialRevision !== context.credentials.revision || !isDeepStrictEqual(context.fiscal.immutablePayload, context.snapshot)) throw new ConflictException('Prueba no disponible o credenciales cambiaron');
    if (format === 'ticket' || format === 'a4') {
      if (!['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED', 'UNKNOWN'].includes(row.state)) throw new ConflictException('Prueba de transporte en curso');
      const xml = await this.store.read(id, row.documentXmlArtifact as unknown as Stored);
      const root = safeXml(xml.toString());
      const digests = root.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'DigestValue');
      if (digests.length !== 1 || digests[0].textContent !== row.documentDigestValue) throw new ConflictException('Hash archivado inconsistente');
      return { bytes: await this.previews.document(context.snapshot, format, authorization, { digestValue: row.documentDigestValue, status: row.state }, context.printContext), mediaType: 'application/pdf', fileName: `${context.snapshot.issuer.identityNumber}-${context.snapshot.fullNumber}-${format}-SIMULADO.pdf` };
    }
    const map = { xml: row.documentXmlArtifact, request: row.requestArtifact, cdr: row.cdrZipArtifact };
    if (!Object.hasOwn(map, format)) throw new BadRequestException('Formato inválido');
    const artifact = map[format as keyof typeof map]; if (!artifact) throw new ConflictException('CDR simulado no disponible');
    const bytes = await this.store.read(id, artifact as unknown as Stored).catch(() => { throw new ServiceUnavailableException('Archivo de prueba dañado'); });
    return { bytes, mediaType: format === 'xml' ? 'application/xml' : 'application/zip', fileName: `${context.snapshot.issuer.identityNumber}-${context.snapshot.fullNumber}-${format}-SIMULADO.${format === 'xml' ? 'xml' : 'zip'}` };
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.worker?.close(); await this.queue?.close(); await this.live.close(); }
}
