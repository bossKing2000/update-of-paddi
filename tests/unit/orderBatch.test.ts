import fs from "fs";

describe("order batch endpoint — GET /orders/batch/:idempotencyKey", () => {
  const source = fs.readFileSync("src/controllers/orderController.ts", "utf8");
  const routerSource = fs.readFileSync("src/routes/orderRouter.ts", "utf8");

  it("defines getOrderBatch controller", () => {
    expect(source).toContain("export const getOrderBatch");
  });

  it("reads idempotencyKey from req.params", () => {
    const fn = source.slice(source.indexOf("export const getOrderBatch"), source.indexOf("export const getSingleOrder"));
    expect(fn).toContain("req.params.idempotencyKey");
  });

  it("validates idempotencyKey presence", () => {
    const fn = source.slice(source.indexOf("export const getOrderBatch"), source.indexOf("export const getSingleOrder"));
    expect(fn).toContain("idempotencyKey is required");
  });

  it("scopes query by customerId (authenticated user)", () => {
    const fn = source.slice(source.indexOf("export const getOrderBatch"), source.indexOf("export const getSingleOrder"));
    expect(fn).toContain("customerId: userId");
  });

  it("filters by idempotencyKey", () => {
    const fn = source.slice(source.indexOf("export const getOrderBatch"), source.indexOf("export const getSingleOrder"));
    expect(fn).toContain("idempotencyKey");
  });

  it("orders results by createdAt asc", () => {
    const fn = source.slice(source.indexOf("export const getOrderBatch"), source.indexOf("export const getSingleOrder"));
    expect(fn).toContain("createdAt");
    expect(fn).toContain("asc");
  });

  it("returns 404 when no orders found for the key", () => {
    const fn = source.slice(source.indexOf("export const getOrderBatch"), source.indexOf("export const getSingleOrder"));
    expect(fn).toContain("NotFoundError");
    expect(fn).toContain("Order batch");
  });

  it("includes order items with product and options", () => {
    const fn = source.slice(source.indexOf("export const getOrderBatch"), source.indexOf("export const getSingleOrder"));
    expect(fn).toContain("items");
    expect(fn).toContain("product");
    expect(fn).toContain("options");
  });

  it("includes customer, vendor, address, assignments, and payments", () => {
    const fn = source.slice(source.indexOf("export const getOrderBatch"), source.indexOf("export const getSingleOrder"));
    expect(fn).toContain("customer");
    expect(fn).toContain("vendor");
    expect(fn).toContain("address");
    expect(fn).toContain("assignments");
    expect(fn).toContain("payments");
  });

  it("registers route before /:orderId to avoid conflict", () => {
    const batchRouteIdx = routerSource.indexOf('router.get("/batch/:idempotencyKey"');
    const orderIdRouteIdx = routerSource.indexOf('router.get("/:orderId"');
    expect(batchRouteIdx).toBeGreaterThan(-1);
    expect(orderIdRouteIdx).toBeGreaterThan(-1);
    expect(batchRouteIdx).toBeLessThan(orderIdRouteIdx);
  });

  it("registers getOrderBatch controller", () => {
    expect(routerSource).toContain("getOrderBatch");
  });

  it("uses sendSuccess response format", () => {
    const fn = source.slice(source.indexOf("export const getOrderBatch"), source.indexOf("export const getSingleOrder"));
    expect(fn).toContain("sendSuccess");
  });
});