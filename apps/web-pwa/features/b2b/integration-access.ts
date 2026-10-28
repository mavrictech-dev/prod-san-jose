import type { User } from '../workspace/types';

/** Discovery follows the page guard; the BFF still authorizes every operation. */
export function canManageIntegrations(user: Pick<User, 'scope' | 'roles'> | null | undefined, can: (permission: string) => boolean): boolean {
  return !!user && user.scope.kind === 'GLOBAL' && user.roles.includes('ADMIN') &&
    ['setup.manage', 'user.manage', 'role.manage'].every(permission => can(permission));
}
