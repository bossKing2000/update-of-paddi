import { z } from "zod";

export const riderBankDetailsSchema = z.object({
  bankName: z.string().trim().min(1).max(120),
  bankCode: z.string().trim().min(1).max(30),
  accountNumber: z.string().regex(/^\d{10}$/, "Nigerian account numbers must contain exactly 10 digits"),
});

export const riderWithdrawalSchema = z.object({
  amount: z.number().finite().positive().min(100, "Minimum withdrawal is ₦100"),
  idempotencyKey: z.string().trim().min(8).max(160),
});

export const riderVehicleSchema = z.object({
  vehicleType: z.string().trim().min(2).max(60),
  licensePlate: z.string().trim().min(3).max(30).transform((value) => value.toUpperCase()),
  make: z.string().trim().max(80).optional().nullable(),
  model: z.string().trim().max(80).optional().nullable(),
  color: z.string().trim().max(60).optional().nullable(),
  documentUrl: z.string().url().max(1000).optional().nullable(),
});

export const riderVehicleReviewSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "SUSPENDED"]),
  reviewNote: z.string().trim().max(1000).optional().nullable(),
});

export const riderProofSchema = z.object({
  recipientName: z.string().trim().max(140).optional().nullable(),
  note: z.string().trim().max(1000).optional().nullable(),
});

export const riderProofReviewSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  reviewNote: z.string().trim().max(1000).optional().nullable(),
});

export const riderSupportTicketSchema = z.object({
  category: z.string().trim().min(2).max(80),
  subject: z.string().trim().min(4).max(160),
  description: z.string().trim().min(10).max(4000),
});

export const riderSupportReviewSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]),
});
