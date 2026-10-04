/**
 * One-off backfill: encrypt legacy plaintext bankAccountNumber rows.
 *
 * - Idempotent: skips NULL values and rows already in encrypt() format.
 * - Dry run by default: pass --apply to actually write.
 *
 * Usage:
 *   npx ts-node scripts/encrypt-existing-bank-accounts.ts          # dry run
 *   npx ts-node scripts/encrypt-existing-bank-accounts.ts --apply   # write
 */
import prisma from "../src/lib/prisma";
import { encrypt, isEncryptedFormat } from "../src/utils/encrypt";

const DRY_RUN = !process.argv.includes("--apply");

async function main() {
  const vendors = await prisma.user.findMany({
    where: { bankAccountNumber: { not: null } },
    select: { id: true, email: true, bankAccountNumber: true },
  });

  let already = 0;
  let plaintext = 0;
  const targets: { id: string; value: string }[] = [];

  for (const v of vendors) {
    if (!v.bankAccountNumber) continue;
    if (isEncryptedFormat(v.bankAccountNumber)) {
      already++;
    } else {
      plaintext++;
      targets.push({ id: v.id, value: v.bankAccountNumber });
    }
  }

  console.log(`Bank rows with a number on file: ${vendors.length}`);
  console.log(`Already encrypted: ${already}`);
  console.log(`Legacy plaintext: ${plaintext}`);

  if (DRY_RUN) {
    console.log("DRY RUN — no writes. Re-run with --apply to encrypt.");
    for (const t of targets.slice(0, 20)) {
      const v = vendors.find((x) => x.id === t.id);
      console.log(`  would encrypt user ${t.id} (${v?.email ?? "no email"})`);
    }
    if (targets.length > 20) console.log(`  ... and ${targets.length - 20} more`);
    return;
  }

  let done = 0;
  for (const t of targets) {
    await prisma.user.update({
      where: { id: t.id },
      data: { bankAccountNumber: encrypt(t.value) },
    });
    done++;
  }
  console.log(`Encrypted ${done} row(s). Re-run to verify zero plaintext remain.`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err?.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
