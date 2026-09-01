import express, { Request, Response } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import http from "http";
import { PrismaClient } from "@prisma/client";

import config from "./config/config";
import { ensureRedisReady, redisProducts } from "./lib/redis";
import { setupSearch } from "./lib/setupSearch";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware";
import { requestIdMiddleware } from "./middlewares/requestId.middleware";
import { authenticate, authorizeAdmin } from "./middlewares/auth.middleware";
import pino from "pino";
import morgan from "morgan";
import chalk from "chalk";
import { logger } from "./lib/logger";
import pinoHttp from "pino-http";
import swaggerUi from "swagger-ui-express";
import { openApiDocument } from "./docs/openapi";
// import { webhookHandler } from './controllers/paymentController';
import { initSocket } from "./socket";

import authRoutes from "./routes/auth.routes";
import productRoutes from "./routes/productRoutes";
import reviewRoutes from "./routes/reviewRoutes";
import orderRouter from "./routes/orderRouter";
import notificationRouter from "./routes/notificationRouter";
import paymentRouter from "./routes/paymentRoute";
import cartRouter from "./routes/cartRouter";
import deliveryRouter from "./routes/deliveryRouter";
import productScheduleRoutes from "./routes/productScheduleRoutes";
import vendorFollowRoutes from "./routes/vendorFollowRoutes";
import seederRoutes from "./routes/seeder.routes";

// ------------------------------
// Cron / In-memory Jobs
// ------------------------------
import {
  updatePopularityScores,
  cancelPopularityJob,
  resetPopularityJob,
} from "./jobs/workers jobs/updatePopularityScore";
import { startKeepAlive } from "./jobs/workers jobs/keepAlive";
import "./jobs/node-cron/runJob"; // ✅ Automatically starts cron jobs

// ✅ Auto-start BullMQ workers
// ------------------------------
// BullMQ Workers (auto-start)
// ------------------------------
import "./jobs/workers jobs/productDeactivateJob";
import "./jobs/workers jobs/vendorFollowWorker";
import "./jobs/workers jobs/productLiveWorker";
import vendorDashboardRoutes from "./routes/vendorDashboard.routes";
import vendorSettingsRoutes from "./routes/vendorSettings.routes";
import vendorSupportRoutes from "./routes/vendorSupport.routes";
import vendorUploadRoutes from "./routes/vendorUpload.routes";
import aiRouter from "./routes/aiRouter";
import adminRoutes from "./routes/admin.routes";
import promoRoutes from "./routes/promoRoutes";
import customerPromotionsRoutes from "./routes/customerPromotions.routes";
import homeFeedRoutes from "./routes/homeFeed.routes";
import referralRoutes from "./routes/referralRoutes";
import {
  riderOperationsAdminRoutes,
  riderOperationsRoutes,
  riderProofReadRoutes,
} from "./routes/riderOperations.routes";
import { ProductImageService } from "./jobs/sripts/backfillThumbnails";
import { fixLiveStatusJob } from "./jobs/workers jobs/fixLiveStatusJob";
import { paystackWebhookHandler } from "./controllers/webhook";

dotenv.config();

const prisma = new PrismaClient();
const app = express();

// ✅ Job flags for in-memory jobs
let jobRunning = false; // only for popularity job

// ------------------------------
// Middleware & setup
// ------------------------------

// Paystack Webhook — must come BEFORE express.json()
// app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookHandler);
app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  paystackWebhookHandler,
);
// Ensure uploads folder exists
const uploadDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Request ID first — every subsequent log line (including the HTTP access
// log below) is tagged with it, so a single request is traceable end to end.
app.use(requestIdMiddleware);

// HTTP access logging: human-readable + colored in development (morgan+chalk style),
// structured JSON in production (pino-http for Render log aggregators).
if (config.isProduction) {
  // Production: concise JSON, no headers/query/remotePort spam
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as any).id,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
      autoLogging: {
        ignore: (req) =>
          req.url === "/healthz" ||
          req.url === "/readyz" ||
          req.url === "/favicon.ico" ||
          req.url.startsWith("/favicon.ico"),
      },
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
        err: pino.stdSerializers.err,
      },
    }),
  );
} else {
  // Development: Morgan + Chalk — e.g. 🟢 GET  /api/product/       200   120ms
  // Restores previous morgan style but via same method/status colors described in spec.
  const devFormat = (tokens: any, req: any, res: any) => {
    const method = tokens.method(req, res);
    const url = tokens.url(req, res);
    const status = Number(tokens.status(req, res) || 0);
    const time = tokens["response-time"](req, res);

    let emoji = "🟢";
    let statusColor: any = chalk.green;
    if (status >= 500) {
      statusColor = chalk.red;
      emoji = "🔴";
    } else if (status >= 400) {
      statusColor = chalk.yellow;
      emoji = "🔴";
    } else if (status >= 300) {
      statusColor = chalk.cyan;
      emoji = "🟡";
    }

    let methodColor: any = chalk.white;
    if (method === "GET") methodColor = chalk.green;
    else if (method === "POST") methodColor = chalk.yellow;
    else if (method === "PUT" || method === "PATCH") methodColor = chalk.blue;
    else if (method === "DELETE") methodColor = chalk.red;

    // Keep method 6 chars, url 30, status 3, time ~6 — no headers/query noise
    const m = methodColor(method.padEnd(6));
    const u = url.padEnd(30);
    const s = statusColor(String(status).padStart(3));
    const t = chalk.gray(`${time}ms`.padStart(7));
    return `${emoji} ${m} ${u} ${s}  ${t}`;
  };

  app.use(
    morgan(devFormat, {
      skip: (req: any) =>
        req.url === "/healthz" ||
        req.url === "/readyz" ||
        req.url === "/favicon.ico" ||
        req.url.startsWith("/favicon.ico"),
    }),
  );
}

