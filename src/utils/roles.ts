import { Role } from '@prisma/client';

type HasRoles = { roles?: Role[] | null } | null | undefined;

/**
 * Multi-role helper (Phase 1B).
 * - `role` stays the ACTIVE role; `roles` holds every role the account holds.
 * - Invariant: if role != null then roles contains role.
 * - ADMIN and DELIVERY must be solo entries.
 */
export function hasRole(user: HasRoles, role: Role): boolean {
  if (!user || !Array.isArray(user.roles)) return false;
  return user.roles.includes(role);
}

export function assertRoleCombination(roles: Role[]): void {
  const set = new Set(roles);
  if (set.has(Role.ADMIN) && set.size > 1) {
    throw new Error('ADMIN cannot be combined with another role');
  }
  if (set.has(Role.DELIVERY) && set.size > 1) {
    throw new Error('DELIVERY cannot be combined with another role');
  }
}
