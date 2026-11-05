import {
  DeliveryPersonStatus,
  DeliveryStatus,
  DiscountType,
  KycStatus,
  OrderStatus,
  PaymentStatus,
  PayoutStatus,
  PrismaClient,
  PromotionScope,
  RefundStatus,
  Role,
} from "@prisma/client";
import bcrypt from "bcryptjs";
import { buildOrderMoneySnapshot } from "../services/orderSnapshot.service";
import { assertSeedAllowed } from "./seedGuard";
import { deriveDeliveryEarningAmounts } from "./seedFinancialRules";

// ------------------------------------------------------------
// Phase 3 deterministic financial fixtures (Stage C).
// faker-random bulk data + Stage B showcase above, fixed financial
// fixtures here. Every record uses a stable ID/key and is
// existence-guarded, so re-runs never duplicate it.
//
// Phase 3 financial fixtures are development-only deterministic
// fixtures. They are not production historical data and do not
// satisfy the 3.2c production-clone evidence gate.
//
// Fixture map (all naira inputs are exact 2dp values; kobo expectations
// verified against buildOrderMoneySnapshot semantics):
//   F1  O1+P1+R1  single vendor A @0.15, partial completed refund
//   F2  O2+P2     vendor B @0.20 rate variant, no refunds
//   F3  O3+P3     FIXED 500 promo + usage, vendor A @0.15
//   F4  O4a+O4b+P4+R4  shared-key batch, ambiguous (NULL) attribution
//   F5  O5+P5+R5a+R5b  sequential partials (completed + processing)
//   F6  O6+P6     saved-card reuse state (one PENDING payment, no dupes)
//   F7  payout    VendorPayout over O1+O3 (live-math aggregate)
//   F8  rider+assignment+earning  delivery-fee derivation + wallet credit
//   F9  receipt   deterministic receipt on P1
// Excluded by design: WebhookEvent (dead producer), RiderWithdrawal
// (deferred: needs payout-account/approval choreography).
// ------------------------------------------------------------

const prisma = new PrismaClient();

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS) || 10;
const SEED_TEST_PASSWORD = process.env.SEED_TEST_PASSWORD ?? "PaddiDemo123!";

const RATE_A = 0.15;
const RATE_B = 0.2;
const DELIVERY_FEE = 500;

const IDS = {
  vendorA: "seed-fin-vendor-a",
  vendorB: "seed-fin-vendor-b",
  cust1: "seed-fin-cust-1",
  cust2: "seed-fin-cust-2",
  rider: "seed-fin-rider",
  prod5000A: "seed-fin-prod-5000-a",
  prod5000B: "seed-fin-prod-5000-b",
  prod3000A: "seed-fin-prod-3000-a",
  prod4000B: "seed-fin-prod-4000-b",
  promo500: "seed-fin-promo-500",
  usage1: "seed-fin-usage-1",
  o1: "seed-fin-o1",
  o2: "seed-fin-o2",
  o3: "seed-fin-o3",
  o4a: "seed-fin-o4a",
  o4b: "seed-fin-o4b",
  o5: "seed-fin-o5",
  o6: "seed-fin-o6",
  p1: "seed-fin-p1",
  p2: "seed-fin-p2",
  p3: "seed-fin-p3",
  p4: "seed-fin-p4",
  p5: "seed-fin-p5",
  p6: "seed-fin-p6",
  r1: "seed-fin-r1",
  r4: "seed-fin-r4",
  r5a: "seed-fin-r5a",
  r5b: "seed-fin-r5b",
  card1: "seed-fin-card-1",
  payout1: "seed-fin-payout-1",
  assign1: "seed-fin-assign-1",
} as const;

const REFS = {
  p1: "SEED-FIN-F1-PAY",
  p2: "SEED-FIN-F2-PAY",
  p3: "SEED-FIN-F3-PAY",
  p4: "SEED-FIN-F4-PAY",
  p5: "SEED-FIN-F5-PAY",
  p6: "SEED-FIN-F6-PAY",
} as const;

