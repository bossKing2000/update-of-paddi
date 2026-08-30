import { addToCartSchema, updateCartItemSchema } from "../../src/validations/cartSchema";

describe("quantityBounds — H3", () => {
  it("addToCart rejects quantity 0", () => {
    const result = addToCartSchema.safeParse({ productId: "550e8400-e29b-41d4-a716-446655440000", quantity: 0 });
    expect(result.success).toBe(false);
  });

  it("addToCart rejects negative quantity", () => {
    const result = addToCartSchema.safeParse({ productId: "550e8400-e29b-41d4-a716-446655440000", quantity: -1 });
    expect(result.success).toBe(false);
  });

  it("addToCart accepts quantity 1", () => {
    const result = addToCartSchema.safeParse({ productId: "550e8400-e29b-41d4-a716-446655440000", quantity: 1 });
    expect(result.success).toBe(true);
  });

  it("addToCart rejects quantity 100 (over MAX_QTY 99)", () => {
    const result = addToCartSchema.safeParse({ productId: "550e8400-e29b-41d4-a716-446655440000", quantity: 100 });
    expect(result.success).toBe(false);
  });

  it("addToCart rejects quantity 999999 (DoS/overflow)", () => {
    const result = addToCartSchema.safeParse({ productId: "550e8400-e29b-41d4-a716-446655440000", quantity: 999999 });
    expect(result.success).toBe(false);
  });

  it("addToCart accepts max allowed 99", () => {
    const result = addToCartSchema.safeParse({ productId: "550e8400-e29b-41d4-a716-446655440000", quantity: 99 });
    expect(result.success).toBe(true);
  });

  it("updateCartItem rejects 0 (now requires min 1)", () => {
    const result = updateCartItemSchema.safeParse({ quantity: 0 });
    expect(result.success).toBe(false);
  });

  it("updateCartItem rejects huge quantity 999999", () => {
    const result = updateCartItemSchema.safeParse({ quantity: 999999 });
    expect(result.success).toBe(false);
  });

  it("updateCartItem accepts valid quantity within bounds", () => {
    const result = updateCartItemSchema.safeParse({ quantity: 5 });
    expect(result.success).toBe(true);
  });

  it("specialRequest respects max 500 chars", () => {
    const long = "a".repeat(501);
    const result = addToCartSchema.safeParse({ productId: "550e8400-e29b-41d4-a716-446655440000", quantity: 1, specialRequest: long });
    expect(result.success).toBe(false);
  });
});
