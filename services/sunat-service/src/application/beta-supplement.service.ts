import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { Queue, Worker } from 'bullmq';
import { LivePublisher, redisConnection } from '@factuez/service-access';
import { fiscalCanonical, validateFiscalAcceptance, type FiscalAcceptanceEvidence, type FiscalNoteSnapshot } from '@factuez/sunat-core/dist/fiscal-note';
import type { FiscalBatchSnapshot } from '@factuez/sunat-core/dist/fiscal-batch';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { PrismaService } from '../infrastructure/prisma.service';
import { ArtifactStore } from '../infrastructure/artifact-store';
import { SecretVault } from '../infrastructure/crypto/secret-vault';
import { CertificateInspectionService } from '../infrastructure/crypto/certificate-inspection.service';
import { CertificateTrustService } from '../infrastructure/crypto/certificate-trust.service';
import { CdrSignatureTrustService } from '../infrastructure/crypto/cdr-signature-trust.service';
import { BetaFiscalPackageWorkerService } from '../infrastructure/crypto/beta-fiscal-package-worker.service';
import { betaFiscalIdentity, type BetaFiscalEnvelope, type BetaSupplementContext } from '../infrastructure/crypto/beta-fiscal-package-pipeline';
import { XsdValidationService } from '../infrastructure/sunat/xsd-validation.service';
import { BoundedSoapAdapter } from '../infrastructure/sunat/bounded-soap.adapter';
import { validateBetaPackage } from '../infrastructure/sunat/beta-package-validator';
import { parseCdrZip } from '../infrastructure/sunat/cdr-parser';
import { BetaDispatchPipeline, type BetaDispatchPorts, type BetaPrepared } from './beta-dispatch-pipeline';
import { BetaSupplementRepository, type BetaSupplementManifest, type BetaSupplementRow } from './beta-supplement.repository';
import { assertOfficialFiscalActivation } from './fiscal-readiness.service';
import { verifyBetaSummaryAcceptance, type BetaSummaryAcceptedBatch, type BetaSummaryAcceptanceMetadata } from './beta-summary-acceptance';
const QUEUE = 'sunat-beta-supplements-v1';

