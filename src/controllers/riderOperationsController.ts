import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import prisma from "../lib/prisma";
import { AuthRequest } from "../middlewares/auth.middleware";
import { sendCreated, sendSuccess } from "../utils/apiResponse";
import { createAuditLog } from "../utils/auditLog.service";
import {
  createTransferRecipient,
  initiateTransfer,
  listBanks,
  resolveBankAccount,
} from "../services/payoutService";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../errors/AppError";
import {
  riderBankDetailsSchema,
  riderProofReviewSchema,
  riderProofSchema,
  riderSupportReviewSchema,
  riderSupportTicketSchema,
  riderVehicleReviewSchema,
  riderVehicleSchema,
  riderWithdrawalSchema,
} from "../validations/riderOperationsSchema";

const getDriver = async (userId: string) => {
  const driver = await prisma.deliveryPerson.findUnique({
    where: { userId },
    include: {
      user: { select: { id: true, name: true, email: true, kycStatus: true } },
    },
  });
  if (!driver) throw new NotFoundError("Rider profile");
  return driver;
};

const withdrawalDetails = {
  payoutAccount: {
    select: {
      id: true,
      bankName: true,
      bankCode: true,
      accountNumber: true,
      accountName: true,
      verifiedAt: true,
    },
  },
} as const;

export const getRiderStatus = async (req: AuthRequest, res: Response) => {
  const driver = await getDriver(req.user!.id);
  return sendSuccess(
    res,
    {
      id: driver.id,
      isOnline: driver.isOnline,
      status: driver.status,
      latitude: driver.latitude,
      longitude: driver.longitude,
      lastSeenAt: driver.lastSeenAt,
      kycStatus: driver.user.kycStatus,
    },
    "Rider status retrieved",
  );
};

export const getRiderPayoutSummary = async (
  req: AuthRequest,
  res: Response,
) => {
  const driver = await getDriver(req.user!.id);
  const [account, reserved, withdrawals] = await Promise.all([
    prisma.riderPayoutAccount.findUnique({
      where: { deliveryPersonId: driver.id },
      select: {
        id: true,
        bankName: true,
        bankCode: true,
        accountNumber: true,
        accountName: true,
        verifiedAt: true,
      },
    }),
    prisma.riderWithdrawal.aggregate({
      where: {
        deliveryPersonId: driver.id,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      _sum: { amount: true },
    }),
    prisma.riderWithdrawal.findMany({
      where: { deliveryPersonId: driver.id },
      orderBy: { requestedAt: "desc" },
      take: 50,
      include: withdrawalDetails,
    }),
  ]);
  const reservedAmount = reserved._sum.amount ?? 0;
  return sendSuccess(
    res,
    {
      kycStatus: driver.user.kycStatus,
      walletBalance: driver.walletBalance,
      reservedAmount,
      availableToWithdraw: Math.max(
        0,
        Number((driver.walletBalance - reservedAmount).toFixed(2)),
      ),
      bankOnFile: account
        ? {
            ...account,
            accountNumber: `••••••${account.accountNumber.slice(-4)}`,
          }
        : null,
      withdrawals: withdrawals.map(({ payoutAccount, ...withdrawal }) => ({
        ...withdrawal,
        payoutAccount: {
          ...payoutAccount,
          accountNumber: `••••••${payoutAccount.accountNumber.slice(-4)}`,
        },
      })),
    },
    "Rider payout summary retrieved",
  );
};

export const getRiderBankList = async (_req: AuthRequest, res: Response) =>
  sendSuccess(res, { banks: await listBanks() }, "Bank list retrieved");

export const setRiderBankDetails = async (req: AuthRequest, res: Response) => {
  const parsed = riderBankDetailsSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid bank details",
      parsed.error.flatten().fieldErrors,
    );
  const driver = await getDriver(req.user!.id);
  const { bankName, bankCode, accountNumber } = parsed.data;
  const openWithdrawals = await prisma.riderWithdrawal.count({
    where: {
      deliveryPersonId: driver.id,
      status: { in: ["PENDING", "PROCESSING"] },
    },
  });
  if (openWithdrawals > 0)
    throw new ConflictError(
      "Wait for pending withdrawals to settle before changing your payout account",
    );
  const resolved = await resolveBankAccount(accountNumber, bankCode);
  const account = await prisma.riderPayoutAccount.upsert({
    where: { deliveryPersonId: driver.id },
    create: {
      deliveryPersonId: driver.id,
      bankName,
      bankCode,
      accountNumber,
      accountName: resolved.account_name,
      recipientCode: null,
    },
    update: {
      bankName,
      bankCode,
      accountNumber,
      accountName: resolved.account_name,
      recipientCode: null,
      verifiedAt: new Date(),
    },
  });
  await createAuditLog({
    userId: req.user!.id,
    action: "RIDER_BANK_DETAILS_UPDATED",
    req,
    metadata: { bankName, bankCode, payoutAccountId: account.id },
  });
  return sendSuccess(
    res,
    {
      accountName: account.accountName,
      bankName: account.bankName,
      last4: account.accountNumber.slice(-4),
    },
    "Bank details verified and saved",
  );
};

