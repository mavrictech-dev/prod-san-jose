import { describe, expect, it } from 'vitest';
import {
  DefaultRolePermissions,
  PermissionCodes,
  RoleCodes,
  hasRequiredPermissions,
} from './authorization';

describe('RBAC contracts', () => {
  it('otorga al administrador todas las capacidades registradas', () => {
    expect(DefaultRolePermissions[RoleCodes.ADMIN]).toEqual(expect.arrayContaining(Object.values(PermissionCodes)));
  });

  it('no eleva a un operador de pista para configurar SUNAT', () => {
    expect(
      hasRequiredPermissions(DefaultRolePermissions[RoleCodes.TRACK_OPERATOR], [PermissionCodes.SUNAT_CONFIGURE]),
    ).toBe(false);
  });
});
