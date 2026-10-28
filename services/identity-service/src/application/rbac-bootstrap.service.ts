import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DefaultRolePermissions, PermissionCodes, RoleCodes, type PermissionCode } from '@factuez/contracts';
import { readFile } from 'node:fs/promises';
import { PasswordService } from './password.service';
import { PrismaService } from '../infrastructure/prisma.service';

const permissionDefinitions = [
  ['SETUP_MANAGE', PermissionCodes.SETUP_MANAGE, 'Administrar la configuración inicial'],
  ['USER_MANAGE', PermissionCodes.USER_MANAGE, 'Administrar usuarios'],
  ['ROLE_MANAGE', PermissionCodes.ROLE_MANAGE, 'Asignar roles y permisos'],
  ['PRODUCT_MANAGE', PermissionCodes.PRODUCT_MANAGE, 'Administrar productos'],
  ['SERIES_MANAGE', PermissionCodes.SERIES_MANAGE, 'Administrar series y puntos de emisión'],
  ['SUNAT_CONFIGURE', PermissionCodes.SUNAT_CONFIGURE, 'Administrar credenciales y entorno SUNAT'],
  ['DOCUMENT_ISSUE', PermissionCodes.DOCUMENT_ISSUE, 'Emitir comprobantes'],
  ['DOCUMENT_VIEW', PermissionCodes.DOCUMENT_VIEW, 'Consultar comprobantes'],
  ['DOCUMENT_RETRY', PermissionCodes.DOCUMENT_RETRY, 'Reintentar envíos SUNAT'],
  ['DOCUMENT_EMAIL', PermissionCodes.DOCUMENT_EMAIL, 'Enviar comprobantes por correo'],
  ['SHIFT_OPEN', PermissionCodes.SHIFT_OPEN, 'Abrir turno'],
  ['SHIFT_CLOSE', PermissionCodes.SHIFT_CLOSE, 'Cerrar turno'],
  ['REPORT_VIEW', PermissionCodes.REPORT_VIEW, 'Consultar reportes'],
  ['REPORT_EXPORT', PermissionCodes.REPORT_EXPORT, 'Exportar reportes'],
  ['AUDIT_VIEW', PermissionCodes.AUDIT_VIEW, 'Consultar auditoría'],
] as const;

const roleDefinitions = [
  [RoleCodes.ADMIN, 'Administrador', 'Control completo de la instalación local'],
  [RoleCodes.STATION_MANAGER, 'Jefe de estación', 'Operación y supervisión de la estación'],
  [RoleCodes.CASHIER, 'Cajero', 'Facturación y turnos de caja'],
  [RoleCodes.TRACK_OPERATOR, 'Operador de pista', 'Emisión limitada al punto de pista asignado'],
  [RoleCodes.AUDITOR, 'Auditor', 'Consulta de comprobantes, reportes y auditoría'],
] as const;

/** Mantiene el catálogo RBAC versionado e idempotente al iniciar identity-service. */
@Injectable()
export class RbacBootstrapService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  async onApplicationBootstrap() {
    const permissionsByApiCode = new Map<PermissionCode, string>();

    for (const [databaseCode, apiCode, description] of permissionDefinitions) {
      const permission = await this.prisma.permission.upsert({
        where: { code: databaseCode },
        create: { code: databaseCode, name: apiCode, description },
        update: { name: apiCode, description },
      });
      permissionsByApiCode.set(apiCode, permission.id);
    }

    for (const [code, name, description] of roleDefinitions) {
      const role = await this.prisma.role.upsert({
        where: { code },
        create: { code, name, description, isSystem: true, active: true, permissions: { create: DefaultRolePermissions[code].map(permissionCode => {
          const permissionId = permissionsByApiCode.get(permissionCode);
          if (!permissionId) throw new Error(`Permiso RBAC no registrado: ${permissionCode}`);
          return { permissionId };
        }) } },
        update: { name, description, isSystem: true, active: true },
      });

      // Los roles existentes conservan la matriz editada. Sólo ADMIN es inmutable.
      for (const permissionCode of code === RoleCodes.ADMIN ? DefaultRolePermissions[code] : []) {
        const permissionId = permissionsByApiCode.get(permissionCode);
        if (!permissionId) throw new Error(`Permiso RBAC no registrado: ${permissionCode}`);
        await this.prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: role.id, permissionId } },
          create: { roleId: role.id, permissionId },
          update: {},
        });
      }
    }

    await this.provisionInitialAdministrator();
  }

  private async provisionInitialAdministrator() {
    const username = process.env.INITIAL_ADMIN_USERNAME?.trim();
    const passwordPath = process.env.INITIAL_ADMIN_PASSWORD_FILE;
    if (!username || !passwordPath) return;

    const existing = await this.prisma.user.findUnique({ where: { username } });
    if (existing) return; // Nunca reemplazar una cuenta existente desde variables de despliegue.

    const password = (await readFile(passwordPath, 'utf8')).trim();
    const administratorRole = await this.prisma.role.findUniqueOrThrow({ where: { code: RoleCodes.ADMIN } });
    await this.prisma.user.create({
      data: {
        username,
        fullName: process.env.INITIAL_ADMIN_FULL_NAME?.trim() || 'Administrador FactuEz',
        passwordHash: await this.passwords.hash(password),
        roles: { create: { roleId: administratorRole.id } },
      },
    });
  }
}
