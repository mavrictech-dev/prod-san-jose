import type { Phase8AdminContextResolver, Phase8AdminContextAction } from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import { Injectable, Optional } from '@nestjs/common';
import { AccessError, identity, privateJson } from '@factuez/service-access';
import { SmtpConfigurationVault } from './smtp-configuration.crypto';
import { approvedHost, approvedSmtpHosts, EXTERNAL_SMTP_STATE, parseSmtpCredentials, parseSmtpInput, parseSmtpSettings, type CorporateSmtpConfiguration } from './smtp-configuration.policy';
import { SmtpConfigurationStore, type SmtpIssuer, type StoredSmtpConfiguration } from './smtp-configuration.store';
import { PreparedCorporateSmtp } from './smtp-configuration.transport';
import { SmtpLiveDiagnostic, smtpConnectionDiagnosticsEnabled } from './smtp-live-diagnostic';
import { CorporateMailStore } from './corporate-mail.store';
import { CorporateMailHealth } from './corporate-mail.health';
import { activeGrant, corporateSmtpEnabled } from './corporate-mail.policy';

@Injectable()
export class SmtpConfigurationService {
  private ownerContext?: Phase8AdminContextResolver;
  static createWithOwnerContext(store: SmtpConfigurationStore, vault: SmtpConfigurationVault, transport: PreparedCorporateSmtp, resolver: Phase8AdminContextResolver) {
    const service = new SmtpConfigurationService(store, vault, transport);
    service.ownerContext = resolver; return service;
  }
  constructor(private readonly store: SmtpConfigurationStore, private readonly vault: SmtpConfigurationVault,
    private readonly transport: PreparedCorporateSmtp, private readonly liveDiagnostic: SmtpLiveDiagnostic = new SmtpLiveDiagnostic(),
    @Optional() private readonly corporateStore?: CorporateMailStore, @Optional() private readonly corporateHealth?: CorporateMailHealth) {}

  /** Valida authVersion actual en Identity y existencia/acceso al RUC en Billing, nunca otra DB. */
  private async context(companyId: string, authorization: string | object, action: Phase8AdminContextAction = 'SMTP_READ', payload: unknown = {}) {
    if (this.ownerContext && typeof authorization === 'string') throw new AccessError(401, 'Se requiere capacidad propietaria');
    if (typeof authorization !== 'string') {
      if (!this.ownerContext) throw new AccessError(401, 'Contexto propietario no disponible');
      const context = await this.ownerContext.resolve(authorization, { action, companyId, environment: 'BETA', payload });
      if (String(context.issuer.companyId) !== companyId || context.environment !== 'BETA' || !/^[0-9]{11}$/.test(context.issuer.ruc) || !context.actorId)
        throw new AccessError(401, 'Contexto propietario inválido');
      return { issuer: context.issuer, actorId: context.actorId };
    }
    const user = await identity(authorization, 'document.email');
    if (!user.roles.includes('ADMIN') || user.scope.kind !== 'GLOBAL') throw new AccessError(403, 'Configuración SMTP requiere un administrador general');
    if (!/^[1-9]\d{0,9}$/.test(companyId) || !Number.isSafeInteger(Number(companyId)) || Number(companyId) > 2147483647)
      throw new AccessError(400, 'Emisor SMTP inválido');
    const catalog = await privateJson<{ companies?: Array<{ id: number; ruc: string }> }>(process.env.BILLING_INTERNAL_URL ?? 'http://billing-service:3002',
      '/api/v1/documents/catalog/issuance', authorization);
    if (!Array.isArray(catalog.companies)) throw new AccessError(503, 'No se pudo verificar el emisor SMTP');
    const issuer = catalog.companies.find(row => row && row.id === Number(companyId));
    if (!issuer || typeof issuer.ruc !== 'string' || !/^\d{11}$/.test(issuer.ruc)) throw new AccessError(404, 'Emisor no disponible');
    return { issuer: { companyId: issuer.id, ruc: issuer.ruc }, actorId: user.sub };
  }