app.use(helmet());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || config.allowedOrigins.includes(origin))
        callback(null, true);
      else callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use(cookieParser());
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use("/uploads", express.static("uploads"));
app.use("/favicon.ico", express.static("public/favicon.ico"));
// /receipts static mount removed — receipts now served via authenticated GET /api/payments/receipt/:paymentId streaming with ownership check

// Routes
// API docs — on by default in dev, opt-in in production via ENABLE_API_DOCS=true
// (a payments/KYC backend's docs shouldn't be publicly browsable by default).
if (!config.isProduction || process.env.ENABLE_API_DOCS === "true") {
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
}

app.use("/api/auth", authRoutes);
app.use("/api/product", productRoutes);
app.use("/api/review", reviewRoutes);
app.use("/api/order", orderRouter);
app.use("/api/notifications", notificationRouter);
app.use("/api/cart", cartRouter);
app.use("/api/payments", paymentRouter);
app.use("/api/delivery", deliveryRouter);
app.use("/api/delivery", riderProofReadRoutes);
app.use("/api/product", productScheduleRoutes);
app.use("/api/vendor-follow", vendorFollowRoutes);
app.use("/api/seeder", seederRoutes);
app.use("/api/vendor", vendorDashboardRoutes);
app.use("/api/vendor/settings", vendorSettingsRoutes);
app.use("/api/vendor/support", vendorSupportRoutes);
app.use("/api/vendor/upload", vendorUploadRoutes);
app.use("/api/ai", aiRouter);
app.use("/api/admin", adminRoutes);
app.use("/api/promotions", promoRoutes);
app.use("/api/promotions", customerPromotionsRoutes);
app.use("/api/home", homeFeedRoutes);
app.use("/api/referrals", referralRoutes);
app.use("/api/rider", riderOperationsRoutes);
app.use("/api/admin/rider", riderOperationsAdminRoutes);

// Root & health endpoints
app.get("/", (_req: Request, res: Response) =>
  res.send("🚀 Food Paddi Backend API is running"),
);

// Liveness: "is the process up" — always fast, no downstream checks.
// Use for platform health checks that just need a quick 200.
app.get("/healthz", (_req: Request, res: Response) =>
  res.status(200).send("OK"),
);

// Readiness: "can this instance actually serve traffic" — checks the
// database and cache it depends on. Use this for load-balancer routing
// decisions or pre-deploy smoke tests.
app.get("/readyz", async (_req: Request, res: Response) => {
  const checks: Record<string, boolean> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch {
    checks.database = false;
  }

  try {
    await redisProducts.ping();
    checks.redis = true;
  } catch {
    checks.redis = false;
  }

  const healthy = Object.values(checks).every(Boolean);
  res
    .status(healthy ? 200 : 503)
    .json({ status: healthy ? "ok" : "degraded", checks });
});

// Disable cache for job control endpoints
app.use(
  [
    "/popularity-progress",
    "/run-popularity-job",
    "/cancel-popularity-job",
    "/reset-popularity-job",
  ],
  (req, res, next) => {
    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    next();
  },
);

// ▶ Start/Resume job
// Popularity job endpoints — ADMIN ONLY.
// These were previously mounted with no auth at all: any anonymous caller
// on the internet could trigger, cancel, or reset this job. Locked down now.
app.get(
  "/run-popularity-job",
  // authenticate,
  // authorizeAdmin,
  async (_req, res) => {
    if (jobRunning) return res.json({ message: "Job is already running" });

    jobRunning = true;
    console.log("🚀 Popularity job started");

    updatePopularityScores()
      .catch((err) => console.error("❌ Popularity job failed:", err))
      .finally(() => {
        jobRunning = false;
        console.log("✅ Popularity job finished");
      });

    res.json({ message: "Popularity job started" });
  },
);

// ▶ Progress endpoint
app.get(
  "/popularity-progress",
  authenticate,
  authorizeAdmin,
  async (_req, res) => {
    try {
      const data = await redisProducts.get("job:popularity:progress");
      if (!data) return res.json({ total: 0, processed: 0, percent: 0 });
      res.json(JSON.parse(data));
    } catch (err: any) {
      console.error("Failed to get progress:", err);
      res.status(500).json({ error: "Failed to get progress" });
    }
  },
);

