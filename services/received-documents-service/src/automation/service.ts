import { automationCompany, hasActivation } from './authorization';
import { Injectable } from '@nestjs/common';
import { AccessError, UUID } from '@factuez/service-access';
import type { ReceivedAutomationConfig, ReceivedAutomationSettings, ReceivedSyncRun, ReceivedSireDiscovery } from '@factuez/contracts';
import type { Prisma, ReceptionConnection } from '../generated/prisma/client';
import { ReceptionPrisma } from '../prisma.service';
import { receptionCompany, type ReceptionAccess } from '../access';
import { defaultReceptionSettings, emptyCounters, imapApproved, parseAutomationSave, receptionReadiness } from './policy';
import { ReceptionVault } from './vault';

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export const connectionSettings = (c: ReceptionConnection) => c.settings as unknown as ReceivedAutomationSettings;
export function automationAdmin(access: ReceptionAccess) {
  if (access.user.scope.kind !== 'GLOBAL' || !access.user.roles.includes('ADMIN') || !access.user.permissions.includes('setup.manage')) throw new AccessError(403, 'La conexión por RUC requiere administrador general');
}
export function syncDto(r: { id: string; source: string; status: string; startedAt: Date | null; finishedAt: Date | null; counters: unknown; errorCode: string | null }): ReceivedSyncRun {
  return { id: r.id, source: r.source as ReceivedSyncRun['source'], status: r.status as ReceivedSyncRun['status'], startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null, counters: r.counters as ReceivedSyncRun['counters'], errorCode: r.errorCode };
}
@Injectable()
export class ReceptionAutomationService {
  private vault = new ReceptionVault();
  constructor(private readonly db: ReceptionPrisma) {}
  private dto(company: { id: number; ruc: string }, row: ReceptionConnection | null): ReceivedAutomationConfig {
    if (row && row.recipientRuc !== company.ruc) throw new AccessError(409, 'RUC de conexión no coincide; requiere revisión de TI');
    const secrets = row ? this.vault.open(row.encryptedCredentials, { companyId: company.id, ruc: company.ruc, revision: row.revision }) : {};
    const settings = row ? connectionSettings(row) : defaultReceptionSettings(), state = receptionReadiness(settings, company.ruc, secrets);
    return { companyId: company.id, recipientRuc: company.ruc, revision: row?.revision ?? 0, updatedAt: row?.updatedAt.toISOString() ?? null, settings,
      credentials: { mailPassword: !!secrets.mailPassword, sireClientSecret: !!secrets.sireClientSecret, solPassword: !!secrets.solPassword },
      liveReadAllowed: process.env.RECEIVED_LIVE_READ_ALLOWED === 'true', mailHostApproved: imapApproved(settings.mailbox.host), canManage: true, state,
      notice: state === 'WAITING_TI' ? 'Guardado; falta habilitación de lectura, host aprobado o credenciales. No se abrió ninguna conexión.' : state === 'READY_LOCAL' ? 'Datos ficticios locales; no hay compras ni aceptación de SUNAT.' : state === 'READY_READ_ONLY' ? 'Sólo lectura de correo y compras; no presenta libros ni emite comprobantes.' : 'Automatización desactivada.' };
  }
  async config(access: ReceptionAccess, companyId: unknown) {
    automationAdmin(access); const company = automationCompany(access, companyId);
    return this.dto(company, await this.db.receptionConnection.findUnique({ where: { companyId: company.id } }));
  }
  async save(access: ReceptionAccess, companyId: unknown, input: unknown) {
    automationAdmin(access); const company = automationCompany(access, companyId), command = parseAutomationSave(input, company.ruc);
    await this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${company.id})`;
      const current = await tx.receptionConnection.findUnique({ where: { companyId: company.id } });
      if ((current?.revision ?? 0) !== command.expectedRevision || current && current.recipientRuc !== company.ruc) throw new AccessError(409, 'La configuración cambió; vuelva a cargarla antes de guardar');
      const revision = command.expectedRevision + 1;
      const secrets = current ? this.vault.open(current.encryptedCredentials, { companyId: company.id, ruc: company.ruc, revision: current.revision }) : {};
      if (current) {
        const before = connectionSettings(current);
        if (before.mailbox.host !== command.settings.mailbox.host || before.mailbox.username !== command.settings.mailbox.username) delete secrets.mailPassword;
        if (before.sire.clientId !== command.settings.sire.clientId) delete secrets.sireClientSecret;
        if (before.sire.solUsername !== command.settings.sire.solUsername) delete secrets.solPassword;
      }
      Object.assign(secrets, command.credentials);
      // Any save invalidates validation and activation, including password-only edits.
      if (command.settings.mode === 'LIVE_READ_ONLY') command.settings.enabled = false;
      const encryptedCredentials = Object.keys(secrets).length ? this.vault.seal(secrets, { companyId: company.id, ruc: company.ruc, revision }) : null;
      const data = { recipientRuc: company.ruc, revision, enabled: command.settings.enabled, mode: command.settings.mode,
        settings: json(command.settings), encryptedCredentials, configuredBy: access.user.sub };
      await tx.receptionConnection.upsert({ where: { companyId: company.id }, create: { companyId: company.id, ...data }, update: data });
      await tx.receptionConnectionAudit.create({ data: { companyId: company.id, actorId: access.user.sub, revision, action: 'CONFIGURATION_SAVED',
        detail: { enabled: command.settings.enabled, mode: command.settings.mode, mailPasswordReplaced: !!command.credentials?.mailPassword,
          sireSecretReplaced: !!command.credentials?.sireClientSecret, solPasswordReplaced: !!command.credentials?.solPassword } } });
      // In-flight network replies for an older revision cannot persist documents.
      await tx.receptionMailboxCheckpoint.deleteMany({ where: { companyId: company.id } });
      await tx.receptionSyncRun.updateMany({ where: { companyId: company.id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'BLOCKED', activeKey: null, finishedAt: new Date(), errorCode: 'CONFIGURATION_CHANGED' } });
    });
    return this.config(access, company.id);
  }
  async runs(access: ReceptionAccess, companyId: unknown) {
    automationAdmin(access); const company = automationCompany(access, companyId);
    return { items: (await this.db.receptionSyncRun.findMany({ where: { companyId: company.id, recipientRuc: company.ruc }, orderBy: { createdAt: 'desc' }, take: 30 })).map(syncDto) };
  }
  async queue(access: ReceptionAccess, body: unknown) {
    automationAdmin(access); const b = body as { companyId?: unknown; source?: unknown };
    if (!b || !['MAIL', 'SIRE', 'ALL'].includes(String(b.source)) || Object.keys(b).some(k => !['companyId', 'source'].includes(k))) throw new AccessError(400, 'Sincronización inválida');
    const company = automationCompany(access, b.companyId), config = await this.config(access, company.id);
    const row = await this.db.receptionConnection.findUnique({ where: { companyId: company.id } });
    if (!row || !await hasActivation(this.db,row) || !['READY_LOCAL', 'READY_READ_ONLY'].includes(config.state)) throw new AccessError(403, 'Conexión desactivada o pendiente de TI. No se contactó SUNAT ni el buzón');
    let queued = 0;
    for (const source of ['MAIL', 'SIRE'] as const) {
      if (b.source !== 'ALL' && b.source !== source || !(source === 'MAIL' ? config.settings.mailbox.enabled : config.settings.sire.enabled)) continue;
      if (await createSyncRun(this.db, company.id, company.ruc, config.revision, source)) queued++;
    }
    return { queued };
  }
  async status(access: ReceptionAccess, companyId: unknown) {
    automationAdmin(access); const company=automationCompany(access,companyId);
    const c=await this.db.receptionConnection.findUnique({where:{companyId:company.id}});
    const config=this.dto(company,c),settings=config.settings;
    const activated=!!c && c.enabled && c.recipientRuc===company.ruc && await hasActivation(this.db,c);
    const sources=await Promise.all((['MAIL','SIRE'] as const).map(async source=>{
      const latest=await this.db.receptionSyncRun.findFirst({where:{companyId:company.id,recipientRuc:company.ruc,source,...(c?{revision:c.revision}:{}),OR:[{activeKey:null},{NOT:{activeKey:{startsWith:'b2b/'}}}]},orderBy:{createdAt:'desc'}});
      return {source,enabled:source==='MAIL'?settings.mailbox.enabled:settings.sire.enabled,authorized:activated && (source==='MAIL'?settings.mailbox.enabled:settings.sire.enabled) && ['READY_LOCAL','READY_READ_ONLY'].includes(config.state),lastRun:latest?syncDto(latest):null};
    }));
    return {companyId:company.id,recipientRuc:company.ruc,revision:c?.revision??0,state:config.state,activated,connectors:sources};
  }
  async discoveries(access: ReceptionAccess, query: Record<string, unknown>) {
    const company = automationCompany(access, query.companyId, query.branchId);
    let authorizedDocuments: string[] | undefined;
    if (access.user.scope.kind === 'ASSIGNED' || query.branchId) {
      const branches = query.branchId ? [String(query.branchId)] : access.catalog.branches.filter(b => b.companyId === company.id && access.user.scope.kind === 'ASSIGNED' && access.user.scope.branchIds.includes(b.id)).map(b => b.id);
      authorizedDocuments = (await this.db.receivedDocument.findMany({ where: { companyId: company.id, recipientRuc: company.ruc, branchId: { in: branches } }, select: { id: true }, take: 10000 })).map(d => d.id);
    }
    const rows = await this.db.receptionSirePurchase.findMany({ where: { companyId: company.id, recipientRuc: company.ruc, ...(authorizedDocuments ? { xmlStatus: 'MATCHED', documentId: { in: authorizedDocuments } } : {}) }, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }], take: 100 });
    const items: ReceivedSireDiscovery[] = rows.map(r => ({ id: r.id, companyId: r.companyId, recipientRuc: r.recipientRuc, period: r.period, supplierRuc: r.supplierRuc, supplierName: r.supplierName,
      documentType: r.documentType, fullNumber: r.fullNumber, issueDate: r.issueDate.toISOString().slice(0, 10), currencyCode: r.currencyCode, amount: r.amount,
      xmlStatus: r.xmlStatus as ReceivedSireDiscovery['xmlStatus'], documentId: r.documentId, observedAt: r.observedAt.toISOString() }));
    return { items };
  }
  async incidents(access: ReceptionAccess, companyId: unknown) {
    automationAdmin(access); const company = automationCompany(access, companyId);
    const rows = await this.db.receptionSireIncident.findMany({ where: { companyId: company.id, recipientRuc: company.ruc, active: true }, select: { id: true, period: true, ordinal: true, code: true, observedAt: true }, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }], take: 100 });
    return { items: rows.map(r => ({ ...r, observedAt: r.observedAt.toISOString() })) };
  }
}
/** Durable queue record survives Redis outage; scheduler republishes it idempotently. */
export async function createSyncRun(db: ReceptionPrisma, companyId: number, recipientRuc: string, revision: number, source: 'MAIL' | 'SIRE') {
  try { return await db.receptionSyncRun.create({ data: { companyId, recipientRuc, revision, source, status: 'QUEUED', activeKey: `${companyId}/${source}`, counters: json(emptyCounters()) } }); }
  catch (e) { if ((e as { code?: string }).code === 'P2002') return null; throw e; }
}