export const requestRiderWithdrawal = async (
  req: AuthRequest,
  res: Response,
) => {
  const parsed = riderWithdrawalSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid withdrawal request",
      parsed.error.flatten().fieldErrors,
    );
  const { amount, idempotencyKey } = parsed.data;
  const withdrawal = await prisma.$transaction(
    async (tx) => {
      const driver = await tx.deliveryPerson.findUnique({
        where: { userId: req.user!.id },
        include: { user: { select: { kycStatus: true } }, payoutAccount: true },
      });
      if (!driver) throw new NotFoundError("Rider profile");
      if (driver.status !== "ACTIVE")
        throw new ForbiddenError(
          "Your rider account is not active for withdrawals",
        );
      if (driver.user.kycStatus !== "VERIFIED")
        throw new ForbiddenError(
          "Complete KYC verification before requesting a withdrawal",
        );
      if (!driver.payoutAccount)
        throw new ValidationError(
          "Save a verified bank account before requesting a withdrawal",
        );
      const existing = await tx.riderWithdrawal.findUnique({
        where: {
          deliveryPersonId_idempotencyKey: {
            deliveryPersonId: driver.id,
            idempotencyKey,
          },
        },
        include: withdrawalDetails,
      });
      if (existing) return existing;
      const reserved = await tx.riderWithdrawal.aggregate({
        where: {
          deliveryPersonId: driver.id,
          status: { in: ["PENDING", "PROCESSING"] },
        },
        _sum: { amount: true },
      });
      const available = Number(
        (driver.walletBalance - (reserved._sum.amount ?? 0)).toFixed(2),
      );
      if (amount > available)
        throw new ValidationError(
          `Requested amount exceeds your available balance of ₦${available.toFixed(2)}`,
        );
      return tx.riderWithdrawal.create({
        data: {
          deliveryPersonId: driver.id,
          payoutAccountId: driver.payoutAccount.id,
          amount,
          balanceSnapshot: driver.walletBalance,
          idempotencyKey,
        },
        include: withdrawalDetails,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  await createAuditLog({
    userId: req.user!.id,
    action: "RIDER_WITHDRAWAL_REQUESTED",
    req,
    metadata: {
      withdrawalId: withdrawal.id,
      amount: withdrawal.amount,
      idempotencyKey,
    },
  });
  return sendCreated(
    res,
    {
      withdrawal: {
        ...withdrawal,
        payoutAccount: {
          ...withdrawal.payoutAccount,
          accountNumber: `••••••${withdrawal.payoutAccount.accountNumber.slice(-4)}`,
        },
      },
    },
    withdrawal.status === "PENDING"
      ? "Withdrawal request created for review"
      : "Existing withdrawal request returned",
  );
};

export const processRiderWithdrawal = async (
  req: AuthRequest,
  res: Response,
) => {
  const withdrawalId = String(req.params.withdrawalId);
  const withdrawal = await prisma.riderWithdrawal.findUnique({
    where: { id: withdrawalId },
    include: {
      payoutAccount: true,
      deliveryPerson: { include: { user: { select: { name: true } } } },
    },
  });
  if (!withdrawal) throw new NotFoundError("Rider withdrawal");
  if (withdrawal.status !== "PENDING")
    throw new ConflictError("Only pending rider withdrawals can be processed");
  const reference = `rider_withdrawal_${withdrawal.id}`;
  const claim = await prisma.riderWithdrawal.updateMany({
    where: { id: withdrawal.id, status: "PENDING" },
    data: { status: "PROCESSING", reference, processedByAdminId: req.user!.id },
  });
  if (claim.count !== 1)
    throw new ConflictError("This withdrawal is already being processed");
  try {
    let recipientCode = withdrawal.payoutAccount.recipientCode;
    if (!recipientCode) {
      recipientCode = await createTransferRecipient({
        name: withdrawal.payoutAccount.accountName,
        accountNumber: withdrawal.payoutAccount.accountNumber,
        bankCode: withdrawal.payoutAccount.bankCode,
      });
      await prisma.riderPayoutAccount.update({
        where: { id: withdrawal.payoutAccountId },
        data: { recipientCode },
      });
    }
    await initiateTransfer({
      amountNaira: withdrawal.amount,
      recipientCode,
      reason: `Paddi rider withdrawal for ${withdrawal.deliveryPerson.user.name}`,
      reference,
    });
    await createAuditLog({
      userId: req.user!.id,
      action: "RIDER_WITHDRAWAL_TRANSFER_INITIATED",
      req,
      metadata: { withdrawalId, reference, amount: withdrawal.amount },
    });
    return sendSuccess(
      res,
      { withdrawalId, reference, status: "PROCESSING" },
      "Transfer initiated; wallet will be debited only after Paystack confirms success",
    );
  } catch (error: any) {
    await prisma.riderWithdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: "FAILED",
        failureReason:
          error?.message?.slice(0, 500) || "Transfer initiation failed",
        processedAt: new Date(),
      },
    });
    throw error;
  }
};

