/**
 * Cart-cache invalidation for catalog deletions/updates.
 *
 * Cart snapshots are written by `cartController` to the `ShopCartRedis`
 * client (logical DB 5) under `cart:user:...`. The previous helper scanned
 * `redisProducts` instead, i.e. a DIFFERENT logical database, so it always
 * found nothing and left real cart snapshots stale after a product/option was
 * deleted or edited.
 *
 * This suite exercises the REAL `clearProductFromCarts` with mocked Redis.
 * It proves:
 *   1. the cart client and `cart:user:*` namespace are the ones scanned
 *   2. `redisProducts` is never read/scanned/deleted by the helper
 *   3. only snapshots whose payload contains the product id are deleted
 *   4. no PostgreSQL cart row is touched
 *   5. Redis failures (scan, read, delete) never fail the completed catalog
 *      write — the helper is best-effort by contract
 *
 * Real Redis behavior is NOT proven here; that requires the Redis integration
 * suite, which was not run.
 */
jest.mock("../../src/lib/redis", () => {
  const client = () => ({
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    scan: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    ping: jest.fn(),
  });
  return {
    __esModule: true,
    redisNotifications: client(),
    redisProducts: client(),
    redisSearch: client(),
    redisTotalViews: client(),
    redisUsersSessions: client(),
    ShopCartRedis: client(),
    redisPayments: client(),
    connectRedis: jest.fn(),
    ensureRedisReady: jest.fn(),
  };
});

jest.mock("../../src/lib/redisScan", () => ({
  __esModule: true,
  scanKeys: jest.fn(),
}));

jest.mock("../../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    cartItem: { deleteMany: jest.fn(), updateMany: jest.fn(), delete: jest.fn() },
    cartItemOption: { deleteMany: jest.fn(), updateMany: jest.fn(), delete: jest.fn() },
  },
}));

import prisma from "../../src/lib/prisma";
import { redisProducts, ShopCartRedis } from "../../src/lib/redis";
import { scanKeys } from "../../src/lib/redisScan";
import { clearProductFromCarts } from "../../src/services/product.service";

interface MockClient {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  scan: jest.Mock;
}

const cartClient = ShopCartRedis as unknown as MockClient;
const productClient = redisProducts as unknown as MockClient;
const mockedScanKeys = scanKeys as unknown as jest.Mock;
const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PRODUCT_ID = "22222222-2222-4222-8222-222222222222";

