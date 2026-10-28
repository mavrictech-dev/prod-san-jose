import { Injectable } from '@nestjs/common';
import { AccessError, UUID } from '@factuez/service-access';
import { randomUUID } from 'node:crypto';
import { SmtpConfigurationService } from './smtp-configuration.service';
import { SmtpConfigurationVault } from './smtp-configuration.crypto';
import { CorporateDocumentStore } from './corporate-document-store';
import { CorporateDocumentHealth } from './corporate-document-health';
import { CorporateDocumentSmtp } from './corporate-document-transport';
import { CorporateDocumentSource } from './corporate-document-source';
import { digest } from './corporate-mail.policy';
import { activeDocumentGrant, documentConfigurationDigest, DOCUMENT_AUTHORIZATION_PROFILE, canonical, documentActivationInput, documentGate, documentJobView, documentSendInput, documentSmtpEnabled, type DocumentMailJob } from './corporate-document-policy';
@Injectable()
export class CorporateDocumentService {
  private preparing = 0;
  constructor(private readonly settings: SmtpConfigurationService, private readonly store: CorporateDocumentStore,
    private readonly vault: SmtpConfigurationVault, private readonly health: CorporateDocumentHealth,
    private readonly smtp: CorporateDocumentSmtp, private readonly source: CorporateDocumentSource) {}
  private same(a: Awaited<ReturnType<SmtpConfigurationService['corporateSnapshot']>>, b: Awaited<ReturnType<SmtpConfigurationService['corporateSnapshot']>>) {
    if (a.actorId !== b.actorId || a.issuer.companyId !== b.issuer.companyId || a.issuer.ruc !== b.issuer.ruc ||
      a.row.revision !== b.row.revision || documentConfigurationDigest(a.row) !== documentConfigurationDigest(b.row))
      throw new AccessError(409, 'La sesión, el RUC o las credenciales cambiaron');
  }
  async status(companyId: string, documentId: string, authorization: string) {
    if (!UUID.test(documentId)) throw new AccessError(400, 'Comprobante inválido');
    const context = await this.settings.corporateAuthorization(companyId, authorization);
    // Read status never downloads originals, prepares a PDF, opens SMTP or submits a job.
    // Document authorization is still required even while send is disabled.
    const configuration = await this.settings.status(companyId, authorization);
    const storageReady = await this.store.ready();
    const grant = storageReady ? await this.store.activation(context.issuer) : null;
    let grantCurrent = false;
    if (configuration.integrity === 'VALID' && configuration.hostnameApproved && configuration.revision > 0) {
      const snap = await this.settings.corporateSnapshot(companyId, authorization, configuration.revision);
      grantCurrent = activeDocumentGrant(grant, snap.row);
    }
    const doc = await this.source.authorize(context.issuer, documentId, authorization, false);
    const history = storageReady ? await this.store.history(context.issuer, documentId) : { jobs: [], events: [] };
    const latest = await this.settings.corporateAuthorization(companyId, authorization);
    if (latest.actorId !== context.actorId || latest.actorId !== doc.actorId || latest.issuer.ruc !== context.issuer.ruc) throw new AccessError(401, 'Autorización cambió');
    const readyToSendDocument = documentSmtpEnabled() && storageReady && this.health.ready && grantCurrent;
    return { ...context.issuer, documentId, fullNumber: doc.fullNumber, documentType: doc.documentType, environment: 'PRODUCTION',
      configurationRevision: configuration.revision, activationRevision: grant?.revision ?? 0, enabledForDocuments: grant?.enabled ?? false,
      authorizedConfigurationRevision: grant?.configurationRevision ?? null, grantCurrent, serverEnabled: documentSmtpEnabled(), storageReady,
      workerReady: this.health.ready, readyToSendDocument, state: readyToSendDocument ? 'CORPORATE_DOCUMENT_SMTP_ACTIVE' : 'CORPORATE_DOCUMENT_SMTP_DISABLED',
      scope: 'DOCUMENT', authorizationProfile: DOCUMENT_AUTHORIZATION_PROFILE, b2bAuthorized: false, deliveredToClient: false, jobs: history.jobs.map(documentJobView), events: history.events };
  }
  async activate(companyId: string, body: unknown, authorization: string) {
    const input = documentActivationInput(body);
    const before = await this.settings.corporateSnapshot(companyId, authorization, input.expectedRevision, input.enabled);
    if (input.enabled) documentGate();
    const current = await this.settings.corporateSnapshot(companyId, authorization, input.expectedRevision, input.enabled);
    this.same(before, current); if (input.enabled) documentGate();
    const grant = await this.store.setActivation(current.row, current.actorId, input.expectedActivationRevision, input.enabled);
    return { companyId: current.issuer.companyId, ruc: current.issuer.ruc, scope: 'DOCUMENT', activationRevision: grant.revision,
      configurationRevision: grant.configurationRevision, enabledForDocuments: grant.enabled, deliveredToClient: false, b2bAuthorized: false };
  }
  async enqueue(companyId: string, body: unknown, key: unknown, authorization: string) {
    if (this.preparing >= 2) throw new AccessError(429, 'Dos comprobantes en preparación; intente más tarde');
    this.preparing++;
    try { return await this.prepareEnqueue(companyId, body, key, authorization); } finally { this.preparing--; }
  }
  private async prepareEnqueue(companyId: string, body: unknown, key: unknown, authorization: string) {
    const input = documentSendInput(body, key);
    const before = await this.settings.corporateSnapshot(companyId, authorization, input.expectedRevision);
    documentGate(); if (!this.health.ready) throw new AccessError(503, 'Cola DOCUMENT no disponible');
    const grant = await this.store.activation(before.issuer);
    if (!activeDocumentGrant(grant, before.row) || grant!.revision !== input.expectedActivationRevision) throw new AccessError(409, 'Falta autorización DOCUMENT vigente para el RUC y revisión');
    const doc = await this.source.authorize(before.issuer, input.documentId, authorization);
    if (doc.actorId !== before.actorId) throw new AccessError(401, 'Identidad documental cambió');
    const idempotencyHash = digest('DOCUMENT:' + before.actorId + ':' + before.issuer.ruc + ':' + input.key);
    const requestHash = digest(idempotencyHash + ':' + canonical({ revision: input.expectedRevision, grant: input.expectedActivationRevision,
      documentId: input.documentId, format: input.format, recipient: input.recipient }));
    const prior = await this.store.prior(before.issuer, before.actorId, idempotencyHash, requestHash);
    if (prior) return documentJobView(prior);
    const prepared = await this.source.prepare(before.issuer, input.documentId, input.format, authorization);
    if (canonical(prepared.proof) !== canonical(doc)) throw new AccessError(409, 'Documento cambió al preparar adjuntos');
    const id = randomUUID();
    const bytes = Buffer.from(JSON.stringify({ purpose: 'CORPORATE_DOCUMENT_V1', id, ...before.issuer, actorId: before.actorId,
      recipient: input.recipient, authorization, configurationRevision: input.expectedRevision, activationRevision: input.expectedActivationRevision,
      documentId: input.documentId, format: input.format, documentProof: prepared.documentProof }));
    let payloadCipher: string;
    try { payloadCipher = this.vault.seal(bytes, { ...before.issuer, field: `corporate-document:${id}` }).cipher; }
    finally { bytes.fill(0); }
    const current = await this.settings.corporateSnapshot(companyId, authorization, input.expectedRevision);
    this.same(before, current);
    if (canonical(await this.source.authorize(before.issuer, input.documentId, authorization)) !== canonical(doc)) throw new AccessError(409, 'Comprobante o acceso cambió antes de encolar');
    documentGate();
    const job = await this.store.enqueue({ row: current.row, actorId: current.actorId, activationRevision: input.expectedActivationRevision,
      id, idempotencyHash, requestHash, payloadCipher, documentId: input.documentId, format: input.format, documentProof: prepared.documentProof });
    return documentJobView(job);
  }
  private payload(job: DocumentMailJob) {
    if (!job.payloadCipher) throw new AccessError(409, 'Payload documental ausente');
    const bytes = this.vault.open(job.payloadCipher, { companyId: job.companyId, ruc: job.issuerRuc, field: `corporate-document:${job.id}` });
    try {
      const d = JSON.parse(bytes.toString('utf8'));
      if (!d || Object.keys(d).sort().join(',') !== 'activationRevision,actorId,authorization,companyId,configurationRevision,documentId,documentProof,format,id,purpose,recipient,ruc' ||
        d.purpose !== 'CORPORATE_DOCUMENT_V1' || d.id !== job.id || d.companyId !== job.companyId || d.ruc !== job.issuerRuc || d.actorId !== job.actorId ||
        d.configurationRevision !== job.configurationRevision || d.activationRevision !== job.activationRevision || d.documentId !== job.documentId ||
        d.format !== job.format || d.documentProof !== job.documentProof || typeof d.authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(d.authorization)) throw Error();
      const parsed = documentSendInput({ expectedRevision: d.configurationRevision, expectedActivationRevision: d.activationRevision,
        documentId: d.documentId, format: d.format, recipient: d.recipient, confirmed: true }, job.id);
      return { authorization: d.authorization as string, recipient: parsed.recipient };
    } catch { throw new AccessError(503, 'Payload documental no verificable'); }
    finally { bytes.fill(0); }
  }
  async process(id: string) {
    documentGate(); if (!UUID.test(id)) return;
    const job = await this.store.claim(id); if (!job) return;
    let sending = false;
    try {
      const payload = this.payload(job);
      let expected: Awaited<ReturnType<CorporateDocumentSource['authorize']>> | undefined;
      const current = async () => {
        documentGate();
        if (new Date(job.expiresAt).getTime() <= Date.now()) throw new AccessError(401, 'Autorización documental vencida');
        const snapshot = await this.settings.corporateSnapshot(String(job.companyId), payload.authorization, job.configurationRevision);
        if (snapshot.actorId !== job.actorId || snapshot.issuer.ruc !== job.issuerRuc || documentConfigurationDigest(snapshot.row) !== job.configurationDigest)
          throw new AccessError(409, 'Identidad o configuración del envío cambió');
        const grant = await this.store.activation(snapshot.issuer);
        if (!activeDocumentGrant(grant, snapshot.row) || grant!.revision !== job.activationRevision) throw new AccessError(409, 'Autorización DOCUMENT revocada');
        const proof = await this.source.authorize(snapshot.issuer, job.documentId, payload.authorization);
        if (proof.actorId !== job.actorId || expected && canonical(proof) !== canonical(expected)) throw new AccessError(409, 'Documento o acceso cambió');
        const stored = await this.store.get(job.id);
        if (!stored || !['PREPARING', 'SENDING'].includes(stored.state)) throw new AccessError(409, 'Trabajo documental cerrado');
        documentGate(); return { snapshot, proof };
      };
      const initial = await current(); expected = initial.proof;
      const prepared = await this.source.prepare(initial.snapshot.issuer, job.documentId, job.format, payload.authorization);
      if (prepared.documentProof !== job.documentProof || canonical(prepared.proof) !== canonical(expected)) throw new AccessError(409, 'Snapshot u originales cambiaron desde la solicitud');
      const latest = await current();
      if (!latest.snapshot.config) throw new AccessError(409, 'Configuración retirada');
      await this.smtp.send(latest.snapshot.config, payload.recipient, job.id, prepared, async () => { await current(); }, async () => {
        await current();
        if (!await this.store.transition(job.id, 'PREPARING', 'SENDING')) throw new AccessError(409, 'Trabajo documental vencido o reclamado');
        sending = true;
      });
      await this.store.transition(job.id, 'SENDING', 'HANDED_OFF');
    } catch (error) {
      const denied = error instanceof AccessError && [401, 403, 404, 409, 423].includes(error.status);
      await this.store.transition(job.id, sending ? 'SENDING' : 'PREPARING', sending ? 'UNKNOWN' : denied ? 'CANCELLED' : 'FAILED');
    }
  }
}
