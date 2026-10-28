import { Injectable, Inject, Optional } from '@nestjs/common';
import { AccessError, UUID } from '@factuez/service-access';
import type { Prisma, ReceptionConnection } from '../generated/prisma/client';
import { ReceptionPrisma } from '../prisma.service';
import type { ReceptionAccess } from '../access';
import { automationCompany, hasActivation } from './authorization';
import { connectionSettings, automationAdmin } from './service';
import { receptionReadiness } from './policy';
import { ReceptionVault } from './vault';
import { productionConnectors, type ReceptionConnectors } from './connectors';
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const ACTIVATION_REVIEW = 'RECEIVED_READ_ONLY_V1';
function command(input: unknown, activation = false) {
  const b = input as Record<string, unknown>;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !(activation ? ['expectedRevision','recipientRuc','validationId','confirmation','reviewVersion'] : ['expectedRevision','recipientRuc']).includes(k)) || !Number.isSafeInteger(b.expectedRevision) || Number(b.expectedRevision) < 1 || typeof b.recipientRuc !== 'string' || !/^\d{11}$/.test(b.recipientRuc)) throw new AccessError(400, 'RECEPTION_REVIEW_INVALID');
  if (activation && (typeof b.validationId !== 'string' || !UUID.test(b.validationId) || b.confirmation !== b.recipientRuc || b.reviewVersion !== ACTIVATION_REVIEW)) throw new AccessError(400, 'RECEPTION_CONFIRM_RUC_REQUIRED');
  return b;
}
@Injectable()
export class ReceptionProductionWorkflow {
  private readonly vault = new ReceptionVault();
  constructor(private readonly db: ReceptionPrisma, @Optional() @Inject('RECEPTION_CONNECTORS') private readonly connectors: ReceptionConnectors = productionConnectors) {}
  private async current(access: ReceptionAccess, companyId: unknown, input?: unknown, activation = false) {
    automationAdmin(access); const company = automationCompany(access, companyId);
    const row = await this.db.receptionConnection.findUnique({ where: { companyId: company.id } });
    if (!row || row.recipientRuc !== company.ruc || row.mode !== 'LIVE_READ_ONLY') throw new AccessError(409, 'RECEPTION_CONFIGURATION_REQUIRED');
    if (input !== undefined) { const b = command(input, activation); if (b.expectedRevision !== row.revision || b.recipientRuc !== company.ruc) throw new AccessError(409, 'RECEPTION_REVIEW_STALE'); }
    return row;
  }
  async serverReadiness() {
    const checks = { database: false, encryption: false, externalReadAllowed: process.env.RECEIVED_LIVE_READ_ALLOWED === 'true' };
    try { await this.db.$queryRaw`SELECT "companyId", "recipientRuc", "revision", "enabled", "mode", "settings", "encryptedCredentials", "configuredBy" FROM "ReceptionConnection" LIMIT 0`; await this.db.$queryRaw`SELECT "id", "companyId", "actorId", "revision", "action", "detail", "createdAt" FROM "ReceptionConnectionAudit" LIMIT 0`;
      await this.db.$queryRaw`SELECT "companyId", "fingerprint", "uidValidity", "lastUid", "updatedAt" FROM "ReceptionMailboxCheckpoint" LIMIT 0`;
      await this.db.$queryRaw`SELECT "id", "companyId", "fingerprint", "uidValidity", "uid", "status", "counts" FROM "ReceptionMessageReceipt" LIMIT 0`;
      await this.db.$queryRaw`SELECT "id", "companyId", "recipientRuc", "revision", "source", "status", "activeKey", "counters", "errorCode", "startedAt", "finishedAt" FROM "ReceptionSyncRun" LIMIT 0`;
      await this.db.$queryRaw`SELECT "id", "companyId", "recipientRuc", "period", "ordinal", "code", "recordHash", "rawRecord", "active", "observedAt", "observedRunId" FROM "ReceptionSireIncident" LIMIT 0`;
      await this.db.$queryRaw`SELECT "id", "companyId", "recipientRuc", "period", "supplierRuc", "documentType", "series", "number", "amount", "rawRecord", "xmlStatus", "documentId", "observedRunId" FROM "ReceptionSirePurchase" LIMIT 0`;
      await this.db.$queryRaw`SELECT "id", "companyId", "recipientRuc", "branchId", "supplierRuc", "documentType", "series", "number", "xmlSha256", "projection" FROM "ReceivedDocument" LIMIT 0`;
      await this.db.$queryRaw`SELECT "id", "documentId", "ordinal", "description", "detail" FROM "ReceivedItemRecord" LIMIT 0`;
      await this.db.$queryRaw`SELECT "id", "documentId", "kind", "sha256", "bytes", "byteLength" FROM "ReceivedArtifact" LIMIT 0`;
      await this.db.$queryRaw`SELECT "id", "documentId", "actorId", "action", "detail" FROM "ReceivedAudit" LIMIT 0`;
      checks.database = true; } catch {}
    try { this.vault.seal({}, { companyId: 1, ruc: '00000000000', revision: 1 }); checks.encryption = true; } catch {}
    return { checks, ready: Object.values(checks).every(Boolean), externalDefault: 'OFF_UNTIL_RUC_CONFIRMED', sireProvides: 'PURCHASE_REGISTRY_TOTALS', xmlDetailSource: 'PROVIDER_MAIL_ATTACHMENTS' };
  }
  async readiness(access: ReceptionAccess, companyId: unknown) {
    automationAdmin(access); const company = automationCompany(access, companyId);
    const c = await this.db.receptionConnection.findUnique({ where: { companyId: company.id } });
    const server = await this.serverReadiness();
    const validation = c ? await this.db.receptionConnectionAudit.findFirst({ where: { companyId: c.companyId, revision: c.revision, action: 'PRODUCTION_VALIDATED' }, orderBy: { createdAt: 'desc' } }) : null;
    return { ...server, companyId: company.id, recipientRuc: company.ruc, revision: c?.revision ?? 0,
      activated: !!c && c.enabled && await hasActivation(this.db,c), validation: validation ? { id: validation.id, revision: validation.revision, createdAt: validation.createdAt.toISOString(), result: validation.detail } : null,
      reviewVersion: ACTIVATION_REVIEW, review: ['Lectura periódica por este RUC; no presenta ni acepta libros.', 'SIRE aporta compras y totales; XML, CDR y detalle se reciben por correo.', 'Los XML de otro destinatario y los adjuntos inseguros se rechazan.'] };
  }
  async validate(access: ReceptionAccess, companyId: unknown, input: unknown) {
    const c = await this.current(access, companyId, input), settings = connectionSettings(c), secrets = this.vault.open(c.encryptedCredentials, { companyId:c.companyId,ruc:c.recipientRuc,revision:c.revision });
    const server = await this.serverReadiness();
    const configured = (settings.mailbox.enabled || settings.sire.enabled) && receptionReadiness({...settings,enabled:true},c.recipientRuc,secrets) === 'READY_READ_ONLY';
    const result = { recipientRuc:c.recipientRuc, ready:false, serverReady:server.ready, mail: settings.mailbox.enabled ? 'NOT_VALIDATED' : 'DISABLED', sire:settings.sire.enabled ? 'NOT_VALIDATED' : 'DISABLED' };
    if (server.ready && configured) {
      if (settings.mailbox.enabled) { try { await this.connectors.validateMailbox(settings.mailbox,secrets.mailPassword); result.mail='VALID'; } catch { result.mail='CONNECTION_REJECTED'; } }
      if (settings.sire.enabled) { try { await this.connectors.sire({ruc:c.recipientRuc,clientId:settings.sire.clientId,clientSecret:secrets.sireClientSecret,solUsername:settings.sire.solUsername,solPassword:secrets.solPassword}).validateCredentials(); result.sire='VALID'; } catch { result.sire='CONNECTION_REJECTED'; } }
      result.ready = [result.mail,result.sire].every(v => ['DISABLED','VALID'].includes(v));
    }
    const audit = await this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${c.companyId})`;
      const current = await tx.receptionConnection.findUnique({where:{companyId:c.companyId}});
      if (!current || current.revision!==c.revision || current.recipientRuc!==c.recipientRuc) throw new AccessError(409,'RECEPTION_REVIEW_STALE');
      return tx.receptionConnectionAudit.create({data:{companyId:c.companyId,actorId:access.user.sub,revision:c.revision,action:'PRODUCTION_VALIDATED',detail:json(result)}});
    });
    return { validationId:audit.id, revision:c.revision, ...result, expiresAt:new Date(audit.createdAt.getTime()+15*60000).toISOString() };
  }
  async activate(access: ReceptionAccess, companyId: unknown, input: unknown) {
    const c = await this.current(access,companyId,input,true), b=command(input,true);
    const server=await this.serverReadiness(); if (!server.ready) throw new AccessError(409,'RECEPTION_SERVER_NOT_READY');
    await this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${c.companyId})`;
      const current=await tx.receptionConnection.findUnique({where:{companyId:c.companyId}});
      const proof=await tx.receptionConnectionAudit.findFirst({where:{id:String(b.validationId),companyId:c.companyId,revision:c.revision,action:'PRODUCTION_VALIDATED'}});
      const detail=proof?.detail as {ready?:boolean;recipientRuc?:string}|undefined;
      if (!current || current.revision!==c.revision || current.recipientRuc!==c.recipientRuc || !proof || detail?.ready!==true || detail.recipientRuc!==c.recipientRuc || Date.now()-proof.createdAt.getTime()>15*60000) throw new AccessError(409,'RECEPTION_VALIDATION_REQUIRED');
      const settings=connectionSettings(current), secrets=this.vault.open(current.encryptedCredentials,{companyId:c.companyId,ruc:c.recipientRuc,revision:c.revision});
      if (receptionReadiness({...settings,enabled:true},c.recipientRuc,secrets)!=='READY_READ_ONLY') throw new AccessError(409,'RECEPTION_SERVER_NOT_READY');
      await tx.receptionConnection.update({where:{companyId:c.companyId},data:{enabled:true,settings:json({...settings,enabled:true})}});
      await tx.receptionConnectionAudit.create({data:{companyId:c.companyId,revision:c.revision,actorId:access.user.sub,action:'PRODUCTION_ACTIVATED',detail:{recipientRuc:c.recipientRuc,validationId:proof.id,reviewVersion:ACTIVATION_REVIEW}}});
    });
    return this.readiness(access,companyId);
  }
}
