// src/controllers/webhook.ts (FIXED VERSION)
import { Request, Response } from 'express';
import crypto from 'crypto';
import retry from 'async-retry';
import { PrismaClient, OrderStatus } from '@prisma/client';
import { validatePaystackSignature } from '../utils/paystack';
import { nowUtc, toUtc, isBeforeUtc } from '../utils/time';

const prisma = new PrismaClient();

// ==================== CONSTANTS ====================
const WEBHOOK_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_RETRIES = 3;
const RETRY_MIN_TIMEOUT = 1000;
const RETRY_MAX_TIMEOUT = 10000;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_REQUESTS_PER_WINDOW = 100;

// Status constants for consistency
const PAYMENT_SUCCESS = 'SUCCESS';
const PAYMENT_FAILED = 'FAILED';
const PAYMENT_EXPIRED = 'EXPIRED';
const PAYMENT_AMOUNT_MISMATCH = 'AMOUNT_MISMATCH';

const PAYABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.AWAITING_PAYMENT,
  OrderStatus.PENDING,
];

const CANCELLABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.AWAITING_PAYMENT,
  OrderStatus.PENDING,
];

// ==================== IN-MEMORY STORES ====================
const processedWebhooks = new Map<string, number>();
const requestCounts = new Map<string, { count: number; resetTime: number }>();

// Clean up old webhook IDs periodically
setInterval(() => {
  const now = Date.now();
  
  for (const [webhookId, timestamp] of processedWebhooks.entries()) {
    if (now - timestamp > WEBHOOK_TTL) {
      processedWebhooks.delete(webhookId);
    }
  }
  
  for (const [ip, data] of requestCounts.entries()) {
    if (now > data.resetTime) {
      requestCounts.delete(ip);
    }
  }
}, 60 * 60 * 1000);

// ==================== UTILITY FUNCTIONS ====================

function rateLimit(req: Request): { allowed: boolean; resetTime?: number } {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  
  const data = requestCounts.get(ip);
  
  if (!data || now > data.resetTime) {
    requestCounts.set(ip, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW
    });
    return { allowed: true };
  }
  
  if (data.count >= MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, resetTime: data.resetTime };
  }
  
  data.count++;
  return { allowed: true };
}

function generateWebhookId(eventPayload: any, timestamp: number): string {
  const payloadString = JSON.stringify(eventPayload);
  return crypto
    .createHash('sha256')
    .update(`${payloadString}-${timestamp}-${process.pid}`)
    .digest('hex');
}

function isWebhookProcessed(webhookId: string): boolean {
  return processedWebhooks.has(webhookId);
}

function markWebhookProcessed(webhookId: string): void {
  processedWebhooks.set(webhookId, Date.now());
}

async function sendAlert(level: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL', title: string, details: any) {
  console.log(`[ALERT:${level}] ${title}`, details);
}

async function createAuditLog(action: string, userId: string | null, metadata: any) {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        userId,
        metadata,
        ipAddress: metadata.ip || 'unknown',
        userAgent: metadata.userAgent || 'unknown',
        path: metadata.path || 'webhook',
        createdAt: nowUtc(),
      },
    });
  } catch (error) {
    console.error('[AUDIT] Failed to create log:', error);
  }
}

function validatePaystackWebhook(payload: any): {
  valid: boolean;
  data?: {
    event: string;
    data: {
      reference: string;
      amount: number;
      metadata?: {
        orderId: string;
        userId: string;
      };
      authorization?: {
        authorization_code: string;
        last4: string;
        brand: string;
        reusable: boolean;
        channel?: string;
      };
    };
  };
  error?: string;
} {
  try {
    if (!payload || typeof payload !== 'object') {
      return { valid: false, error: 'Invalid payload format' };
    }
    
    if (payload.event !== 'charge.success') {
      return { valid: false, error: 'Unsupported event type' };
    }
    
    if (!payload.data?.reference) {
      return { valid: false, error: 'Missing reference' };
    }
    
    if (!payload.data?.amount) {
      return { valid: false, error: 'Missing amount' };
    }
    
    if (!payload.data?.metadata?.userId || !payload.data?.metadata?.orderId) {
      return { valid: false, error: 'Missing required metadata' };
    }
    
    return { valid: true, data: payload };
  } catch (error) {
    return { valid: false, error: 'Validation failed' };
  }
}

