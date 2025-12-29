import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import prisma from "../lib/prisma";

/**
 * Returns the public receipt URL for a payment.
 * PDF files are already served statically from /receipts.
 */
export const getReceipt = async (req: AuthRequest, res: Response) => {
  const paymentId = String(req.params.paymentId);

  const receipt = await prisma.receipt.findFirst({
    where: { paymentId },
  });

  if (!receipt) {
    return res.status(404).json({ error: "Receipt not found" });
  }

  return res.json({
    success: true,
    message: "Receipt retrieved successfully",
    receipt: {
      paymentId,
      pdfUrl: receipt.pdfUrl, // ✅ Directly viewable/downloadable link
    },
  });
};