  private decode(issuer: SmtpIssuer, row: StoredSmtpConfiguration): CorporateSmtpConfiguration | null {
    if (row.companyId !== issuer.companyId || row.ruc !== issuer.ruc || !Number.isInteger(row.keyVersion) ||
      row.configurationCipher.split('.')[1] !== String(row.keyVersion)) throw new AccessError(503, 'Integridad de configuración SMTP no verificable');
    const bytes = this.vault.open(row.configurationCipher, { ...issuer, field: 'configuration' });
    try {
      const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      // Tombstone cifrado: conserva revisión y auditoría, pero no contiene secretos.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).join(',') === 'removed' && parsed.removed === true) return null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'fromAddress,fromName,host,password,port,replyTo,tlsMode,username') throw new Error();
      return { ...parseSmtpSettings({ host: parsed.host, port: parsed.port, tlsMode: parsed.tlsMode, fromName: parsed.fromName,
        fromAddress: parsed.fromAddress, replyTo: parsed.replyTo }), ...parseSmtpCredentials({ username: parsed.username, password: parsed.password }) };
    } catch { throw new AccessError(503, 'Integridad de configuración SMTP no verificable'); }
    finally { bytes.fill(0); }
  }

  private async localStatus(issuer: SmtpIssuer) {
    const storageReady = await this.store.ready();
    const row = storageReady ? await this.store.read(issuer) : null;
    const encryption = this.vault.readiness();
    let config: CorporateSmtpConfiguration | undefined;
    let removed = false;
    let integrity: 'NOT_CONFIGURED' | 'NOT_CHECKED' | 'VALID' | 'INVALID' = row ? 'NOT_CHECKED' : 'NOT_CONFIGURED';
    if (row && encryption === 'READY') {
      try { const decoded = this.decode(issuer, row); removed = decoded === null; config = decoded ?? undefined; integrity = removed ? 'NOT_CONFIGURED' : 'VALID'; } catch { integrity = 'INVALID'; }
    }
    const { username: _username, password: _password, ...settings } = config ?? {} as Partial<CorporateSmtpConfiguration>;
    return { view: { ...issuer, state: EXTERNAL_SMTP_STATE, revision: row?.revision ?? 0, updatedAt: row?.updatedAt ?? null,
      configured: Boolean(row) && !removed, credentialsConfigured: Boolean(config?.username && config.password),
      settings: config ? settings : null, storageReady, encryption, integrity,
      approvedHostListConfigured: approvedSmtpHosts().length > 0, hostnameApproved: Boolean(config && approvedHost(config.host)),
      ...(smtpConnectionDiagnosticsEnabled() && !this.ownerContext ? { connectionDiagnosticsEnabled: true } : {}),
      networkAttempted: false, dnsValidated: false, smtpAuthenticationVerified: false, deliveredToClient: false, readyToSend: false }, config };
  }

  async status(companyId: string, authorization: string | object) {
    const { issuer } = await this.context(companyId, authorization);
    const view = (await this.localStatus(issuer)).view;
    if (typeof authorization !== 'string' || !this.corporateStore || !this.corporateHealth) return view;
    const runtime = await this.corporateRuntime(issuer, view.revision, view.integrity === 'VALID' && view.hostnameApproved);
    return { ...view, state: runtime.readyToSendTest ? 'CORPORATE_SMTP_ACTIVE_TEST_ONLY' as const : EXTERNAL_SMTP_STATE, corporate: runtime };
  }

  async corporateAuthorization(companyId: string, authorization: string) {
    if (typeof authorization !== 'string' || this.ownerContext) throw new AccessError(403, 'Correo PWA requiere una sesión humana');
    return this.context(companyId, authorization);
  }
  /** Private composition port, not an HTTP response. Authorization always precedes secret opening. */
  async corporateSnapshot(companyId: string, authorization: string, expectedRevision: number, requireConfig = true) {
    const context = await this.corporateAuthorization(companyId, authorization);
    const stored = await this.store.read(context.issuer);
    if (!stored || stored.revision !== expectedRevision) throw new AccessError(409, 'La configuración SMTP cambió; vuelva a consultar');
    const row = { ...stored };
    const config = requireConfig ? this.decode(context.issuer, row) : null;
    if (requireConfig && (!config || !approvedHost(config.host))) throw new AccessError(409, 'Configuración SMTP ausente o servidor sin aprobación');
    if (config) this.transport.dryRun(config);
    return { ...context, row, config };
  }
  async corporateRuntime(issuer: SmtpIssuer, revision: number, localValid: boolean) {
    const storageReady = Boolean(this.corporateStore && await this.corporateStore.ready());
    const grant = storageReady ? await this.corporateStore!.activation(issuer) : null;
    const row = storageReady ? await this.store.read(issuer) : null;
    const grantCurrent = Boolean(row && row.revision === revision && activeGrant(grant, row));
    const serverEnabled = corporateSmtpEnabled(), workerReady = this.corporateHealth?.ready === true;
    const readyToSendTest = serverEnabled && storageReady && workerReady && grantCurrent && localValid;
    return { serverEnabled, storageReady, workerReady, activationRevision: grant?.revision ?? 0,
      enabledForRuc: grant?.enabled ?? false, authorizedConfigurationRevision: grant?.configurationRevision ?? null,
      grantCurrent, readyToSendTest, scope: 'TEST_ONLY' as const, b2bAuthorized: false, documentEmailAvailable: false,
      readyToSend: false, deliveredToClient: false };
  }

