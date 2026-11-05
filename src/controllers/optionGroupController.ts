import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import { sendSuccess, sendCreated } from "../utils/apiResponse";
import { ValidationError } from "../errors/AppError";
import { ensureString } from "../utils/paramUtils";
import {
  createOptionGroupSchema,
  updateOptionGroupSchema,
  createOptionGroupItemSchema,
  updateOptionGroupItemSchema,
} from "../validations/ProductCRUDSchema";
import * as optionGroups from "../services/optionGroup.service";

// Phase 2B.3 vendor management for structured add-ons. Routes already
// enforce authenticate + authorizeVendor + requireVendorNotSuspended;
// every handler additionally establishes product ownership in the
// service layer (never trusts ids alone).

function vendorOf(req: AuthRequest): string {
  if (!req.user?.id) throw new ValidationError("Not authenticated");
  return req.user.id;
}

// POST /api/product/:productId/option-groups
export const createProductOptionGroup = async (req: AuthRequest, res: Response) => {
  const productId = ensureString(req.params.productId);
  const parsed = createOptionGroupSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
  const group = await optionGroups.createOptionGroup(vendorOf(req), productId, parsed.data);
  return sendCreated(res, { group }, "Option group created successfully.");
};

// GET /api/product/:productId/option-groups
export const listProductOptionGroups = async (req: AuthRequest, res: Response) => {
  const productId = ensureString(req.params.productId);
  const groups = await optionGroups.listOptionGroups(vendorOf(req), productId);
  return sendSuccess(res, { groups }, "Option groups fetched successfully.");
};

// PATCH /api/product/option-groups/:groupId
export const updateProductOptionGroup = async (req: AuthRequest, res: Response) => {
  const groupId = ensureString(req.params.groupId);
  const parsed = updateOptionGroupSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
  const group = await optionGroups.updateOptionGroup(vendorOf(req), groupId, parsed.data);
  return sendSuccess(res, { group }, "Option group updated successfully.");
};

// DELETE /api/product/option-groups/:groupId
export const deleteProductOptionGroup = async (req: AuthRequest, res: Response) => {
  const groupId = ensureString(req.params.groupId);
  const result = await optionGroups.deleteOptionGroup(vendorOf(req), groupId);
  return sendSuccess(res, result, "Option group deleted successfully.");
};

// POST /api/product/option-groups/:groupId/items
export const createProductOptionGroupItem = async (req: AuthRequest, res: Response) => {
  const groupId = ensureString(req.params.groupId);
  const parsed = createOptionGroupItemSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
  const item = await optionGroups.createOptionGroupItem(vendorOf(req), groupId, parsed.data);
  return sendCreated(res, { item }, "Option group item created successfully.");
};

// PATCH /api/product/option-items/:itemId
export const updateProductOptionGroupItem = async (req: AuthRequest, res: Response) => {
  const itemId = ensureString(req.params.itemId);
  const parsed = updateOptionGroupItemSchema.safeParse(req.body);
  if (!parsed.success)
    throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
  const item = await optionGroups.updateOptionGroupItem(vendorOf(req), itemId, parsed.data);
  return sendSuccess(res, { item }, "Option group item updated successfully.");
};

// DELETE /api/product/option-items/:itemId
export const deleteProductOptionGroupItem = async (req: AuthRequest, res: Response) => {
  const itemId = ensureString(req.params.itemId);
  const result = await optionGroups.deleteOptionGroupItem(vendorOf(req), itemId);
  return sendSuccess(res, result, "Option group item deleted successfully.");
};
