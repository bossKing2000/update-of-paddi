import fs from "fs";

describe("RefundRequest.orderId attribution (Phase 3.2b writers)", () => {
  const paymentSource = fs.readFileSync("src/controllers/paymentController.ts", "utf8");
  const orderSource = fs.readFileSync("src/controllers/orderController.ts", "utf8");
  const adminSource = fs.readFileSync("src/controllers/admin.controller.ts", "utf8");

  it("customer path resolves the exact order via the shared rule", () => {
    const createIdx = paymentSource.indexOf("await prisma.refundRequest.create({");
    const block = paymentSource.slice(createIdx, createIdx + 1200);
    // `orderId: refundOrderId` is declared in the refundData object passed to
    // create; assert both the attribution and the shared resolution rule.
    expect(paymentSource).toContain("orderId: refundOrderId");
    expect(paymentSource).toContain("resolveRefundOrderId(prisma, payment, userId)");
  });

  it("paid-cancel path attributes the exact cancelled order", () => {
    expect(orderSource).toContain("orderId: order.id");
    // C-2 replaced the typed `create` with a conflict-tolerant
    // `fileRefundOwed(tx, {...})` insert. The attribution guarantees asserted
    // here are unchanged; only the anchor moved.
    const createIdx = orderSource.indexOf("await fileRefundOwed(tx, {");
    expect(createIdx).toBeGreaterThan(-1);
    const block = orderSource.slice(createIdx, createIdx + 600);
    expect(block).toContain("orderId: order.id");
    expect(block).toContain('"Order cancelled after payment"');
  });

  it("admin submit does not invent or alter order attribution (economics untouched)", () => {
    const submitIdx = adminSource.indexOf("requestedAmountKobo: reservedKobo");
    const block = adminSource.slice(submitIdx - 2000, submitIdx + 500);
    expect(block).not.toContain("orderId");
  });

  it("shared rule: single-order batch attributes, multi-order stays null", () => {
    const service = fs.readFileSync("src/services/orderSnapshot.service.ts", "utf8");
    expect(service).toContain("matches.length === 1 ? matches[0].id : null");
    expect(service).toContain("linked.customerId === customerId ? linked.id : null");
  });
});
