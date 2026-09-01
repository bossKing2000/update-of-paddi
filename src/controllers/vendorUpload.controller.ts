// src/controllers/vendorUpload.controller.ts
import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import { sendSuccess } from "../utils/apiResponse";
import { ValidationError } from "../errors/AppError";

export const uploadVendorLogo = async (req: AuthRequest, res: Response) => {
  // Auth is handled by middleware - req.user exists and is VENDOR
  if (!req.file) {
    throw new ValidationError("Logo image is required");
  }

  // multer with CloudinaryStorage has already uploaded the file
  // The file path is the Cloudinary URL
  const logoUrl = req.file.path;

  return sendSuccess(res, { url: logoUrl }, "Vendor logo uploaded successfully");
};