/** Transporte real 07/08-F y RC/RA separado del QA. Sin controlador público ni activación automática. */
@Injectable()
export class BetaSupplementService implements OnApplicationBootstrap, OnModuleDestroy {
  private queue?: Queue; private worker?: Worker; private timer?: NodeJS.Timeout; private flushing = false;
  private readonly manifests = new Map<string, BetaSupplementManifest>(); private readonly live = new LivePublisher();
  constructor(private readonly prisma: PrismaService, private readonly repository: BetaSupplementRepository,
    private readonly store: ArtifactStore, private readonly vault: SecretVault, private readonly inspection: CertificateInspectionService,
    private readonly trust: CertificateTrustService, private readonly signer: BetaFiscalPackageWorkerService,
    private readonly xsd: XsdValidationService, private readonly cdrTrust: CdrSignatureTrustService) {}
  private authorize(envelope: BetaFiscalEnvelope) {
    betaFiscalIdentity(envelope); assertOfficialFiscalActivation();
  }
  /** Invocación interna tras evento autorizado de Billing, no acepta XML ni evidencia de una PWA. */
  async stage(envelope: BetaFiscalEnvelope, eventId: string, correlationId: string) {
    this.authorize(envelope); const checked = await this.context(envelope);
    return this.repository.stage(envelope, eventId, correlationId, checked.summaryProofs);
  }
  private async matchingDocument(snapshot: FiscalDocumentSnapshot | FiscalNoteSnapshot, identityOnly = false) {
    const document = await this.prisma.fiscalDocument.findFirst({ where: { documentId: snapshot.documentId,
      issuerRuc: snapshot.issuer.identityNumber, environment: 'BETA' } });
    if (!document) throw new Error('Snapshot no corresponde a la copia propia del emisor');
    if (identityOnly) {
      // RC modificación congela la identidad: sólo su versión de importes/ítems
      // puede diferir. Nunca usar este camino sin acreditar el RC anterior.
      const original = document.immutablePayload as unknown as FiscalDocumentSnapshot | FiscalNoteSnapshot;
      for (const field of ['documentId', 'documentTypeCode', 'series', 'number', 'fullNumber', 'issueDate', 'environment', 'currencyCode', 'operationTypeCode', 'companyId', 'branchId', 'issuer', 'customer'] as const)
        if (!isDeepStrictEqual(original[field], snapshot[field])) throw new Error('Identidad de versión RC no corresponde al documento propio');
      if ('reference' in snapshot && (!('reference' in original) || !isDeepStrictEqual(original.reference, snapshot.reference))) throw new Error('Referencia de nota RC cambió');
    } else if (!isDeepStrictEqual(document.immutablePayload, JSON.parse(JSON.stringify(snapshot)))) throw new Error('Snapshot no corresponde a la copia propia del emisor');
    return document;
  }
  private async summaryRecord(ruc: string, identifier: string): Promise<BetaSummaryAcceptedBatch | null> {
    const batch = await this.prisma.fiscalBatch.findUnique({ where: { issuerRuc_environment_identifier: { issuerRuc: ruc, environment: 'BETA', identifier } } });
    if (!batch || !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(batch.status)) return null;
    const submission = await this.prisma.sunatSubmission.findFirst({ where: { batchId: batch.id, errorCode: 'DONE', result: 'SUCCESS', completedAt: { not: null } }, orderBy: { completedAt: 'desc' } });
    if (!submission?.completedAt) return null;
    const cdr = await this.prisma.batchArtifact.findUnique({ where: { batchId_kind: { batchId: batch.id, kind: 'CDR_ZIP' } } });
    const request = await this.prisma.batchArtifact.findUnique({ where: { batchId_kind: { batchId: batch.id, kind: 'SIGNED_XML' } } });
    if (!cdr || !request) return null;
    const snapshot = batch.immutablePayload as unknown as FiscalBatchSnapshot;
    return { batch: snapshot, status: batch.status as BetaSummaryAcceptedBatch['status'], completedAt: submission.completedAt.toISOString(),
      cdrZip: { fileName: `R-${ruc}-${identifier}.zip`, storageKey: cdr.storageKey, sha256: cdr.sha256, sizeBytes: Number(cdr.sizeBytes) },
      requestXml: { bytes: await this.store.read(snapshot.documentId, request), sha256: request.sha256 } };
  }
  private async latestSummary(snapshot: FiscalDocumentSnapshot | FiscalNoteSnapshot, proof: BetaSummaryAcceptanceMetadata) {
    const batches = await this.prisma.fiscalBatch.findMany({ where: { issuerRuc: proof.issuerRuc, environment: 'BETA',
      identifier: { startsWith: 'RC-' }, status: { in: ['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'] } },
      orderBy: { updatedAt: 'desc' }, take: 201, select: { id: true, identifier: true, immutablePayload: true } });
    if (batches.length > 200) throw new Error('Historial RC excede revisión acotada; conciliar antes de continuar');
    for (const batch of batches) {
      if (batch.identifier === proof.identifier) continue;
      const payload = batch.immutablePayload as unknown as FiscalBatchSnapshot;
      const member = payload.input?.entries?.find(e => e.document.snapshot.documentId.toLowerCase() === snapshot.documentId.toLowerCase());
      // El RC unipersonal legado también puede contener esta identidad.
      const legacy = batch.immutablePayload as unknown as { documentId?: string };
      if (!member && legacy.documentId?.toLowerCase() !== snapshot.documentId.toLowerCase()) continue;
      const later = await this.prisma.sunatSubmission.findFirst({ where: { batchId: batch.id, errorCode: 'DONE', result: 'SUCCESS',
        completedAt: { gte: new Date(proof.acceptedAt) } }, select: { id: true } });
      if (later) throw new Error('Existe otra versión/baja RC aceptada; no se usa evidencia anterior');
    }
  }
  private async acceptance(snapshot: FiscalDocumentSnapshot | FiscalNoteSnapshot, evidence: FiscalAcceptanceEvidence, asOf: string) {
    validateFiscalAcceptance(snapshot, evidence, asOf);
    if (evidence.source.kind === 'CDR_SUMMARY') {
      await this.matchingDocument(snapshot, true);
      const proof = await verifyBetaSummaryAcceptance(snapshot, evidence, asOf, {
        loadBatch: (ruc, _environment, identifier) => this.summaryRecord(ruc, identifier),
        readCdr: record => this.store.read(record.batch.documentId, { ...record.cdrZip, storageKey: record.cdrZip.storageKey! }),
        verifySignature: xml => this.cdrTrust.verify(xml),
      });
      await this.latestSummary(snapshot, proof); return proof;
    }
    const document = await this.matchingDocument(snapshot);
    if (!['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(document.status) || !document.acceptedAt ||
        document.acceptedAt.toISOString() !== evidence.acceptedAt) throw new Error('Original no tiene aceptación fiscal acreditada');
    const artifact = await this.prisma.documentArtifact.findUnique({ where: { documentId_kind: { documentId: snapshot.documentId, kind: 'CDR_ZIP' } } });
    if (!artifact || artifact.sha256 !== evidence.cdrSha256) throw new Error('CDR original no vinculado');
    const bytes = await this.store.read(snapshot.documentId, artifact);
    const cdr = parseCdrZip(bytes, { fileName: `R-${snapshot.issuer.identityNumber}-${snapshot.documentTypeCode}-${snapshot.fullNumber}.xml`,
      issuerRuc: snapshot.issuer.identityNumber, reference: snapshot.fullNumber });
    if (cdr.code !== '0' || cdr.status !== evidence.status || !await this.cdrTrust.verify(cdr.xml)) throw new Error('CDR original sin firma/confianza verificadas');
  }
  private async context(envelope: BetaFiscalEnvelope, revision?: number) {
    const identity = betaFiscalIdentity(envelope);
    const summaryProofs: BetaSummaryAcceptanceMetadata[] = [];
    const accept = async (snapshot: FiscalDocumentSnapshot | FiscalNoteSnapshot, evidence: FiscalAcceptanceEvidence, asOf: string) => {
      const proof = await this.acceptance(snapshot, evidence, asOf); if (proof) summaryProofs.push(proof);
    };
    if (envelope.kind === 'NOTE') {
      const ctx = envelope.context; await accept(ctx.original, ctx.acceptance, ctx.asOf);
      for (const entry of ctx.creditHistory.entries) {
        const previous = await this.matchingDocument(entry.note);
        if (entry.state === 'ACCEPTED' && !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(previous.status)) throw new Error('Historial de créditos no corresponde al estado persistido');
        if (previous.status === 'REJECTED') throw new Error('Crédito rechazado no reserva capacidad');
      }
    } else for (const entry of envelope.batch.input.entries) {
      const snapshot = entry.document.snapshot;
      const modifying = 'conditionCode' in entry && entry.conditionCode !== '1';
      const previous = await this.matchingDocument(snapshot, modifying);
      if (entry.document.noteContext) {
        const noteContext = entry.document.noteContext;
        await accept(noteContext.original, noteContext.acceptance, envelope.asOf);
        for (const credit of noteContext.creditHistory.entries) await this.matchingDocument(credit.note);
      }
      if (envelope.batch.kind === 'RA') {
        if (!('acceptance' in entry)) throw new Error('RA sin aceptación'); await accept(snapshot, entry.acceptance, envelope.asOf);
      } else if ('conditionCode' in entry) {
        if (entry.conditionCode === '1' && previous.acceptedAt) throw new Error('Alta RC ya informada; no se reenvía');
        if (entry.conditionCode !== '1') await accept(entry.previous.document.snapshot, entry.previous.acceptance, envelope.asOf);
      }
    }
    const credentials = await this.prisma.sunatCredentials.findUnique({ where: { issuerRuc_environment: { issuerRuc: identity.ruc, environment: 'BETA' } } });
    if (!credentials?.certificateCipher || !credentials.certificatePasswordCipher || credentials.certificateSelfSigned !== false ||
        !credentials.certificateExpiresAt || credentials.certificateExpiresAt <= new Date() || !credentials.certificateFingerprint ||
        (revision !== undefined && credentials.revision !== revision)) throw new Error('Certificado Beta no preparado');
    // Cada proof vuelve a comprobarse dentro de la reserva transaccional. No se
    // guardan secretos ni se confía en booleanos de la PWA.
    return { ...credentials, summaryProofs: summaryProofs.filter((proof, index) =>
      summaryProofs.findIndex(p => fiscalCanonical(p) === fiscalCanonical(proof)) === index) };
  }
  private adapter(row: BetaSupplementRow) { return new BoundedSoapAdapter({ environment: 'BETA', ruc: row.snapshot.issuer.identityNumber, solUser: 'MODDATOS', solPassword: 'MODDATOS' }); }
  private async prepare(row: BetaSupplementRow): Promise<BetaPrepared> {
    const envelope = row.snapshot.envelope, credentials = await this.context(envelope);
    const ctx = { ruc: row.snapshot.issuer.identityNumber, environment: 'BETA' };
    const bytes = this.vault.open(credentials.certificateCipher!, { ...ctx, field: 'certificate' }); let password: Buffer | undefined;
    let prepared: Awaited<ReturnType<BetaFiscalPackageWorkerService['prepare']>>;
    try {
      password = this.vault.open(credentials.certificatePasswordCipher!, { ...ctx, field: 'certificatePassword' });
      const metadata = await this.inspection.inspect(bytes, password.toString()); const trust = await this.trust.evaluate(metadata, ctx.ruc);
      if (metadata.fingerprint !== credentials.certificateFingerprint || !trust.chainValid || !trust.identityMatched || trust.revocation !== 'VERIFIED_OFFLINE_CRL') throw new Error('Cadena/identidad/revocación pendientes');
      prepared = await this.signer.prepare(envelope, bytes, password.toString());
    } finally { bytes.fill(0); password?.fill(0); }
    if (prepared.signed.certificateFingerprintSha256 !== credentials.certificateFingerprint) throw new Error('Firmante cambió');
    const proof = await this.xsd.validate(prepared.xml, prepared.rootName);
    await this.context(envelope, credentials.revision);
    if (!await this.repository.owns(row, 'PREPARING')) throw new Error('Lease perdida');
    const manifest: BetaSupplementManifest = { fileName: prepared.fileName, reference: prepared.reference, revision: credentials.revision,
      fingerprint: credentials.certificateFingerprint!, digest: prepared.signed.digestValue,
      xml: await this.store.put(row.documentId, prepared.fileName.replace(/\.zip$/, '.xml'), Buffer.from(prepared.xml)),
      zip: await this.store.put(row.documentId, prepared.fileName, prepared.zip), xsdEvidence: proof };
    if (manifest.xml.sha256 !== proof.xmlSha256) throw new Error('XSD no corresponde al paquete'); this.manifests.set(row.id, manifest);
    return { fileName: manifest.fileName, reference: manifest.reference, revision: manifest.revision, zip: prepared.zip, sha256: manifest.zip.sha256 };
  }
  private async archived(row: BetaSupplementRow) {
    const manifest = await this.repository.manifest(row); await this.context(row.snapshot.envelope, manifest.revision);
    const bytes = await this.store.read(row.documentId, manifest.zip);
    const identity = betaFiscalIdentity(row.snapshot.envelope), verified = validateBetaPackage({ documentId: row.documentId, fileName: manifest.fileName, zip: bytes, sha256: manifest.zip.sha256 }, identity.ruc, identity.method);
    const archived = await this.store.read(row.documentId, manifest.xml);
    if (!Buffer.from(verified.xml).equals(archived) || verified.certificateFingerprint !== manifest.fingerprint || identity.reference !== manifest.reference) throw new Error('Paquete archivado cambió');
    await this.xsd.validate(verified.xml, identity.rootName);
    return { fileName: manifest.fileName, reference: manifest.reference, revision: manifest.revision, zip: bytes, sha256: manifest.zip.sha256 };
  }
  async process(id: string) {
    const row = await this.repository.load(id); if (!row) return;
    const ports: BetaDispatchPorts<BetaSupplementContext> = {
      authorize: async value => { this.authorize(value.snapshot.envelope); }, claim: (value, phase) => this.repository.claim(value, phase),
      prepare: value => this.prepare(value), archived: value => this.archived(value), owns: (value, phase) => this.repository.owns(value, phase),
      savePrepared: async value => this.repository.savePrepared(value, this.manifests.get(value.id) ?? await this.repository.manifest(value)),
      transition: async (value, from, to, details) => { const changed = await this.repository.transition(value, from, to, details);
        if (changed) await this.live.changed(value.documentId); return changed; },
      submit: async (value, prepared) => {
        await this.context(value.snapshot.envelope, prepared.revision); const identity = betaFiscalIdentity(value.snapshot.envelope);
        const pkg = { documentId: value.documentId, fileName: prepared.fileName, zip: prepared.zip, sha256: prepared.sha256 };
        return identity.method === 'sendBill' ? this.adapter(value).submit(pkg) : { kind: 'TICKET', ticket: await this.adapter(value).submitSummary(pkg) };
      },
      getStatus: async (value, ticket) => { await this.context(value.snapshot.envelope); return this.adapter(value).getStatus(ticket); },
      cdr: async (value, prepared, bytes) => {
        const parsed = parseCdrZip(bytes, { fileName: `R-${prepared.fileName.replace(/\.zip$/, '.xml')}`, issuerRuc: value.snapshot.issuer.identityNumber, reference: prepared.reference });
        const trusted = await this.cdrTrust.verify(parsed.xml);
        const zip = await this.store.put(value.documentId, `R-${prepared.fileName}`, bytes), xml = await this.store.put(value.documentId, `R-${prepared.fileName.replace(/\.zip$/, '.xml')}`, parsed.xml);
        await this.prisma.$transaction(async tx => {
          const stored = await tx.sunatSubmission.findUniqueOrThrow({ where: { id: value.id } });
          const owned = await tx.sunatSubmission.updateMany({ where: { id: value.id, startedAt: value.owner, attempt: value.attempt,
            result: 'PENDING', completedAt: null, errorCode: { in: ['SENDING', 'POLLING'] }, nextRetryAt: { gt: new Date() } },
            data: { responseArtifactKey: zip.storageKey, nextRetryAt: new Date(Date.now() + 60000) } });
          if (owned.count !== 1) throw new Error('CDR perdió lease');
          for (const [kind, file, mediaType] of [['CDR_ZIP', zip, 'application/zip'], ['CDR_XML', xml, 'application/xml']] as const) {
            if (stored.documentId) await tx.documentArtifact.create({ data: { documentId: stored.documentId, kind, ...file, mediaType } });
            else await tx.batchArtifact.create({ data: { batchId: stored.batchId!, kind, ...file, mediaType } });
          }
          await tx.cdrLog.create({ data: { documentId: stored.documentId, batchId: stored.batchId, submissionId: stored.id,
            responseCode: parsed.code, description: trusted ? parsed.description : 'CDR recibido: confianza no acreditada',
            notes: parsed.notes, cdrStorageKey: zip.storageKey, cdrSha256: zip.sha256 } });
        });
        return { trusted, status: parsed.status, code: parsed.code, description: parsed.description, notes: parsed.notes };
      },
    };
    try { await new BetaDispatchPipeline(ports).run(row); } finally { this.manifests.delete(id); }
  }
  onApplicationBootstrap() {
    if (process.env.SUNAT_BETA_WORKFLOW_ENABLED !== 'true') return; try { assertOfficialFiscalActivation(); } catch { return; }
    const queue = new Queue(QUEUE, { connection: redisConnection() }); this.queue = queue; queue.on('error', () => {});
    const worker = new Worker(QUEUE, job => this.process(String(job.data.id)), { connection: redisConnection(), concurrency: 1 }); this.worker = worker; worker.on('error', () => {});
    this.timer = setInterval(() => void this.dispatch(), 2000);
  }
  private async dispatch() {
    if (this.flushing || !this.queue) return; this.flushing = true;
    try { await this.repository.recoverInterrupted(); for (const row of await this.repository.due()) await this.queue.add('supplement', { id: row.id }, { jobId: row.id, attempts: 1, removeOnComplete: true, removeOnFail: true }); }
    catch { /* Persistencia primaria; no imprimir snapshots/errores externos. */ } finally { this.flushing = false; }
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.worker?.close(); await this.queue?.close(); await this.live.close(); }
}