export const submitDeliveryProof = async (req: AuthRequest, res: Response) => {
  const parsed = riderProofSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid delivery proof details",
      parsed.error.flatten().fieldErrors,
    );
  if (!req.file?.path || !req.file.mimetype.startsWith("image/"))
    throw new ValidationError("A proof image is required");
  const assignmentId = String(req.params.assignmentId);
  const driver = await getDriver(req.user!.id);
  const assignment = await prisma.deliveryAssignment.findUnique({
    where: { id: assignmentId },
  });
  if (!assignment || assignment.deliveryPersonId !== driver.id)
    throw new ForbiddenError(
      "You can only submit proof for your own assignment",
    );
  if (!(["PICKED_UP", "EN_ROUTE"] as string[]).includes(assignment.status))
    throw new ConflictError(
      "Proof can only be submitted after pickup and before delivery completion",
    );
  const proof = await prisma.deliveryProof.upsert({
    where: { assignmentId },
    create: {
      assignmentId,
      proofUrl: req.file.path,
      mediaType: req.file.mimetype,
      recipientName: parsed.data.recipientName || null,
      note: parsed.data.note || null,
    },
    update: {
      proofUrl: req.file.path,
      mediaType: req.file.mimetype,
      recipientName: parsed.data.recipientName || null,
      note: parsed.data.note || null,
      status: "SUBMITTED",
      reviewNote: null,
      reviewedAt: null,
      reviewedByAdminId: null,
    },
  });
  await createAuditLog({
    userId: req.user!.id,
    action: "DELIVERY_PROOF_SUBMITTED",
    req,
    metadata: { assignmentId, proofId: proof.id },
  });
  return sendCreated(res, { proof }, "Delivery proof submitted");
};

