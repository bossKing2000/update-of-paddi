import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import morgan from 'morgan';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import http from "http";
import { PrismaClient } from '@prisma/client';

import config from './config/config';
import { ensureRedisReady, redisProducts } from './lib/redis';
import { setupSearch } from './lib/setupSearch';
import { errorHandler } from './middlewares/error.middleware';
import { webhookHandler } from './controllers/paymentController';
import { initSocket } from './socket';

import authRoutes from './routes/auth.routes';
import productRoutes from './routes/productRoutes';
import reviewRoutes from './routes/reviewRoutes';
import orderRouter from './routes/orderRouter';
import paymentRouter from './routes/paymentRoute';
import cartRouter from './routes/cartRouter';
import deliveryRouter from './routes/deliveryRouter';
import productScheduleRoutes from './routes/productScheduleRoutes';
import vendorFollowRoutes from './routes/vendorFollowRoutes';


// ------------------------------
// Cron / In-memory Jobs
// ------------------------------
import { updatePopularityScores, cancelPopularityJob, resetPopularityJob } from './jobs/workers jobs/updatePopularityScore';
import { startKeepAliveJob } from './jobs/workers jobs/keepAlive';
import "./jobs/node-cron/runJob"; // ✅ Automatically starts cron jobs


// ✅ Auto-start BullMQ workers
// ------------------------------
// BullMQ Workers (auto-start)
// ------------------------------
import "./jobs/workers jobs/productDeactivateJob";
import "./jobs/workers jobs/vendorFollowWorker";
import "./jobs/workers jobs/productLiveWorker";
import vendorDashboardRoutes from './routes/vendorDashboard.routes';
import aiRouter from './routes/aiRouter';
import { ProductImageService } from './jobs/sripts/backfillThumbnails';
import { fixLiveStatusJob } from './jobs/workers jobs/fixLiveStatusJob';






dotenv.config();

const prisma = new PrismaClient();
const app = express();

// ✅ Job flags for in-memory jobs
let jobRunning = false; // only for popularity job

// ------------------------------
// Middleware & setup
// ------------------------------

// Paystack Webhook — must come BEFORE express.json()
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhookHandler);

// Ensure uploads folder exists
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Logger with chalk
morgan.token('statusColor', (_req, res) => {
  const status = res.statusCode;
  if (status >= 500) return chalk.red(status.toString());
  if (status >= 400) return chalk.yellow(status.toString());
  if (status >= 300) return chalk.cyan(status.toString());
  if (status >= 200) return chalk.green(status.toString());
  return status.toString();
});

app.use(
  morgan((tokens, req, res) => [
    chalk.gray(`[${tokens.date(req, res, 'iso')}]`),
    chalk.magenta(tokens.method(req, res)),
    chalk.blue(tokens.url(req, res)),
    chalk.white(tokens['statusColor'](req, res)),
    chalk.gray(`- ${tokens['response-time'](req, res)} ms`)
  ].join(' '))
);

app.use(helmet());

const allowedOrigins = [
  config.clientUrl,
  "http://127.0.0.1:60308",
  "https://ui-food-paddi.onrender.com",
  "https://ceeb2aee.food-paddi-website.pages.dev",
  "http://127.0.0.1:8080",
  "http://10.0.2.2:5000",
  "http://localhost:52498",
  ""
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true
}));

app.use(cookieParser());
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use('/uploads', express.static('uploads'));
app.use('/favicon.ico', express.static('public/favicon.ico'));
app.use("/receipts", express.static(path.join(__dirname, "../receipts")));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/product', productRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/order', orderRouter);
app.use('/api/cart', cartRouter);
app.use('/api/payments', paymentRouter);
app.use("/api/delivery", deliveryRouter);
app.use("/api/product", productScheduleRoutes);
app.use("/api/vendor-follow", vendorFollowRoutes);
app.use("/api/status", productScheduleRoutes);
app.use("/api/vendor", vendorDashboardRoutes);
app.use('/api/ai', aiRouter);


// Root & health endpoints
app.get('/', (_req: Request, res: Response) => res.send('🚀 Food Paddi Backend API is running'));
app.get('/healthz', (_req: Request, res: Response) => res.status(200).send('OK'));

