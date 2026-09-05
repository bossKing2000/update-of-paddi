import { Response } from "express";
import { AuthRequest } from "../middlewares/auth.middleware";
import { sendSuccess } from "../utils/apiResponse";
import {
  getPotPointsBalance,
  getPotPointsHistory,
} from "../services/potPoints.service";

// GET /api/rewards/pot-points
// Real Pot Points balance + recent ledger history for the authenticated
// user. Read-only: nothing here accepts client-submitted point values.
export const getMyPotPoints = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const [balance, history] = await Promise.all([
    getPotPointsBalance(userId),
    getPotPointsHistory(userId),
  ]);
  return sendSuccess(res, { balance, history }, "Pot Points retrieved");
};
