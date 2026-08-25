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
import { logger } from "./lib/logger";
import pinoHttp from "pino-http";
import swaggerUi from "swagger-ui-express";
import { openApiDocument } from "./docs/openapi";
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
import "./jobs/node-cron/runJob";

// ------------------------------
// BullMQ Workers
// ------------------------------
import "./jobs/workers jobs/productDeactivateJob";
import "./jobs/workers jobs/vendorFollowWorker";
import "./jobs/workers jobs/productLiveWorker";

import vendorDashboardRoutes from "./routes/vendorDashboard.routes";
import vendorSettingsRoutes from "./routes/vendorSettings.routes";
import vendorSupportRoutes from "./routes/vendorSupport.routes";
import aiRouter from "./routes/aiRouter";
import adminRoutes from "./routes/admin.routes";
import promoRoutes from "./routes/promoRoutes";
import referralRoutes from "./routes/referralRoutes";

import {
  riderOperationsAdminRoutes,
  riderOperationsRoutes,
  riderProofReadRoutes,
} from "./routes/riderOperations.routes";

import { ProductImageService } from "./jobs/sripts/backfillThumbnails";
import { fixLiveStatusJob } from "./jobs/workers jobs/fixLiveStatusJob";
import { paystackWebhookHandler } from "./controllers/webhook";

// ------------------------------
// Environment
// ------------------------------
dotenv.config();

// ------------------------------
// App / Database
// ------------------------------
const prisma = new PrismaClient();
const app = express();

// ------------------------------
// Job flags
// ------------------------------
let jobRunning = false;

// ============================================================
// SECURITY / MIDDLEWARE
// ============================================================

// Helmet — only register once
app.use(helmet());

// ============================================================
// PAYSTACK WEBHOOK
// ============================================================
//
// IMPORTANT:
// This must come BEFORE express.json() because Paystack needs
// the raw request body for webhook signature verification.
//

app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  paystackWebhookHandler,
);

// ============================================================
// CORS
// ============================================================
const productionOrigins = [
  config.clientUrl,
  "https://ui-food-paddi.onrender.com",
  "https://ceeb2aee.food-paddi-website.pages.dev",
  "https://food-paddi-admin.onrender.com",
].filter((origin): origin is string => Boolean(origin));

const developmentOrigins = [
  "http://127.0.0.1:60308",
  "http://127.0.0.1:8080",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://localhost:5173",
  "http://localhost:5174",
];

// Always allow localhost during local development.
// Production origins remain available as well.
const allowedOrigins = [...productionOrigins, ...developmentOrigins].filter(
  (origin, index, array) => array.indexOf(origin) === index,
);

logger.info(
  {
    environment: process.env.NODE_ENV,
    allowedOrigins,
  },
  "CORS configuration loaded",
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      logger.warn(
        {
          origin,
          allowedOrigins,
        },
        "CORS request rejected",
      );

      return callback(new Error(`Not allowed by CORS: ${origin}`));
    },

    credentials: true,

    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
      "Cache-Control",
      "Pragma",
      "X-Request-ID",
    ],
  }),
);

// ============================================================
// GENERAL REQUEST MIDDLEWARE
// ============================================================

app.use(cookieParser());

app.set("trust proxy", 1);

// JSON body parser
app.use(express.json());

// URL encoded body parser
app.use(express.urlencoded({ extended: true }));

// ============================================================
// UPLOAD DIRECTORY
// ============================================================

const uploadDir = path.join(__dirname, "../uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// ============================================================
// REQUEST ID
// ============================================================

app.use(requestIdMiddleware);

// ============================================================
// HTTP LOGGING
// ============================================================

app.use(
  pinoHttp({
    logger,

    genReqId: (req) => (req as any).id,

    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) {
        return "error";
      }

      if (res.statusCode >= 400) {
        return "warn";
      }

      return "info";
    },

    autoLogging: {
      ignore: (req) => req.url === "/healthz",
    },
  }),
);

// ============================================================
// STATIC FILES
// ============================================================

app.use("/uploads", express.static("uploads"));

app.use("/favicon.ico", express.static("public/favicon.ico"));

app.use("/receipts", express.static(path.join(__dirname, "../receipts")));

// ============================================================
// API DOCUMENTATION
// ============================================================

if (!config.isProduction || process.env.ENABLE_API_DOCS === "true") {
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
}

// ============================================================
// API ROUTES
// ============================================================

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

app.use("/api/ai", aiRouter);

app.use("/api/admin", adminRoutes);

app.use("/api/promotions", promoRoutes);

app.use("/api/referrals", referralRoutes);

app.use("/api/rider", riderOperationsRoutes);

app.use("/api/admin/rider", riderOperationsAdminRoutes);

// ============================================================
// ROOT
// ============================================================

app.get("/", (_req: Request, res: Response) => {
  res.send("🚀 Food Paddi Backend API is running");
});

// ============================================================
// LIVENESS CHECK
// ============================================================

app.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).send("OK");
});

// ============================================================
// READINESS CHECK
// ============================================================

app.get("/readyz", async (_req: Request, res: Response) => {
  const checks: Record<string, boolean> = {};

  // Database
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch {
    checks.database = false;
  }

  // Redis
  try {
    await redisProducts.ping();
    checks.redis = true;
  } catch {
    checks.redis = false;
  }

  const healthy = Object.values(checks).every(Boolean);

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    checks,
  });
});

// ============================================================
// JOB CACHE CONTROL
// ============================================================

