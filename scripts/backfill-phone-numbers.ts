/**
 * One-off backfill: populate User.phoneNumberE164 from legacy phoneNumber.
 *
 * - Idempotent: skips users whose phoneNumberE164 is already correct.
 * - Never sets isPhoneVerified=true (existing numbers are unverified).
 * - Duplicates: when several users normalize to the same E.164, only the
 *   earliest-created user claims it; the rest are reported and left NULL.
 * - Invalid numbers are reported and left NULL.
 * - Dry run by default: pass --apply to actually write.
 *
 * Usage:
 *   npx ts-node scripts/backfill-phone-numbers.ts          # dry run
 *   npx ts-node scripts/backfill-phone-numbers.ts --apply   # write
 */
import prisma from "../src/lib/prisma";
import { tryNormalizePhoneNumber } from "../src/utils/phone";

const DRY_RUN = !process.argv.includes("--apply");

async function main() {
  const users = await prisma.user.findMany({
    where: { phoneNumber: { not: null } },
    select: {
      id: true,
      email: true,
      phoneNumber: true,
      phoneNumberE164: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const valid: { id: string; email: string; raw: string; e164: string }[] = [];
  const invalid: { id: string; email: string; raw: string }[] = [];
  let alreadyCorrect = 0;

  for (const u of users) {
    if (!u.phoneNumber) continue;
    const normalized = tryNormalizePhoneNumber(u.phoneNumber);
    if (!normalized) {
      invalid.push({ id: u.id, email: u.email, raw: u.phoneNumber });
      continue;
    }
    if (u.phoneNumberE164 === normalized) {
      alreadyCorrect++;
      continue;
    }
    valid.push({ id: u.id, email: u.email, raw: u.phoneNumber, e164: normalized });
  }

  // Detect duplicates deterministically: earliest createdAt wins.
  const byE164 = new Map<string, typeof valid>();
  for (const v of valid) {
    const group = byE164.get(v.e164) ?? [];
    group.push(v);
    byE164.set(v.e164, group);
  }

  const winners: typeof valid = [];
  const duplicates: typeof valid = [];
  for (const group of byE164.values()) {
    if (group.length === 1) {
      winners.push(group[0]);
    } else {
      winners.push(group[0]);
      duplicates.push(...group.slice(1));
    }
  }

  // Also exclude winners whose E.164 is already claimed in the DB by a user
  // outside this batch (e.g. set manually). Keeps the unique constraint safe.
  const claimed = await prisma.user.findMany({
    where: { phoneNumberE164: { not: null } },
    select: { id: true, phoneNumberE164: true },
  });
  const claimedMap = new Map<string, string>();
  for (const c of claimed) {
    if (c.phoneNumberE164) claimedMap.set(c.phoneNumberE164, c.id);
  }
  const toWrite = winners.filter((w) => {
    const owner = claimedMap.get(w.e164);
    return !owner || owner === w.id;
  });
  const blockedByExisting = winners.filter((w) => {
    const owner = claimedMap.get(w.e164);
    return owner && owner !== w.id;
  });

  console.log(`Users with phoneNumber: ${users.length}`);
  console.log(`Already correct E.164: ${alreadyCorrect}`);
  console.log(`Valid normalizable: ${valid.length}`);
  console.log(`Invalid/unparseable: ${invalid.length}`);
  console.log(`Duplicate E.164 groups: ${[...byE164.values()].filter((g) => g.length > 1).length}`);
  console.log(`Duplicate rows left NULL: ${duplicates.length}`);
  console.log(`Blocked by existing E.164 owner: ${blockedByExisting.length}`);
  console.log(`Would backfill: ${toWrite.length}`);

  for (const v of invalid.slice(0, 20)) {
    console.log(`  invalid: ${v.id} (${v.email}) raw=${JSON.stringify(v.raw)}`);
  }
  for (const v of duplicates.slice(0, 20)) {
    console.log(`  duplicate: ${v.id} (${v.email}) e164=${v.e164} raw=${JSON.stringify(v.raw)}`);
  }

  if (DRY_RUN) {
    console.log("DRY RUN — no writes. Re-run with --apply to backfill.");
    return;
  }

  let done = 0;
  for (const w of toWrite) {
    try {
      await prisma.user.update({
        where: { id: w.id },
        data: { phoneNumberE164: w.e164 },
      });
      done++;
    } catch (e) {
      console.log(`  skipped ${w.id} (${w.email}): ${(e as Error).message}`);
    }
  }
  console.log(`Backfilled ${done} row(s). Re-run to verify zero remaining.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