export const getDeliveryProof = async (req: AuthRequest, res: Response) => {
  const assignmentId = String(req.params.assignmentId);
  const proof = await prisma.deliveryProof.findUnique({
    where: { assignmentId },
    include: {
      assignment: {
        include: {
          order: { select: { customerId: true, vendorId: true } },
          deliveryPerson: { select: { userId: true } },
        },
      },
    },
  });
  if (!proof) throw new NotFoundError("Delivery proof");
  const userId = req.user!.id;
  const involved =
    proof.assignment.deliveryPerson.userId === userId ||
    proof.assignment.order.customerId === userId ||
    proof.assignment.order.vendorId === userId ||
    req.user!.role === "ADMIN";
  if (!involved)
    throw new ForbiddenError("You do not have access to this delivery proof");
  return sendSuccess(res, { proof }, "Delivery proof retrieved");
};

export const reviewDeliveryProof = async (req: AuthRequest, res: Response) => {
  const parsed = riderProofReviewSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid proof review",
      parsed.error.flatten().fieldErrors,
    );
  const proof = await prisma.deliveryProof.findUnique({
    where: { assignmentId: String(req.params.assignmentId) },
  });
  if (!proof) throw new NotFoundError("Delivery proof");
  const updated = await prisma.deliveryProof.update({
    where: { id: proof.id },
    data: {
      status: parsed.data.status,
      reviewNote: parsed.data.reviewNote || null,
      reviewedAt: new Date(),
      reviewedByAdminId: req.user!.id,
    },
  });
  await createAuditLog({
    userId: req.user!.id,
    action: "DELIVERY_PROOF_REVIEWED",
    req,
    metadata: { proofId: proof.id, status: updated.status },
  });
  return sendSuccess(res, { proof: updated }, "Delivery proof reviewed");
};

export const getRiderVehicle = async (req: AuthRequest, res: Response) => {
  const driver = await getDriver(req.user!.id);
  const vehicle = await prisma.riderVehicle.findUnique({
    where: { deliveryPersonId: driver.id },
  });
  return sendSuccess(
    res,
    {
      vehicle,
      legacyVehicle: {
        vehicleType: driver.vehicleType,
        licensePlate: driver.licensePlate,
      },
      kycStatus: driver.user.kycStatus,
    },
    "Rider vehicle retrieved",
  );
};

export const uploadRiderVehicleDocument = async (
  req: AuthRequest,
  res: Response,
) => {
  if (!req.file?.path || !req.file.mimetype.startsWith("image/"))
    throw new ValidationError("A vehicle document image is required");
  const driver = await getDriver(req.user!.id);
  const vehicle = await prisma.riderVehicle.findUnique({
    where: { deliveryPersonId: driver.id },
  });
  if (!vehicle)
    throw new ValidationError(
      "Save your vehicle details before uploading a document",
    );
  const updated = await prisma.riderVehicle.update({
    where: { id: vehicle.id },
    data: {
      documentUrl: req.file.path,
      status: "PENDING",
      reviewNote: null,
      reviewedAt: null,
    },
  });
  await createAuditLog({
    userId: req.user!.id,
    action: "RIDER_VEHICLE_DOCUMENT_UPLOADED",
    req,
    metadata: { vehicleId: vehicle.id },
  });
  return sendSuccess(
    res,
    { vehicle: updated },
    "Vehicle document uploaded and queued for review",
  );
};

export const upsertRiderVehicle = async (req: AuthRequest, res: Response) => {
  const parsed = riderVehicleSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid vehicle details",
      parsed.error.flatten().fieldErrors,
    );
  const driver = await getDriver(req.user!.id);
  const vehicle = await prisma.$transaction(async (tx) => {
    const saved = await tx.riderVehicle.upsert({
      where: { deliveryPersonId: driver.id },
      create: {
        deliveryPersonId: driver.id,
        ...parsed.data,
        status: "PENDING",
        reviewNote: null,
        reviewedAt: null,
      },
      update: {
        ...parsed.data,
        status: "PENDING",
        reviewNote: null,
        reviewedAt: null,
      },
    });
    await tx.deliveryPerson.update({
      where: { id: driver.id },
      data: {
        vehicleType: parsed.data.vehicleType,
        licensePlate: parsed.data.licensePlate,
      },
    });
    return saved;
  });
  await createAuditLog({
    userId: req.user!.id,
    action: "RIDER_VEHICLE_UPSERTED",
    req,
    metadata: { vehicleId: vehicle.id, licensePlate: vehicle.licensePlate },
  });
  return sendSuccess(
    res,
    { vehicle },
    "Vehicle details saved and queued for review",
  );
};

