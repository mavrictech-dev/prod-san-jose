import { mailerDatabaseName } from './mailer-database-identity';
import { Injectable } from '@nestjs/common';
import { AccessError } from '@factuez/service-access';
import { PrismaService } from './prisma.service';

export type SmtpIssuer = { companyId: number; ruc: string };
export type StoredSmtpConfiguration = SmtpIssuer & {
  configurationCipher: string; keyVersion: number; revision: number; updatedAt: Date;
};

/** SQL parametrizado sobre tablas nuevas propiedad de Mailer; sin acceso a otras bases/esquemas. */
@Injectable()
export class SmtpConfigurationStore {
  constructor(private readonly prisma: PrismaService) {}

  async ready(): Promise<boolean> {
    try {
      const expectedDatabase = mailerDatabaseName();
      const [row] = await this.prisma.$queryRaw<Array<{ db: string; configuration: string | null; audit: string | null }>>`
        SELECT current_database() AS db, to_regclass('public."CorporateSmtpConfiguration"')::text AS configuration,
          to_regclass('public."CorporateSmtpConfigurationAudit"')::text AS audit`;
      return row?.db === expectedDatabase && Boolean(row.configuration && row.audit);
    } catch { return false; }
  }

  async read(issuer: SmtpIssuer): Promise<StoredSmtpConfiguration | null> {
    if (!(await this.ready())) throw new AccessError(503, 'Almacenamiento de configuración SMTP aún no preparado');
    try {
      const rows = await this.prisma.$queryRaw<StoredSmtpConfiguration[]>`
        SELECT "companyId", "issuerRuc" AS ruc, "configurationCipher", "keyVersion", revision, "updatedAt"
        FROM "CorporateSmtpConfiguration" WHERE "issuerRuc" = ${issuer.ruc} AND "companyId" = ${issuer.companyId}`;
      return rows[0] ?? null;
    } catch { throw new AccessError(503, 'No se pudo leer la configuración SMTP'); }
  }
  async audit(issuer: SmtpIssuer, page: number) {
    if (!(await this.ready())) throw new AccessError(503, 'Almacenamiento SMTP no preparado');
    try {
      return await this.prisma.$transaction(async tx => {
        const [count] = await tx.$queryRaw<Array<{ total: number }>>`SELECT COUNT(*)::integer AS total FROM "CorporateSmtpConfigurationAudit" WHERE "issuerRuc" = ${issuer.ruc} AND "companyId" = ${issuer.companyId}`;
        const items = await tx.$queryRaw<Array<{ actorId: string; revision: number; credentialsReplaced: boolean; createdAt: Date }>>`SELECT "actorId", revision, "credentialsReplaced", "createdAt" FROM "CorporateSmtpConfigurationAudit" WHERE "issuerRuc" = ${issuer.ruc} AND "companyId" = ${issuer.companyId} ORDER BY revision DESC LIMIT 10 OFFSET ${(page - 1) * 10}`;
        return { page, pageSize: 10, total: count.total, items };
      }, { isolationLevel: 'RepeatableRead', timeout: 5000 });
    } catch { throw new AccessError(503, 'No se pudo consultar la auditoría SMTP'); }
  }

  async save(issuer: SmtpIssuer, sealed: { cipher: string; keyVersion: number }, expectedRevision: number,
    actorId: string, credentialReplacement: boolean): Promise<StoredSmtpConfiguration> {
    if (!(await this.ready())) throw new AccessError(503, 'Almacenamiento de configuración SMTP aún no preparado');
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`smtp-config:${issuer.ruc}`}, 0))`;
        const [before] = await tx.$queryRaw<Array<{ companyId: number; revision: number }>>`
          SELECT "companyId", revision FROM "CorporateSmtpConfiguration" WHERE "issuerRuc" = ${issuer.ruc} FOR UPDATE`;
        if ((before?.revision ?? 0) !== expectedRevision || (before && before.companyId !== issuer.companyId))
          throw new AccessError(409, 'La configuración SMTP cambió; vuelva a consultar antes de guardar');
        const [row] = await tx.$queryRaw<StoredSmtpConfiguration[]>`
          INSERT INTO "CorporateSmtpConfiguration" ("issuerRuc", "companyId", "configurationCipher", "keyVersion", revision, "updatedBy")
          VALUES (${issuer.ruc}, ${issuer.companyId}, ${sealed.cipher}, ${sealed.keyVersion}, ${expectedRevision + 1}, ${actorId}::uuid)
          ON CONFLICT ("issuerRuc") DO UPDATE SET "configurationCipher" = EXCLUDED."configurationCipher",
            "keyVersion" = EXCLUDED."keyVersion", revision = EXCLUDED.revision, "updatedBy" = EXCLUDED."updatedBy", "updatedAt" = CURRENT_TIMESTAMP
          RETURNING "companyId", "issuerRuc" AS ruc, "configurationCipher", "keyVersion", revision, "updatedAt"`;
        await tx.$executeRaw`
          INSERT INTO "CorporateSmtpConfigurationAudit" ("issuerRuc", "companyId", "actorId", revision, "credentialsReplaced")
          VALUES (${issuer.ruc}, ${issuer.companyId}, ${actorId}::uuid, ${expectedRevision + 1}, ${credentialReplacement})`;
        return row;
      }, { timeout: 5000 });
    } catch (error) {
      if (error instanceof AccessError) throw error;
      throw new AccessError(503, 'No se pudo guardar la configuración SMTP');
    }
  }
}
