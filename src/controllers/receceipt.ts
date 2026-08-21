import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import prisma from "../lib/prisma";
import { sendSuccess } from "../utils/apiResponse";
import { NotFoundError, ForbiddenError } from "../errors/AppError";

/**
 * Returns the public receipt URL for a payment.
 * PDF files are served statically from /receipts.
 *
 * Previously this route had no authentication at all, and even if it had,
 * this function never checked that the requester actually owned the
 * payment — anyone who learned/guessed a paymentId could pull up someone
 * else's receipt (order contents, amount paid). Fixed: route now requires
 * auth, and this checks ownership via the payment relation.
 */
export const getReceipt = async (req: AuthRequest, res: Response) => {
  const paymentId = String(req.params.paymentId);

  const receipt = await prisma.receipt.findFirst({
    where: { paymentId },
    include: { payment: { select: { userId: true } } },
  });

  if (!receipt) throw new NotFoundError("Receipt");
  if (receipt.payment.userId !== req.user!.id) throw new ForbiddenError("This receipt doesn't belong to you");

  return sendSuccess(res, { paymentId, pdfUrl: receipt.pdfUrl }, "Receipt retrieved successfully");
};
