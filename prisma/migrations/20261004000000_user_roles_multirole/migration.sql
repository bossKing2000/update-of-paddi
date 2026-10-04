-- Phase 1B: multi-role accounts using an "active role" model.
-- `role` stays the ACTIVE role (nullable, unchanged).
-- `roles` holds every role the account holds.
ALTER TABLE "User" ADD COLUMN "roles" "Role"[] NOT NULL DEFAULT ARRAY[]::"Role"[];

-- Backfill existing single-role users: roles = [role] where role is set.
UPDATE "User" SET "roles" = ARRAY["role"] WHERE "role" IS NOT NULL;