export const reviewRiderVehicle = async (req: AuthRequest, res: Response) => {
  const parsed = riderVehicleReviewSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid vehicle review",
      parsed.error.flatten().fieldErrors,
    );
  const vehicle = await prisma.riderVehicle.findUnique({
    where: { deliveryPersonId: String(req.params.deliveryPersonId) },
  });
  if (!vehicle) throw new NotFoundError("Rider vehicle");
  const updated = await prisma.riderVehicle.update({
    where: { id: vehicle.id },
    data: {
      status: parsed.data.status,
      reviewNote: parsed.data.reviewNote || null,
      reviewedAt: new Date(),
    },
  });
  await createAuditLog({
    userId: req.user!.id,
    action: "RIDER_VEHICLE_REVIEWED",
    req,
    metadata: { vehicleId: vehicle.id, status: updated.status },
  });
  return sendSuccess(res, { vehicle: updated }, "Vehicle review saved");
};

export const createRiderSupportTicket = async (
  req: AuthRequest,
  res: Response,
) => {
  const parsed = riderSupportTicketSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid support ticket",
      parsed.error.flatten().fieldErrors,
    );
  const driver = await getDriver(req.user!.id);
  const ticket = await prisma.riderSupportTicket.create({
    data: { deliveryPersonId: driver.id, ...parsed.data },
  });
  await createAuditLog({
    userId: req.user!.id,
    action: "RIDER_SUPPORT_TICKET_CREATED",
    req,
    metadata: { ticketId: ticket.id, category: ticket.category },
  });
  return sendCreated(res, { ticket }, "Rider support ticket submitted");
};

export const getRiderSupportTickets = async (
  req: AuthRequest,
  res: Response,
) => {
  const driver = await getDriver(req.user!.id);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const [tickets, total] = await Promise.all([
    prisma.riderSupportTicket.findMany({
      where: { deliveryPersonId: driver.id },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.riderSupportTicket.count({ where: { deliveryPersonId: driver.id } }),
  ]);
  const totalPages = Math.ceil(total / limit);
  return sendSuccess(res, { tickets }, "Rider support tickets retrieved", 200, {
    total,
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  });
};

export const getAdminRiderWithdrawals = async (
  req: AuthRequest,
  res: Response,
) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const status = req.query.status as string | undefined;
  const where = status ? { status: status as any } : {};
  const [withdrawals, total] = await Promise.all([
    prisma.riderWithdrawal.findMany({
      where,
      orderBy: { requestedAt: "asc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        ...withdrawalDetails,
        deliveryPerson: {
          include: {
            user: {
              select: { id: true, name: true, email: true, kycStatus: true },
            },
          },
        },
      },
    }),
    prisma.riderWithdrawal.count({ where }),
  ]);
  const totalPages = Math.ceil(total / limit);
  return sendSuccess(
    res,
    { withdrawals },
    "Rider withdrawal queue retrieved",
    200,
    {
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  );
};

export const reviewRiderSupportTicket = async (
  req: AuthRequest,
  res: Response,
) => {
  const parsed = riderSupportReviewSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError(
      "Invalid support-ticket review",
      parsed.error.flatten().fieldErrors,
    );
  const ticket = await prisma.riderSupportTicket.findUnique({
    where: { id: String(req.params.ticketId) },
  });
  if (!ticket) throw new NotFoundError("Rider support ticket");
  const updated = await prisma.riderSupportTicket.update({
    where: { id: ticket.id },
    data: { status: parsed.data.status },
  });
  await createAuditLog({
    userId: req.user!.id,
    action: "RIDER_SUPPORT_TICKET_REVIEWED",
    req,
    metadata: { ticketId: ticket.id, status: updated.status },
  });
  return sendSuccess(res, { ticket: updated }, "Rider support ticket reviewed");
};