async function processWithRetry<T>(
  fn: () => Promise<T>,
  context: { reference: string; webhookId: string }
): Promise<T> {
  return retry(
    async (bail: (error: Error) => void, attempt: number) => {
      try {
        const result = await fn();
        console.log(`[WEBHOOK] ✅ ${context.reference} processed on attempt ${attempt}`);
        return result;
      } catch (error: any) {
        console.error(`[WEBHOOK] ❌ Attempt ${attempt} failed for ${context.reference}:`, error.message);
        
        if (attempt === MAX_RETRIES) {
          await sendAlert('ERROR', 'Webhook Processing Failed', {
            reference: context.reference,
            webhookId: context.webhookId,
            error: error.message,
            attempts: attempt,
          });
        }
        
        if (error.code === 'P2025') {
          bail(new Error(`Record not found: ${context.reference}`));
          throw error;
        }
        
        if (error.code === 'P2002') {
          bail(new Error(`Duplicate processing: ${context.reference}`));
          throw error;
        }
        
        throw error;
      }
    },
    {
      retries: MAX_RETRIES,
      factor: 2,
      minTimeout: RETRY_MIN_TIMEOUT,
      maxTimeout: RETRY_MAX_TIMEOUT,
    }
  );
}

// ==================== MAIN WEBHOOK HANDLER ====================