app.use(
  [
    "/popularity-progress",
    "/run-popularity-job",
    "/cancel-popularity-job",
    "/reset-popularity-job",
  ],
  (_req, res, next) => {
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

// ============================================================
// START POPULARITY JOB
// ============================================================

app.get(
  "/run-popularity-job",
  authenticate,
  authorizeAdmin,
  async (_req, res) => {
    if (jobRunning) {
      return res.json({
        message: "Job is already running",
      });
    }

    jobRunning = true;

    console.log("🚀 Popularity job started");

    updatePopularityScores()
      .catch((err) => {
        console.error("❌ Popularity job failed:", err);
      })
      .finally(() => {
        jobRunning = false;

        console.log("✅ Popularity job finished");
      });

    res.json({
      message: "Popularity job started",
    });
  },
);

// ============================================================
// POPULARITY JOB PROGRESS
// ============================================================

app.get(
  "/popularity-progress",
  authenticate,
  authorizeAdmin,
  async (_req, res) => {
    try {
      const data = await redisProducts.get("job:popularity:progress");

      if (!data) {
        return res.json({
          total: 0,
          processed: 0,
          percent: 0,
        });
      }

      res.json(JSON.parse(data));
    } catch (err: any) {
      console.error("Failed to get progress:", err);

      res.status(500).json({
        error: "Failed to get progress",
      });
    }
  },
);

// ============================================================
// CANCEL POPULARITY JOB
// ============================================================

app.get("/cancel-popularity-job", authenticate, authorizeAdmin, (_req, res) => {
  if (!jobRunning) {
    return res.json({
      message: "No job is running",
    });
  }

  cancelPopularityJob();

  res.json({
    message: "Cancellation requested",
  });
});

// ============================================================
// RESET POPULARITY JOB
// ============================================================

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

      res.status(500).json({
        message: "Failed to reset popularity job",
      });
    }
  },
);

// ============================================================
// 404
// ============================================================

app.use(notFoundHandler);

// ============================================================
// CENTRAL ERROR HANDLER
// ============================================================

app.use(errorHandler);

// ============================================================
// BACKGROUND STARTUP TASKS
// ============================================================

async function runBackgroundStartupTasks() {
  // ----------------------------------------------------------
  // Search setup
  // ----------------------------------------------------------

  try {
    await setupSearch();

    logger.info("Search setup completed");
  } catch (err) {
    logger.error({ err }, "Search setup failed (non-critical)");
  }

  // ----------------------------------------------------------
  // Thumbnail backfill
  // ----------------------------------------------------------

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

          images: {
            isEmpty: false,
          },
        },

        select: {
          id: true,
        },

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
            {
              err: batchError,
              batchIndex: i / batchSize,
            },
            "Thumbnail batch failed, continuing",
          );
        }
      }

      logger.info(
        {
          processedCount,
        },
        "Thumbnail backfill complete",
      );
    } else {
      logger.info("All products already have thumbnails");
    }
  } catch (error) {
    logger.warn(
      { err: error },
      "Thumbnail backfill encountered an error (non-critical)",
    );
  }

  // ----------------------------------------------------------
  // Product live-status check
  // ----------------------------------------------------------

  fixLiveStatusJob(true)
    .then(() => {
      logger.info("Background product status check completed");
    })
    .catch((err) => {
      logger.error(
        { err },
        "Background product status check failed (non-critical)",
      );
    });
}

// ============================================================
// SERVER START
// ============================================================

const startServer = async () => {
  try {
    // --------------------------------------------------------
    // Redis
    // --------------------------------------------------------

    await ensureRedisReady();

    logger.info("Redis connected");

    // --------------------------------------------------------
    // PostgreSQL
    // --------------------------------------------------------

    await prisma.$connect();

    logger.info("PostgreSQL connected");

    // --------------------------------------------------------
    // Server configuration
    // --------------------------------------------------------

    logger.info(
      {
        serverUrl: config.serverUrl,

        port: config.port,

        environment: process.env.NODE_ENV,
      },
      "Starting server",
    );

    // --------------------------------------------------------
    // HTTP server
    // --------------------------------------------------------

    const server = http.createServer(app);

    // --------------------------------------------------------
    // Socket.IO
    // --------------------------------------------------------

    initSocket(server);

    // --------------------------------------------------------
    // Listen
    // --------------------------------------------------------

    server.listen(config.port, "0.0.0.0", () => {
      logger.info(
        {
          port: config.port,
          host: "0.0.0.0",
        },
        "🚀 Server running",
      );

      // Start keep-alive
      startKeepAlive();

      // Start non-critical maintenance
      // without blocking the server.
      void runBackgroundStartupTasks();
    });

    // ========================================================
    // GRACEFUL SHUTDOWN
    // ========================================================

    const shutdown = (signal: string) => {
      logger.info(
        {
          signal,
        },
        "Shutdown signal received, closing server gracefully",
      );

      server.close(async () => {
        try {
          await prisma.$disconnect();

          logger.info("Shutdown complete");

          process.exit(0);
        } catch (err) {
          logger.error(
            {
              err,
            },
            "Error during shutdown",
          );

          process.exit(1);
        }
      });

      // Force exit if graceful shutdown
      // takes longer than 10 seconds.
      setTimeout(() => process.exit(1), 10_000).unref();
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));

    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    logger.error(
      {
        err: error,
      },
      "Failed to start server",
    );

    process.exit(1);
  }
};

// ============================================================
// START
// ============================================================

startServer();