  async save(companyId: string, body: unknown, authorization: string | object) {
    const context = await this.context(companyId, authorization, 'SMTP_SAVE', body);
    const input = parseSmtpInput(body);
    if (!approvedHost(input.settings.host)) throw new AccessError(400, 'Servidor SMTP no aprobado por el administrador de infraestructura');
    const existing = await this.store.read(context.issuer);
    if ((existing?.revision ?? 0) !== input.expectedRevision) throw new AccessError(409, 'La configuración SMTP cambió; vuelva a consultar antes de guardar');
    const previous = input.credentials ? undefined : existing ? this.decode(context.issuer, existing) : undefined;
    const credentials = input.credentials ?? (previous ? { username: previous.username, password: previous.password } : undefined);
    if (!credentials) throw new AccessError(400, 'Complete usuario y contraseña SMTP para la configuración inicial');
    const config = { ...input.settings, ...credentials };
    this.transport.dryRun(config); // Política local, no conexiones, DNS, verify() ni sendMail().
    const plaintext = Buffer.from(JSON.stringify(config), 'utf8');
    let sealed: { cipher: string; keyVersion: number };
    try { sealed = this.vault.seal(plaintext, { ...context.issuer, field: 'configuration' }); }
    finally { plaintext.fill(0); }
    // Evita admitir una mutación después de revocar la sesión durante la preparación.
    const current = await this.context(companyId, authorization, 'SMTP_SAVE', body);
    if (current.actorId !== context.actorId || current.issuer.ruc !== context.issuer.ruc) throw new AccessError(401, 'Sesión o emisor cambió; vuelva a consultar');
    await this.store.save(context.issuer, sealed, input.expectedRevision, context.actorId, Boolean(input.credentials));
    if (typeof authorization !== 'string') await this.context(companyId, authorization, 'SMTP_SAVE', body);
    return (await this.localStatus(context.issuer)).view;
  }
  async remove(companyId: string, body: unknown, authorization: string) {
    if (typeof authorization !== 'string') throw new AccessError(403, 'Operación propietaria no admitida');
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'expectedRevision' ||
      !Number.isSafeInteger((body as { expectedRevision: unknown }).expectedRevision) || Number((body as { expectedRevision: unknown }).expectedRevision) < 1 || Number((body as { expectedRevision: unknown }).expectedRevision) > 2147483646)
      throw new AccessError(400, 'Se requiere la revisión vigente para retirar SMTP');
    const context = await this.context(companyId, authorization);
    const existing = await this.store.read(context.issuer);
    const revision = (body as { expectedRevision: number }).expectedRevision;
    if (!existing || existing.revision !== revision) throw new AccessError(409, 'La configuración SMTP cambió; vuelva a consultar');
    const bytes = Buffer.from(JSON.stringify({ removed: true }));
    let sealed: { cipher: string; keyVersion: number };
    try { sealed = this.vault.seal(bytes, { ...context.issuer, field: 'configuration' }); } finally { bytes.fill(0); }
    const current = await this.context(companyId, authorization);
    if (current.actorId !== context.actorId || current.issuer.ruc !== context.issuer.ruc) throw new AccessError(401, 'La sesión o el emisor cambió');
    await this.store.save(context.issuer, sealed, revision, context.actorId, true);
    return (await this.localStatus(context.issuer)).view;
  }
  async audit(companyId: string, authorization: string, page = '1') {
    if (typeof authorization !== 'string') throw new AccessError(403, 'Operación propietaria no admitida');
    if (!/^[1-9]\d{0,5}$/.test(page)) throw new AccessError(400, 'Página inválida');
    const { issuer } = await this.context(companyId, authorization);
    return this.store.audit(issuer, Number(page));
  }

  async verifyConnection(companyId: string, body: unknown, authorization: string) {
    const startedAt = Date.now();
    // Browser administrator path only: owner/B2B capabilities never acquire network diagnostics.
    if (typeof authorization !== 'string') throw new AccessError(403, 'Operación propietaria no admitida');
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'expectedRevision' ||
      !Number.isSafeInteger((body as { expectedRevision: unknown }).expectedRevision) ||
      Number((body as { expectedRevision: unknown }).expectedRevision) < 1 || Number((body as { expectedRevision: unknown }).expectedRevision) > 2147483647)
      throw new AccessError(400, 'Se requiere únicamente expectedRevision con la revisión SMTP guardada');
    const context = await this.context(companyId, authorization);
    const expectedRevision = (body as { expectedRevision: number }).expectedRevision;
    return this.liveDiagnostic.run(context.actorId, context.issuer.ruc, async scope => {
      const stored = await scope.step(() => this.store.read(context.issuer));
      if (!stored || stored.revision !== expectedRevision) throw new AccessError(409, 'La configuración SMTP cambió; vuelva a consultar');
      const row = { ...stored };
      // Identity and Billing were checked before opening any secret or resolving DNS.
      scope.check();
      let config: CorporateSmtpConfiguration | null = null;
      const current = async () => {
        const latest = await scope.step(() => this.context(companyId, authorization));
        if (latest.actorId !== context.actorId || latest.issuer.companyId !== context.issuer.companyId || latest.issuer.ruc !== context.issuer.ruc)
          throw new AccessError(401, 'La sesión o el emisor cambió durante la comprobación');
        const snapshot = await scope.step(() => this.store.read(context.issuer));
        if (!snapshot || snapshot.companyId !== row.companyId || snapshot.ruc !== row.ruc || snapshot.revision !== row.revision ||
          snapshot.keyVersion !== row.keyVersion || snapshot.configurationCipher !== row.configurationCipher)
          throw new AccessError(409, 'La configuración o las credenciales SMTP cambiaron durante la comprobación; vuelva a consultar');
        if (config && !approvedHost(config.host)) throw new AccessError(409, 'El servidor SMTP dejó de estar aprobado');
      };
      await current();
      scope.check();
      config = this.decode(context.issuer, row);
      if (!config) throw new AccessError(409, 'La configuración SMTP fue retirada; vuelva a consultar');
      let result: Awaited<ReturnType<SmtpLiveDiagnostic['verify']>> | undefined;
      let failure: unknown;
      try { result = await this.liveDiagnostic.verify(config, current, scope); } catch (error) { failure = error; }
      // Recheck even after a failed SMTP exchange; no stale/unauthorized result is returned.
      await current();
      if (failure) throw failure;
      if (!result) throw new AccessError(503, 'Comprobación SMTP no disponible');
      return { companyId: context.issuer.companyId, ruc: context.issuer.ruc, revision: row.revision,
        state: EXTERNAL_SMTP_STATE, connectionVerified: true, ...result, networkAttempted: true,
        readyToSend: false, deliveredToClient: false, checkedAt: new Date().toISOString() };
    }, startedAt);
  }

  async dryRun(companyId: string, body: unknown, authorization: string) {
    if (typeof authorization !== 'string') throw new AccessError(403, 'Operación propietaria no admitida');
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new AccessError(400, 'El diagnóstico local no admite destinatarios ni parámetros de conexión');
    const { issuer } = await this.context(companyId, authorization);
    const { view, config } = await this.localStatus(issuer);
    const locallyPrepared = Boolean(view.storageReady && view.encryption === 'READY' && view.integrity === 'VALID' && config && view.hostnameApproved);
    if (locallyPrepared && config) this.transport.dryRun(config);
    return { companyId: issuer.companyId, ruc: issuer.ruc, state: EXTERNAL_SMTP_STATE, locallyPrepared,
      checks: [
        { code: 'STORAGE', status: view.storageReady ? 'READY' : 'MISSING' },
        { code: 'ENCRYPTION_KEY', status: view.encryption },
        { code: 'CONFIGURATION', status: view.configured ? 'STORED' : 'MISSING' },
        { code: 'AUTHENTICATED_ENCRYPTION', status: view.integrity },
        { code: 'APPROVED_HOST', status: view.hostnameApproved ? 'APPROVED' : view.approvedHostListConfigured ? 'NOT_APPROVED_OR_MISSING' : 'MISSING_ALLOWLIST' },
        { code: 'CREDENTIALS', status: view.credentialsConfigured ? 'STORED' : 'MISSING_OR_NOT_VERIFIABLE' },
        { code: 'TLS_POLICY', status: locallyPrepared ? 'STRICT' : 'NOT_CHECKED' },
        { code: 'DNS_AND_EGRESS', status: 'NOT_TESTED' },
        { code: 'SMTP_AUTHENTICATION', status: 'NOT_TESTED' },
        { code: 'DELIVERY', status: 'DISABLED' },
      ], networkAttempted: false, dnsValidated: false, smtpAuthenticationVerified: false, readyToSend: false, deliveredToClient: false };
  }
}
