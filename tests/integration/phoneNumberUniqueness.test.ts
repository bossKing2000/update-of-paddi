/**
 * Phase 1D.2 — real PostgreSQL verification of `User.phoneNumberE164`
 * uniqueness and concurrent duplicate-phone handling.
 *
 * The schema declares `phoneNumberE164 String? @unique`
 * (prisma/schema.prisma:20) and the migration creates
 * `User_phoneNumberE164_key` (migration line 1081). That unique index is the
 * database backstop: application preflight lookups can race, so the index must
 * itself refuse duplicates under concurrency. PostgreSQL unique indexes treat
 * NULL as distinct, so multiple NULL `phoneNumberE164` rows are allowed — only
 * non-null values are unique.
 *
 * Nothing here re-implements the operation: the real Prisma client is executed
 * against a disposable PostgreSQL target pinned by the integration preflight.
 *
 * FAILS CLOSED unless TEST_DATABASE_URL names the authorized disposable
 * loopback target (see tests/setup/integrationPreflight.ts).
 */
import prisma from "../../src/lib/prisma";
import type { Role } from "@prisma/client";

const PREFIX = `u_pnu_${Date.now()}_`;

async function makeUser(suffix: string, over: Record<string, unknown> = {}) {
  const id = `${PREFIX}${suffix}`;
  await prisma.user.create({
    data: {
      id,
      name: `PNU ${suffix}`,
      email: `${suffix}@pnu.test`,
      password: "x",
      role: "CUSTOMER" as Role,
      roles: ["CUSTOMER"],
      tokenVersion: 1,
      isEmailVerified: true,
      ...over,
    } as any,
  });
  return id;
}

async function readPhone(id: string) {
  const row = await prisma.user.findUnique({
    where: { id },
    select: { phoneNumberE164: true, isPhoneVerified: true },
  });
  return row?.phoneNumberE164 ?? null;
}

const E1 = "+2348012345670";
const E2 = "+2348012345671";

beforeEach(async () => {
  await prisma.user.deleteMany({
    where: { id: { startsWith: PREFIX } },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { id: { startsWith: PREFIX } },
  });
});

describe("Phase 1D.2 — phoneNumberE164 uniqueness (real PostgreSQL)", () => {
  it("allows multiple NULL phoneNumberE164 rows (nullable unique column)", async () => {
    const a = await makeUser("a-null");
    const b = await makeUser("b-null");
    expect(await readPhone(a)).toBeNull();
    expect(await readPhone(b)).toBeNull();
    // A third NULL row must still insert — NULLs are distinct in a unique index.
    const c = await makeUser("c-null");
    expect(await readPhone(c)).toBeNull();
  });

  it("refuses a duplicate non-null phoneNumberE164 with P2002", async () => {
    const a = await makeUser("dup-a", { phoneNumberE164: E1, phoneNumber: "08012345670" });
    const b = await makeUser("dup-b"); // no phone yet
    // Real write path: verifyPhoneOtp does prisma.user.update({where:{id}, data:{phoneNumberE164}}).
    await expect(
      prisma.user.update({
        where: { id: b },
        data: { phoneNumberE164: E1, phoneNumber: "08012345671" } as any,
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    // The loser must not have acquired the number.
    expect(await readPhone(b)).toBeNull();
    expect(await readPhone(a)).toBe(E1);
  });

  it("keeps the first writer's number under concurrent duplicate assignment", async () => {
    const a = await makeUser("conc-a");
    const b = await makeUser("conc-b");
    // Both try to claim the same number concurrently: exactly one may win.
    const results = await Promise.allSettled([
      prisma.user.update({
        where: { id: a },
        data: { phoneNumberE164: E1, phoneNumber: "08012345670" } as any,
      }),
      prisma.user.update({
        where: { id: b },
        data: { phoneNumberE164: E1, phoneNumber: "08012345671" } as any,
      }),
    ]);
    const winners = results.filter(
      (r) => r.status === "fulfilled",
    ).length;
    const losers = results.filter(
      (r) => r.status === "rejected" &&
        (r as PromiseRejectedResult).reason?.code === "P2002",
    ).length;
    expect(winners).toBe(1);
    expect(losers).toBe(1);
    // Exactly one row holds the number.
    const holders = await prisma.user.findMany({
      where: { phoneNumberE164: E1 },
      select: { id: true },
    });
    expect(holders).toHaveLength(1);
  });
});
