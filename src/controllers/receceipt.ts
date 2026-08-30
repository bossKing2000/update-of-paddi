import { Response } from "express";
import fs from "fs";
import path from "path";
import { AuthRequest } from "../middlewares/auth.middleware";
import prisma from "../lib/prisma";
import { sendSuccess } from "../utils/apiResponse";
import { NotFoundError, ForbiddenError } from "../errors/AppError";

export const getReceipt = async (req: AuthRequest, res: Response) => {
  const paymentId = String(req.params.paymentId);

  const receipt = await prisma.receipt.findFirst({
    where: { paymentId },
    include: { payment: { select: { userId: true, reference: true } } },
  });

  if (!receipt) throw new NotFoundError("Receipt");
  if (receipt.payment.userId !== req.user!.id) throw new ForbiddenError("This receipt doesn't belong to you");

  // If client requests stream (Accept: application/pdf or ?download=1), stream file with auth
  const wantsStream = req.query.stream === "1" || req.headers.accept?.includes("application/pdf");
  if (wantsStream && receipt.pdfUrl) {
    const fileName = `receipt_${receipt.payment.reference}.pdf`;
    const filePath = path.join(process.cwd(), "receipts", fileName);
    if (fs.existsSync(filePath)) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.sendFile(path.resolve(filePath));
    }
  }

  // Default: return JSON with authenticated pdfUrl (no longer publicly enumerable via /receipts static)
  return sendSuccess(res, { paymentId, pdfUrl: receipt.pdfUrl }, "Receipt retrieved successfully");
};
