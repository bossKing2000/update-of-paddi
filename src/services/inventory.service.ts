import type { Prisma } from "@prisma/client";
import { ValidationError, ConflictError } from "../errors/AppError";
import { clearProductCache } from "./clearCaches";
import { logger } from "../lib/logger";

type Tx = Prisma.TransactionClient;

export interface StockCheckItem {
  productId: string;
  productName?: string;
  quantity: number;
  trackInventory?: boolean | null;
  stock?: number | null;
}

/**
 * Validates a requested quantity against current stock (read-model check
 * for add-to-cart / cart-update UX). The checkout transaction revalidates
 * atomically — this never replaces the in-transaction reservation below.
 */
export function assertQuantityAvailable(item: StockCheckItem): void {
  if (!item.trackInventory) return;
  const remaining = item.stock ?? 0;
  if (item.quantity > remaining) {
    const name = item.productName ? ` for "${item.productName}"` : "";
    throw new ValidationError(
      remaining <= 0
        ? `This item is sold out${name}.`
        : `Only ${remaining} portion${remaining === 1 ? "" : "s"} left${name}.`,
    );
  }
}

/**
 * Atomically reserves stock for checkout line items INSIDE the checkout
 * transaction. Each tracked product is decremented only when enough
 * portions remain — the `stock >= qty` condition makes concurrent
 * checkouts serialize on the row: exactly one winner per final portion,
 * losers get count === 0 and the whole transaction rolls back.
 *
 * Must be called within the same transaction that creates the orders so a
 * reservation can never exist without its order (and vice versa).
 */
export async function reserveStockForItems(
  tx: Tx,
  items: StockCheckItem[],
): Promise<void> {
  // Aggregate per product: one cart can hold the same product on several
  // lines (different add-on combos), but stock is per product.
  const byProduct = new Map<string, { quantity: number; name?: string }>();
  for (const item of items) {
    if (!item.trackInventory) continue;
    const prev = byProduct.get(item.productId) ?? { quantity: 0, name: item.productName };
    prev.quantity += item.quantity;
    byProduct.set(item.productId, prev);
  }

  for (const [productId, { quantity, name }] of byProduct) {
    const claimed = await tx.product.updateMany({
      where: {
        id: productId,
        trackInventory: true,
        archived: false,
        stock: { gte: quantity },
      },
      data: { stock: { decrement: quantity } },
    });
    if (claimed.count === 0) {
      const label = name ? `"${name}"` : "An item in your cart";
      throw new ConflictError(
        `${label} just sold out. Please refresh your cart and try again.`,
      );
    }
  }
}

export interface ReservedOrderItem {
  productId: string;
  quantity: number;
}

/**
 * Releases a previous reservation when an UNPAID order dies (payment
 * expired, vendor/product went offline, user/vendor cancelled before
 * payment, late payment). Each death path restores only after its own
 * atomic status transition succeeds, so concurrent paths cannot
 * double-restore the same order. Paid orders never restore — the portions
 * are consumed.
 */
export async function restoreStockForOrders(
  prisma: Pick<Tx, "order" | "product">,
  orderIds: string[],
): Promise<void> {
  if (orderIds.length === 0) return;

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { items: { select: { productId: true, quantity: true } } },
  });

  const byProduct = new Map<string, number>();
  for (const order of orders) {
    for (const item of order.items) {
      byProduct.set(item.productId, (byProduct.get(item.productId) ?? 0) + item.quantity);
    }
  }

  for (const [productId, quantity] of byProduct) {
    const restored = await prisma.product.updateMany({
      where: { id: productId, trackInventory: true },
      data: { stock: { increment: quantity } },
    });
    // Stock changed → cached detail/listing rows are stale. Best-effort;
    // a miss only costs one extra DB read on the next request.
    if (restored.count > 0) {
      await clearProductCache(productId).catch((err) =>
        logger.warn({ err, productId }, "Failed to invalidate product cache after stock restore"),
      );
    }
  }
}
