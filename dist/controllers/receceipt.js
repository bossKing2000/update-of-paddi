"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getReceipt = void 0;
const prisma_1 = __importDefault(require("../lib/prisma"));
/**
 * Returns the public receipt URL for a payment.
 * PDF files are already served statically from /receipts.
 */
const getReceipt = async (req, res) => {
    const paymentId = String(req.params.paymentId);
    const receipt = await prisma_1.default.receipt.findFirst({
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
exports.getReceipt = getReceipt;
