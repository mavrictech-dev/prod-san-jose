import { Injectable } from '@nestjs/common';
import { AccessError, UUID } from '@factuez/service-access';
import { randomUUID } from 'node:crypto';
import { SmtpConfigurationService } from './smtp-configuration.service';
import { SmtpConfigurationVault } from './smtp-configuration.crypto';
import { CorporateMailStore } from './corporate-mail.store';
import { CorporateMailHealth } from './corporate-mail.health';
import { CorporateMailSmtp } from './corporate-mail.transport';
import { activationInput, activeGrant, configurationDigest, corporateDisabled, corporateSmtpEnabled, digest, jobView, testInput, type CorporateMailJob } from './corporate-mail.policy';
@Injectable()
export class CorporateMailService {
  constructor(private readonly settings: SmtpConfigurationService, private readonly store: CorporateMailStore,
    private readonly vault: SmtpConfigurationVault, private readonly health: CorporateMailHealth, private readonly smtp: CorporateMailSmtp) {}
  private gate() { if (!corporateSmtpEnabled()) throw corporateDisabled(); }
  private same(a: Awaited<ReturnType<SmtpConfigurationService['corporateSnapshot']>>, b: Awaited<ReturnType<SmtpConfigurationService['corporateSnapshot']>>) {
    if (a.actorId !== b.actorId || a.issuer.companyId !== b.issuer.companyId || a.issuer.ruc !== b.issuer.ruc ||
      a.row.revision !== b.row.revision || configurationDigest(a.row) !== configurationDigest(b.row))
      throw new AccessError(409, 'La sesión, el RUC o las credenciales cambiaron');
  }
  async status(companyId: string, authorization: string) {
    const context = await this.settings.corporateAuthorization(companyId, authorization);
    const configuration = await this.settings.status(companyId, authorization);
    const runtime = await this.settings.corporateRuntime(context.issuer, configuration.revision, configuration.integrity === 'VALID' && configuration.hostnameApproved);
    const history = runtime.storageReady ? await this.store.history(context.issuer) : { jobs: [], events: [] };
    const latest = await this.settings.corporateAuthorization(companyId, authorization);
    if (latest.actorId !== context.actorId || latest.issuer.ruc !== context.issuer.ruc) throw new AccessError(401, 'La sesión o el emisor cambió');
    return { ...context.issuer, configurationRevision: configuration.revision,
      state: runtime.readyToSendTest ? 'CORPORATE_SMTP_ACTIVE_TEST_ONLY' : 'EXTERNAL_SMTP_DISABLED',
      ...runtime, jobs: history.jobs.map(jobView), events: history.events };
  }
  async activate(companyId: string, body: unknown, authorization: string) {
    const input = activationInput(body);
    const before = await this.settings.corporateSnapshot(companyId, authorization, input.expectedRevision, input.enabled);
    if (input.enabled) this.gate(); // Revocation is allowed even while the server gate is disabled.
    const current = await this.settings.corporateSnapshot(companyId, authorization, input.expectedRevision, input.enabled);
    this.same(before, current); if (input.enabled) this.gate();
    await this.store.setActivation(current.row, current.actorId, input.expectedActivationRevision, input.enabled);
    return this.status(companyId, authorization);
  }
  async sendTest(companyId: string, body: unknown, key: unknown, authorization: string) {
    const input = testInput(body, key);
    const before = await this.settings.corporateSnapshot(companyId, authorization, input.expectedRevision);
    this.gate(); if (!this.health.ready) throw new AccessError(503, 'La cola y el worker de correo no están disponibles');
    const grant = await this.store.activation(before.issuer);
    if (!activeGrant(grant, before.row) || grant!.revision !== input.expectedActivationRevision) throw new AccessError(409, 'Autorice esta revisión de correo para el RUC');
    const id = randomUUID();
    const bytes = Buffer.from(JSON.stringify({ purpose: 'CORPORATE_TEST_V1', id, ...before.issuer, actorId: before.actorId,
      recipient: input.recipient, authorization, configurationRevision: input.expectedRevision, activationRevision: input.expectedActivationRevision }));
    let payloadCipher: string;
    try { payloadCipher = this.vault.seal(bytes, { ...before.issuer, field: `corporate-test:${id}` }).cipher; }
    finally { bytes.fill(0); }
    const current = await this.settings.corporateSnapshot(companyId, authorization, input.expectedRevision);
    this.same(before, current); this.gate();
    const idempotencyHash = digest(before.actorId + ':' + before.issuer.ruc + ':' + input.key);
    const requestHash = digest(idempotencyHash + ':' + JSON.stringify({ revision: input.expectedRevision, grant: input.expectedActivationRevision, recipient: input.recipient }));
    const job = await this.store.enqueue({ row: current.row, actorId: current.actorId, activationRevision: input.expectedActivationRevision,
      id, idempotencyHash, requestHash, payloadCipher });
    return jobView(job);
  }
  private payload(job: CorporateMailJob) {
    if (!job.payloadCipher) throw new AccessError(409, 'Autorización de tarea ausente');
    const bytes = this.vault.open(job.payloadCipher, { companyId: job.companyId, ruc: job.issuerRuc, field: `corporate-test:${job.id}` });
    try {
      const data = JSON.parse(bytes.toString('utf8'));
      if (!data || data.purpose !== 'CORPORATE_TEST_V1' || data.id !== job.id || data.companyId !== job.companyId ||
        data.ruc !== job.issuerRuc || data.actorId !== job.actorId || data.configurationRevision !== job.configurationRevision ||
        data.activationRevision !== job.activationRevision || typeof data.authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(data.authorization)) throw new Error();
      const checked = testInput({ expectedRevision: data.configurationRevision, expectedActivationRevision: data.activationRevision, recipient: data.recipient, confirmed: true }, job.id);
      return { authorization: data.authorization as string, recipient: checked.recipient };
    } catch { throw new AccessError(503, 'Integridad de la tarea de correo no verificable'); }
    finally { bytes.fill(0); }
  }
  async process(id: string) {
    this.gate(); if (!UUID.test(id)) return;
    const job = await this.store.claim(id); if (!job) return;
    let sending = false;
    try {
      const payload = this.payload(job);
      const current = async () => {
        this.gate();
        if (new Date(job.expiresAt).getTime() <= Date.now()) throw new AccessError(401, 'Autorización de prueba vencida');
        const snapshot = await this.settings.corporateSnapshot(String(job.companyId), payload.authorization, job.configurationRevision);
        if (snapshot.actorId !== job.actorId || snapshot.issuer.ruc !== job.issuerRuc || configurationDigest(snapshot.row) !== job.configurationDigest)
          throw new AccessError(409, 'La identidad o configuración del trabajo cambió');
        const grant = await this.store.activation(snapshot.issuer);
        if (!activeGrant(grant, snapshot.row) || grant!.revision !== job.activationRevision) throw new AccessError(409, 'Autorización de envío revocada o cambiada');
        const stored = await this.store.get(job.id);
        if (!stored || !['PREPARING', 'SENDING'].includes(stored.state)) throw new AccessError(409, 'Trabajo de correo ya cerrado');
        this.gate();
        return snapshot;
      };
      const prepared = await current();
      if (!prepared.config) throw new AccessError(409, 'Configuración de correo retirada');
      await this.smtp.send(prepared.config, payload.recipient, job.id, async () => { await current(); }, async () => {
        await current();
        if (!await this.store.transition(job.id, 'PREPARING', 'SENDING')) throw new AccessError(409, 'Trabajo de correo ya reclamado o vencido');
        sending = true;
      });
      await this.store.transition(job.id, 'SENDING', 'HANDED_OFF');
    } catch (error) {
      // Never persist exception text, SMTP responses, addresses, credentials or bearer tokens in audit/queue.
      const cancelled = error instanceof AccessError && [401, 403, 409, 423].includes(error.status);
      await this.store.transition(job.id, sending ? 'SENDING' : 'PREPARING', sending ? 'UNKNOWN' : cancelled ? 'CANCELLED' : 'FAILED');
    }
  }
}
