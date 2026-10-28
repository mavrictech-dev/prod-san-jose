import { mailerDatabaseName } from './mailer-database-identity';
import { Injectable } from '@nestjs/common';
import { AccessError } from '@factuez/service-access';
import { PrismaService } from './prisma.service';
import type { SmtpIssuer, StoredSmtpConfiguration } from './smtp-configuration.store';
import { type Activation, type CorporateMailState } from './corporate-mail.policy';
import { activeDocumentGrant, documentConfigurationDigest, type DocumentMailJob } from './corporate-document-policy';
type Sql = Pick<PrismaService, '$queryRaw' | '$executeRaw'>;
const changed = () => new AccessError(409, 'La configuración o autorización SMTP cambió; vuelva a consultar');
@Injectable()
export class CorporateDocumentStore {
  constructor(private readonly prisma: PrismaService) {}
  async ready(): Promise<boolean> {
    try {
      const expectedDatabase = mailerDatabaseName();
      const [r] = await this.prisma.$queryRaw<Array<{ db: string; activation: string | null; job: string | null; audit: string | null }>>
        `SELECT current_database() AS db, to_regclass('public."CorporateDocumentActivation"')::text AS activation,
          to_regclass('public."CorporateDocumentJob"')::text AS job, to_regclass('public."CorporateDocumentAudit"')::text AS audit`;
      return r?.db === expectedDatabase && Boolean(r.activation && r.job && r.audit);
    } catch { return false; }
  }
  private async safe<T>(action: () => Promise<T>): Promise<T> {
    if (!await this.ready()) throw new AccessError(503, 'Almacenamiento corporativo pendiente de integración');
    try { return await action(); } catch (error) {
      if (error instanceof AccessError) throw error;
      throw new AccessError(503, 'Operación de correo corporativo no disponible');
    }
  }
  private async lock(tx: Sql, issuer: SmtpIssuer) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'smtp-config:' + issuer.ruc}, 0))`;
  }
  private async checkConfiguration(tx: Sql, row: StoredSmtpConfiguration) {
    const [current] = await tx.$queryRaw<StoredSmtpConfiguration[]>`SELECT "companyId", "issuerRuc" AS ruc, revision,
      "configurationCipher", "keyVersion", "updatedAt" FROM "CorporateSmtpConfiguration"
      WHERE "issuerRuc" = ${row.ruc} AND "companyId" = ${row.companyId} FOR SHARE`;
    if (!current || current.revision !== row.revision || current.keyVersion !== row.keyVersion || documentConfigurationDigest(current) !== documentConfigurationDigest(row)) throw changed();
  }
  private async grant(tx: Sql, issuer: SmtpIssuer) {
    const rows = await tx.$queryRaw<Activation[]>`SELECT * FROM "CorporateDocumentActivation"
      WHERE "issuerRuc" = ${issuer.ruc} AND "companyId" = ${issuer.companyId}`;
    return rows[0] ?? null;
  }
  activation(issuer: SmtpIssuer) { return this.safe(() => this.grant(this.prisma, issuer)); }
  private event(tx: Sql, issuer: SmtpIssuer, actor: string, configRevision: number, activationRevision: number, event: string, jobId: string | null = null) {
    return tx.$executeRaw`INSERT INTO "CorporateDocumentAudit" ("issuerRuc", "companyId", "actorId", "configurationRevision", "activationRevision", "jobId", event)
      VALUES (${issuer.ruc}, ${issuer.companyId}, ${actor}::uuid, ${configRevision}, ${activationRevision}, ${jobId}::uuid, ${event})`;
  }
  setActivation(row: StoredSmtpConfiguration, actor: string, expectedActivationRevision: number, enabled: boolean) {
    return this.safe(() => this.prisma.$transaction(async tx => {
      await this.lock(tx, row); await this.checkConfiguration(tx, row);
      const before = await this.grant(tx, row);
      if ((before?.revision ?? 0) !== expectedActivationRevision) throw changed();
      const [grant] = await tx.$queryRaw<Activation[]>`INSERT INTO "CorporateDocumentActivation"
        ("issuerRuc", "companyId", revision, "configurationRevision", "configurationDigest", enabled, "updatedBy")
        VALUES (${row.ruc}, ${row.companyId}, ${expectedActivationRevision + 1}, ${row.revision}, ${documentConfigurationDigest(row)}, ${enabled}, ${actor}::uuid)
        ON CONFLICT ("issuerRuc") DO UPDATE SET revision = EXCLUDED.revision, "configurationRevision" = EXCLUDED."configurationRevision",
        "configurationDigest" = EXCLUDED."configurationDigest", enabled = EXCLUDED.enabled, "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = CURRENT_TIMESTAMP
        RETURNING *`;
      await this.event(tx, row, actor, row.revision, grant.revision, enabled ? 'ACTIVATED' : 'DEACTIVATED');
      return grant;
    }, { timeout: 5000 }));
  }
  enqueue(input: { row: StoredSmtpConfiguration; actorId: string; activationRevision: number; id: string; idempotencyHash: string; requestHash: string; payloadCipher: string; documentId: string; format: 'a4' | 'ticket'; documentProof: string }) {
    return this.safe(() => this.prisma.$transaction(async tx => {
      const { row, actorId } = input;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'smtp-document-actor:' + actorId}, 0))`;
      await this.lock(tx, row); await this.checkConfiguration(tx, row);
      const grant = await this.grant(tx, row);
      if (!activeDocumentGrant(grant, row) || grant!.revision !== input.activationRevision) throw changed();
      const prior = await tx.$queryRaw<DocumentMailJob[]>`SELECT * FROM "CorporateDocumentJob"
        WHERE "issuerRuc" = ${row.ruc} AND "actorId" = ${actorId}::uuid AND "idempotencyHash" = ${input.idempotencyHash}`;
      if (prior[0]) { if (prior[0].requestHash !== input.requestHash) throw new AccessError(409, 'Idempotency-Key ya usada para otra solicitud'); return prior[0]; }
      const [counts] = await tx.$queryRaw<Array<{ actor: number; issuer: number }>>`SELECT
        COUNT(*) FILTER (WHERE "actorId" = ${actorId}::uuid)::integer AS actor,
        COUNT(*) FILTER (WHERE "issuerRuc" = ${row.ruc})::integer AS issuer
        FROM "CorporateDocumentJob" WHERE "createdAt" > CURRENT_TIMESTAMP - interval '1 minute'
        AND ("actorId" = ${actorId}::uuid OR "issuerRuc" = ${row.ruc})`;
      if (counts.actor >= 6 || counts.issuer >= 3) throw new AccessError(429, 'Límite de envíos de comprobantes alcanzado; espere un minuto');
      const [job] = await tx.$queryRaw<DocumentMailJob[]>`INSERT INTO "CorporateDocumentJob"
        (id, "issuerRuc", "companyId", "actorId", "configurationRevision", "configurationDigest", "activationRevision", "idempotencyHash", "requestHash", "payloadCipher", "documentId", format, "documentProof", "expiresAt")
        VALUES (${input.id}::uuid, ${row.ruc}, ${row.companyId}, ${actorId}::uuid, ${row.revision}, ${documentConfigurationDigest(row)},
          ${input.activationRevision}, ${input.idempotencyHash}, ${input.requestHash}, ${input.payloadCipher}, ${input.documentId}::uuid, ${input.format}, ${input.documentProof}, CURRENT_TIMESTAMP + interval '2 minutes') RETURNING *`;
      await this.event(tx, row, actorId, row.revision, input.activationRevision, 'QUEUED', job.id);
      return job;
    }, { timeout: 5000 }));
  }
  prior(issuer: SmtpIssuer, actor: string, idempotencyHash: string, requestHash: string) {
    return this.safe(async () => {
      const [job] = await this.prisma.$queryRaw<DocumentMailJob[]>`SELECT * FROM "CorporateDocumentJob"
        WHERE "issuerRuc" = ${issuer.ruc} AND "companyId" = ${issuer.companyId} AND "actorId" = ${actor}::uuid AND "idempotencyHash" = ${idempotencyHash}`;
      if (job && job.requestHash !== requestHash) throw new AccessError(409, 'Idempotency-Key ya usada para otro envío documental');
      return job ?? null;
    });
  }
  get(id: string) { return this.safe(async () => (await this.prisma.$queryRaw<DocumentMailJob[]>`SELECT * FROM "CorporateDocumentJob" WHERE id = ${id}::uuid`)[0] ?? null); }
  history(issuer: SmtpIssuer, documentId: string) {
    return this.safe(async () => ({
      jobs: await this.prisma.$queryRaw<DocumentMailJob[]>`SELECT * FROM "CorporateDocumentJob"
        WHERE "issuerRuc" = ${issuer.ruc} AND "companyId" = ${issuer.companyId} AND "documentId" = ${documentId}::uuid ORDER BY "createdAt" DESC LIMIT 10`,
      events: await this.prisma.$queryRaw<Array<{ event: string; actorId: string; jobId: string | null; configurationRevision: number; activationRevision: number; createdAt: Date }>>`SELECT event, "actorId", "jobId", "configurationRevision", "activationRevision", "createdAt" FROM "CorporateDocumentAudit"
        WHERE "issuerRuc" = ${issuer.ruc} AND "companyId" = ${issuer.companyId} ORDER BY id DESC LIMIT 20`,
    }));
  }
  pending() { return this.safe(() => this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "CorporateDocumentJob"
    WHERE state = 'QUEUED' AND "expiresAt" > CURRENT_TIMESTAMP ORDER BY "createdAt" LIMIT 20`); }
  claim(id: string) {
    return this.safe(() => this.prisma.$transaction(async tx => {
      const [job] = await tx.$queryRaw<DocumentMailJob[]>`UPDATE "CorporateDocumentJob" SET state = 'PREPARING', "claimedAt" = CURRENT_TIMESTAMP
        WHERE id = ${id}::uuid AND state = 'QUEUED' AND "expiresAt" > CURRENT_TIMESTAMP RETURNING *`;
      if (!job) return null;
      await this.event(tx, { companyId: job.companyId, ruc: job.issuerRuc }, job.actorId, job.configurationRevision, job.activationRevision, 'PREPARING', id);
      return job;
    }, { timeout: 5000 }));
  }
  /** Never transitions terminal jobs back to QUEUED/SENDING. BullMQ redelivery cannot resend. */
  transition(id: string, from: 'PREPARING' | 'SENDING', to: CorporateMailState) {
    if (!(from === 'PREPARING' && ['SENDING', 'FAILED', 'CANCELLED'].includes(to) || from === 'SENDING' && ['HANDED_OFF', 'UNKNOWN'].includes(to)))
      throw new AccessError(400, 'Transición de correo no admitida');
    return this.safe(() => this.prisma.$transaction(async tx => {
      const terminal = to !== 'SENDING';
      const rows = await tx.$queryRaw<DocumentMailJob[]>`UPDATE "CorporateDocumentJob" SET state = ${to},
        "payloadCipher" = CASE WHEN ${terminal} THEN NULL ELSE "payloadCipher" END,
        "finishedAt" = CASE WHEN ${terminal} THEN CURRENT_TIMESTAMP ELSE NULL END
        WHERE id = ${id}::uuid AND state = ${from} AND (${terminal} OR "expiresAt" > CURRENT_TIMESTAMP) RETURNING *`;
      const job = rows[0]; if (!job) return false;
      await this.event(tx, { companyId: job.companyId, ruc: job.issuerRuc }, job.actorId, job.configurationRevision, job.activationRevision, to, id);
      return true;
    }, { timeout: 5000 }));
  }
  expire() {
    return this.safe(() => this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<DocumentMailJob[]>`UPDATE "CorporateDocumentJob" SET
        state = CASE WHEN state = 'SENDING' THEN 'UNKNOWN' ELSE 'CANCELLED' END,
        "payloadCipher" = NULL, "finishedAt" = CURRENT_TIMESTAMP
        WHERE state IN ('QUEUED','PREPARING','SENDING') AND "expiresAt" <= CURRENT_TIMESTAMP RETURNING *`;
      for (const job of rows) await this.event(tx, { companyId: job.companyId, ruc: job.issuerRuc }, job.actorId, job.configurationRevision, job.activationRevision, job.state, job.id);
    }, { timeout: 5000 }));
  }
}
