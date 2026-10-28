import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PermissionCodes, type AccessTokenClaims, type PermissionCode } from '@factuez/contracts';
import { PrismaService } from '../infrastructure/prisma.service';

// Facultades adicionales operativas. La administración global no es delegable por esta vía.
export const EXTRA_USER_PERMISSIONS: PermissionCode[] = [PermissionCodes.DOCUMENT_VIEW, PermissionCodes.DOCUMENT_ISSUE,
  PermissionCodes.DOCUMENT_EMAIL, PermissionCodes.REPORT_VIEW, PermissionCodes.REPORT_EXPORT, PermissionCodes.AUDIT_VIEW,
  PermissionCodes.SHIFT_OPEN, PermissionCodes.SHIFT_CLOSE];
export function validateExtraPermissions(value: unknown): asserts value is PermissionCode[] {
  if (!Array.isArray(value) || value.length > EXTRA_USER_PERMISSIONS.length || new Set(value).size !== value.length || value.some(permission => !EXTRA_USER_PERMISSIONS.includes(permission)))
    throw new BadRequestException('Permisos adicionales inválidos o no delegables');
}
@Injectable()
export class UserPermissionsService {
  constructor(private readonly prisma: PrismaService) {}
  async ready() {
    const [row] = await this.prisma.$queryRaw<Array<{ ready: boolean }>>`SELECT to_regclass('public."UserExtraPermission"') IS NOT NULL AS ready`;
    return Boolean(row?.ready);
  }
  async effective(userId: string): Promise<PermissionCode[]> {
    // Si la ampliación aún no fue aplicada, no se concede ningún permiso adicional.
    if (!(await this.ready())) return [];
    const rows = await this.prisma.$queryRaw<Array<{ permission: string }>>`SELECT permission FROM "UserExtraPermission" WHERE "userId" = ${userId}::uuid ORDER BY permission`;
    if (rows.some(row => !EXTRA_USER_PERMISSIONS.includes(row.permission as PermissionCode))) throw new ServiceUnavailableException('Permisos adicionales requieren revisión');
    return rows.map(row => row.permission as PermissionCode);
  }
  private authorize(userId: string, actor: AccessTokenClaims) {
    if (actor.scope.kind !== 'GLOBAL' || !actor.roles.includes('ADMIN') || !actor.permissions.includes(PermissionCodes.USER_MANAGE) || !actor.permissions.includes(PermissionCodes.ROLE_MANAGE)) throw new ForbiddenException('Se requiere administrador general de accesos');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId) || userId === actor.sub) throw new BadRequestException('No puede modificar su propio acceso');
  }
  async status(userId: string, actor: AccessTokenClaims) {
    this.authorize(userId, actor);
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, authVersion: true, roles: { include: { role: true } } } });
    if (!target) throw new NotFoundException('Usuario no disponible');
    const storageReady = await this.ready();
    return { userId, storageReady, permissions: storageReady ? await this.effective(userId) : [], expectedAuthVersion: target.authVersion, available: EXTRA_USER_PERMISSIONS, editable: storageReady && !target.roles.some(item => item.role.code === 'ADMIN') };
  }
  async update(userId: string, input: unknown, actor: AccessTokenClaims) {
    this.authorize(userId, actor);
    const body = input as { permissions?: unknown; expectedAuthVersion?: unknown };
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['permissions', 'expectedAuthVersion'].includes(key)) || !Number.isSafeInteger(body.expectedAuthVersion) || Number(body.expectedAuthVersion) < 0) throw new BadRequestException('Cambio de permisos inválido');
    validateExtraPermissions(body.permissions);
    const selected = body.permissions;
    if (!(await this.ready())) throw new ServiceUnavailableException('La ampliación de permisos individuales requiere preparación de Identity por TI');
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
      const target = await tx.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: true } } } });
      if (!target) throw new NotFoundException('Usuario no disponible');
      if (target.roles.some(item => item.role.code === 'ADMIN')) throw new ForbiddenException('El administrador general está protegido');
      if (target.authVersion !== body.expectedAuthVersion) throw new ConflictException('El acceso cambió. Actualice antes de guardar');
      const previous = await tx.$queryRaw<Array<{ permission: string }>>`SELECT permission FROM "UserExtraPermission" WHERE "userId" = ${userId}::uuid ORDER BY permission`;
      await tx.$executeRaw`DELETE FROM "UserExtraPermission" WHERE "userId" = ${userId}::uuid`;
      for (const permission of selected) await tx.$executeRaw`INSERT INTO "UserExtraPermission" ("userId", permission, "assignedBy") VALUES (${userId}::uuid, ${permission}, ${actor.sub}::uuid)`;
      await tx.user.update({ where: { id: userId }, data: { authVersion: { increment: 1 } } });
      await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { userId: actor.sub, action: 'user.extra-permissions.updated', entityType: 'User', entityId: userId, metadata: { before: previous.map(row => row.permission), after: selected, scopeChanged: false } } });
    });
    return this.status(userId, actor);
  }
}
