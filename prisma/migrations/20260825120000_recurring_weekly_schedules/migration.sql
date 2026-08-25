-- Recurring weekly product schedules.
-- Existing ProductSchedule rows are ONE_TIME by default (no backfill
-- needed) so legacy absolute windows keep working unchanged.

CREATE TYPE "ProductScheduleType" AS ENUM ('ONE_TIME', 'WEEKLY');

ALTER TABLE "ProductSchedule" ADD COLUMN "type" "ProductScheduleType" NOT NULL DEFAULT 'ONE_TIME';
ALTER TABLE "ProductSchedule" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ProductSchedule" ADD COLUMN "startDate" TIMESTAMP(3);
ALTER TABLE "ProductSchedule" ADD COLUMN "endDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ProductScheduleWindow" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ProductScheduleWindow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductScheduleWindow_scheduleId_dayOfWeek_idx"
  ON "ProductScheduleWindow"("scheduleId", "dayOfWeek");

-- AddForeignKey
ALTER TABLE "ProductScheduleWindow"
  ADD CONSTRAINT "ProductScheduleWindow_scheduleId_fkey"
  FOREIGN KEY ("scheduleId") REFERENCES "ProductSchedule"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Vendor business timezone (IANA name) for local schedule evaluation.
ALTER TABLE "User" ADD COLUMN "timezone" TEXT;
