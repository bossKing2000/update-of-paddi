# Backend fix: /api/product/p/most returning 500

## Root cause
`getMostPopularProducts` in `src/controllers/productController.ts` runs a raw
SQL query that selects `p."productScheduleId"` directly off the `Product`
table. That column doesn't exist — per your own `prisma/schema.prisma`, the
foreign key lives on `ProductSchedule.productId` (pointing *at* Product), not
the other way around:

```prisma
model Product {
  ...
  productSchedule ProductSchedule?   // no productScheduleId column here
}

model ProductSchedule {
  id        String  @id @default(uuid())
  productId String  @unique
  product   Product @relation(fields: [productId], references: [id])
}
```

The query's JOIN clause (`LEFT JOIN "ProductSchedule" s ON s."productId" = p.id`)
is already correct — it was only the SELECT list that referenced a column
that has never existed on `Product`. Postgres error `42703` confirms this:
`column p.productScheduleId does not exist`.

## Fix
Removed `p."productScheduleId",` from the SELECT list (this file,
`productController.ts`, around line 1022). Nothing else needed to change —
the schedule data (`goLiveAt`, `takeDownAt`, `graceMinutes`) still comes
through fine via the `s.` alias from the join.

## To deploy
1. Copy this `productController.ts` over
   `src/controllers/productController.ts` in your backend repo (or apply the
   single-line diff below by hand).
2. Commit and push — Render will redeploy automatically on push, or trigger
   a manual deploy from the Render dashboard.
3. Confirm with: `curl https://update-of-paddi.onrender.com/api/product/p/most`
   — should return `200` with a product list instead of `500`.

```diff
     SELECT p.id, p.name, p.price, p.images, p."averageRating", p."reviewCount",
            p."popularityScore", p."popularityPercent", p."totalViews", p.category,
-           p."isLive", p."archived", p."productScheduleId",
+           p."isLive", p."archived",
            s."goLiveAt", s."takeDownAt", s."graceMinutes"
     FROM "Product" p
     LEFT JOIN "ProductSchedule" s ON s."productId" = p.id
```
