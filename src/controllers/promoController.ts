import { Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { AuthRequest } from "../middlewares/auth.middleware";
import { DiscountType } from "@prisma/client";
import { sendSuccess, sendCreated } from "../utils/apiResponse";
import { NotFoundError, ForbiddenError, ValidationError } from "../errors/AppError";
import { ensureString } from "../utils/paramUtils";
import { getActivePromotionsForCustomer } from "../services/promoService";

const createPromoSchema = z.object({
  code: z.string().min(3).max(20).regex(/^[A-Za-z0-9]+$/, "Code must be alphanumeric"),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  type: z.nativeEnum(DiscountType),
  value: z.number().positive(),
  maxDiscount: z.number().positive().optional(),
  startsAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
  usageLimit: z.number().int().positive().optional(),
  maxUsesPerUser: z.number().int().positive().default(1),
  minOrderAmount: z.number().min(0).default(0),
});

const updatePromoSchema = createPromoSchema.partial();

const validatePromoDatesAndValue = (data: { type?: DiscountType; value?: number; startsAt?: Date; expiresAt?: Date }) => {
  if (data.type === DiscountType.PERCENTAGE && (data.value ?? 0) > 100) {
    throw new ValidationError("Percentage discount can't exceed 100");
  }
  if (data.startsAt && data.expiresAt && data.startsAt >= data.expiresAt) {
    throw new ValidationError("expiresAt must be after startsAt");
  }
};

// POST /promotions — vendor creates a promo scoped to their own store
export const createPromo = async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== "VENDOR") throw new ForbiddenError("Only vendors can create promotions");

  const parsed = createPromoSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError("Invalid promotion", parsed.error.flatten().fieldErrors);
  const data = parsed.data;

  validatePromoDatesAndValue(data);

  const code = data.code.toUpperCase();
  const existing = await prisma.promotion.findUnique({ where: { vendorId_code: { vendorId: req.user.id, code } } });
  if (existing) throw new ValidationError("You already have a promotion with this code");

  const promo = await prisma.promotion.create({ data: { ...data, code, vendorId: req.user.id } });
  return sendCreated(res, { promo }, "Promotion created");
};

// GET /promotions/mine
export const getMyPromos = async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== "VENDOR") throw new ForbiddenError("Only vendors can view their promotions");

  const promos = await prisma.promotion.findMany({ where: { vendorId: req.user.id }, orderBy: { createdAt: "desc" } });
  return sendSuccess(res, { promos }, "Your promotions retrieved");
};

// PATCH /promotions/:id/deactivate
export const deactivatePromo = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const promo = await prisma.promotion.findUnique({ where: { id } });
  if (!promo || promo.vendorId !== req.user!.id) throw new NotFoundError("Promotion");

  const updated = await prisma.promotion.update({ where: { id }, data: { isActive: false } });
  return sendSuccess(res, { promo: updated }, "Promotion deactivated");
};

// PATCH /promotions/:id — vendor edits their own promotion.
export const updatePromo = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const promo = await prisma.promotion.findUnique({ where: { id } });
  if (!promo || promo.vendorId !== req.user!.id) throw new NotFoundError("Promotion");

  const parsed = updatePromoSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError("Invalid promotion", parsed.error.flatten().fieldErrors);
  if (Object.keys(parsed.data).length === 0) throw new ValidationError("Provide at least one field to update");

  const data = { ...parsed.data } as typeof parsed.data & { code?: string };
  if (data.code) {
    data.code = data.code.toUpperCase();
    const duplicate = await prisma.promotion.findUnique({ where: { vendorId_code: { vendorId: req.user!.id, code: data.code } } });
    if (duplicate && duplicate.id !== id) throw new ValidationError("You already have a promotion with this code");
  }
  validatePromoDatesAndValue({
    type: data.type ?? promo.type,
    value: data.value ?? Number(promo.value),
    startsAt: data.startsAt ?? promo.startsAt ?? undefined,
    expiresAt: data.expiresAt ?? promo.expiresAt ?? undefined,
  });

  const updated = await prisma.promotion.update({ where: { id }, data });
  return sendSuccess(res, { promo: updated }, "Promotion updated");
};

// PATCH /promotions/:id/reactivate — vendor re-enables a non-expired promotion.
export const reactivatePromo = async (req: AuthRequest, res: Response) => {
  const id = ensureString(req.params.id);
  const promo = await prisma.promotion.findUnique({ where: { id } });
  if (!promo || promo.vendorId !== req.user!.id) throw new NotFoundError("Promotion");
  if (promo.expiresAt && promo.expiresAt < new Date()) throw new ValidationError("Expired promotions cannot be reactivated; create a new promotion instead");
  const updated = await prisma.promotion.update({ where: { id }, data: { isActive: true } });
  return sendSuccess(res, { promo: updated }, "Promotion reactivated");
};

// GET /customer/promotions/active — customer-facing browse. Previously
// there was no way for a customer to discover a promo without already
// knowing its code; every existing route in this file is vendor-only
// (self-management of promos a vendor created). The eligibility checks
// (active, within its date window, not exhausted) live in
// promoService.getActivePromotionsForCustomer, shared with GET /api/home/feed.
export const getActivePromotions = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const promotions = await getActivePromotionsForCustomer(userId);

  return sendSuccess(res, { promotions }, "Active promotions retrieved");
};
