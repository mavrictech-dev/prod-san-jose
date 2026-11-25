import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { GUIDE_OPERATIONAL_SETTINGS_VERSION, PermissionCodes, validateGuideSettingsWrite, type GuideOperationalSettings, type GuideSettingsDocument } from '@factuez/contracts';
import { PrismaService } from '../infrastructure/prisma.service';
import type { AuthenticatedRequest } from '../auth/jwt-permission.guard';

type Row = { companyId: number; settings: GuideOperationalSettings; revision: number; updatedAt: Date; updatedBy: string };
type Company = { id: number; ruc: string; active: boolean };
const unavailable = () => new ServiceUnavailableException('La configuración de guías no está disponible. El administrador debe preparar su almacenamiento en el servidor.');

@Injectable()
export class GuideOperationalSettingsService {
  constructor(private readonly prisma: PrismaService) {}
  private actor(request: AuthenticatedRequest) {
    // JwtPermissionGuard verifies signature, permission and current (non-revoked) access with Identity.
    const actor = request.user;
    if (!actor || actor.scope?.kind !== 'GLOBAL' || !actor.roles?.includes('ADMIN') || !actor.permissions?.includes(PermissionCodes.SETUP_MANAGE))
      throw new ForbiddenException('Se requiere un administrador general activo con permiso de configuración.');
    return actor;
  }
  private companyId(value: string) {
    if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) throw new BadRequestException('Emisor inválido.');
    return Number(value);
  }
  private async company(tx: PrismaService, id: number): Promise<Company> {
    // Shared lock prevents deactivation while saving; no fiscal settings/counters are changed.
    const rows = await tx.$queryRawUnsafe<Company[]>('SELECT "id", "ruc", "active" FROM "CompanySettings" WHERE "id"=$1 FOR SHARE', id);
    if (!rows.length) throw new NotFoundException('Emisor no disponible.');
    if (!rows[0].active) throw new ForbiddenException('El emisor está inactivo.');
    return rows[0];
  }
  private document(company: Company, row?: Row): GuideSettingsDocument {
    if (row) {
      const validated = validateGuideSettingsWrite({ expectedRevision: row.revision, settings: row.settings });
      if (!validated.ok) throw unavailable();
      row = { ...row, settings: validated.value.settings };
    }
    return { version: GUIDE_OPERATIONAL_SETTINGS_VERSION, companyId: company.id, ruc: company.ruc, revision: row?.revision ?? 0,
      settings: row?.settings ?? null, updatedAt: row?.updatedAt.toISOString() ?? null, updatedBy: row?.updatedBy ?? null,
      configured: !!row, status: row ? 'PROFILE_REVIEW_PENDING' : 'NOT_CONFIGURED', fiscalTransmission: false };
  }
  private async transaction<T>(work: (tx: PrismaService) => Promise<T>): Promise<T> {
    try { return await this.prisma.$transaction(tx => work(tx as unknown as PrismaService)); }
    catch (error) {
      const e = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } };
      const sqlState = e.meta?.code ?? e.meta?.driverAdapterError?.cause?.originalCode ?? e.code;
      if (e.code === 'P2002' || sqlState === '23505') throw new ConflictException('La configuración cambió. Revise los datos guardados antes de reenviar.');
      if (['P2021', 'P2022'].includes(e.code ?? '') || ['42P01', '42703'].includes(sqlState ?? '')) throw unavailable();
      throw error;
    }
  }
  get(value: string, request: AuthenticatedRequest) {
    this.actor(request); const companyId = this.companyId(value);
    return this.transaction(async tx => {
      const company = await this.company(tx, companyId);
      const rows = await tx.$queryRawUnsafe<Row[]>('SELECT "companyId", "settings", "revision", "updatedAt", "updatedBy" FROM "GuideOperationalSettings" WHERE "companyId"=$1', companyId);
      return this.document(company, rows[0]);
    });
  }
  put(value: string, input: unknown, request: AuthenticatedRequest) {
    const actor = this.actor(request), companyId = this.companyId(value);
    const validation = validateGuideSettingsWrite(input);
    if (!validation.ok) throw new BadRequestException({ message: 'Revise los campos indicados.', issues: validation.issues });
    const { expectedRevision, settings } = validation.value;
    return this.transaction(async tx => {
      const company = await this.company(tx, companyId);
      // INSERT ... ON CONFLICT DO NOTHING handles concurrent first saves without overwriting.
      // UPDATE compares revision in the write itself, including under concurrent transactions.
      const rows = expectedRevision === 0
        ? await tx.$queryRawUnsafe<Row[]>(`INSERT INTO "GuideOperationalSettings" ("companyId","settings","revision","updatedBy","createdAt","updatedAt")
            VALUES ($1,$2::jsonb,1,$3::uuid,now(),now()) ON CONFLICT ("companyId") DO NOTHING RETURNING *`, companyId, JSON.stringify(settings), actor.sub)
        : await tx.$queryRawUnsafe<Row[]>(`UPDATE "GuideOperationalSettings" SET "settings"=$2::jsonb,"revision"="revision"+1,"updatedBy"=$3::uuid,"updatedAt"=now()
            WHERE "companyId"=$1 AND "revision"=$4 RETURNING *`, companyId, JSON.stringify(settings), actor.sub, expectedRevision);
      if (!rows.length) throw new ConflictException('La configuración cambió. Revise los datos guardados antes de reenviar.');
      await tx.configurationAudit.create({ data: { actorId: actor.sub, action: 'guide-operational-settings.saved', entityId: String(companyId),
        metadata: { companyId, issuerRuc: company.ruc, revision: rows[0].revision, changedFields: ['role', 'products', 'routes', ...(settings.fuelProfile ? ['fuelProfile'] : [])], fiscalTransmission: false } } });
      return this.document(company, rows[0]);
    });
  }
}