const snapshot = (productIds: string[]): string =>
  JSON.stringify({
    userId: "user-1",
    items: productIds.map((productId) => ({ productId, quantity: 1 })),
  });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  mockedScanKeys.mockResolvedValue([]);
  cartClient.get.mockResolvedValue(null);
  cartClient.del.mockResolvedValue(1);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("clearProductFromCarts — correct Redis surface", () => {
  it("1. scans ShopCartRedis with the cart:user:* namespace", async () => {
    mockedScanKeys.mockResolvedValue([]);

    await expect(clearProductFromCarts(PRODUCT_ID)).resolves.toBeUndefined();

    expect(mockedScanKeys).toHaveBeenCalledTimes(1);
    expect(mockedScanKeys).toHaveBeenCalledWith(ShopCartRedis, "cart:user:*");
    // Identity proof: not some other client that happens to accept a pattern.
    expect(mockedScanKeys.mock.calls[0][0]).not.toBe(redisProducts);
  });

  it("2. never reads, scans or deletes through redisProducts", async () => {
    mockedScanKeys.mockResolvedValue(["cart:user:v2:user-1"]);
    cartClient.get.mockResolvedValue(snapshot([PRODUCT_ID]));

    await clearProductFromCarts(PRODUCT_ID);

    expect(productClient.get).not.toHaveBeenCalled();
    expect(productClient.scan).not.toHaveBeenCalled();
    expect(productClient.del).not.toHaveBeenCalled();
    expect(cartClient.del).toHaveBeenCalledTimes(1);
  });

  it("3. deletes only snapshots whose payload contains the product id", async () => {
    mockedScanKeys.mockResolvedValue([
      "cart:user:v2:user-1",
      "cart:user:v2:user-2",
      "cart:user:legacy-user-3",
    ]);
    cartClient.get.mockImplementation(async (key: string) => {
      if (key === "cart:user:v2:user-1") return snapshot([PRODUCT_ID]);
      if (key === "cart:user:v2:user-2") return snapshot([OTHER_PRODUCT_ID]);
      return snapshot([PRODUCT_ID, OTHER_PRODUCT_ID]);
    });

    await clearProductFromCarts(PRODUCT_ID);

    expect(cartClient.get).toHaveBeenCalledTimes(3);
    expect(cartClient.del).toHaveBeenCalledTimes(1);
    expect(cartClient.del).toHaveBeenCalledWith([
      "cart:user:v2:user-1",
      "cart:user:legacy-user-3",
    ]);
  });

  it("4. deletes nothing when no snapshot contains the product id", async () => {
    mockedScanKeys.mockResolvedValue([
      "cart:user:v2:user-1",
      "cart:user:v2:user-2",
    ]);
    cartClient.get.mockResolvedValue(snapshot([OTHER_PRODUCT_ID]));

    await clearProductFromCarts(PRODUCT_ID);

    expect(cartClient.get).toHaveBeenCalledTimes(2);
    expect(cartClient.del).not.toHaveBeenCalled();
  });

  it("5. touches no PostgreSQL cart rows and no product cache keys", async () => {
    mockedScanKeys.mockResolvedValue(["cart:user:v2:user-1"]);
    cartClient.get.mockResolvedValue(snapshot([PRODUCT_ID]));

    await clearProductFromCarts(PRODUCT_ID);

    expect(db.cartItem.deleteMany).not.toHaveBeenCalled();
    expect(db.cartItem.updateMany).not.toHaveBeenCalled();
    expect(db.cartItem.delete).not.toHaveBeenCalled();
    expect(db.cartItemOption.deleteMany).not.toHaveBeenCalled();
    expect(db.cartItemOption.updateMany).not.toHaveBeenCalled();
    expect(db.cartItemOption.delete).not.toHaveBeenCalled();
    expect(productClient.set).not.toHaveBeenCalled();
  });
});

describe("clearProductFromCarts — best effort on Redis failure", () => {
  it("6. a SCAN failure resolves without throwing and deletes nothing", async () => {
    mockedScanKeys.mockRejectedValueOnce(new Error("redis SCAN failed"));

    await expect(clearProductFromCarts(PRODUCT_ID)).resolves.toBeUndefined();
    expect(cartClient.del).not.toHaveBeenCalled();
  });

  it("7. a failed per-key GET skips only that key; other matches still clear", async () => {
    mockedScanKeys.mockResolvedValue([
      "cart:user:v2:user-1",
      "cart:user:v2:user-2",
    ]);
    cartClient.get.mockImplementation(async (key: string) => {
      if (key === "cart:user:v2:user-1") throw new Error("read failed");
      return snapshot([PRODUCT_ID]);
    });

    await expect(clearProductFromCarts(PRODUCT_ID)).resolves.toBeUndefined();
    expect(cartClient.del).toHaveBeenCalledWith(["cart:user:v2:user-2"]);
  });

  it("8. a DEL failure resolves without throwing (deletion already committed)", async () => {
    mockedScanKeys.mockResolvedValue(["cart:user:v2:user-1"]);
    cartClient.get.mockResolvedValue(snapshot([PRODUCT_ID]));
    cartClient.del.mockRejectedValueOnce(new Error("delete failed"));

    await expect(clearProductFromCarts(PRODUCT_ID)).resolves.toBeUndefined();
  });

  it("9. an empty scan performs no DEL call", async () => {
    mockedScanKeys.mockResolvedValue([]);

    await expect(clearProductFromCarts(PRODUCT_ID)).resolves.toBeUndefined();
    expect(cartClient.get).not.toHaveBeenCalled();
    expect(cartClient.del).not.toHaveBeenCalled();
  });
});
