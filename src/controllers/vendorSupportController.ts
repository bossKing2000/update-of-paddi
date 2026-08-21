import { Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { AuthRequest } from "../middlewares/auth.middleware";
import { ForbiddenError, ValidationError } from "../errors/AppError";
import { sendCreated, sendSuccess } from "../utils/apiResponse";

const createSupportTicketSchema = z.object({
  category: z.enum(["ACCOUNT", "ORDER", "PAYOUT", "MENU", "TECHNICAL", "OTHER"]),
  subject: z.string().trim().min(4).max(120),
  description: z.string().trim().min(12).max(2_000),
});

export const createVendorSupportTicket = async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== "VENDOR") throw new ForbiddenError("Only vendors can submit support tickets");
  const parsed = createSupportTicketSchema.safeParse(req.body);
  if (!parsed.success) throw new ValidationError("Invalid support ticket", parsed.error.flatten().fieldErrors);

  const ticket = await prisma.vendorSupportTicket.create({
    data: { vendorId: req.user.id, ...parsed.data },
  });
  return sendCreated(res, { ticket }, "Support ticket submitted");
};

export const getVendorSupportTickets = async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== "VENDOR") throw new ForbiddenError("Only vendors can view support tickets");
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const skip = (page - 1) * limit;
  const [tickets, total] = await Promise.all([
    prisma.vendorSupportTicket.findMany({
      where: { vendorId: req.user.id },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.vendorSupportTicket.count({ where: { vendorId: req.user.id } }),
  ]);

  return sendSuccess(res, {
    tickets,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }, "Support tickets retrieved");
};
