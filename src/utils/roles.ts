import { Role } from '@prisma/client';

type HasRoles = { roles?: Role[] | null } | null | undefined;

/**
 * Multi-role helper (Phase 1B).
 * - `role` stays the ACTIVE role; `roles` holds every role the account holds.
 * - Invariant: if role != null then roles contains role.
 * - ADMIN must be the only role held.
 * - DELIVERY may be combined with CUSTOMER only, never with VENDOR or ADMIN.
 * - CUSTOMER and VENDOR may be combined.
 *
 * NOTE: this module must not dereference `Role` at import time. Test suites
 * (e.g. tests/unit/socketSecurity.test.ts) mock @prisma/client without a Role
 * export, and a module-scope `Role.X` would throw during import. Every
 * reference to `Role` stays inside a function body.
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
    // Allowlist, not a blocklist. Deleting the DELIVERY rule outright would
    // also admit VENDOR + DELIVERY and ADMIN + DELIVERY, which is a wider grant
    // than the policy authorises. An allowlist fails closed, so any role added
    // to the enum later is refused here until it is deliberately allowed.
    const compatible: readonly Role[] = [Role.CUSTOMER];
    // Reading the Set rather than the raw input collapses duplicates first, so
    // [DELIVERY, DELIVERY] is a solo DELIVERY and `set.size > 1` above keeps a
    // solo DELIVERY out of this scan entirely — DELIVERY is not one of its own
    // permitted companions. `Set.has` compares by SameValueZero, which is exact
    // for these string enum members.
    const allAllowed = [...set].every(
      (role) => role === Role.DELIVERY || compatible.includes(role),
    );
    if (!allAllowed) {
      throw new Error('DELIVERY can only be combined with CUSTOMER');
    }
  }
}