// ▶ Cancel job
app.get("/cancel-popularity-job", authenticate, authorizeAdmin, (_req, res) => {
  if (!jobRunning) return res.json({ message: "No job is running" });

  cancelPopularityJob();
  res.json({ message: "Cancellation requested" });
});

// ▶ Reset job
app.get(
  "/reset-popularity-job",
  authenticate,
  authorizeAdmin,
  async (_req, res) => {
    try {
      const result = await resetPopularityJob();
      jobRunning = false;
      console.log("♻️ Popularity job has been reset");
      res.json(result);
    } catch (err: any) {
      console.error("Error resetting job:", err);
      res.status(500).json({ message: "Failed to reset popularity job" });
    }
  },
);

// Error handler
// Unmatched routes -> 404
app.use(notFoundHandler);

// Central error handler — must be last
app.use(errorHandler);

// ------------------------------
// Start server
// ------------------------------
// const startServer = async () => {
//   try {
//     await ensureRedisReady();
//     console.log('✅ Redis connected');

//     await prisma.$connect();
//     console.log('✅ PostgreSQL connected');

//     try {
//       await setupSearch();
//       console.log('✅ Search setup completed');
//     } catch (err) {
//       console.error('⚠️ Search setup failed:', err);
//     }

//     console.log(`🌐 SERVER_URL: ${process.env.SERVER_URL}`);

//     const server = http.createServer(app);
//     initSocket(server);

//     server.listen(5000, "0.0.0.0", () => {
//       console.log(`🚀 Server running at http://localhost:${config.port}`);

//       // Start cron / in-memory jobs
//       startKeepAliveJob();

//     });

//   } catch (error) {
//     console.error('❌ Failed to start server:', error);
//     process.exit(1);
//   }
// };

/**
 * Runs the non-critical startup maintenance tasks (search index setup,
 * thumbnail backfill, product live-status fix) in the background, after
 * the server is already listening. None of these should ever delay port
 * binding — a slow backfill previously ran *before* server.listen(),
 * which risks failing a platform's deploy health check on a large catalog.
 */
async function runBackgroundStartupTasks() {
  try {
    await setupSearch();
    logger.info("Search setup completed");
  } catch (err) {
    logger.error({ err }, "Search setup failed (non-critical)");
  }

  try {
    logger.info("Running thumbnail backfill...");
    const initialHealth = await ProductImageService.healthCheck();
    logger.info(
      {
        percentage: initialHealth.percentage,
        healthy: initialHealth.healthy,
        total: initialHealth.total,
      },
      "Initial thumbnail health",
    );

    if (initialHealth.missing > 0) {
      const productsWithoutThumbnails = await prisma.product.findMany({
        where: {
          OR: [{ thumbnail: null }, { thumbnail: "" }],
          images: { isEmpty: false },
        },
        select: { id: true },
        take: 2000,
      });

      const batchSize = 100;
      const productIds = productsWithoutThumbnails.map((p) => p.id);
      let processedCount = 0;

      for (let i = 0; i < productIds.length; i += batchSize) {
        const batch = productIds.slice(i, i + batchSize);
        try {
          await ProductImageService.batchEnsureThumbnails(batch);
          processedCount += batch.length;
        } catch (batchError) {
          logger.warn(
            { err: batchError, batchIndex: i / batchSize },
            "Thumbnail batch failed, continuing",
          );
        }
      }

      logger.info({ processedCount }, "Thumbnail backfill complete");
    } else {
      logger.info("All products already have thumbnails");
    }
  } catch (error) {
    logger.warn(
      { err: error },
      "Thumbnail backfill encountered an error (non-critical)",
    );
  }

  fixLiveStatusJob(true)
    .then(() => logger.info("Background product status check completed"))
    .catch((err) =>
      logger.error(
        { err },
        "Background product status check failed (non-critical)",
      ),
    );
}

const startServer = async () => {
  try {
    await ensureRedisReady();
    logger.info("Redis connected");

    await prisma.$connect();
    logger.info("PostgreSQL connected");

    logger.info({ serverUrl: config.serverUrl }, "Starting server");

    const server = http.createServer(app);
    initSocket(server);

    server.listen(config.port, "0.0.0.0", () => {
      logger.info({ port: config.port }, "Server running");

      // Delay cron job start slightly to let server stabilize
      startKeepAlive();

      // Fire-and-forget background maintenance — never blocks the port
      // from being bound, which is what health checks actually wait on.
      void runBackgroundStartupTasks();
    });

    // Graceful shutdown — important on platforms (Render/Railway/K8s) that
    // send SIGTERM before killing the process on redeploy/scale-down, so
    // in-flight requests get to finish instead of being dropped.
    const shutdown = (signal: string) => {
      logger.info(
        { signal },
        "Shutdown signal received, closing server gracefully",
      );
      server.close(async () => {
        try {
          await prisma.$disconnect();
          logger.info("Shutdown complete");
          process.exit(0);
        } catch (err) {
          logger.error({ err }, "Error during shutdown");
          process.exit(1);
        }
      });
      // Force-exit if graceful shutdown hangs
      setTimeout(() => process.exit(1), 10_000).unref();
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    logger.error({ err: error }, "Failed to start server");
    process.exit(1);
  }
};

startServer();
