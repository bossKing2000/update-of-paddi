import { z } from "zod";

// 🟢 Schema for scheduling Go Live + Take Down
export const goLiveSchema = z.object({
  goLiveAt: z.string().datetime("Invalid goLiveAt date format."), // <── Missing field fixed
  takeDownAt: z.string().datetime("Invalid takeDownAt date format."),
  graceMinutes: z.number().min(0).max(300).optional(),
});

// ⏰ Schema for extending grace period
export const extendGraceSchema = z.object({
  extraMinutes: z.number().min(1, "extraMinutes must be at least 1."),
});
