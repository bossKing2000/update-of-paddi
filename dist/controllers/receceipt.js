"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getReceipt = void 0;
const prisma_1 = __importDefault(require("../lib/prisma"));
const apiResponse_1 = require("../utils/apiResponse");
const AppError_1 = require("../errors/AppError");
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
const getReceipt = async (req, res) => {
    const paymentId = String(req.params.paymentId);
    const receipt = await prisma_1.default.receipt.findFirst({
        where: { paymentId },
        include: { payment: { select: { userId: true } } },
    });
    if (!receipt)
        throw new AppError_1.NotFoundError("Receipt");
    if (receipt.payment.userId !== req.user.id)
        throw new AppError_1.ForbiddenError("This receipt doesn't belong to you");
    return (0, apiResponse_1.sendSuccess)(res, { paymentId, pdfUrl: receipt.pdfUrl }, "Receipt retrieved successfully");
};
exports.getReceipt = getReceipt;