const KEYS = {
  f1: "seed-fin-key-f1",
  f2: "seed-fin-key-f2",
  f3: "seed-fin-key-f3",
  batch1: "seed-fin-batch-1",
  f5: "seed-fin-key-f5",
  savedcard1: "seed-fin-savedcard-1",
} as const;

async function ensureFinUser(
  id: string,
  data: {
    name: string;
    email: string;
    username: string;
    role: Role;
    passwordHash: string;
    brandName?: string;
    isLive?: boolean;
    commissionRate?: number;
  },
) {
  // Canonical operational fields are enforced on every run so later bulk
  // showcase flips (or a previous run) can never leave fixture vendors
  // with non-fixture rates or offline status. Password is create-only.
  return prisma.user.upsert({
    where: { id },
    update: {
      isLive: data.isLive,
      kycStatus: KycStatus.VERIFIED,
      ...(data.commissionRate !== undefined ? { commissionRate: data.commissionRate } : {}),
    },
    create: {
      id,
      name: data.name,
      email: data.email,
      username: data.username,
      password: data.passwordHash,
      role: data.role,
      roles: [data.role],
      preferences: [],
      authProviders: ["local"],
      brandName: data.brandName,
      isEmailVerified: true,
      isLive: data.isLive,
      kycStatus: KycStatus.VERIFIED,
      commissionRate: data.commissionRate,
    },
  });
}

async function ensureFinProduct(
  id: string,
  data: { name: string; price: number; vendorId: string; categoryId: string },
) {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (existing) {
    return assertFixtureMatches(`product ${id}`, existing as never, {
      name: data.name,
      vendorId: data.vendorId,
      categoryId: data.categoryId,
    } as never);
  }
  return prisma.product.create({
    data: {
      id,
      name: data.name,
      description: `${data.name} (deterministic Phase 3 fixture).`,
      price: data.price,
      dishTypeId: "JOLLOF",
      categoryId: data.categoryId,
      archived: false,
      vendorId: data.vendorId,
      images: [],
      video: [],
    },
  });
}

/**
 * F4-5 seeder reliability — fixture shape validation.
 *
 * Every existence-guarded `ensure*` helper here uses `if (existing) return
 * existing`. That guard is what makes re-runs non-duplicating, but it also means
 * a row left over from an EARLIER definition is preserved silently and forever.
 * That is precisely the mechanism behind the stale F6 order: the O6 row in the
 * dev database still carried a retired `idempotencyKey` while the source
 * fixture had been corrected to `seed-fin-savedcard-1`, and because a row with
 * that id already existed the guard returned it without ever comparing it.
 *
 * This turns that silent skip into a loud failure. When a guarded row exists its
 * identity and critical relationship fields are compared against the values the
 * fixture intends to create; any mismatch throws with the exact differences.
 *
 * It never deletes or repairs a row — reporting the drift is the whole point. The
 * operator chooses between a deliberate reset-and-reseed and a manual correction.
 *
 * Note `ensureFinUser` is deliberately excluded: it uses `upsert` and
 * re-asserts canonical operational fields on every run, so it already
 * self-heals rather than silently skipping.
 */
