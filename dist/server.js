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
const morgan_1 = __importDefault(require("morgan"));
const chalk_1 = __importDefault(require("chalk"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const client_1 = require("@prisma/client");
const config_1 = __importDefault(require("./config/config"));
const redis_1 = require("./lib/redis");
const setupSearch_1 = require("./lib/setupSearch");
const error_middleware_1 = require("./middlewares/error.middleware");
const paymentController_1 = require("./controllers/paymentController");
const socket_1 = require("./socket");
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
const productRoutes_1 = __importDefault(require("./routes/productRoutes"));
const reviewRoutes_1 = __importDefault(require("./routes/reviewRoutes"));
const orderRouter_1 = __importDefault(require("./routes/orderRouter"));
const paymentRoute_1 = __importDefault(require("./routes/paymentRoute"));
const cartRouter_1 = __importDefault(require("./routes/cartRouter"));
const deliveryRouter_1 = __importDefault(require("./routes/deliveryRouter"));
const productScheduleRoutes_1 = __importDefault(require("./routes/productScheduleRoutes"));
const vendorFollowRoutes_1 = __importDefault(require("./routes/vendorFollowRoutes"));
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
const aiRouter_1 = __importDefault(require("./routes/aiRouter"));
const backfillThumbnails_1 = require("./jobs/sripts/backfillThumbnails");
const fixLiveStatusJob_1 = require("./jobs/workers jobs/fixLiveStatusJob");
dotenv_1.default.config();
const prisma = new client_1.PrismaClient();
const app = (0, express_1.default)();
// ✅ Job flags for in-memory jobs
let jobRunning = false; // only for popularity job
// ------------------------------
// Middleware & setup
// ------------------------------
// Paystack Webhook — must come BEFORE express.json()
app.post('/api/payments/webhook', express_1.default.raw({ type: 'application/json' }), paymentController_1.webhookHandler);
// Ensure uploads folder exists
const uploadDir = path_1.default.join(__dirname, '../uploads');
if (!fs_1.default.existsSync(uploadDir))
    fs_1.default.mkdirSync(uploadDir, { recursive: true });
// Logger with chalk
morgan_1.default.token('statusColor', (_req, res) => {
    const status = res.statusCode;
    if (status >= 500)
        return chalk_1.default.red(status.toString());
    if (status >= 400)
        return chalk_1.default.yellow(status.toString());
    if (status >= 300)
        return chalk_1.default.cyan(status.toString());
    if (status >= 200)
        return chalk_1.default.green(status.toString());
    return status.toString();
});
app.use((0, morgan_1.default)((tokens, req, res) => [
    chalk_1.default.gray(`[${tokens.date(req, res, 'iso')}]`),
    chalk_1.default.magenta(tokens.method(req, res)),
    chalk_1.default.blue(tokens.url(req, res)),
    chalk_1.default.white(tokens['statusColor'](req, res)),
    chalk_1.default.gray(`- ${tokens['response-time'](req, res)} ms`)
].join(' ')));
app.use((0, helmet_1.default)());
const allowedOrigins = [
    config_1.default.clientUrl,
    "http://127.0.0.1:60308",
    "https://ui-food-paddi.onrender.com",
    "https://ceeb2aee.food-paddi-website.pages.dev",
    "http://127.0.0.1:8080",
    "http://10.0.2.2:5000",
    "http://localhost:52498",
    ""
];
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin))
            callback(null, true);
        else
            callback(new Error("Not allowed by CORS"));
    },
    credentials: true
}));
app.use((0, cookie_parser_1.default)());
app.set('trust proxy', 1);
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// Static files
app.use('/uploads', express_1.default.static('uploads'));
app.use('/favicon.ico', express_1.default.static('public/favicon.ico'));
app.use("/receipts", express_1.default.static(path_1.default.join(__dirname, "../receipts")));
// Routes
app.use('/api/auth', auth_routes_1.default);
app.use('/api/product', productRoutes_1.default);
app.use('/api/review', reviewRoutes_1.default);
app.use('/api/order', orderRouter_1.default);
app.use('/api/cart', cartRouter_1.default);
app.use('/api/payments', paymentRoute_1.default);
app.use("/api/delivery", deliveryRouter_1.default);
app.use("/api/product", productScheduleRoutes_1.default);
app.use("/api/vendor-follow", vendorFollowRoutes_1.default);
app.use("/api/status", productScheduleRoutes_1.default);
app.use("/api/vendor", vendorDashboard_routes_1.default);
app.use('/api/ai', aiRouter_1.default);
// Root & health endpoints
app.get('/', (_req, res) => res.send('🚀 Food Paddi Backend API is running'));
app.get('/healthz', (_req, res) => res.status(200).send('OK'));
// Disable cache for job control endpoints
app.use(["/popularity-progress", "/run-popularity-job", "/cancel-popularity-job", "/reset-popularity-job"], (req, res, next) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    next();
});
// ▶ Start/Resume job
// Popularity job endpoints
app.get("/run-popularity-job", async (_req, res) => {
    if (jobRunning)
        return res.json({ message: "Job is already running" });
    jobRunning = true;
    console.log("🚀 Popularity job started");
    (0, updatePopularityScore_1.updatePopularityScores)()
        .catch(err => console.error("❌ Popularity job failed:", err))
        .finally(() => {
        jobRunning = false;
        console.log("✅ Popularity job finished");
    });
    res.json({ message: "Popularity job started" });
});
// ▶ Progress endpoint
app.get("/popularity-progress", async (_req, res) => {
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
app.get("/cancel-popularity-job", (_req, res) => {
    if (!jobRunning)
        return res.json({ message: "No job is running" });
    (0, updatePopularityScore_1.cancelPopularityJob)();
    res.json({ message: "Cancellation requested" });
});
// ▶ Reset job
app.get("/reset-popularity-job", async (_req, res) => {
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
const startServer = async () => {
    try {
        await (0, redis_1.ensureRedisReady)();
        console.log('✅ Redis connected');
        await prisma.$connect();
        console.log('✅ PostgreSQL connected');
        // ──────────────────────────────────────────────────────
        // NEW: Run thumbnail backfill on server startup
        // ──────────────────────────────────────────────────────
        try {
            console.log('🔍 Running thumbnail backfill on server startup...');
            // Step 1: Check initial health status
            const initialHealth = await backfillThumbnails_1.ProductImageService.healthCheck();
            console.log(`📊 Initial thumbnail health: ${initialHealth.percentage}% (${initialHealth.healthy}/${initialHealth.total} products)`);
            if (initialHealth.missing > 0) {
                console.log(`🔄 Found ${initialHealth.missing} products without thumbnails, starting backfill...`);
                // Step 2: Find products that need thumbnails
                const productsWithoutThumbnails = await prisma.product.findMany({
                    where: {
                        OR: [
                            { thumbnail: null },
                            { thumbnail: '' }
                        ],
                        images: {
                            isEmpty: false // Only products that actually have images
                        }
                    },
                    select: { id: true },
                    take: 2000 // Process up to 2000 products per startup
                });
                console.log(`📊 Processing ${productsWithoutThumbnails.length} products...`);
                if (productsWithoutThumbnails.length > 0) {
                    // Step 3: Process in batches
                    const batchSize = 100;
                    const productIds = productsWithoutThumbnails.map(p => p.id);
                    let processedCount = 0;
                    for (let i = 0; i < productIds.length; i += batchSize) {
                        const batch = productIds.slice(i, i + batchSize);
                        try {
                            await backfillThumbnails_1.ProductImageService.batchEnsureThumbnails(batch);
                            processedCount += batch.length;
                            // Log progress every 500 products
                            if (processedCount % 500 === 0) {
                                console.log(`   Progress: ${processedCount}/${productIds.length} products`);
                            }
                        }
                        catch (batchError) {
                            console.warn(`   ⚠️ Batch ${i / batchSize + 1} failed, continuing with next batch:`, batchError);
                            // Continue with next batch even if one fails
                        }
                    }
                    console.log(`✅ Backfilled thumbnails for ${processedCount} products`);
                    // Step 4: Final health check
                    const finalHealth = await backfillThumbnails_1.ProductImageService.healthCheck();
                    console.log(`📊 Final thumbnail health: ${finalHealth.percentage}% (${finalHealth.healthy}/${finalHealth.total} products)`);
                    if (finalHealth.missing > 0) {
                        console.log(`⚠️  Note: ${finalHealth.missing} products still without thumbnails (products without images)`);
                    }
                    else {
                        console.log('🎉 All products with images now have thumbnails!');
                    }
                }
                else {
                    console.log('✅ No products found without thumbnails');
                }
            }
            else {
                console.log('✅ All products already have thumbnails!');
            }
        }
        catch (error) {
            console.warn('⚠️  Thumbnail backfill encountered an error (non-critical), continuing server startup:', error);
            // Don't crash the server if backfill fails
        }
        // ──────────────────────────────────────────────────────
        try {
            await (0, setupSearch_1.setupSearch)();
            console.log('✅ Search setup completed');
        }
        catch (err) {
            console.error('⚠️ Search setup failed:', err);
        }
        // ──────────────────────────────────────────────────────
        // SAFE UPDATE: Run fixLiveStatusJob in background
        // (Doesn't block server startup like before)
        // ──────────────────────────────────────────────────────
        console.log('🔄 Starting product status fix in background (non-blocking)...');
        // Start the job but don't wait for it - run in background
        const startupFixPromise = (0, fixLiveStatusJob_1.fixLiveStatusJob)(true)
            .then(() => {
            // console.log('✅ Background product status check completed');
        })
            .catch(err => {
            // Don't crash the server if this fails
            console.error('⚠️ Background product status check failed (non-critical):', err.message || err);
        });
        // Optional: Track this promise if you need to wait for it later
        // You can store it somewhere if needed, but we don't await it here
        // Add a safety timeout: if it takes more than 2 minutes, log a warning
        setTimeout(() => {
            startupFixPromise.then(() => {
                // Already completed, nothing to do
            }).catch(() => {
                // Already handled
            });
        }, 2 * 60 * 1000); // 2 minutes
        // ──────────────────────────────────────────────────────
        console.log(`🌐 SERVER_URL: ${process.env.SERVER_URL}`);
        const server = http_1.default.createServer(app);
        (0, socket_1.initSocket)(server);
        server.listen(5000, "0.0.0.0", () => {
            console.log(`🚀 Server running at http://localhost:${config_1.default.port}`);
            // Delay cron job start slightly to let server stabilize
            (0, keepAlive_1.startKeepAlive)();
        });
    }
    catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
};
startServer();
