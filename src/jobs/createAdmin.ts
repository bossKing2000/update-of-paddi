/**
 * Bootstrap an ADMIN account.
 *
 * ADMIN can't be self-assigned through the normal /select-role endpoint
 * (that's CUSTOMER/VENDOR/DELIVERY only, by design) — this script is the
 * one-time/occasional way to create or promote an admin.
 *
 * Usage:
 *   ADMIN_EMAIL=you@paddi.com ADMIN_PASSWORD=xxxxxxxx ADMIN_NAME="Your Name" \
 *     npx ts-node src/jobs/createAdmin.ts
 *
 * If a user with ADMIN_EMAIL already exists, it's promoted to ADMIN
 * in place rather than erroring — safe to re-run.
 */
import bcrypt from "bcrypt";
import prisma from "../lib/prisma";
import config from "../config/config";
import { logger } from "../lib/logger";

async function createAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || "Admin";

  if (!email || !password) {
    logger.error("ADMIN_EMAIL and ADMIN_PASSWORD env vars are required");
    process.exit(1);
  }

  if (password.length < 8) {
    logger.error("ADMIN_PASSWORD must be at least 8 characters");
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    if (existing.role === "ADMIN") {
      logger.info({ email }, "User is already an ADMIN — nothing to do");
      process.exit(0);
    }

    await prisma.user.update({
      where: { email },
      data: { role: "ADMIN" },
    });
    logger.info({ email }, "Existing user promoted to ADMIN");
    process.exit(0);
  }

  const hashedPassword = await bcrypt.hash(password, config.bcryptSaltRounds);

  await prisma.user.create({
    data: {
      name,
      email,
      password: hashedPassword,
      role: "ADMIN",
    },
  });

  logger.info({ email }, "Admin account created");
  process.exit(0);
}

createAdmin()
  .catch((err) => {
    logger.error({ err }, "Failed to create admin");
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