function assertFixtureMatches<T extends Record<string, unknown>>(
  label: string,
  existing: T,
  expected: Partial<Record<keyof T, unknown>>,
): T {
  const mismatches: string[] = [];
  for (const key of Object.keys(expected) as Array<keyof T>) {
    const want = expected[key];
    if (want === undefined) continue;
    const got = existing[key];
    const same =
      got instanceof Date && want instanceof Date
        ? got.getTime() === want.getTime()
        : got === want;
    if (!same) {
      mismatches.push(`${String(key)}: expected ${JSON.stringify(want)}, found ${JSON.stringify(got)}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Financial fixture drift on ${label}: a row with this id already exists but its critical ` +
        `fields do not match the fixture definition. Refusing to skip it — silently preserving a ` +
        `stale row is how the retired F6 idempotency key survived on the dev database. ` +
        `Mismatches: ${mismatches.join("; ")}. ` +
        `No row was changed. Reset the schema and reseed, or correct the row deliberately.`,
    );
  }
  return existing;
}

export async function seedFinancialFixtures(): Promise<void> {
  // Opt-in guard first. This lives inside the exported function (not only in
  // the demo seeder that calls it) so that any future direct-invocation path —
  // a new npm script, `ts-node`, or an ad-hoc import — cannot bypass it.
  assertSeedAllowed("src/jobs/seedFinancialFixtures.ts");

  console.log("Seeding Phase 3 deterministic financial fixtures (F1-F9)...");
  const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
  const now = new Date();

  const passwordHash = await bcrypt.hash(SEED_TEST_PASSWORD, BCRYPT_ROUNDS);

  const vendorA = await ensureFinUser(IDS.vendorA, {
    name: "Seed Fin Vendor A",
    email: "vendor-a.seed-fin@foodpaddi.test",
    username: "seed_fin_vendor_a",
    role: Role.VENDOR,
    passwordHash,
    brandName: "Seed Fin Vendor A Foods",
    isLive: true,
    commissionRate: RATE_A,
  });
  const vendorB = await ensureFinUser(IDS.vendorB, {
    name: "Seed Fin Vendor B",
    email: "vendor-b.seed-fin@foodpaddi.test",
    username: "seed_fin_vendor_b",
    role: Role.VENDOR,
    passwordHash,
    brandName: "Seed Fin Vendor B Foods",
    isLive: true,
    commissionRate: RATE_B,
  });
  const cust1 = await ensureFinUser(IDS.cust1, {
    name: "Seed Fin Customer One",
    email: "cust-1.seed-fin@foodpaddi.test",
    username: "seed_fin_cust_1",
    role: Role.CUSTOMER,
    passwordHash,
  });
  const cust2 = await ensureFinUser(IDS.cust2, {
    name: "Seed Fin Customer Two",
    email: "cust-2.seed-fin@foodpaddi.test",
    username: "seed_fin_cust_2",
    role: Role.CUSTOMER,
    passwordHash,
  });
  const rider = await ensureFinUser(IDS.rider, {
    name: "Seed Fin Rider",
    email: "rider.seed-fin@foodpaddi.test",
    username: "seed_fin_rider",
    role: Role.DELIVERY,
    passwordHash,
  });
  // Rates are read back from the canonical rows so snapshots always match
  // the stored vendor state, even across reruns.
  const rateA = vendorA.commissionRate;
  const rateB = vendorB.commissionRate;

  const categoryId =
    (await prisma.dishType.findUnique({ where: { id: "JOLLOF" }, select: { categoryId: true } }))
      ?.categoryId ?? "RICE_DISHES";

  const prod5000A = await ensureFinProduct(IDS.prod5000A, {
    name: "Seed Fin Jollof 5000",
    price: 5000,
    vendorId: vendorA.id,
    categoryId,
  });
  const prod5000B = await ensureFinProduct(IDS.prod5000B, {
    name: "Seed Fin Jollof B5000",
    price: 5000,
    vendorId: vendorB.id,
    categoryId,
  });
  const prod3000A = await ensureFinProduct(IDS.prod3000A, {
    name: "Seed Fin Rice 3000",
    price: 3000,
    vendorId: vendorA.id,
    categoryId,
  });
  const prod4000B = await ensureFinProduct(IDS.prod4000B, {
    name: "Seed Fin Rice B4000",
    price: 4000,
    vendorId: vendorB.id,
    categoryId,
  });

  // F3 promotion: real FIXED code promo on the production pricing path.
  const promo500 =
    (await prisma.promotion.findUnique({ where: { id: IDS.promo500 } })) ??
    (await prisma.promotion.create({
      data: {
        id: IDS.promo500,
        vendorId: vendorA.id,
        code: "SEED-FIN-500",
        name: "Seed Fin fixed 500",
        description: "Deterministic ₦500-off fixture promo (vendor-wide).",
        type: DiscountType.FIXED,
        value: 500,
        scope: PromotionScope.VENDOR_WIDE,
        isActive: true,
        startsAt: at(now, -7 * 24 * 3600 * 1000),
        expiresAt: at(now, 30 * 24 * 3600 * 1000),
        usageLimit: 100,
        maxUsesPerUser: 2,
        minOrderAmount: 2000,
      },
    }));

  async function ensureFinOrder(orderId: string, input: {
    customerId: string;
    vendorId: string;
    basePrice: number;
    discountNaira: number;
    commissionRate: number;
    productId: string;
    productName: string;
    unitPrice: number;
    quantity: number;
    idempotencyKey: string;
    status?: "COMPLETED" | "AWAITING_PAYMENT";
    createdAt?: Date;
  }) {
    const existing = await prisma.order.findUnique({ where: { id: orderId } });
    if (existing) {
      const paid = input.status === "COMPLETED";
      return assertFixtureMatches(`order ${orderId}`, existing as never, {
        idempotencyKey: input.idempotencyKey,
        vendorId: input.vendorId,
        customerId: input.customerId,
        status: paid ? OrderStatus.COMPLETED : OrderStatus.AWAITING_PAYMENT,
        paymentStatus: paid ? PaymentStatus.SUCCESS : PaymentStatus.PENDING,
      } as never);
    }
    // Builder-coupled: fixture kobo values always equal production math.
    const snap = buildOrderMoneySnapshot({
      basePriceNaira: input.basePrice,
      discountNaira: input.discountNaira,
      commissionRate: input.commissionRate,
    });
    const createdAt = input.createdAt ?? now;
    const paid = input.status !== "AWAITING_PAYMENT";
    // Line math mirrors checkout: subtotal = unitPrice × quantity; the
    // order-level discount lives only in basePrice (= raw − discount).
    const lineSubtotal = input.unitPrice * input.quantity;
    return prisma.order.create({
      data: {
        id: orderId,
        customerId: input.customerId,
        vendorId: input.vendorId,
        basePrice: input.basePrice,
        extraCharge: 0,
        deliveryFee: DELIVERY_FEE,
        totalPrice: input.basePrice + DELIVERY_FEE,
        commissionRateSnapshot: snap.commissionRateSnapshot,
        commissionKobo: snap.commissionKobo,
        vendorPayoutKobo: snap.vendorPayoutKobo,
        discountKobo: snap.discountKobo,
        customerApproval: true,
        status: paid ? OrderStatus.COMPLETED : OrderStatus.AWAITING_PAYMENT,
        paymentStatus: paid ? PaymentStatus.SUCCESS : PaymentStatus.PENDING,
        idempotencyKey: input.idempotencyKey,
        createdAt,
        updatedAt: createdAt,
        paidAt: paid ? at(createdAt, 60_000) : null,
        paymentStartedAt: at(createdAt, 5_000),
        protectedUntil: at(createdAt, 15 * 60_000),
        paymentGraceMinutes: 15,
        items: {
          create: [
            {
              productId: input.productId,
              productName: input.productName,
              quantity: input.quantity,
              unitPrice: input.unitPrice,
              subtotal: lineSubtotal,
              createdAt,
              updatedAt: createdAt,
            },
          ],
        },
      },
    });
  }

  // F1: base 5000, fee 500, total 5500 @0.15 → comm 75000, payout 425000.
  await ensureFinOrder(IDS.o1, {
    customerId: cust1.id,
    vendorId: vendorA.id,
    basePrice: 5000,
    discountNaira: 0,
    commissionRate: rateA,
    productId: prod5000A.id,
    productName: prod5000A.name,
    unitPrice: 5000,
    quantity: 1,
    idempotencyKey: KEYS.f1,
  });
  // F2: base 5000 @0.20 → comm 100000, payout 400000, snapshot 0.20.
  await ensureFinOrder(IDS.o2, {
    customerId: cust1.id,
    vendorId: vendorB.id,
    basePrice: 5000,
    discountNaira: 0,
    commissionRate: rateB,
    productId: prod5000B.id,
    productName: prod5000B.name,
    unitPrice: 5000,
    quantity: 1,
    idempotencyKey: KEYS.f2,
  });
  // F3: raw 5000 − 500 promo → base 4500 @0.15 → comm 67500,
  // payout 382500, discount 50000.
  await ensureFinOrder(IDS.o3, {
    customerId: cust1.id,
    vendorId: vendorA.id,
    basePrice: 4500,
    discountNaira: 500,
    commissionRate: rateA,
    productId: prod5000A.id,
    productName: prod5000A.name,
    unitPrice: 5000,
    quantity: 1,
    idempotencyKey: KEYS.f3,
  });
  if (
    !(await prisma.promotionUsage.findUnique({ where: { id: IDS.usage1 } }))
  ) {
    await prisma.promotionUsage.create({
      data: {
        id: IDS.usage1,
        promotionId: promo500.id,
        userId: cust1.id,
        orderIds: [IDS.o3],
        promoCode: "SEED-FIN-500",
        discount: 500,
      },
    });
    await prisma.promotion.update({
      where: { id: promo500.id },
      data: { usedCount: { increment: 1 } },
    });
  }
  // F4 batch: O4a (A: base 3000 → total 3500) + O4b (B: base 4000 →
  // total 4500) share one key; single payment of 800000 kobo.
  await ensureFinOrder(IDS.o4a, {
    customerId: cust1.id,
    vendorId: vendorA.id,
    basePrice: 3000,
    discountNaira: 0,
    commissionRate: rateA,
    productId: prod3000A.id,
    productName: prod3000A.name,
    unitPrice: 3000,
    quantity: 1,
    idempotencyKey: KEYS.batch1,
  });
  await ensureFinOrder(IDS.o4b, {
    customerId: cust1.id,
    vendorId: vendorB.id,
    basePrice: 4000,
    discountNaira: 0,
    commissionRate: rateB,
    productId: prod4000B.id,
    productName: prod4000B.name,
    unitPrice: 4000,
    quantity: 1,
    idempotencyKey: KEYS.batch1,
  });
  // F5: base 5000 @0.15 (cust-2 isolates the refund fixtures).
  await ensureFinOrder(IDS.o5, {
    customerId: cust2.id,
    vendorId: vendorA.id,
    basePrice: 5000,
    discountNaira: 0,
    commissionRate: rateA,
    productId: prod5000A.id,
    productName: prod5000A.name,
    unitPrice: 5000,
    quantity: 1,
    idempotencyKey: KEYS.f5,
  });
  // F6: pre-payment order (checkout writes snapshots before payment, so
  // snapshots are populated here too). The order carries the SAME
  // idempotency key as its payment: batch resolution looks orders up by
  // that key, so a divergent key would be an unreachable state.
  await ensureFinOrder(IDS.o6, {
    customerId: cust1.id,
    vendorId: vendorA.id,
    basePrice: 5000,
    discountNaira: 0,
    commissionRate: rateA,
    productId: prod5000A.id,
    productName: prod5000A.name,
    unitPrice: 5000,
    quantity: 1,
    idempotencyKey: KEYS.savedcard1,
    status: "AWAITING_PAYMENT",
  });

  async function ensureFinPayment(paymentId: string, input: {
    userId: string;
    orderId: string;
    amountKobo: number;
    reference: string;
    idempotencyKey: string;
    status: "SUCCESS" | "PENDING";
    refundedAmount?: number;
    channel?: string;
  }) {
    const existing = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (existing) {
      return assertFixtureMatches(`payment ${paymentId}`, existing as never, {
        idempotencyKey: input.idempotencyKey,
        orderId: input.orderId,
        reference: input.reference,
        status: input.status,
        amount: input.amountKobo,
      } as never);
    }
    const startedAt = now;
    return prisma.payment.create({
      data: {
        id: paymentId,
        userId: input.userId,
        orderId: input.orderId,
        amount: input.amountKobo,
        reference: input.reference,
        status: input.status === "SUCCESS" ? PaymentStatus.SUCCESS : PaymentStatus.PENDING,
        idempotencyKey: input.idempotencyKey,
        refundedAmount: input.refundedAmount ?? 0,
        channel: input.channel ?? "card",
        ipAddress: "127.0.0.1",
        userAgent: "seed-financial-fixtures",
        startedAt,
        completedAt: input.status === "SUCCESS" ? at(startedAt, 60_000) : null,
        expiresAt: at(startedAt, 15 * 60_000),
        createdAt: startedAt,
        updatedAt: startedAt,
      },
    });
  }

  const p1 = await ensureFinPayment(IDS.p1, {
    userId: cust1.id, orderId: IDS.o1, amountKobo: 550000,
    reference: REFS.p1, idempotencyKey: KEYS.f1, status: "SUCCESS",
    refundedAmount: 150000,
  });
  await ensureFinPayment(IDS.p2, {
    userId: cust1.id, orderId: IDS.o2, amountKobo: 550000,
    reference: REFS.p2, idempotencyKey: KEYS.f2, status: "SUCCESS",
  });
  await ensureFinPayment(IDS.p3, {
    userId: cust1.id, orderId: IDS.o3, amountKobo: 500000,
    reference: REFS.p3, idempotencyKey: KEYS.f3, status: "SUCCESS",
  });
  await ensureFinPayment(IDS.p4, {
    userId: cust1.id, orderId: IDS.o4a, amountKobo: 800000,
    reference: REFS.p4, idempotencyKey: KEYS.batch1, status: "SUCCESS",
  });
  await ensureFinPayment(IDS.p5, {
    userId: cust2.id, orderId: IDS.o5, amountKobo: 550000,
    reference: REFS.p5, idempotencyKey: KEYS.f5, status: "SUCCESS",
    refundedAmount: 300000,
  });
  // F6 saved-card reuse state: exactly one PENDING keyed payment, unexpired
  // (expiresAt = seed + 15min). The corrected 3.2b path reuses this row.
  await ensureFinPayment(IDS.p6, {
    userId: cust1.id, orderId: IDS.o6, amountKobo: 550000,
    reference: REFS.p6, idempotencyKey: KEYS.savedcard1, status: "PENDING",
  });
  if (
    !(await prisma.userPaymentMethod.findUnique({ where: { id: IDS.card1 } }))
  ) {
    await prisma.userPaymentMethod.create({
      data: {
        id: IDS.card1,
        userId: cust1.id,
        cardToken: "SEED-FIN-CARD-4242",
        last4: "4242",
        brand: "visa",
        isDefault: true,
      },
    });
  }

  async function ensureFinRefund(refundId: string, input: {
    userId: string;
    paymentRef: string;
    reason: string;
    status: "PENDING" | "PROCESSING" | "COMPLETED";
    requestedAmountKobo: number | null;
    orderId: string | null;
  }) {
    const existing = await prisma.refundRequest.findUnique({ where: { id: refundId } });
    if (existing) {
      const mapped =
        input.status === "COMPLETED"
          ? RefundStatus.COMPLETED
          : input.status === "PROCESSING"
            ? RefundStatus.PROCESSING
            : RefundStatus.PENDING;
      return assertFixtureMatches(`refund ${refundId}`, existing as never, {
        userId: input.userId,
        paymentRef: input.paymentRef,
        status: mapped,
        requestedAmountKobo: input.requestedAmountKobo,
        orderId: input.orderId,
      } as never);
    }
    return prisma.refundRequest.create({
      data: {
        id: refundId,
        userId: input.userId,
        paymentRef: input.paymentRef,
        reason: input.reason,
        status:
          input.status === "COMPLETED"
            ? RefundStatus.COMPLETED
            : input.status === "PROCESSING"
              ? RefundStatus.PROCESSING
              : RefundStatus.PENDING,
        requestedAmountKobo: input.requestedAmountKobo,
        orderId: input.orderId,
      },
    });
  }

  // F1: single completed partial (150000 of 550000; reserved == completed).
  await ensureFinRefund(IDS.r1, {
    userId: cust1.id,
    paymentRef: REFS.p1,
    reason: "Seed Fin F1: completed partial refund.",
    status: "COMPLETED",
    requestedAmountKobo: 150000,
    orderId: IDS.o1,
  });
  // F4: batch-level PENDING request — amount-less, unattributed by design.
  // Never assign this to O4a merely because Payment.orderId points there.
  await ensureFinRefund(IDS.r4, {
    userId: cust1.id,
    paymentRef: REFS.p4,
    reason: "Seed Fin F4: batch-level request under review.",
    status: "PENDING",
    requestedAmountKobo: null,
    orderId: null,
  });
  // F5: sequential partials — one terminal + one active (the only active
  // refund on this payment). Reserved total 200000 + 100000 = 300000,
  // matching P5.refundedAmount; remaining = 250000.
  await ensureFinRefund(IDS.r5a, {
    userId: cust2.id,
    paymentRef: REFS.p5,
    reason: "Seed Fin F5: first partial (completed).",
    status: "COMPLETED",
    requestedAmountKobo: 200000,
    orderId: IDS.o5,
  });
  await ensureFinRefund(IDS.r5b, {
    userId: cust2.id,
    paymentRef: REFS.p5,
    reason: "Seed Fin F5: second partial (processing).",
    status: "PROCESSING",
    requestedAmountKobo: 100000,
    orderId: IDS.o5,
  });

  // F7 payout over O1+O3 on live math: gross 5000 + 4500 = 9500,
  // commission (9500 × 0.15).toFixed(2) = 1425, amount = 8075.
  // PENDING (unprocessed); O5 stays unclaimed as eligible-pool demo.
  const payout =
    (await prisma.vendorPayout.findUnique({ where: { id: IDS.payout1 } })) ??
    (await prisma.vendorPayout.create({
      data: {
        id: IDS.payout1,
        vendorId: vendorA.id,
        grossRevenue: 9500,
        commission: 1425,
        amount: 8075,
        orderCount: 2,
        periodStart: now,
        periodEnd: now,
        status: PayoutStatus.PENDING,
      },
    }));
  await prisma.order.updateMany({
    where: { id: { in: [IDS.o1, IDS.o3] }, payoutId: null },
    data: { payoutId: payout.id },
  });

  // F8 delivery: DELIVERED assignment on O1; earning derived exactly as
  // the production writer derives it (totalEarned = order.deliveryFee
  // 500 → baseFee min(300, 500) = 300, distanceFee 200); wallet credited
  // to match. No withdrawal/account fixtures (deferred by design).
  const riderPerson =
    (await prisma.deliveryPerson.findUnique({ where: { userId: rider.id } })) ??
    (await prisma.deliveryPerson.create({
      data: { userId: rider.id, status: DeliveryPersonStatus.ACTIVE, walletBalance: 0 },
    }));
  // Derived, not hardcoded, so the fixture cannot silently disagree with the
  // production payout rule if DELIVERY_BASE_FEE or the order fee changes.
  const F8_DELIVERY_FEE = 500;
  const amounts = deriveDeliveryEarningAmounts(F8_DELIVERY_FEE);

  // Both F8 guards VALIDATE an existing row rather than skipping it. Keying the
  // lookup on orderId alone meant a row for O1 with the wrong rider or the wrong
  // status was accepted as "already seeded", and an earning with the wrong split
  // was accepted while the rider's wallet was left uncredited.
  const existingAssignment = await prisma.deliveryAssignment.findFirst({
    where: { orderId: IDS.o1 },
  });
  if (existingAssignment) {
    assertFixtureMatches(`F8 delivery assignment on ${IDS.o1}`, existingAssignment as never, {
      orderId: IDS.o1,
      deliveryPersonId: riderPerson.id,
      status: DeliveryStatus.DELIVERED,
    } as never);
  } else {
    const assignedAt = at(now, 120_000);
    await prisma.deliveryAssignment.create({
      data: {
        id: IDS.assign1,
        orderId: IDS.o1,
        deliveryPersonId: riderPerson.id,
        status: DeliveryStatus.DELIVERED,
        assignedAt,
        acceptedAt: at(assignedAt, 60_000),
        startedAt: at(assignedAt, 180_000),
        completedAt: at(assignedAt, 900_000),
      },
    });
  }

  const existingEarning = await prisma.deliveryEarning.findFirst({
    where: { orderId: IDS.o1 },
  });
  if (existingEarning) {
    assertFixtureMatches(`F8 delivery earning on ${IDS.o1}`, existingEarning as never, {
      orderId: IDS.o1,
      deliveryPersonId: riderPerson.id,
      baseFee: amounts.baseFee,
      distanceFee: amounts.distanceFee,
      totalEarned: amounts.totalEarned,
    } as never);
  } else {
    await prisma.deliveryEarning.create({
      data: {
        deliveryPersonId: riderPerson.id,
        orderId: IDS.o1,
        baseFee: amounts.baseFee,
        distanceFee: amounts.distanceFee,
        totalEarned: amounts.totalEarned,
      },
    });
    // Credit the rider exactly as production does, in the same branch that
    // records the earning. `creditDeliveryEarning`
    // (src/services/deliveryEarning.ts) writes
    //   totalDeliveries: { increment: 1 }, walletBalance: { increment: totalEarned }
    // Assigning walletBalance would clobber any prior balance, and leaving
    // totalDeliveries untouched would produce a state production can never
    // reach: an earning on record with a zero delivery count. Both counters
    // are incremented here and only here, so a rerun that finds the earning
    // already present does not credit the rider a second time.
    await prisma.deliveryPerson.update({
      where: { id: riderPerson.id },
      data: {
        totalDeliveries: { increment: 1 },
        walletBalance: { increment: amounts.totalEarned },
      },
    });
  }

  // Wallet reconciliation runs on EVERY seed, not only when the earning is new.
  // The earning and its credit are written together on first run; on later runs
  // the credit is deliberately not rewritten, so a wallet that no longer covers
  // the earning is drift that must be surfaced rather than ignored. Withdrawal
  // fixtures are deferred by design, so a balance below the earned amount can
  // only mean the credit was lost or altered.
  const riderAfterSeed = await prisma.deliveryPerson.findUniqueOrThrow({
    where: { id: riderPerson.id },
    select: { walletBalance: true, totalDeliveries: true },
  });
  if (riderAfterSeed.walletBalance < amounts.totalEarned) {
    throw new Error(
      `F8 fixture drift on rider ${riderPerson.id}: walletBalance ` +
        `${riderAfterSeed.walletBalance} is below the ${amounts.totalEarned} earned on order ${IDS.o1}. ` +
        "The earning and its wallet credit are written together, so a shortfall means one of them " +
        "was changed outside the seeder. No row was changed. Reset the schema and reseed, or " +
        "correct the wallet deliberately.",
    );
  }
  // `totalDeliveries` is incremented once per earning and never decremented, so
  // for this rider — which the fixture gives exactly one earning — the expected
  // value is exact, not a floor. Comparing with `===` is what catches a double
  // increment, which a `>= 1` check would silently accept.
  const expectedDeliveries = 1;
  if (riderAfterSeed.totalDeliveries !== expectedDeliveries) {
    throw new Error(
      `F8 fixture drift on rider ${riderPerson.id}: totalDeliveries is ` +
        `${riderAfterSeed.totalDeliveries}, expected exactly ${expectedDeliveries} for the single ` +
        `earning this fixture creates on order ${IDS.o1}. Production increments this counter in the ` +
        `same statement that records the earning (src/services/deliveryEarning.ts), so a mismatch ` +
        `means the earning and its delivery count were written separately or credited twice. ` +
        "No row was changed. Reset the schema and reseed.",
    );
  }

  // F9 receipt on P1 (finalizer-equivalent: one receipt per paid payment).
  if (!(await prisma.receipt.findFirst({ where: { paymentId: p1.id } }))) {
    await prisma.receipt.create({ data: { paymentId: p1.id } });
  }

  console.log("Phase 3 financial fixtures complete (F1-F9).");
}