export const paystackWebhookHandler = async (req: Request, res: Response) => {
  const startTime = Date.now();
  const requestId = crypto.randomBytes(16).toString('hex');
  
  try {
    // 1️⃣ RATE LIMITING
    const rateLimitResult = rateLimit(req);
    if (!rateLimitResult.allowed) {
      await createAuditLog('WEBHOOK_RATE_LIMITED', null, {
        requestId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        path: req.path,
        resetTime: rateLimitResult.resetTime,
      });
      
      await sendAlert('WARNING', 'Webhook Rate Limited', {
        requestId,
        ip: req.ip,
        resetTime: rateLimitResult.resetTime,
      });
      
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: rateLimitResult.resetTime 
          ? Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000)
          : RATE_LIMIT_WINDOW / 1000,
      });
    }
    
    // 2️⃣ VALIDATE RAW BODY & SIGNATURE
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      console.error(`[WEBHOOK:${requestId}] ❌ Raw body must be a Buffer`);
      return res.status(400).send('Invalid body format');
    }
    
    const signature = req.headers['x-paystack-signature'] as string | undefined;
    
    // ✅ FIXED: Add null check for signature
    if (!signature || !validatePaystackSignature(rawBody, signature)) {
      console.warn(`[WEBHOOK:${requestId}] ❌ Invalid signature`);
      
      await createAuditLog('WEBHOOK_SIGNATURE_INVALID', null, {
        requestId,
        ip: req.ip,
        signatureProvided: signature,
      });
      
      await sendAlert('WARNING', 'Invalid Webhook Signature', {
        requestId,
        ip: req.ip,
        signatureProvided: signature,
      });
      
      return res.status(401).send('Unauthorized: Invalid signature');
    }
    
    // 3️⃣ PARSE AND VALIDATE PAYLOAD
    let eventPayload;
    try {
      eventPayload = JSON.parse(rawBody.toString());
    } catch (error) {
      console.error(`[WEBHOOK:${requestId}] ❌ Failed to parse JSON`);
      return res.status(400).send('Invalid JSON');
    }
    
    const validation = validatePaystackWebhook(eventPayload);
    if (!validation.valid || !validation.data) {
      console.error(`[WEBHOOK:${requestId}] ❌ Validation failed: ${validation.error}`);
      return res.status(400).send(`Invalid payload: ${validation.error}`);
    }
    
    const { event, data } = validation.data;
    
    // Generate webhook ID for replay protection
    const webhookId = generateWebhookId(eventPayload, startTime);
    
    // 4️⃣ REPLAY PROTECTION
    if (isWebhookProcessed(webhookId)) {
      console.log(`[WEBHOOK:${requestId}] ⚠️ Replay detected`);
      
      await createAuditLog('WEBHOOK_REPLAY', data.metadata?.userId || null, {
        requestId,
        webhookId,
        reference: data.reference,
        ip: req.ip,
      });
      
      return res.status(200).send('Webhook already processed');
    }
    
    const { reference, amount, metadata, authorization } = data;
    const now = nowUtc();
    
    // ✅ FIXED: Add null check for metadata
    if (!metadata) {
      console.error(`[WEBHOOK:${requestId}] ❌ Missing metadata`);
      return res.status(400).send('Missing required metadata');
    }
    
    // 5️⃣ LOG WEBHOOK RECEIPT
    await createAuditLog('WEBHOOK_RECEIVED', metadata.userId, {
      requestId,
      webhookId,
      event,
      reference,
      amount,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      path: req.path,
    });
    
    // Mark as processed early
    markWebhookProcessed(webhookId);
    
    // 6️⃣ PROCESS WITH RETRY LOGIC
    await processWithRetry(async () => {
      await prisma.$transaction(async (tx) => {
        // 7️⃣ FETCH PAYMENT WITH ORDER
        const payment = await tx.payment.findUnique({
          where: { reference },
          include: {
            order: {
              select: {
                id: true,
                customerId: true,
                vendorId: true,
                totalPrice: true,
                status: true,
                paymentStatus: true,
                paymentInitiatedAt: true,
                paidAt: true,
                protectedUntil: true,
                paymentGraceMinutes: true,
              },
            },
          },
        });
        
        if (!payment || !payment.order) {
          console.error(`[WEBHOOK:${requestId}] ❌ Payment not found: ${reference}`);
          throw new Error(`Payment not found: ${reference}`);
        }
        
        const order = payment.order;
        const amountInNaira = amount / 100;
        
        // 8️⃣ IDEMPOTENCY CHECK
        if (payment.status === PAYMENT_SUCCESS) {
          console.log(`[WEBHOOK:${requestId}] ℹ️ Payment already successful: ${reference}`);
          
          if (order.paymentStatus !== PAYMENT_SUCCESS) {
            await tx.order.update({
              where: { id: order.id },
              data: { paymentStatus: PAYMENT_SUCCESS },
            });
          }
          
          return;
        }
        
        // 9️⃣ VALIDATE CUSTOMER CONSISTENCY
        if (order.customerId !== metadata.userId) {
          console.warn(`[WEBHOOK:${requestId}] ⚠️ Customer mismatch for ${reference}`);
          
          await createAuditLog('WEBHOOK_CUSTOMER_MISMATCH', order.customerId, {
            requestId,
            webhookId,
            reference,
            orderCustomerId: order.customerId,
            metadataCustomerId: metadata.userId,
            ip: req.ip,
          });
          
          throw new Error(`Customer ID mismatch for ${reference}`);
        }
        
        // 🔟 VALIDATE AMOUNT
        if (Math.abs(amountInNaira - order.totalPrice) > 1) {
          console.warn(`[WEBHOOK:${requestId}] ⚠️ Amount mismatch for ${reference}`);
          
          await tx.payment.update({
            where: { reference },
            data: { 
              status: PAYMENT_AMOUNT_MISMATCH,
              updatedAt: now,
              paystackData: eventPayload.data,
            },
          });
          
          await createAuditLog('WEBHOOK_AMOUNT_MISMATCH', order.customerId, {
            requestId,
            webhookId,
            reference,
            orderAmount: order.totalPrice,
            paymentAmount: amountInNaira,
            difference: Math.abs(amountInNaira - order.totalPrice),
            ip: req.ip,
          });
          
          await sendAlert('WARNING', 'Payment Amount Mismatch', {
            requestId,
            reference,
            orderId: order.id,
            expected: order.totalPrice,
            received: amountInNaira,
            customerId: order.customerId,
          });
          
          throw new Error(`Amount mismatch for ${reference}`);
        }
        
        // 1️⃣1️⃣ CHECK TIMING SAFETY
        const protectedUntilUtc = order.protectedUntil ? toUtc(order.protectedUntil) : null;
        const expiresAtUtc = payment.expiresAt ? toUtc(payment.expiresAt) : null;
        
        const isWithinProtection = protectedUntilUtc ? isBeforeUtc(now, protectedUntilUtc) : false;
        const isBeforeExpiry = expiresAtUtc ? isBeforeUtc(now, expiresAtUtc) : false;
        
        if (!isWithinProtection && !isBeforeExpiry) {
          console.warn(`[WEBHOOK:${requestId}] ⚠️ Late payment: ${reference}`);
          
          await tx.payment.update({
            where: { reference },
            data: { 
              status: PAYMENT_EXPIRED,
              updatedAt: now,
              paystackData: eventPayload.data,
            },
          });
          
          // Cancel order if in cancellable state
          if (CANCELLABLE_ORDER_STATUSES.includes(order.status)) {
            await tx.order.update({
              where: { id: order.id },
              data: {
                status: OrderStatus.CANCELLED_UNPAID,
                cancellationReason: 'LATE_PAYMENT',
                cancelledAt: now,
                paymentStatus: PAYMENT_FAILED,
              },
            });
          }
          
          await createAuditLog('WEBHOOK_LATE_PAYMENT', order.customerId, {
            requestId,
            webhookId,
            reference,
            orderId: order.id,
            orderStatus: order.status,
            isWithinProtection,
            isBeforeExpiry,
            ip: req.ip,
          });
          
          await sendAlert('WARNING', 'Late Payment Received', {
            requestId,
            reference,
            orderId: order.id,
            customerId: order.customerId,
            orderStatus: order.status,
            isWithinProtection,
            isBeforeExpiry,
          });
          
          throw new Error(`Late payment for ${reference}`);
        }
        
        // 1️⃣2️⃣ SAVE REUSABLE CARD (if applicable)
        if (authorization?.reusable && metadata.userId) {
          try {
            await tx.userPaymentMethod.upsert({
              where: { cardToken: authorization.authorization_code },
              create: {
                userId: metadata.userId,
                cardToken: authorization.authorization_code,
                last4: authorization.last4,
                brand: authorization.brand.toLowerCase(),
                isDefault: false,
              },
              update: { updatedAt: now },
            });
            console.log(`[WEBHOOK:${requestId}] 💳 Saved reusable card for user ${metadata.userId}`);
          } catch (err: any) {
            console.error(`[WEBHOOK:${requestId}] ⚠️ Failed to save card:`, err);
          }
        }
        
        // 1️⃣3️⃣ UPDATE PAYMENT AS SUCCESSFUL
        await tx.payment.update({
          where: { reference },
          data: {
            status: PAYMENT_SUCCESS,
            completedAt: now,
            paystackData: eventPayload.data,
            updatedAt: now,
          },
        });
        
        // 1️⃣4️⃣ UPDATE ORDER STATUS (FIXED CRITICAL BUG)
        if (PAYABLE_ORDER_STATUSES.includes(order.status)) {
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: OrderStatus.PAYMENT_CONFIRMED,
              paymentStatus: PAYMENT_SUCCESS,
              paidAt: order.paidAt || now,
            },
          });
          
          console.log(`[WEBHOOK:${requestId}] ✅ Order ${order.id} confirmed (first payment)`);
          
        } else if (order.status === OrderStatus.PAYMENT_CONFIRMED) {
          if (order.paymentStatus !== PAYMENT_SUCCESS) {
            await tx.order.update({
              where: { id: order.id },
              data: {
                paymentStatus: PAYMENT_SUCCESS,
              },
            });
            console.log(`[WEBHOOK:${requestId}] ℹ️ Updated paymentStatus for already-confirmed order ${order.id}`);
          }
          
        } else {
          console.warn(`[WEBHOOK:${requestId}] ⚠️ Order ${order.id} in state ${order.status}`);
          
          if (order.paymentStatus !== PAYMENT_SUCCESS) {
            await tx.order.update({
              where: { id: order.id },
              data: {
                paymentStatus: PAYMENT_SUCCESS,
              },
            });
          }
        }
        
        // 1️⃣5️⃣ CREATE SUCCESS AUDIT LOG
        await createAuditLog('PAYMENT_SUCCESS', order.customerId, {
          requestId,
          webhookId,
          reference,
          orderId: order.id,
          amount: amountInNaira,
          previousOrderStatus: order.status,
          newOrderStatus: OrderStatus.PAYMENT_CONFIRMED,
          previousPaymentStatus: order.paymentStatus,
          newPaymentStatus: PAYMENT_SUCCESS,
          vendorId: order.vendorId,
          isWithinProtection,
          isBeforeExpiry,
          processingTimeMs: Date.now() - startTime,
          ip: req.ip,
        });
        
        // 1️⃣6️⃣ SEND SUCCESS ALERT
        await sendAlert('INFO', 'Payment Successfully Processed', {
          requestId,
          webhookId,
          reference,
          orderId: order.id,
          amount: amountInNaira,
          customerId: order.customerId,
          vendorId: order.vendorId,
          processingTimeMs: Date.now() - startTime,
        });
      });
      
    }, { reference, webhookId });
    
    // 1️⃣7️⃣ SUCCESS RESPONSE
    console.log(`[WEBHOOK:${requestId}] ✅ ${reference} processed successfully`);
    return res.status(200).send('Webhook processed successfully');
    
  } catch (error: any) {
    const processingTime = Date.now() - startTime;
    const errorMessage = error?.message || 'Unknown error';
    
    console.error(`[WEBHOOK:${requestId}] ❌ Processing failed after ${processingTime}ms:`, errorMessage);
    
    await sendAlert('ERROR', 'Webhook Processing Failed', {
      requestId,
      processingTimeMs: processingTime,
      error: errorMessage,
      stack: error?.stack,
      path: req.path,
      ip: req.ip,
    });
    
    return res.status(200).send('Webhook received (check logs for details)');
  }
};