// Disable cache for job control endpoints
app.use(
  ["/popularity-progress", "/run-popularity-job", "/cancel-popularity-job", "/reset-popularity-job"],
  (req, res, next) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    next();
  }
);

// ▶ Start/Resume job
// Popularity job endpoints
app.get("/run-popularity-job", async (_req, res) => {
  if (jobRunning) return res.json({ message: "Job is already running" });

  jobRunning = true;
  console.log("🚀 Popularity job started");

  updatePopularityScores()
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
    const data = await redisProducts.get("job:popularity:progress");
    if (!data) return res.json({ total: 0, processed: 0, percent: 0 });
    res.json(JSON.parse(data));
  } catch (err: any) {
    console.error("Failed to get progress:", err);
    res.status(500).json({ error: "Failed to get progress" });
  }
});
 

// ▶ Cancel job
app.get("/cancel-popularity-job", (_req, res) => {
  if (!jobRunning) return res.json({ message: "No job is running" });

  cancelPopularityJob();
  res.json({ message: "Cancellation requested" });
});


// ▶ Reset job
app.get("/reset-popularity-job", async (_req, res) => {
  try {
    const result = await resetPopularityJob();
    jobRunning = false;
    console.log("♻️ Popularity job has been reset");
    res.json(result);
  } catch (err: any) {
    console.error("Error resetting job:", err);
    res.status(500).json({ message: "Failed to reset popularity job" });
  }
});

// Error handler
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

const startServer = async () => {
  try {
    await ensureRedisReady();
    console.log('✅ Redis connected');

    await prisma.$connect();
    console.log('✅ PostgreSQL connected');

    // ──────────────────────────────────────────────────────
    // NEW: Run thumbnail backfill on server startup
    // ──────────────────────────────────────────────────────
    try {
      console.log('🔍 Running thumbnail backfill on server startup...');
      
      // Step 1: Check initial health status
      const initialHealth = await ProductImageService.healthCheck();
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
              await ProductImageService.batchEnsureThumbnails(batch);
              processedCount += batch.length;
              
              // Log progress every 500 products
              if (processedCount % 500 === 0) {
                console.log(`   Progress: ${processedCount}/${productIds.length} products`);
              }
            } catch (batchError) {
              console.warn(`   ⚠️ Batch ${i/batchSize + 1} failed, continuing with next batch:`, batchError);
              // Continue with next batch even if one fails
            }
          }
          
          console.log(`✅ Backfilled thumbnails for ${processedCount} products`);
          
          // Step 4: Final health check
          const finalHealth = await ProductImageService.healthCheck();
          console.log(`📊 Final thumbnail health: ${finalHealth.percentage}% (${finalHealth.healthy}/${finalHealth.total} products)`);
          
          if (finalHealth.missing > 0) {
            console.log(`⚠️  Note: ${finalHealth.missing} products still without thumbnails (products without images)`);
          } else {
            console.log('🎉 All products with images now have thumbnails!');
          }
        } else {
          console.log('✅ No products found without thumbnails');
        }
      } else {
        console.log('✅ All products already have thumbnails!');
      }
      
    } catch (error) {
      console.warn('⚠️  Thumbnail backfill encountered an error (non-critical), continuing server startup:', error);
      // Don't crash the server if backfill fails
    }
    // ──────────────────────────────────────────────────────

    try {
      await setupSearch();
      console.log('✅ Search setup completed');
    } catch (err) {
      console.error('⚠️ Search setup failed:', err);
    }

    // ──────────────────────────────────────────────────────
    // SAFE UPDATE: Run fixLiveStatusJob in background
    // (Doesn't block server startup like before)
    // ──────────────────────────────────────────────────────
    console.log('🔄 Starting product status fix in background (non-blocking)...');
    
    // Start the job but don't wait for it - run in background
    const startupFixPromise = fixLiveStatusJob(true)
      .then(() => {
        console.log('✅ Background product status check completed');
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

    const server = http.createServer(app);
    initSocket(server);

    server.listen(5000, "0.0.0.0", () => {
      console.log(`🚀 Server running at http://localhost:${config.port}`);
      
      // Delay cron job start slightly to let server stabilize
      setTimeout(() => {
        startKeepAliveJob();
        console.log('⏰ Cron jobs started');
      }, 5000); // 5 second delay
    });

  } catch (error) { 
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
