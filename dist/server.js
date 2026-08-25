"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const client_1 = require("@prisma/client");
const config_1 = __importDefault(require("./config/config"));
const redis_1 = require("./lib/redis");
const setupSearch_1 = require("./lib/setupSearch");
const error_middleware_1 = require("./middlewares/error.middleware");
const requestId_middleware_1 = require("./middlewares/requestId.middleware");
const auth_middleware_1 = require("./middlewares/auth.middleware");
const logger_1 = require("./lib/logger");
const pino_http_1 = __importDefault(require("pino-http"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const openapi_1 = require("./docs/openapi");
// import { webhookHandler } from './controllers/paymentController';
const socket_1 = require("./socket");
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
const productRoutes_1 = __importDefault(require("./routes/productRoutes"));
const reviewRoutes_1 = __importDefault(require("./routes/reviewRoutes"));
const orderRouter_1 = __importDefault(require("./routes/orderRouter"));
const notificationRouter_1 = __importDefault(require("./routes/notificationRouter"));
const paymentRoute_1 = __importDefault(require("./routes/paymentRoute"));
const cartRouter_1 = __importDefault(require("./routes/cartRouter"));
const deliveryRouter_1 = __importDefault(require("./routes/deliveryRouter"));
const productScheduleRoutes_1 = __importDefault(require("./routes/productScheduleRoutes"));
const vendorFollowRoutes_1 = __importDefault(require("./routes/vendorFollowRoutes"));
const seeder_routes_1 = __importDefault(require("./routes/seeder.routes"));
// ------------------------------
// Cron / In-memory Jobs
// ------------------------------
const updatePopularityScore_1 = require("./jobs/workers jobs/updatePopularityScore");
const keepAlive_1 = require("./jobs/workers jobs/keepAlive");
require("./jobs/node-cron/runJob"); // ✅ Automatically starts cron jobs
// ✅ Auto-start BullMQ workers
// ------------------------------
// BullMQ Workers (auto-start)
// ------------------------------
require("./jobs/workers jobs/productDeactivateJob");
require("./jobs/workers jobs/vendorFollowWorker");
require("./jobs/workers jobs/productLiveWorker");
const vendorDashboard_routes_1 = __importDefault(require("./routes/vendorDashboard.routes"));
const vendorSettings_routes_1 = __importDefault(require("./routes/vendorSettings.routes"));
const vendorSupport_routes_1 = __importDefault(require("./routes/vendorSupport.routes"));
const aiRouter_1 = __importDefault(require("./routes/aiRouter"));
const admin_routes_1 = __importDefault(require("./routes/admin.routes"));
const promoRoutes_1 = __importDefault(require("./routes/promoRoutes"));
const customerPromotions_routes_1 = __importDefault(require("./routes/customerPromotions.routes"));
const homeFeed_routes_1 = __importDefault(require("./routes/homeFeed.routes"));
const referralRoutes_1 = __importDefault(require("./routes/referralRoutes"));
const riderOperations_routes_1 = require("./routes/riderOperations.routes");
const backfillThumbnails_1 = require("./jobs/sripts/backfillThumbnails");
const fixLiveStatusJob_1 = require("./jobs/workers jobs/fixLiveStatusJob");
const webhook_1 = require("./controllers/webhook");
dotenv_1.default.config();
const prisma = new client_1.PrismaClient();
const app = (0, express_1.default)();
// ✅ Job flags for in-memory jobs
let jobRunning = false; // only for popularity job
// ------------------------------
// Middleware & setup
// ------------------------------
// Paystack Webhook — must come BEFORE express.json()
// app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookHandler);
app.post("/api/payments/webhook", express_1.default.raw({ type: "application/json" }), webhook_1.paystackWebhookHandler);
// Ensure uploads folder exists
const uploadDir = path_1.default.join(__dirname, "../uploads");
if (!fs_1.default.existsSync(uploadDir))
    fs_1.default.mkdirSync(uploadDir, { recursive: true });
// Request ID first — every subsequent log line (including the HTTP access
// log below) is tagged with it, so a single request is traceable end to end.
app.use(requestId_middleware_1.requestIdMiddleware);
// Structured HTTP access logging (replaces morgan+chalk). JSON in
// production for log aggregators, pretty-printed in dev via the same
// pino instance used everywhere else in the app.
app.use((0, pino_http_1.default)({
    logger: logger_1.logger,
    genReqId: (req) => req.id,
    customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500)
            return "error";
        if (res.statusCode >= 400)
            return "warn";
        return "info";
    },
    // Don't spam logs with successful health-check pings.
    autoLogging: {
        ignore: (req) => req.url === "/healthz",
    },
}));
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin || config_1.default.allowedOrigins.includes(origin))
            callback(null, true);
        else
            callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
}));
app.use((0, cookie_parser_1.default)());
app.set("trust proxy", 1);
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// Static files
app.use("/uploads", express_1.default.static("uploads"));
app.use("/favicon.ico", express_1.default.static("public/favicon.ico"));
app.use("/receipts", express_1.default.static(path_1.default.join(__dirname, "../receipts")));
// Routes
// API docs — on by default in dev, opt-in in production via ENABLE_API_DOCS=true
// (a payments/KYC backend's docs shouldn't be publicly browsable by default).
if (!config_1.default.isProduction || process.env.ENABLE_API_DOCS === "true") {
    app.use("/api/docs", swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(openapi_1.openApiDocument));
}
app.use("/api/auth", auth_routes_1.default);
app.use("/api/product", productRoutes_1.default);
app.use("/api/review", reviewRoutes_1.default);
app.use("/api/order", orderRouter_1.default);
app.use("/api/notifications", notificationRouter_1.default);
app.use("/api/cart", cartRouter_1.default);
app.use("/api/payments", paymentRoute_1.default);
app.use("/api/delivery", deliveryRouter_1.default);
app.use("/api/delivery", riderOperations_routes_1.riderProofReadRoutes);
app.use("/api/product", productScheduleRoutes_1.default);
app.use("/api/vendor-follow", vendorFollowRoutes_1.default);
app.use("/api/seeder", seeder_routes_1.default);
app.use("/api/vendor", vendorDashboard_routes_1.default);
app.use("/api/vendor/settings", vendorSettings_routes_1.default);
app.use("/api/vendor/support", vendorSupport_routes_1.default);
app.use("/api/ai", aiRouter_1.default);
app.use("/api/admin", admin_routes_1.default);
app.use("/api/promotions", promoRoutes_1.default);
app.use("/api/promotions", customerPromotions_routes_1.default);
app.use("/api/home", homeFeed_routes_1.default);
app.use("/api/referrals", referralRoutes_1.default);
app.use("/api/rider", riderOperations_routes_1.riderOperationsRoutes);
app.use("/api/admin/rider", riderOperations_routes_1.riderOperationsAdminRoutes);
// Root & health endpoints
app.get("/", (_req, res) => res.send("🚀 Food Paddi Backend API is running"));
// Liveness: "is the process up" — always fast, no downstream checks.
// Use for platform health checks that just need a quick 200.
app.get("/healthz", (_req, res) => res.status(200).send("OK"));
// Readiness: "can this instance actually serve traffic" — checks the
// database and cache it depends on. Use this for load-balancer routing
// decisions or pre-deploy smoke tests.
app.get("/readyz", async (_req, res) => {
    const checks = {};
    try {
        await prisma.$queryRaw `SELECT 1`;
        checks.database = true;
    }
    catch {
        checks.database = false;
    }
    try {
        await redis_1.redisProducts.ping();
        checks.redis = true;
    }
    catch {
        checks.redis = false;
    }
    const healthy = Object.values(checks).every(Boolean);
    res
        .status(healthy ? 200 : 503)
        .json({ status: healthy ? "ok" : "degraded", checks });
});
// Disable cache for job control endpoints
app.use([
    "/popularity-progress",
    "/run-popularity-job",
    "/cancel-popularity-job",
    "/reset-popularity-job",
], (req, res, next) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    next();
});
// ▶ Start/Resume job
// Popularity job endpoints — ADMIN ONLY.
// These were previously mounted with no auth at all: any anonymous caller
// on the internet could trigger, cancel, or reset this job. Locked down now.
app.get("/run-popularity-job", auth_middleware_1.authenticate, auth_middleware_1.authorizeAdmin, async (_req, res) => {
    if (jobRunning)
        return res.json({ message: "Job is already running" });
    jobRunning = true;
    console.log("🚀 Popularity job started");
    (0, updatePopularityScore_1.updatePopularityScores)()
        .catch((err) => console.error("❌ Popularity job failed:", err))
        .finally(() => {
        jobRunning = false;
        console.log("✅ Popularity job finished");
    });
    res.json({ message: "Popularity job started" });
});
// ▶ Progress endpoint
app.get("/popularity-progress", auth_middleware_1.authenticate, auth_middleware_1.authorizeAdmin, async (_req, res) => {
    try {
        const data = await redis_1.redisProducts.get("job:popularity:progress");
        if (!data)
            return res.json({ total: 0, processed: 0, percent: 0 });
        res.json(JSON.parse(data));
    }
    catch (err) {
        console.error("Failed to get progress:", err);
        res.status(500).json({ error: "Failed to get progress" });
    }
});
// ▶ Cancel job
app.get("/cancel-popularity-job", auth_middleware_1.authenticate, auth_middleware_1.authorizeAdmin, (_req, res) => {
    if (!jobRunning)
        return res.json({ message: "No job is running" });
    (0, updatePopularityScore_1.cancelPopularityJob)();
    res.json({ message: "Cancellation requested" });
});
// ▶ Reset job
app.get("/reset-popularity-job", auth_middleware_1.authenticate, auth_middleware_1.authorizeAdmin, async (_req, res) => {
    try {
        const result = await (0, updatePopularityScore_1.resetPopularityJob)();
        jobRunning = false;
        console.log("♻️ Popularity job has been reset");
        res.json(result);
    }
    catch (err) {
        console.error("Error resetting job:", err);
        res.status(500).json({ message: "Failed to reset popularity job" });
    }
});
// Error handler
// Unmatched routes -> 404
app.use(error_middleware_1.notFoundHandler);
// Central error handler — must be last
app.use(error_middleware_1.errorHandler);
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
        await (0, setupSearch_1.setupSearch)();
        logger_1.logger.info("Search setup completed");
    }
    catch (err) {
        logger_1.logger.error({ err }, "Search setup failed (non-critical)");
    }
    try {
        logger_1.logger.info("Running thumbnail backfill...");
        const initialHealth = await backfillThumbnails_1.ProductImageService.healthCheck();
        logger_1.logger.info({
            percentage: initialHealth.percentage,
            healthy: initialHealth.healthy,
            total: initialHealth.total,
        }, "Initial thumbnail health");
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
                    await backfillThumbnails_1.ProductImageService.batchEnsureThumbnails(batch);
                    processedCount += batch.length;
                }
                catch (batchError) {
                    logger_1.logger.warn({ err: batchError, batchIndex: i / batchSize }, "Thumbnail batch failed, continuing");
                }
            }
            logger_1.logger.info({ processedCount }, "Thumbnail backfill complete");
        }
        else {
            logger_1.logger.info("All products already have thumbnails");
        }
    }
    catch (error) {
        logger_1.logger.warn({ err: error }, "Thumbnail backfill encountered an error (non-critical)");
    }
    (0, fixLiveStatusJob_1.fixLiveStatusJob)(true)
        .then(() => logger_1.logger.info("Background product status check completed"))
        .catch((err) => logger_1.logger.error({ err }, "Background product status check failed (non-critical)"));
}
const startServer = async () => {
    try {
        await (0, redis_1.ensureRedisReady)();
        logger_1.logger.info("Redis connected");
        await prisma.$connect();
        logger_1.logger.info("PostgreSQL connected");
        logger_1.logger.info({ serverUrl: config_1.default.serverUrl }, "Starting server");
        const server = http_1.default.createServer(app);
        (0, socket_1.initSocket)(server);
        server.listen(config_1.default.port, "0.0.0.0", () => {
            logger_1.logger.info({ port: config_1.default.port }, "Server running");
            // Delay cron job start slightly to let server stabilize
            (0, keepAlive_1.startKeepAlive)();
            // Fire-and-forget background maintenance — never blocks the port
            // from being bound, which is what health checks actually wait on.
            void runBackgroundStartupTasks();
        });
        // Graceful shutdown — important on platforms (Render/Railway/K8s) that
        // send SIGTERM before killing the process on redeploy/scale-down, so
        // in-flight requests get to finish instead of being dropped.
        const shutdown = (signal) => {
            logger_1.logger.info({ signal }, "Shutdown signal received, closing server gracefully");
            server.close(async () => {
                try {
                    await prisma.$disconnect();
                    logger_1.logger.info("Shutdown complete");
                    process.exit(0);
                }
                catch (err) {
                    logger_1.logger.error({ err }, "Error during shutdown");
                    process.exit(1);
                }
            });
            // Force-exit if graceful shutdown hangs
            setTimeout(() => process.exit(1), 10_000).unref();
        };
        process.on("SIGTERM", () => shutdown("SIGTERM"));
        process.on("SIGINT", () => shutdown("SIGINT"));
    }
    catch (error) {
        logger_1.logger.error({ err: error }, "Failed to start server");
        process.exit(1);
    }
};
startServer();
