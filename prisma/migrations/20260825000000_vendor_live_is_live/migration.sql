-- Vendor Live migration: add vendor-level operating flag.
-- Backfill existing vendors to isLive = true so marketplace behavior is
-- unchanged until each vendor explicitly goes offline via the new
-- PATCH /api/vendor/settings/live endpoint.

ALTER TABLE "User" ADD COLUMN "isLive" BOOLEAN NOT NULL DEFAULT false;

UPDATE "User" SET "isLive" = true WHERE "role" = 'VENDOR';