// ==================== ADDITIONAL UTILITY ENDPOINTS ====================

export const webhookHealthCheck = async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    
    const health = {
      status: 'healthy',
      timestamp: nowUtc(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      processedWebhooks: processedWebhooks.size,
      rateLimitData: Array.from(requestCounts.entries()).map(([ip, data]) => ({
        ip,
        count: data.count,
        resetTime: new Date(data.resetTime).toISOString(),
      })),
    };
    
    res.json(health);
  } catch (error: any) {
    console.error('[WEBHOOK-HEALTH] ❌ Health check failed:', error);
    
    await sendAlert('CRITICAL', 'Webhook Service Unhealthy', {
      error: error.message,
      timestamp: nowUtc(),
    });
    
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: nowUtc(),
    });
  }
};

export const webhookStats = async (req: Request, res: Response) => {
  try {
    const stats = {
      processedWebhooksCount: processedWebhooks.size,
      rateLimitedIPs: requestCounts.size,
      oldestProcessedWebhook: processedWebhooks.size > 0 
        ? new Date(Math.min(...Array.from(processedWebhooks.values()))).toISOString()
        : null,
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
    };
    
    res.json(stats);
  } catch (error: any) {
    console.error('[WEBHOOK-STATS] ❌ Failed to get stats:', error);
    res.status(500).json({ error: error.message });
  }
};

export const cleanupWebhooks = async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [webhookId, timestamp] of processedWebhooks.entries()) {
      if (now - timestamp > WEBHOOK_TTL) {
        processedWebhooks.delete(webhookId);
        cleaned++;
      }
    }
    
    res.json({
      success: true,
      cleaned,
      remaining: processedWebhooks.size,
      message: `Cleaned ${cleaned} old webhook IDs`,
    });
  } catch (error: any) {
    console.error('[WEBHOOK-CLEANUP] ❌ Cleanup failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};